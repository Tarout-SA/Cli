/**
 * @fileoverview Engine for `tarout agent setup`: installs the Tarout skills and
 * registers the Tarout MCP server in every coding agent found on this machine.
 *
 * `runAgentSetup` computes, per target, what would change. With `apply: false`
 * it only reads (the plan, and `--dry-run`); with `apply: true` it recomputes
 * from the files as they are now and writes. Recomputing on apply keeps it
 * correct when a file changed while the user was reading the plan, and makes
 * a re-run report "unchanged".
 *
 * Rules the engine keeps:
 * - Only detected agents are touched.
 * - Other servers in a config file are never modified; JSON keeps its keys,
 *   key order and indentation.
 * - An existing `tarout` entry that differs is replaced only when `replace`
 *   (`--yes`) is set; one that does not point at Tarout at all is never
 *   replaced.
 * - A config that is not strict JSON (JSONC with comments) is left untouched
 *   and a snippet is returned instead, since rewriting it would drop comments.
 * - `claude` / `codex` run from an argv array with a timeout, never a shell;
 *   one target failing never stops the others.
 *
 * All I/O goes through `SetupIO`, so tests run it on a temp HOME with fake
 * command runners.
 * @module lib/agent-install
 */

import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectJsonIndent } from "./agent-scaffold.js";
import {
	AGENT_TARGETS,
	type AgentTarget,
	type AgentTargetId,
	claudeUserConfigFile,
	codexHome,
	HOSTED_MCP_URL,
	LOCAL_MCP_COMMAND,
	MCP_SERVER_NAME,
	type McpMode,
	type SetupHost,
	TAROUT_SKILLS,
} from "./agent-targets.js";

/** Upper bound for any `claude` / `codex` invocation. */
export const COMMAND_TIMEOUT_MS = 15_000;

export interface CommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Spawn failure (e.g. ENOENT), when the process never ran. */
	error?: string;
}

export interface SetupIO extends SetupHost {
	/** Absolute path of `bin` on PATH, or null. */
	findOnPath(bin: string): string | null;
	/** Run argv (argv[0] is the binary) without a shell. */
	run(argv: readonly string[], timeoutMs: number): CommandResult;
}

export interface SetupOptions {
	mode: McpMode;
	/** Restrict to these targets; undefined means all. */
	agents?: readonly AgentTargetId[];
	skills: boolean;
	mcp: boolean;
	/** `--yes`: allow replacing a `tarout` entry whose settings differ. */
	replace: boolean;
	/** Write (true) or only report what would change (false). */
	apply: boolean;
	/** Directory holding `<skill>/SKILL.md`; defaults to the packaged copy. */
	skillsSource?: string;
}

export type SkillStatus =
	| "written"
	| "unchanged"
	| "skipped"
	| "error"
	| "would-write";

export interface SkillOutcome {
	skill: string;
	path: string;
	status: SkillStatus;
	/** For written / would-write: whether the file is new or replaced. */
	change?: "create" | "update";
	reason?: string;
}

export type McpStatus =
	| "registered"
	| "updated"
	| "unchanged"
	| "skipped"
	| "snippet"
	| "error"
	| "would-register"
	| "would-update";

export interface McpOutcome {
	method: "claude-cli" | "codex-cli" | "codex-toml" | "json";
	status: McpStatus;
	/** Config file involved (for JSON and TOML methods). */
	path?: string;
	/** The command that registers the server (CLI methods). */
	command?: string;
	/** The existing `tarout` entry, when there was one. */
	before?: unknown;
	/** The entry this run writes (or would write). */
	after?: unknown;
	/** Paste-ready config for the user when it was not written. */
	snippet?: string;
	reason?: string;
}

export interface TargetOutcome {
	id: AgentTargetId;
	name: string;
	detected: boolean;
	/** What was found: a directory (with `~`) or `<bin> on PATH`. */
	detectedBy?: string;
	skills: SkillOutcome[];
	mcp: McpOutcome | null;
	nextSteps: string[];
	errors: string[];
}

export interface SetupReport {
	mode: McpMode;
	/** The hosted URL, or the local command. */
	server: string;
	applied: boolean;
	targets: TargetOutcome[];
	notes: string[];
}

// ---------------------------------------------------------------------------
// Default I/O
// ---------------------------------------------------------------------------

/** Locate `bin` on PATH without spawning `which` / `where`. */
export function findBinaryOnPath(
	bin: string,
	env: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform,
): string | null {
	const isWindows = platform === "win32";
	const pathValue = env.PATH ?? env.Path ?? "";
	const dirs = pathValue.split(isWindows ? ";" : ":").filter(Boolean);
	const exts = isWindows
		? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
		: [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, `${bin}${ext.toLowerCase()}`);
			try {
				if (!statSync(candidate).isFile()) continue;
				if (!isWindows) accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// not here
			}
		}
	}
	return null;
}

function spawnCommand(
	argv: readonly string[],
	timeoutMs: number,
): CommandResult {
	const [command, ...args] = argv;
	if (!command) {
		return { status: null, stdout: "", stderr: "", timedOut: false, error: "empty command" };
	}
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		timeout: timeoutMs,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		cwd: homedir(),
	});
	const spawnError = result.error as NodeJS.ErrnoException | undefined;
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		timedOut: spawnError?.code === "ETIMEDOUT",
		...(spawnError ? { error: spawnError.message } : {}),
	};
}

export function defaultSetupIO(): SetupIO {
	const env = process.env;
	const platform = process.platform;
	return {
		home: homedir(),
		platform,
		env,
		findOnPath: (bin) => findBinaryOnPath(bin, env, platform),
		run: spawnCommand,
	};
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Show a path with the home directory as `~`. */
export function displayPath(path: string, home: string): string {
	if (path === home) return "~";
	const rel = relative(home, path);
	if (rel && !rel.startsWith("..") && !rel.startsWith(sep) && rel !== path) {
		return `~/${rel.split(sep).join("/")}`;
	}
	return path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function quoteArg(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Human form of an argv, with the binary shown by its bare name. */
export function formatCommand(bin: string, args: readonly string[]): string {
	return [bin, ...args].map(quoteArg).join(" ");
}

/** Node refuses to spawn `.cmd` / `.bat` shims without a shell. */
function isWindowsShim(path: string): boolean {
	return /\.(cmd|bat|ps1)$/i.test(path);
}

/** Realpath of the nearest existing ancestor plus the rest, for de-duplication. */
function canonicalPath(path: string): string {
	let existing = path;
	const rest: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return path;
		rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
		existing = parent;
	}
	try {
		return join(realpathSync(existing), ...rest);
	} catch {
		return path;
	}
}

/**
 * A stable identity for an MCP entry across the spellings agents use:
 * `url` / `serverUrl` / `httpUrl` for remote servers, `command` (+ `args`, or
 * OpenCode's command array) for stdio. Returns null when neither is present.
 */
export function mcpEntrySignature(entry: unknown): string | null {
	if (!isPlainObject(entry)) return null;
	const url = entry.httpUrl ?? entry.serverUrl ?? entry.url;
	if (typeof url === "string") {
		const transport = entry.type === "sse" ? "sse" : "remote";
		return `${transport} ${url.replace(/\/+$/, "")}`;
	}
	const command = entry.command;
	let argv: string[] | null = null;
	if (Array.isArray(command)) {
		argv = command.map(String);
	} else if (typeof command === "string") {
		const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
		argv = [command, ...args];
	}
	return argv ? `stdio ${JSON.stringify(argv)}` : null;
}

/** Whether an existing `tarout` entry actually points at Tarout. */
export function looksLikeTaroutEntry(entry: unknown): boolean {
	return /tarout/i.test(JSON.stringify(entry ?? null));
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * Find the packaged `skills/` directory by walking up from this module. The
 * build emits chunks in both `dist/` and `dist/mcp/`, and tests run from
 * `src/lib/`, so a fixed relative path would break in one of them.
 */
export function locateSkillsSource(fromUrl: string = import.meta.url): string | null {
	let dir = dirname(fileURLToPath(fromUrl));
	for (let depth = 0; depth < 5; depth++) {
		const candidate = join(dir, "skills");
		if (existsSync(join(candidate, TAROUT_SKILLS[0], "SKILL.md"))) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function frontmatterName(content: string): string | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return match?.[1]?.match(/^name:\s*["']?([^\s"']+)/m)?.[1] ?? null;
}

type SkillPlan =
	| { action: "create" | "update" }
	| { action: "unchanged" }
	| { action: "skip"; reason: string };

function planSkill(skillDir: string, skill: string, content: string): SkillPlan {
	try {
		if (existsSync(skillDir) && lstatSync(skillDir).isSymbolicLink()) {
			return {
				action: "skip",
				reason: "is a symlink, so it is managed elsewhere; left untouched",
			};
		}
		const file = join(skillDir, "SKILL.md");
		if (!existsSync(file)) return { action: "create" };
		const existing = readFileSync(file, "utf-8");
		if (existing === content) return { action: "unchanged" };
		if (frontmatterName(existing) !== skill) {
			return {
				action: "skip",
				reason: "holds a different skill with the same folder name; left untouched",
			};
		}
		return { action: "update" };
	} catch (err) {
		return { action: "skip", reason: errorMessage(err) };
	}
}

// ---------------------------------------------------------------------------
// MCP: JSON config files
// ---------------------------------------------------------------------------

interface JsonMergePlan {
	file: string;
	action: "create" | "update" | "unchanged" | "skip" | "snippet";
	before?: unknown;
	after: Record<string, unknown>;
	nextText?: string;
	snippet: string;
	reason?: string;
}

function jsonSnippet(key: string, entry: Record<string, unknown>): string {
	return JSON.stringify({ [key]: { [MCP_SERVER_NAME]: entry } }, null, 2);
}

function planJsonMerge(
	files: string[],
	key: string,
	desired: Record<string, unknown>,
	replace: boolean,
): JsonMergePlan {
	const file = files.find((candidate) => existsSync(candidate)) ?? files[0];
	if (!file) throw new Error("target has no config file");
	const snippet = jsonSnippet(key, desired);
	const base = { file, after: desired, snippet };

	if (!existsSync(file)) {
		return {
			...base,
			action: "create",
			nextText: `${JSON.stringify({ [key]: { [MCP_SERVER_NAME]: desired } }, null, 2)}\n`,
		};
	}

	let raw: string;
	try {
		raw = readFileSync(file, "utf-8");
	} catch (err) {
		return { ...base, action: "snippet", reason: `could not read the file: ${errorMessage(err)}` };
	}

	let config: unknown;
	if (raw.trim() === "") {
		config = {};
	} else {
		try {
			config = JSON.parse(raw);
		} catch {
			return {
				...base,
				action: "snippet",
				reason:
					"the file has comments or is not strict JSON, so it was left untouched; add the entry by hand",
			};
		}
	}
	if (!isPlainObject(config)) {
		return { ...base, action: "snippet", reason: "the file is not a JSON object; left untouched" };
	}

	const servers = config[key];
	if (servers !== undefined && !isPlainObject(servers)) {
		return {
			...base,
			action: "snippet",
			reason: `"${key}" is not an object; left untouched`,
		};
	}
	const container: Record<string, unknown> = servers ?? {};
	const existing = container[MCP_SERVER_NAME];

	let action: "create" | "update";
	if (existing === undefined) {
		action = "create";
	} else if (mcpEntrySignature(existing) === mcpEntrySignature(desired)) {
		return { ...base, action: "unchanged", before: existing };
	} else if (!looksLikeTaroutEntry(existing)) {
		return {
			...base,
			action: "skip",
			before: existing,
			reason: `a different server is already registered as "${MCP_SERVER_NAME}"; left untouched`,
		};
	} else if (!replace) {
		return {
			...base,
			action: "skip",
			before: existing,
			reason: `the existing "${MCP_SERVER_NAME}" entry has different settings; re-run with --yes to replace it`,
		};
	} else {
		action = "update";
	}

	container[MCP_SERVER_NAME] = desired;
	config[key] = container;
	const indent = detectJsonIndent(dirname(file), raw);
	return {
		...base,
		action,
		...(existing !== undefined ? { before: existing } : {}),
		nextText: `${JSON.stringify(config, null, indent)}\n`,
	};
}

function readJsonEntry(file: string, key: string): unknown {
	const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
	const servers = parsed?.[key];
	return isPlainObject(servers) ? servers[MCP_SERVER_NAME] : undefined;
}

function runJsonTarget(
	method: Extract<AgentTarget["mcp"], { kind: "json" }>,
	io: SetupIO,
	options: SetupOptions,
): McpOutcome {
	const desired = method.entry(options.mode);
	const plan = planJsonMerge(method.files(io), method.key, desired, options.replace);
	const outcome: McpOutcome = {
		method: "json",
		status: "unchanged",
		path: plan.file,
		...(plan.before !== undefined ? { before: plan.before } : {}),
		after: plan.after,
	};

	if (plan.action === "unchanged") return outcome;
	if (plan.action === "skip") {
		return { ...outcome, status: "skipped", snippet: plan.snippet, reason: plan.reason };
	}
	if (plan.action === "snippet") {
		return { ...outcome, status: "snippet", snippet: plan.snippet, reason: plan.reason };
	}
	if (!options.apply) {
		return {
			...outcome,
			status: plan.action === "create" ? "would-register" : "would-update",
		};
	}

	try {
		mkdirSync(dirname(plan.file), { recursive: true });
		writeFileSync(plan.file, plan.nextText ?? "", "utf-8");
		// Verify against the file, not against our own write call.
		const written = readJsonEntry(plan.file, method.key);
		if (mcpEntrySignature(written) !== mcpEntrySignature(desired)) {
			throw new Error("the entry is not in the file after writing it");
		}
	} catch (err) {
		return { ...outcome, status: "error", snippet: plan.snippet, reason: errorMessage(err) };
	}
	return { ...outcome, status: plan.action === "create" ? "registered" : "updated" };
}

// ---------------------------------------------------------------------------
// MCP: Claude Code
// ---------------------------------------------------------------------------

function claudeDesiredEntry(mode: McpMode): Record<string, unknown> {
	return mode === "hosted"
		? { type: "http", url: HOSTED_MCP_URL }
		: { type: "stdio", command: LOCAL_MCP_COMMAND, args: [] };
}

function claudeAddArgs(mode: McpMode): string[] {
	return mode === "hosted"
		? ["mcp", "add", "--transport", "http", "--scope", "user", MCP_SERVER_NAME, HOSTED_MCP_URL]
		: ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", LOCAL_MCP_COMMAND];
}

const CLAUDE_REMOVE_ARGS = ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME];

/** The user-scope `tarout` entry from `.claude.json`; undefined when absent. */
function readClaudeEntry(io: SetupIO): unknown {
	const file = claudeUserConfigFile(io);
	if (!existsSync(file)) return undefined;
	const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
	const servers = parsed?.mcpServers;
	return isPlainObject(servers) ? servers[MCP_SERVER_NAME] : undefined;
}

function describeFailure(result: CommandResult): string {
	if (result.timedOut) return `timed out after ${COMMAND_TIMEOUT_MS / 1000}s`;
	if (result.error) return result.error;
	const output = `${result.stderr}\n${result.stdout}`.trim().split("\n")[0];
	return output || `exited with status ${result.status}`;
}

function succeeded(result: CommandResult): boolean {
	return result.status === 0 && !result.timedOut && !result.error;
}

function runClaudeTarget(io: SetupIO, options: SetupOptions): McpOutcome {
	const desired = claudeDesiredEntry(options.mode);
	const addArgs = claudeAddArgs(options.mode);
	const command = formatCommand("claude", addArgs);
	const bin = io.findOnPath("claude");
	const usable = bin !== null && !isWindowsShim(bin);
	const base: McpOutcome = {
		method: "claude-cli",
		status: "unchanged",
		path: claudeUserConfigFile(io),
		command,
		after: desired,
	};
	const manual = usable
		? undefined
		: bin
			? "claude is a script shim here and cannot be run without a shell; run the command yourself"
			: "the claude command is not on PATH; run the command yourself";

	let existing: unknown;
	try {
		existing = readClaudeEntry(io);
	} catch {
		// Unreadable .claude.json: let `claude mcp add` report any duplicate.
		existing = undefined;
	}

	if (existing === undefined) {
		if (!usable) return { ...base, status: "snippet", snippet: command, reason: manual };
		if (!options.apply) return { ...base, status: "would-register" };
		const result = io.run([bin, ...addArgs], COMMAND_TIMEOUT_MS);
		if (!succeeded(result)) {
			return { ...base, status: "error", snippet: command, reason: describeFailure(result) };
		}
		return verifyClaude(io, base, desired, "registered", command);
	}

	const withBefore = { ...base, before: existing };
	if (mcpEntrySignature(existing) === mcpEntrySignature(desired)) return withBefore;
	if (!looksLikeTaroutEntry(existing)) {
		return {
			...withBefore,
			status: "skipped",
			reason: `a different server is already registered as "${MCP_SERVER_NAME}" in Claude Code; left untouched`,
		};
	}
	if (!options.replace) {
		return {
			...withBefore,
			status: "skipped",
			reason: `the existing "${MCP_SERVER_NAME}" entry has different settings; re-run with --yes to replace it`,
		};
	}
	const replaceCommand = `${formatCommand("claude", CLAUDE_REMOVE_ARGS)} && ${command}`;
	if (!usable) {
		return { ...withBefore, status: "snippet", snippet: replaceCommand, reason: manual };
	}
	if (!options.apply) return { ...withBefore, status: "would-update" };

	const removed = io.run([bin, ...CLAUDE_REMOVE_ARGS], COMMAND_TIMEOUT_MS);
	if (!succeeded(removed)) {
		return {
			...withBefore,
			status: "error",
			snippet: replaceCommand,
			reason: `could not remove the old entry: ${describeFailure(removed)}`,
		};
	}
	const added = io.run([bin, ...addArgs], COMMAND_TIMEOUT_MS);
	if (!succeeded(added)) {
		// Put the previous entry back so a failed replace never leaves the
		// agent with no tarout server at all.
		const restore = io.run(
			[bin, "mcp", "add-json", "--scope", "user", MCP_SERVER_NAME, JSON.stringify(existing)],
			COMMAND_TIMEOUT_MS,
		);
		return {
			...withBefore,
			status: "error",
			snippet: replaceCommand,
			reason: `could not add the new entry (${describeFailure(added)}); ${
				succeeded(restore)
					? "the previous entry was restored"
					: `restoring the previous entry also failed: ${describeFailure(restore)}`
			}`,
		};
	}
	return verifyClaude(io, withBefore, desired, "updated", command);
}

function verifyClaude(
	io: SetupIO,
	outcome: McpOutcome,
	desired: Record<string, unknown>,
	status: "registered" | "updated",
	command: string,
): McpOutcome {
	try {
		if (mcpEntrySignature(readClaudeEntry(io)) === mcpEntrySignature(desired)) {
			return { ...outcome, status };
		}
	} catch {
		// fall through to the error below
	}
	return {
		...outcome,
		status: "error",
		snippet: command,
		reason: `claude reported success, but ${displayPath(claudeUserConfigFile(io), io.home)} has no matching "${MCP_SERVER_NAME}" entry`,
	};
}

// ---------------------------------------------------------------------------
// MCP: Codex
// ---------------------------------------------------------------------------

type CodexState =
	| { present: false }
	| { present: true; entry: Record<string, unknown> | null };

const TOML_TAROUT_TABLE =
	/^\s*\[\s*mcp_servers\s*\.\s*(?:"tarout"|'tarout'|tarout)\s*\]\s*(?:#.*)?$/;
const TOML_TAROUT_ELSEWHERE = [
	// a sub-table such as [mcp_servers.tarout.env]
	/^\s*\[\s*mcp_servers\s*\.\s*(?:"tarout"|'tarout'|tarout)\s*\./,
	// dotted keys at the root: mcp_servers.tarout.url = "..."
	/^\s*mcp_servers\s*\.\s*(?:"tarout"|'tarout'|tarout)\s*[.=]/,
];

function tomlString(value: string): string {
	return value.replace(/\\(["\\])/g, "$1");
}

/**
 * Find the `tarout` server in Codex's config.toml without a TOML parser. Reads
 * `url`, `command` and a one-line `args` from a `[mcp_servers.tarout]` table;
 * any other way of declaring it is reported as present with unknown settings.
 */
export function scanCodexToml(text: string): CodexState {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => TOML_TAROUT_TABLE.test(line));
	if (start === -1) {
		let inServersTable = false;
		for (const line of lines) {
			if (/^\s*\[/.test(line)) {
				inServersTable = /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/.test(line);
			}
			if (TOML_TAROUT_ELSEWHERE.some((pattern) => pattern.test(line))) {
				return { present: true, entry: null };
			}
			if (inServersTable && /^\s*(?:"tarout"|'tarout'|tarout)\s*[.=]/.test(line)) {
				return { present: true, entry: null };
			}
		}
		return { present: false };
	}

	const entry: Record<string, unknown> = {};
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^\s*\[/.test(line)) break;
		const str = line.match(/^\s*(url|command)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
		if (str?.[1] && str[2] !== undefined) entry[str[1]] = tomlString(str[2]);
		const args = line.match(/^\s*args\s*=\s*\[(.*)\]\s*(?:#.*)?$/);
		if (args?.[1] !== undefined) {
			entry.args = [...args[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
				tomlString(m[1] ?? ""),
			);
		}
	}
	return { present: true, entry: Object.keys(entry).length > 0 ? entry : null };
}

/** Read Codex's own view of the entry (`codex mcp get --json`). */
function codexStateFromCli(bin: string, io: SetupIO): CodexState | null {
	const result = io.run([bin, "mcp", "get", MCP_SERVER_NAME, "--json"], COMMAND_TIMEOUT_MS);
	if (succeeded(result)) {
		try {
			const parsed = JSON.parse(result.stdout) as { transport?: Record<string, unknown> };
			const transport = parsed.transport ?? {};
			if (typeof transport.url === "string") {
				return { present: true, entry: { url: transport.url } };
			}
			if (typeof transport.command === "string") {
				return {
					present: true,
					entry: {
						command: transport.command,
						args: Array.isArray(transport.args) ? transport.args : [],
					},
				};
			}
			return { present: true, entry: null };
		} catch {
			return null;
		}
	}
	if (/No MCP server named/i.test(`${result.stdout}\n${result.stderr}`)) {
		return { present: false };
	}
	return null;
}

function codexTomlTable(mode: McpMode): string {
	return mode === "hosted"
		? `[mcp_servers.${MCP_SERVER_NAME}]\nurl = "${HOSTED_MCP_URL}"\n`
		: `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${LOCAL_MCP_COMMAND}"\n`;
}

function runCodexTarget(io: SetupIO, options: SetupOptions): McpOutcome {
	const { mode } = options;
	const desired: Record<string, unknown> =
		mode === "hosted"
			? { url: HOSTED_MCP_URL }
			: { command: LOCAL_MCP_COMMAND, args: [] };
	const configFile = join(codexHome(io), "config.toml");
	const shownFile = displayPath(configFile, io.home);
	const bin = io.findOnPath("codex");
	const cli = bin !== null && !isWindowsShim(bin) ? bin : null;
	const table = codexTomlTable(mode);
	const localAddArgs = ["mcp", "add", MCP_SERVER_NAME, "--", LOCAL_MCP_COMMAND];
	const snippet =
		mode === "hosted"
			? `${table}\n# then run: codex mcp login ${MCP_SERVER_NAME}`
			: table;

	const readText = (): string | null =>
		existsSync(configFile) ? readFileSync(configFile, "utf-8") : null;
	const readState = (): CodexState =>
		(cli ? codexStateFromCli(cli, io) : null) ?? scanCodexToml(readText() ?? "");

	// `codex mcp add --url` starts an OAuth login inline and blocks until the
	// browser flow finishes (observed with Codex 0.157), so the hosted entry is
	// appended to config.toml directly: the same table `codex mcp add --url`
	// writes. The stdio add returns at once, so --local uses the CLI when it is
	// available.
	const viaCli = mode === "local" && cli !== null;
	const base: McpOutcome = {
		method: viaCli ? "codex-cli" : "codex-toml",
		status: "unchanged",
		path: configFile,
		...(viaCli ? { command: formatCommand("codex", localAddArgs) } : {}),
		after: desired,
	};

	let state: CodexState;
	try {
		state = readState();
	} catch (err) {
		return {
			...base,
			status: "snippet",
			snippet,
			reason: `could not read ${shownFile}: ${errorMessage(err)}`,
		};
	}

	/**
	 * Add the entry, then read it back the way Codex does. `snapshot` is the
	 * file as it was before this run touched it; a failed write puts it back.
	 */
	const write = (
		outcome: McpOutcome,
		status: "registered" | "updated",
		snapshot: string | null,
	): McpOutcome => {
		const restore = () => {
			try {
				if (snapshot !== null) writeFileSync(configFile, snapshot, "utf-8");
			} catch {
				// best effort; the error below still reports the failure
			}
		};
		if (viaCli && cli) {
			const added = io.run([cli, ...localAddArgs], COMMAND_TIMEOUT_MS);
			if (!succeeded(added)) {
				restore();
				return { ...outcome, status: "error", snippet, reason: describeFailure(added) };
			}
		} else {
			try {
				mkdirSync(dirname(configFile), { recursive: true });
				const current = readText() ?? "";
				const separator =
					current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
				writeFileSync(configFile, `${current}${separator}${table}`, "utf-8");
			} catch (err) {
				restore();
				return { ...outcome, status: "error", snippet, reason: errorMessage(err) };
			}
		}
		let after: CodexState | null = null;
		try {
			after = readState();
		} catch {
			after = null;
		}
		if (after?.present && mcpEntrySignature(after.entry) === mcpEntrySignature(desired)) {
			return { ...outcome, status };
		}
		restore();
		return {
			...outcome,
			status: "error",
			snippet,
			reason: `the entry could not be read back from ${shownFile}; the file was restored`,
		};
	};

	if (!state.present) {
		if (!options.apply) return { ...base, status: "would-register" };
		return write(base, "registered", readText());
	}

	const withBefore: McpOutcome = {
		...base,
		...(state.entry ? { before: state.entry } : {}),
	};
	if (state.entry === null) {
		return {
			...withBefore,
			status: "skipped",
			snippet,
			reason: `a "${MCP_SERVER_NAME}" server is declared in a form this command cannot read; left untouched`,
		};
	}
	if (mcpEntrySignature(state.entry) === mcpEntrySignature(desired)) {
		return withBefore;
	}
	if (!looksLikeTaroutEntry(state.entry)) {
		return {
			...withBefore,
			status: "skipped",
			snippet,
			reason: `a different server is already registered as "${MCP_SERVER_NAME}" in Codex; left untouched`,
		};
	}
	if (!options.replace) {
		return {
			...withBefore,
			status: "skipped",
			reason: `the existing "${MCP_SERVER_NAME}" entry has different settings; re-run with --yes to replace it`,
		};
	}
	if (!cli) {
		return {
			...withBefore,
			status: "snippet",
			snippet,
			reason: `replace the [mcp_servers.${MCP_SERVER_NAME}] table in ${shownFile} by hand (the codex command is not available to remove it)`,
		};
	}
	if (!options.apply) return { ...withBefore, status: "would-update" };

	const snapshot = readText();
	const removed = io.run([cli, "mcp", "remove", MCP_SERVER_NAME], COMMAND_TIMEOUT_MS);
	if (!succeeded(removed)) {
		return {
			...withBefore,
			status: "error",
			snippet,
			reason: `could not remove the old entry: ${describeFailure(removed)}`,
		};
	}
	return write(withBefore, "updated", snapshot);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function outcomeMethod(method: NonNullable<AgentTarget["mcp"]>): McpOutcome["method"] {
	if (method.kind === "claude-cli") return "claude-cli";
	if (method.kind === "codex") return "codex-toml";
	return "json";
}

function detect(target: AgentTarget, io: SetupIO): string | null {
	for (const dir of target.detectDirs(io)) {
		try {
			if (existsSync(dir) && statSync(dir).isDirectory()) {
				return displayPath(dir, io.home);
			}
		} catch {
			// unreadable: treat as absent
		}
	}
	for (const bin of target.detectBins ?? []) {
		if (io.findOnPath(bin)) return `${bin} on PATH`;
	}
	return null;
}

function readSkillSources(source: string): Map<string, string> {
	const contents = new Map<string, string>();
	for (const skill of TAROUT_SKILLS) {
		contents.set(skill, readFileSync(join(source, skill, "SKILL.md"), "utf-8"));
	}
	return contents;
}

/**
 * Plan (apply: false) or perform (apply: true) the setup for every selected
 * target. Never throws for a single target's failure: it lands in that
 * target's `errors` and the rest continue.
 */
export function runAgentSetup(options: SetupOptions, io: SetupIO): SetupReport {
	const notes: string[] = [];
	const selected = AGENT_TARGETS.filter(
		(target) => !options.agents || options.agents.includes(target.id),
	);

	let skillContents: Map<string, string> | null = null;
	if (options.skills) {
		const source = options.skillsSource ?? locateSkillsSource();
		if (!source) {
			notes.push("The packaged skills were not found; skills were not installed.");
		} else {
			try {
				skillContents = readSkillSources(source);
			} catch (err) {
				notes.push(`The packaged skills could not be read (${errorMessage(err)}); skills were not installed.`);
			}
		}
	}

	// One write per skill directory, even when several agents share it.
	const skillResults = new Map<string, SkillOutcome>();

	const targets: TargetOutcome[] = selected.map((target) => {
		const detectedBy = detect(target, io);
		const outcome: TargetOutcome = {
			id: target.id,
			name: target.name,
			detected: detectedBy !== null,
			...(detectedBy ? { detectedBy } : {}),
			skills: [],
			mcp: null,
			nextSteps: [],
			errors: [],
		};
		if (!detectedBy) return outcome;

		if (skillContents && target.skillsDir) {
			const skillsDir = target.skillsDir(io);
			const skipReason = target.skipSkills?.(io) ?? null;
			for (const [skill, content] of skillContents) {
				const skillDir = join(skillsDir, skill);
				const path = join(skillDir, "SKILL.md");
				if (skipReason) {
					outcome.skills.push({ skill, path, status: "skipped", reason: skipReason });
					continue;
				}
				const key = canonicalPath(path);
				const shared = skillResults.get(key);
				if (shared) {
					outcome.skills.push({ ...shared, path });
					continue;
				}
				const result = installSkill(skillDir, skill, content, options.apply);
				skillResults.set(key, result);
				outcome.skills.push(result);
			}
		}

		if (options.mcp && target.mcp) {
			const superseding = target.supersededBy
				? AGENT_TARGETS.find((other) => other.id === target.supersededBy)
				: undefined;
			if (superseding && detect(superseding, io)) {
				outcome.mcp = {
					method: outcomeMethod(target.mcp),
					status: "skipped",
					reason: `${target.name} is now ${superseding.name}, which is installed here; tarout is registered through the "${superseding.id}" target instead`,
				};
			} else {
				try {
					outcome.mcp =
						target.mcp.kind === "claude-cli"
							? runClaudeTarget(io, options)
							: target.mcp.kind === "codex"
								? runCodexTarget(io, options)
								: runJsonTarget(target.mcp, io, options);
				} catch (err) {
					outcome.mcp = {
						method: outcomeMethod(target.mcp),
						status: "error",
						reason: errorMessage(err),
					};
				}
			}
		}

		for (const skill of outcome.skills) {
			if (skill.status === "error") {
				outcome.errors.push(`${skill.skill}: ${skill.reason ?? "write failed"}`);
			}
		}
		if (outcome.mcp?.status === "error") {
			outcome.errors.push(`mcp: ${outcome.mcp.reason ?? "registration failed"}`);
		}
		const mcpActive =
			outcome.mcp !== null &&
			!["skipped", "snippet", "error"].includes(outcome.mcp.status);
		if (mcpActive) outcome.nextSteps = target.nextSteps(options.mode);
		return outcome;
	});

	if (options.mcp && options.mode === "local" && !io.findOnPath(LOCAL_MCP_COMMAND)) {
		notes.push(
			`${LOCAL_MCP_COMMAND} is not on PATH. Install the CLI globally (npm install -g @tarout/cli) so agents can start it.`,
		);
	}
	if (options.mcp && options.mode === "local") {
		notes.push(
			`${LOCAL_MCP_COMMAND} signs in with the CLI's credential: run \`tarout login\` in each project (or \`tarout login --global\` once).`,
		);
	}

	return {
		mode: options.mode,
		server: options.mode === "hosted" ? HOSTED_MCP_URL : LOCAL_MCP_COMMAND,
		applied: options.apply,
		targets,
		notes,
	};
}

function installSkill(
	skillDir: string,
	skill: string,
	content: string,
	apply: boolean,
): SkillOutcome {
	const path = join(skillDir, "SKILL.md");
	const plan = planSkill(skillDir, skill, content);
	if (plan.action === "unchanged") return { skill, path, status: "unchanged" };
	if (plan.action === "skip") return { skill, path, status: "skipped", reason: plan.reason };
	if (!apply) return { skill, path, status: "would-write", change: plan.action };
	try {
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(path, content, "utf-8");
		if (readFileSync(path, "utf-8") !== content) {
			throw new Error("the file does not match after writing it");
		}
		return { skill, path, status: "written", change: plan.action };
	} catch (err) {
		return { skill, path, status: "error", reason: errorMessage(err) };
	}
}

/** Whether a report contains anything that applying would write. */
export function hasPendingChanges(report: SetupReport): boolean {
	return report.targets.some(
		(target) =>
			target.skills.some((skill) => skill.status === "would-write") ||
			target.mcp?.status === "would-register" ||
			target.mcp?.status === "would-update",
	);
}
