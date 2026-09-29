import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const {
	COMMAND_TIMEOUT_MS,
	hasPendingChanges,
	locateSkillsSource,
	mcpEntrySignature,
	runAgentSetup,
	scanCodexToml,
} = await import("../../src/lib/agent-install");
const { HOSTED_MCP_URL, resolveTargetIds } = await import(
	"../../src/lib/agent-targets"
);

type CommandResult = {
	status: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	error?: string;
};

const SKILLS_SOURCE = join(import.meta.dir, "..", "..", "skills");
const OK: CommandResult = { status: 0, stdout: "", stderr: "", timedOut: false };

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "tarout-agent-setup-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
	const path = join(home, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

function read(rel: string): string {
	return readFileSync(join(home, rel), "utf-8");
}

function readJson(rel: string): any {
	return JSON.parse(read(rel));
}

/** Every file under HOME with its content, to prove a run wrote nothing. */
function snapshot(dir = home): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) Object.assign(out, snapshot(path));
		else out[path] = readFileSync(path, "utf-8");
	}
	return out;
}

/**
 * A stand-in for the `claude` CLI that edits `~/.claude.json` the way
 * `claude mcp add|remove|add-json --scope user` does (observed with 2.1.284).
 */
function fakeClaude(argv: readonly string[]): CommandResult {
	const file = join(home, ".claude.json");
	const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : {};
	config.mcpServers ??= {};
	const [, , verb] = argv;
	const nameIndex = argv.indexOf("user") + 1;
	const name = argv[nameIndex] as string;
	if (verb === "add") {
		if (config.mcpServers[name]) {
			return { ...OK, status: 1, stderr: `MCP server ${name} already exists in user config` };
		}
		const dashDash = argv.indexOf("--");
		config.mcpServers[name] =
			dashDash === -1
				? { type: "http", url: argv[nameIndex + 1] }
				: { type: "stdio", command: argv[dashDash + 1], args: [], env: {} };
	} else if (verb === "add-json") {
		config.mcpServers[name] = JSON.parse(argv[nameIndex + 1] as string);
	} else if (verb === "remove") {
		if (!config.mcpServers[name]) return { ...OK, status: 1, stderr: "not found" };
		delete config.mcpServers[name];
	}
	writeFileSync(file, JSON.stringify(config, null, 2));
	return OK;
}

/** A stand-in for `codex mcp get|add|remove` over `~/.codex/config.toml`. */
function fakeCodex(argv: readonly string[]): CommandResult {
	const file = join(home, ".codex", "config.toml");
	const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
	const [, , verb, name] = argv;
	const state = scanCodexToml(text);
	if (verb === "get") {
		if (!state.present) {
			return { ...OK, status: 1, stderr: `Error: No MCP server named '${name}' found.` };
		}
		const entry = state.entry ?? {};
		const transport =
			typeof entry.url === "string"
				? { type: "streamable_http", url: entry.url }
				: { type: "stdio", command: entry.command, args: entry.args ?? [] };
		return { ...OK, stdout: JSON.stringify({ name, enabled: true, transport }) };
	}
	if (verb === "remove") {
		const kept = text.replace(/\[mcp_servers\.tarout\][^[]*/g, "");
		writeFileSync(file, kept);
		return OK;
	}
	if (verb === "add") {
		// Real `codex mcp add` silently overwrites an existing entry.
		const kept = text.replace(/\[mcp_servers\.tarout\][^[]*/g, "");
		const command = argv[argv.indexOf("--") + 1];
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${kept}[mcp_servers.tarout]\ncommand = "${command}"\n`);
		return OK;
	}
	return { ...OK, status: 2, stderr: "unexpected" };
}

interface FakeOptions {
	bins?: Record<string, string>;
	run?: (argv: readonly string[]) => CommandResult | undefined;
	platform?: NodeJS.Platform;
	env?: Record<string, string>;
}

function makeIO(options: FakeOptions = {}) {
	const calls: string[][] = [];
	const timeouts: number[] = [];
	const bins = options.bins ?? {};
	const io = {
		home,
		platform: options.platform ?? ("darwin" as NodeJS.Platform),
		env: options.env ?? {},
		findOnPath: (bin: string) => bins[bin] ?? null,
		run: (argv: readonly string[], timeoutMs: number): CommandResult => {
			calls.push([...argv]);
			timeouts.push(timeoutMs);
			const custom = options.run?.(argv);
			if (custom) return custom;
			if (argv[0] === bins.claude) return fakeClaude(argv);
			if (argv[0] === bins.codex) return fakeCodex(argv);
			return { ...OK, status: 127, stderr: "unknown binary" };
		},
	};
	return { io, calls, timeouts };
}

function setup(
	io: ReturnType<typeof makeIO>["io"],
	overrides: Partial<Parameters<typeof runAgentSetup>[0]> = {},
) {
	return runAgentSetup(
		{
			mode: "hosted",
			skills: true,
			mcp: true,
			replace: false,
			apply: true,
			skillsSource: SKILLS_SOURCE,
			...overrides,
		},
		io,
	);
}

function target(report: ReturnType<typeof runAgentSetup>, id: string) {
	const found = report.targets.find((t) => t.id === id);
	if (!found) throw new Error(`no target ${id}`);
	return found;
}

describe("detection", () => {
	it("touches only agents whose config dir exists (or whose CLI is on PATH)", () => {
		mkdirSync(join(home, ".cursor"));
		const { io } = makeIO({ bins: { claude: "/fake/bin/claude" } });

		const report = setup(io, { apply: false });

		expect(target(report, "cursor").detected).toBe(true);
		expect(target(report, "cursor").detectedBy).toBe("~/.cursor");
		expect(target(report, "claude").detected).toBe(true);
		expect(target(report, "claude").detectedBy).toBe("claude on PATH");
		for (const id of ["codex", "vscode", "devin", "windsurf", "opencode", "gemini", "agents"]) {
			const t = target(report, id);
			expect(t.detected).toBe(false);
			expect(t.skills).toEqual([]);
			expect(t.mcp).toBeNull();
		}
	});

	it("reports nothing to do on a machine with no agents", () => {
		const { io } = makeIO();
		const report = setup(io, { apply: false });
		expect(report.targets.every((t) => !t.detected)).toBe(true);
		expect(hasPendingChanges(report)).toBe(false);
	});

	it("uses the VS Code user dir for the platform", () => {
		mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
		const { io } = makeIO({ platform: "linux" });
		setup(io);
		expect(readJson(".config/Code/User/mcp.json").servers.tarout).toEqual({
			type: "http",
			url: HOSTED_MCP_URL,
		});
	});

	it("uses %APPDATA% for VS Code on Windows", () => {
		const appData = join(home, "AppData", "Roaming");
		mkdirSync(join(appData, "Code", "User"), { recursive: true });
		const { io } = makeIO({ platform: "win32", env: { APPDATA: appData } });
		const report = setup(io, { apply: false });
		expect(target(report, "vscode").mcp?.path).toBe(
			join(appData, "Code", "User", "mcp.json"),
		);
	});

	it("resolves --agents names and aliases, and flags unknown ones", () => {
		expect(resolveTargetIds(["claude-code", "Copilot", "cursor", "cursor"])).toEqual({
			ids: ["claude", "vscode", "cursor"],
			unknown: [],
		});
		expect(resolveTargetIds(["nope"]).unknown).toEqual(["nope"]);
	});

	it("restricts the run to --agents", () => {
		mkdirSync(join(home, ".cursor"));
		mkdirSync(join(home, ".gemini"));
		const { io } = makeIO();
		const report = setup(io, { agents: ["gemini"] });
		expect(report.targets.map((t) => t.id)).toEqual(["gemini"]);
		expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
	});
});

describe("dry run", () => {
	it("writes nothing and runs no mutating command", () => {
		mkdirSync(join(home, ".cursor"));
		mkdirSync(join(home, ".gemini"));
		mkdirSync(join(home, ".codex"));
		write(".cursor/mcp.json", '{"mcpServers":{"other":{"command":"x"}}}');
		const before = snapshot();
		const { io, calls } = makeIO({
			bins: { claude: "/fake/bin/claude", codex: "/fake/bin/codex" },
		});

		const report = setup(io, { apply: false });

		expect(snapshot()).toEqual(before);
		// Only the read-only `codex mcp get` may run while planning.
		expect(calls).toEqual([["/fake/bin/codex", "mcp", "get", "tarout", "--json"]]);
		expect(hasPendingChanges(report)).toBe(true);
		expect(target(report, "cursor").mcp?.status).toBe("would-register");
		expect(target(report, "claude").mcp?.status).toBe("would-register");
		expect(target(report, "codex").mcp?.status).toBe("would-register");
		expect(target(report, "cursor").skills.map((s) => s.status)).toEqual([
			"would-write",
			"would-write",
		]);
		expect(report.applied).toBe(false);
	});
});

describe("skills", () => {
	it("writes both skills to ~/.claude/skills and the shared ~/.agents/skills", () => {
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".cursor"));
		const { io } = makeIO();

		const report = setup(io, { mcp: false });

		for (const skill of ["tarout-deploy", "tarout-domains"]) {
			const source = readFileSync(join(SKILLS_SOURCE, skill, "SKILL.md"), "utf-8");
			expect(read(`.claude/skills/${skill}/SKILL.md`)).toBe(source);
			expect(read(`.agents/skills/${skill}/SKILL.md`)).toBe(source);
		}
		expect(target(report, "claude").skills.map((s) => s.status)).toEqual([
			"written",
			"written",
		]);
		expect(target(report, "cursor").mcp).toBeNull();
	});

	it("is idempotent: a second run reports unchanged", () => {
		mkdirSync(join(home, ".claude"));
		mkdirSync(join(home, ".gemini"));
		const { io } = makeIO();
		setup(io, { mcp: false });

		const again = setup(io, { mcp: false });

		for (const t of again.targets.filter((x) => x.detected)) {
			expect(t.skills.every((s) => s.status === "unchanged")).toBe(true);
		}
		expect(hasPendingChanges(setup(io, { mcp: false, apply: false }))).toBe(false);
	});

	it("writes a shared directory once and reports it under every agent that reads it", () => {
		for (const dir of [".cursor", ".gemini", ".codex", ".agents"]) {
			mkdirSync(join(home, dir));
		}
		const { io } = makeIO();
		const report = setup(io, { mcp: false });
		for (const id of ["codex", "cursor", "gemini", "agents"]) {
			expect(target(report, id).skills.map((s) => s.path)).toEqual([
				join(home, ".agents", "skills", "tarout-deploy", "SKILL.md"),
				join(home, ".agents", "skills", "tarout-domains", "SKILL.md"),
			]);
			expect(target(report, id).skills.every((s) => s.status === "written")).toBe(true);
		}
	});

	it("updates an older Tarout skill but never a different skill in the same folder", () => {
		mkdirSync(join(home, ".claude"));
		write(".claude/skills/tarout-deploy/SKILL.md", "---\nname: tarout-deploy\n---\nold\n");
		write(".claude/skills/tarout-domains/SKILL.md", "---\nname: someone-else\n---\nmine\n");
		const { io } = makeIO();

		const report = setup(io, { mcp: false });

		const [deploy, domains] = target(report, "claude").skills;
		expect(deploy?.status).toBe("written");
		expect(deploy?.change).toBe("update");
		expect(domains?.status).toBe("skipped");
		expect(read(".claude/skills/tarout-domains/SKILL.md")).toContain("mine");
	});

	it("leaves a symlinked skill folder alone", () => {
		mkdirSync(join(home, ".claude", "skills"), { recursive: true });
		const elsewhere = join(home, "checkout", "tarout-deploy");
		mkdirSync(elsewhere, { recursive: true });
		symlinkSync(elsewhere, join(home, ".claude", "skills", "tarout-deploy"));
		const { io } = makeIO();

		const report = setup(io, { mcp: false });

		expect(target(report, "claude").skills[0]?.status).toBe("skipped");
		expect(existsSync(join(elsewhere, "SKILL.md"))).toBe(false);
	});

	it("skips Claude Code skills when the Tarout plugin already provides them", () => {
		write(
			".claude/plugins/installed_plugins.json",
			JSON.stringify({ version: 2, plugins: { "tarout@tarout": [] } }),
		);
		const { io } = makeIO();
		const report = setup(io, { mcp: false });
		expect(target(report, "claude").skills.map((s) => s.status)).toEqual([
			"skipped",
			"skipped",
		]);
		expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
	});

	it("finds the packaged skills relative to the module", () => {
		const source = locateSkillsSource();
		expect(source).not.toBeNull();
		expect(existsSync(join(source as string, "tarout-domains", "SKILL.md"))).toBe(true);
	});
});

describe("JSON MCP configs", () => {
	it("merges into Cursor's mcp.json, keeping other servers, keys and tab indentation", () => {
		write(
			".cursor/mcp.json",
			'{\n\t"mcpServers": {\n\t\t"other": {\n\t\t\t"command": "x"\n\t\t}\n\t},\n\t"theme": "dark"\n}\n',
		);
		const { io } = makeIO();

		const report = setup(io, { skills: false });

		expect(target(report, "cursor").mcp?.status).toBe("registered");
		const text = read(".cursor/mcp.json");
		expect(text).toContain('\n\t\t"tarout": {');
		const config = JSON.parse(text);
		expect(config.mcpServers.other).toEqual({ command: "x" });
		expect(config.theme).toBe("dark");
		expect(config.mcpServers.tarout).toEqual({ url: HOSTED_MCP_URL });
		expect(Object.keys(config)).toEqual(["mcpServers", "theme"]);
	});

	it("writes each agent's own shape", () => {
		for (const dir of [
			".cursor",
			"Library/Application Support/Code/User",
			".config/devin",
			".config/opencode",
			".gemini",
		]) {
			mkdirSync(join(home, dir), { recursive: true });
		}
		write(".gemini/settings.json", '{\n  "mcpServers": {\n    "keep": {"command": "k"}\n  },\n  "ui": {"theme": "x"}\n}\n');
		write(".config/opencode/opencode.json", '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "m"\n}\n');
		const { io } = makeIO();

		setup(io, { skills: false });

		expect(readJson(".cursor/mcp.json").mcpServers.tarout).toEqual({ url: HOSTED_MCP_URL });
		expect(readJson("Library/Application Support/Code/User/mcp.json").servers.tarout).toEqual({
			type: "http",
			url: HOSTED_MCP_URL,
		});
		expect(readJson(".config/devin/mcp_config.json").mcpServers.tarout).toEqual({
			url: HOSTED_MCP_URL,
		});
		const opencode = readJson(".config/opencode/opencode.json");
		expect(opencode.mcp.tarout).toEqual({ type: "remote", url: HOSTED_MCP_URL, enabled: true });
		expect(opencode.model).toBe("m");
		const gemini = readJson(".gemini/settings.json");
		expect(gemini.mcpServers.tarout).toEqual({ httpUrl: HOSTED_MCP_URL });
		expect(gemini.mcpServers.keep).toEqual({ command: "k" });
		expect(gemini.ui).toEqual({ theme: "x" });
	});

	it("writes Windsurf's legacy file with serverUrl, unless Devin Desktop is installed", () => {
		mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
		const { io } = makeIO();
		setup(io, { skills: false });
		expect(readJson(".codeium/windsurf/mcp_config.json").mcpServers.tarout).toEqual({
			serverUrl: HOSTED_MCP_URL,
		});

		rmSync(join(home, ".codeium", "windsurf", "mcp_config.json"));
		mkdirSync(join(home, ".config", "devin"), { recursive: true });
		const report = setup(io, { skills: false });
		expect(target(report, "windsurf").mcp?.status).toBe("skipped");
		expect(existsSync(join(home, ".codeium", "windsurf", "mcp_config.json"))).toBe(false);
		expect(target(report, "devin").mcp?.status).toBe("registered");
	});

	it("prefers an existing opencode.jsonc over opencode.json", () => {
		write(".config/opencode/opencode.json", "{}\n");
		write(".config/opencode/opencode.jsonc", '{"model": "m"}\n');
		const { io } = makeIO();
		const report = setup(io, { skills: false });
		expect(target(report, "opencode").mcp?.path).toBe(
			join(home, ".config", "opencode", "opencode.jsonc"),
		);
		expect(readJson(".config/opencode/opencode.jsonc").mcp.tarout.type).toBe("remote");
		expect(read(".config/opencode/opencode.json")).toBe("{}\n");
	});

	it("falls back to a snippet for JSONC with comments and leaves the file untouched", () => {
		const original = '{\n  // my models\n  "model": "m",\n}\n';
		write(".config/opencode/opencode.jsonc", original);
		const { io } = makeIO();

		const report = setup(io, { skills: false });

		const mcp = target(report, "opencode").mcp;
		expect(mcp?.status).toBe("snippet");
		expect(mcp?.reason).toContain("comments");
		expect(JSON.parse(mcp?.snippet as string).mcp.tarout).toEqual({
			type: "remote",
			url: HOSTED_MCP_URL,
			enabled: true,
		});
		expect(read(".config/opencode/opencode.jsonc")).toBe(original);
		expect(target(report, "opencode").nextSteps).toEqual([]);
	});

	it("reports an identical entry as unchanged, whatever spelling it uses", () => {
		write(
			".gemini/settings.json",
			JSON.stringify({ mcpServers: { tarout: { url: HOSTED_MCP_URL, type: "http" } } }),
		);
		const { io } = makeIO();
		const before = read(".gemini/settings.json");
		const report = setup(io, { skills: false });
		expect(target(report, "gemini").mcp?.status).toBe("unchanged");
		expect(read(".gemini/settings.json")).toBe(before);
	});

	it("does not replace a differing tarout entry without --yes, and does with it", () => {
		write(".cursor/mcp.json", JSON.stringify({ mcpServers: { tarout: { command: "tarout-mcp" } } }));
		const { io } = makeIO();

		const withoutYes = setup(io, { skills: false });
		const skipped = target(withoutYes, "cursor").mcp;
		expect(skipped?.status).toBe("skipped");
		expect(skipped?.reason).toContain("--yes");
		expect(skipped?.before).toEqual({ command: "tarout-mcp" });
		expect(readJson(".cursor/mcp.json").mcpServers.tarout).toEqual({ command: "tarout-mcp" });

		const withYes = setup(io, { skills: false, replace: true });
		const updated = target(withYes, "cursor").mcp;
		expect(updated?.status).toBe("updated");
		expect(updated?.before).toEqual({ command: "tarout-mcp" });
		expect(updated?.after).toEqual({ url: HOSTED_MCP_URL });
		expect(readJson(".cursor/mcp.json").mcpServers.tarout).toEqual({ url: HOSTED_MCP_URL });
	});

	it("never replaces an unrelated server that happens to be named tarout", () => {
		const foreign = { mcpServers: { tarout: { url: "https://example.com/mcp" } } };
		write(".cursor/mcp.json", JSON.stringify(foreign));
		const { io } = makeIO();

		const report = setup(io, { skills: false, replace: true });

		expect(target(report, "cursor").mcp?.status).toBe("skipped");
		expect(readJson(".cursor/mcp.json")).toEqual(foreign);
	});
});

describe("--local", () => {
	it("registers the stdio tarout-mcp form in every agent", () => {
		for (const dir of [
			".cursor",
			"Library/Application Support/Code/User",
			".config/devin",
			".config/opencode",
			".gemini",
			".codeium/windsurf",
		]) {
			mkdirSync(join(home, dir), { recursive: true });
		}
		const { io, calls } = makeIO({
			bins: { claude: "/fake/bin/claude", codex: "/fake/bin/codex", "tarout-mcp": "/fake/bin/tarout-mcp" },
		});
		mkdirSync(join(home, ".codex"));

		const report = setup(io, { skills: false, mode: "local" });

		expect(report.server).toBe("tarout-mcp");
		expect(readJson(".cursor/mcp.json").mcpServers.tarout).toEqual({ command: "tarout-mcp" });
		expect(readJson("Library/Application Support/Code/User/mcp.json").servers.tarout).toEqual({
			type: "stdio",
			command: "tarout-mcp",
		});
		expect(readJson(".config/devin/mcp_config.json").mcpServers.tarout).toEqual({
			command: "tarout-mcp",
		});
		expect(readJson(".config/opencode/opencode.jsonc").mcp.tarout).toEqual({
			type: "local",
			command: ["tarout-mcp"],
			enabled: true,
		});
		expect(readJson(".gemini/settings.json").mcpServers.tarout).toEqual({ command: "tarout-mcp" });
		expect(calls).toContainEqual([
			"/fake/bin/claude",
			"mcp",
			"add",
			"--scope",
			"user",
			"tarout",
			"--",
			"tarout-mcp",
		]);
		expect(calls).toContainEqual(["/fake/bin/codex", "mcp", "add", "tarout", "--", "tarout-mcp"]);
		expect(target(report, "codex").mcp?.status).toBe("registered");
		expect(target(report, "codex").mcp?.method).toBe("codex-cli");
		expect(report.notes.some((n) => n.includes("tarout login"))).toBe(true);
	});

	it("warns when tarout-mcp is not on PATH", () => {
		mkdirSync(join(home, ".cursor"));
		const { io } = makeIO();
		const report = setup(io, { mode: "local", apply: false });
		expect(report.notes.some((n) => n.includes("not on PATH"))).toBe(true);
	});
});

describe("Claude Code (shell-out)", () => {
	const claude = "/fake/bin/claude";

	it("runs `claude mcp add` as an argv array with a timeout, then verifies the entry", () => {
		const { io, calls, timeouts } = makeIO({ bins: { claude } });

		const report = setup(io, { skills: false });

		expect(calls).toEqual([
			[claude, "mcp", "add", "--transport", "http", "--scope", "user", "tarout", HOSTED_MCP_URL],
		]);
		expect(timeouts).toEqual([COMMAND_TIMEOUT_MS]);
		const t = target(report, "claude");
		expect(t.mcp?.status).toBe("registered");
		expect(t.mcp?.command).toBe(
			`claude mcp add --transport http --scope user tarout ${HOSTED_MCP_URL}`,
		);
		expect(t.nextSteps.join(" ")).toContain("/mcp");
		expect(readJson(".claude.json").mcpServers.tarout).toEqual({ type: "http", url: HOSTED_MCP_URL });
	});

	it("reads .claude.json and runs nothing when the entry already matches", () => {
		write(".claude.json", JSON.stringify({ mcpServers: { tarout: { type: "http", url: HOSTED_MCP_URL } } }));
		const { io, calls } = makeIO({ bins: { claude } });
		const report = setup(io, { skills: false });
		expect(calls).toEqual([]);
		expect(target(report, "claude").mcp?.status).toBe("unchanged");
	});

	it("honours CLAUDE_CONFIG_DIR for .claude.json and skills", () => {
		const configDir = join(home, "alt-claude");
		mkdirSync(configDir);
		const { io } = makeIO({ env: { CLAUDE_CONFIG_DIR: configDir } });
		const report = setup(io, { apply: false });
		const t = target(report, "claude");
		expect(t.detectedBy).toBe("~/alt-claude");
		expect(t.skills[0]?.path).toBe(join(configDir, "skills", "tarout-deploy", "SKILL.md"));
		expect(t.mcp?.path).toBe(join(configDir, ".claude.json"));
	});

	it("replaces a differing entry only with --yes, via remove then add", () => {
		write(".claude.json", JSON.stringify({ mcpServers: { tarout: { type: "stdio", command: "tarout-mcp", args: [] } } }));
		const { io, calls } = makeIO({ bins: { claude } });

		expect(target(setup(io, { skills: false }), "claude").mcp?.status).toBe("skipped");
		expect(calls).toEqual([]);

		const report = setup(io, { skills: false, replace: true });
		expect(target(report, "claude").mcp?.status).toBe("updated");
		expect(calls.map((c) => c[2])).toEqual(["remove", "add"]);
		expect(readJson(".claude.json").mcpServers.tarout.url).toBe(HOSTED_MCP_URL);
	});

	it("restores the previous entry when the replacing add fails", () => {
		const old = { type: "stdio", command: "tarout-mcp", args: [] };
		write(".claude.json", JSON.stringify({ mcpServers: { tarout: old } }));
		const { io, calls } = makeIO({
			bins: { claude },
			run: (argv) =>
				argv[2] === "add" ? { ...OK, status: 1, stderr: "boom" } : undefined,
		});

		const report = setup(io, { skills: false, replace: true });

		const t = target(report, "claude");
		expect(t.mcp?.status).toBe("error");
		expect(t.mcp?.reason).toContain("restored");
		expect(calls.map((c) => c[2])).toEqual(["remove", "add", "add-json"]);
		expect(readJson(".claude.json").mcpServers.tarout).toEqual(old);
	});

	it("keeps going when claude fails or times out, and reports the error", () => {
		mkdirSync(join(home, ".cursor"));
		const { io } = makeIO({
			bins: { claude },
			run: (argv) =>
				argv[0] === claude ? { ...OK, status: null, timedOut: true, error: "spawnSync ETIMEDOUT" } : undefined,
		});

		const report = setup(io, { skills: false });

		const t = target(report, "claude");
		expect(t.mcp?.status).toBe("error");
		expect(t.errors[0]).toContain("timed out");
		expect(t.nextSteps).toEqual([]);
		expect(target(report, "cursor").mcp?.status).toBe("registered");
	});

	it("prints the command when claude is not runnable (not on PATH, or a Windows .cmd shim)", () => {
		mkdirSync(join(home, ".claude"));
		const { io, calls } = makeIO();
		const report = setup(io, { skills: false });
		expect(target(report, "claude").mcp?.status).toBe("snippet");
		expect(target(report, "claude").mcp?.snippet).toContain("claude mcp add");
		expect(calls).toEqual([]);

		const shim = makeIO({ bins: { claude: "C:\\npm\\claude.cmd" }, platform: "win32" });
		const shimReport = setup(shim.io, { skills: false });
		expect(target(shimReport, "claude").mcp?.status).toBe("snippet");
		expect(shim.calls).toEqual([]);
	});
});

describe("Codex", () => {
	const codex = "/fake/bin/codex";

	it("appends the hosted table to config.toml instead of `codex mcp add --url` (which blocks on OAuth)", () => {
		write(".codex/config.toml", 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n');
		const { io, calls } = makeIO({ bins: { codex } });

		const report = setup(io, { skills: false });

		const t = target(report, "codex");
		expect(t.mcp?.status).toBe("registered");
		expect(t.mcp?.method).toBe("codex-toml");
		expect(read(".codex/config.toml")).toBe(
			`model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.tarout]\nurl = "${HOSTED_MCP_URL}"\n`,
		);
		expect(calls.every((c) => c[2] === "get")).toBe(true);
		expect(t.nextSteps).toEqual(["Run `codex mcp login tarout` to sign in"]);

		const again = setup(io, { skills: false });
		expect(target(again, "codex").mcp?.status).toBe("unchanged");
	});

	it("works without the codex binary by reading config.toml directly", () => {
		mkdirSync(join(home, ".codex"));
		const { io, calls } = makeIO();
		const report = setup(io, { skills: false });
		expect(target(report, "codex").mcp?.status).toBe("registered");
		expect(calls).toEqual([]);
		expect(scanCodexToml(read(".codex/config.toml"))).toEqual({
			present: true,
			entry: { url: HOSTED_MCP_URL },
		});
	});

	it("falls back to reading the file when `codex mcp get` times out", () => {
		write(".codex/config.toml", `[mcp_servers.tarout]\nurl = "${HOSTED_MCP_URL}"\n`);
		const { io } = makeIO({
			bins: { codex },
			run: () => ({ ...OK, status: null, timedOut: true }),
		});
		expect(target(setup(io, { skills: false }), "codex").mcp?.status).toBe("unchanged");
	});

	it("replaces a differing Tarout entry only with --yes", () => {
		write(".codex/config.toml", '[mcp_servers.tarout]\ncommand = "tarout-mcp"\n');
		const { io, calls } = makeIO({ bins: { codex } });

		expect(target(setup(io, { skills: false }), "codex").mcp?.status).toBe("skipped");
		expect(read(".codex/config.toml")).toBe('[mcp_servers.tarout]\ncommand = "tarout-mcp"\n');

		const report = setup(io, { skills: false, replace: true });
		expect(target(report, "codex").mcp?.status).toBe("updated");
		expect(calls.some((c) => c[2] === "remove")).toBe(true);
		expect(scanCodexToml(read(".codex/config.toml"))).toEqual({
			present: true,
			entry: { url: HOSTED_MCP_URL },
		});
	});

	it("restores config.toml when Codex cannot read the appended table back", () => {
		const original = 'model = "gpt-5"\n';
		write(".codex/config.toml", original);
		const { io } = makeIO({
			bins: { codex },
			run: (argv) =>
				argv[2] === "get" ? { ...OK, status: 1, stderr: "Error: No MCP server named 'tarout' found." } : undefined,
		});

		const report = setup(io, { skills: false });

		expect(target(report, "codex").mcp?.status).toBe("error");
		expect(read(".codex/config.toml")).toBe(original);
	});

	it("never replaces an unrelated server named tarout", () => {
		write(".codex/config.toml", '[mcp_servers.tarout]\nurl = "https://example.com/mcp"\n');
		const { io } = makeIO({ bins: { codex } });
		const report = setup(io, { skills: false, replace: true });
		expect(target(report, "codex").mcp?.status).toBe("skipped");
		expect(read(".codex/config.toml")).toContain("example.com");
	});
});

describe("scanCodexToml", () => {
	it("reads a [mcp_servers.tarout] table", () => {
		expect(
			scanCodexToml('[mcp_servers.tarout]\ncommand = "tarout-mcp"\nargs = ["--x", "y"]\n\n[other]\nurl = "no"\n'),
		).toEqual({ present: true, entry: { command: "tarout-mcp", args: ["--x", "y"] } });
	});

	it("detects other ways of declaring it without claiming to know the settings", () => {
		expect(scanCodexToml("[mcp_servers]\ntarout = { url = \"u\" }\n")).toEqual({ present: true, entry: null });
		expect(scanCodexToml('mcp_servers.tarout.url = "u"\n')).toEqual({ present: true, entry: null });
		expect(scanCodexToml('[mcp_servers.tarout.env]\nA = "b"\n')).toEqual({ present: true, entry: null });
		expect(scanCodexToml('[mcp_servers.taroutx]\nurl = "u"\n')).toEqual({ present: false });
		expect(scanCodexToml("")).toEqual({ present: false });
	});
});

describe("report shape", () => {
	it("carries per-target detected, skills, mcp, nextSteps and errors", () => {
		mkdirSync(join(home, ".cursor"));
		const { io } = makeIO();
		const report = JSON.parse(JSON.stringify(setup(io)));

		expect(Object.keys(report).sort()).toEqual(["applied", "mode", "notes", "server", "targets"]);
		expect(report.mode).toBe("hosted");
		expect(report.server).toBe(HOSTED_MCP_URL);
		expect(report.applied).toBe(true);
		const cursor = report.targets.find((t: { id: string }) => t.id === "cursor");
		expect(Object.keys(cursor).sort()).toEqual([
			"detected",
			"detectedBy",
			"errors",
			"id",
			"mcp",
			"name",
			"nextSteps",
			"skills",
		]);
		expect(cursor.skills[0]).toEqual({
			skill: "tarout-deploy",
			path: join(home, ".agents", "skills", "tarout-deploy", "SKILL.md"),
			status: "written",
			change: "create",
		});
		expect(cursor.mcp).toEqual({
			method: "json",
			status: "registered",
			path: join(home, ".cursor", "mcp.json"),
			after: { url: HOSTED_MCP_URL },
		});
		expect(cursor.errors).toEqual([]);
	});

	it("treats the url spellings as one signature", () => {
		expect(mcpEntrySignature({ httpUrl: "https://a/" })).toBe(mcpEntrySignature({ url: "https://a", type: "http" }));
		expect(mcpEntrySignature({ command: ["tarout-mcp"] })).toBe(mcpEntrySignature({ command: "tarout-mcp", args: [] }));
		expect(mcpEntrySignature({ url: "https://a", type: "sse" })).not.toBe(mcpEntrySignature({ url: "https://a" }));
	});
});
