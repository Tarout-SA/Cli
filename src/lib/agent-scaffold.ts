/**
 * @fileoverview Engine for `tarout agent init` — scaffolds AI-agent config into
 * a user's project so a coding agent can drive the Tarout CLI hands-free.
 *
 * Writes an instruction block to the agent's memory file (CLAUDE.md for Claude,
 * AGENTS.md for codex/cursor/other) and, for Claude, merges Tarout permission
 * rules into `.claude/settings.local.json`:
 *   - an `allow` rule so read-only tarout commands run without prompts,
 *   - `ask` rules so deploys and paid/destructive commands PROMPT for in-editor
 *     approval (these run *before* the auto-mode classifier, which otherwise
 *     silently denies "production deploy" commands), and
 *   - an `autoMode` trust block so the classifier treats the user's own Tarout
 *     resources as trusted infrastructure instead of exfiltration targets.
 * Pure file I/O, no auth/network — all paths derive from the passed `cwd` so
 * tests can run against a temp dir.
 * @module lib/agent-scaffold
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AgentType = "claude" | "codex" | "cursor" | "other";

export const AGENT_TYPES: readonly AgentType[] = [
	"claude",
	"codex",
	"cursor",
	"other",
];

/** Permission entry that lets a Claude Code agent run any `tarout` subcommand. */
export const TAROUT_ALLOW_ENTRY = "Bash(tarout:*)";

/**
 * `ask` rules: commands that PROMPT for approval before running. They are
 * evaluated before the auto-mode classifier (which silently denies production
 * deploys), so they convert a silent denial into an in-editor approval prompt —
 * the command still runs in-session, the user never copy-pastes it.
 *
 * Patterns use a trailing `*` with no space (e.g. `tarout deploy*`) so they also
 * cover colon subcommands like `tarout deploy:rollback`; `Bash(tarout up:*)`
 * keeps a word boundary so it matches `tarout up` but not `update`/`upgrade`.
 */
export const TAROUT_ASK_ENTRIES: readonly string[] = [
	"Bash(tarout deploy*)",
	"Bash(tarout up:*)",
	"Bash(tarout undeploy*)",
	"Bash(tarout billing*)",
	"Bash(tarout subscription*)",
	"Bash(tarout wallet*)",
];

/**
 * `autoMode.environment` entry: tells the auto-mode classifier that the user's
 * Tarout account is trusted infrastructure, not an external destination.
 */
export const TAROUT_AUTOMODE_ENV_ENTRY =
	"This project deploys to Tarout (https://tarout.sa), the user's trusted Platform-as-a-Service. The `tarout` CLI talks to the Tarout API and manages the user's own apps, databases, storage, and domains hosted on Tarout — these are the user's own infrastructure, not external or exfiltration targets.";

/**
 * `autoMode.allow` entry: lets routine tarout management commands through the
 * classifier without a silent denial. Deploys and paid/destructive commands are
 * still gated by the `ask` rules above, which take precedence and prompt.
 */
export const TAROUT_AUTOMODE_ALLOW_ENTRY =
	"Running `tarout` CLI commands to manage the user's own apps, databases, storage, domains, and environment variables on Tarout is a routine, trusted operation on the user's own infrastructure.";

const BLOCK_BEGIN = "<!-- BEGIN TAROUT -->";
const BLOCK_END = "<!-- END TAROUT -->";

/**
 * The markdown instruction block written into CLAUDE.md / AGENTS.md. Wrapped in
 * BEGIN/END markers so re-running the command replaces the block in place rather
 * than appending a duplicate.
 */
export const TAROUT_AGENT_BLOCK = `${BLOCK_BEGIN}
## Tarout

This project deploys to [Tarout](https://tarout.sa) (PaaS). Use the **Tarout CLI**
for all deployment, database, storage, environment-variable, and domain operations —
don't hand-edit infrastructure.

- **Deploy** the current folder: \`tarout up --json --yes\` (inspects → builds → deploys;
  read the final JSON envelope's \`success\` and \`data.url\`).
- **Re-deploy** a linked app: \`tarout deploy --wait\`.
- **Run locally** with cloud env vars: \`tarout dev\`.
- **Full agent guide:** https://tarout.sa/docs/for-ai/onboarding

Run Tarout commands with \`--json\` for machine-readable output, and run them
**directly** in your shell — never print a command for the user to copy-paste, and
don't wrap them in pipes or redirects (e.g. \`2>&1\`) so approval rules match the
command. New apps and databases automatically use your org's **subscribed tier** —
don't pass \`--plan free\` / \`--database-plan free\`. \`tarout login\` opens the browser
for you; the user just signs in.

Deploys and paid or destructive commands (\`tarout deploy\`, \`tarout up\`,
\`tarout billing …\`, \`tarout undeploy\`) pop an in-editor approval prompt before they
run — this is expected. Run the command and let the user approve it in place; do
**not** fall back to asking the user to run it themselves. A \`NEEDS_UPGRADE\` error
means the org is out of slots for its tier: surface the two options (buy the add-on
vs upgrade the plan) and let the user pick — the chosen command opens the payment
page and waits until it's confirmed.
${BLOCK_END}`;

export type FileAction =
	| "created"
	| "updated"
	| "appended"
	| "unchanged"
	| "skipped";

export interface ScaffoldedFile {
	/** Path relative to the scaffold cwd (e.g. "CLAUDE.md"). */
	path: string;
	action: FileAction;
	/** Present when action is "skipped" — why the file was left untouched. */
	reason?: string;
}

export interface ScaffoldResult {
	agent: AgentType;
	files: ScaffoldedFile[];
	nextSteps: string[];
}

export interface ScaffoldOptions {
	cwd: string;
	agent: AgentType;
}

/** The agent memory file an agent type reads. */
export function markdownTargetFor(agent: AgentType): string {
	return agent === "claude" ? "CLAUDE.md" : "AGENTS.md";
}

function hasMarkers(content: string): boolean {
	return content.includes(BLOCK_BEGIN) && content.includes(BLOCK_END);
}

function replaceBlock(content: string, block: string): string {
	const begin = content.indexOf(BLOCK_BEGIN);
	const end = content.indexOf(BLOCK_END);
	if (begin === -1 || end === -1 || end < begin) return content;
	return `${content.slice(0, begin)}${block}${content.slice(end + BLOCK_END.length)}`;
}

/**
 * Create the memory file with the block, refresh an existing block in place, or
 * append the block after existing content — never clobbering user prose.
 */
export function upsertMarkdownBlock(filePath: string, block: string): FileAction {
	if (!existsSync(filePath)) {
		writeFileSync(filePath, `${block}\n`, "utf-8");
		return "created";
	}

	const existing = readFileSync(filePath, "utf-8");

	if (hasMarkers(existing)) {
		const replaced = replaceBlock(existing, block);
		if (replaced === existing) return "unchanged";
		writeFileSync(filePath, replaced, "utf-8");
		return "updated";
	}

	const separator = existing.endsWith("\n") ? "\n" : "\n\n";
	writeFileSync(filePath, `${existing}${separator}${block}\n`, "utf-8");
	return "appended";
}

interface ClaudeSettings {
	permissions?: {
		allow?: unknown[];
		ask?: unknown[];
	} & Record<string, unknown>;
	autoMode?: {
		environment?: unknown[];
		allow?: unknown[];
	} & Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * Ensure every entry in `wanted` is present in `current`, returning the merged
 * array and whether anything changed. When the array is created from scratch and
 * `prependDefaults` is set, the `$defaults` token is added first so the built-in
 * auto-mode rules are preserved (omitting it would replace the whole list). An
 * existing array is never reordered — we only append what's missing.
 */
function ensureEntries(
	current: unknown,
	wanted: readonly string[],
	prependDefaults = false,
): { next: string[]; changed: boolean } {
	const list = Array.isArray(current) ? [...(current as string[])] : [];
	let changed = false;

	if (prependDefaults && list.length === 0) {
		list.push("$defaults");
		changed = true;
	}
	for (const entry of wanted) {
		if (!list.includes(entry)) {
			list.push(entry);
			changed = true;
		}
	}
	return { next: list, changed };
}

/** Apply all Tarout allow/ask/autoMode rules to a settings object in place. */
function applyTaroutRules(settings: ClaudeSettings): boolean {
	const permissions = (settings.permissions ??= {});
	const autoMode = (settings.autoMode ??= {});

	const allow = ensureEntries(permissions.allow, [TAROUT_ALLOW_ENTRY]);
	permissions.allow = allow.next;

	const ask = ensureEntries(permissions.ask, TAROUT_ASK_ENTRIES);
	permissions.ask = ask.next;

	const env = ensureEntries(autoMode.environment, [TAROUT_AUTOMODE_ENV_ENTRY], true);
	autoMode.environment = env.next;

	const amAllow = ensureEntries(autoMode.allow, [TAROUT_AUTOMODE_ALLOW_ENTRY], true);
	autoMode.allow = amAllow.next;

	return allow.changed || ask.changed || env.changed || amAllow.changed;
}

/**
 * True when `.claude/settings.local.json` under `cwd` already carries the Tarout
 * allow rule *and* every ask rule — i.e. the agent can run tarout commands with
 * read-only ones auto-approved and deploys prompting instead of being blocked.
 * A partial (allow-only) config returns false so onboarding re-runs and upgrades
 * it. Used to decide whether onboarding still needs `tarout agent init`.
 */
export function hasTaroutAgentConfig(cwd: string): boolean {
	const settingsPath = join(cwd, ".claude", "settings.local.json");
	if (!existsSync(settingsPath)) return false;
	try {
		const settings = JSON.parse(
			readFileSync(settingsPath, "utf-8"),
		) as ClaudeSettings;
		const allow = settings?.permissions?.allow;
		const ask = settings?.permissions?.ask;
		const hasAllow =
			Array.isArray(allow) && allow.includes(TAROUT_ALLOW_ENTRY);
		const hasAsk =
			Array.isArray(ask) && TAROUT_ASK_ENTRIES.every((e) => ask.includes(e));
		return hasAllow && hasAsk;
	} catch {
		return false;
	}
}

/**
 * Ensure `.claude/settings.local.json` carries the Tarout allow/ask/autoMode
 * rules. Merges into any existing file (preserving other keys and entries) and
 * never destroys a file whose JSON can't be parsed — that case returns "skipped"
 * with a reason.
 */
export function mergeClaudeSettings(claudeDir: string): ScaffoldedFile {
	const settingsPath = join(claudeDir, "settings.local.json");
	const relPath = join(".claude", "settings.local.json");

	const exists = existsSync(settingsPath);

	let settings: ClaudeSettings = {};
	if (exists) {
		try {
			settings = JSON.parse(
				readFileSync(settingsPath, "utf-8"),
			) as ClaudeSettings;
		} catch {
			return {
				path: relPath,
				action: "skipped",
				reason: "existing settings.local.json is not valid JSON; left untouched",
			};
		}

		if (typeof settings !== "object" || settings === null) {
			return {
				path: relPath,
				action: "skipped",
				reason: "existing settings.local.json is not a JSON object; left untouched",
			};
		}
	}

	const changed = applyTaroutRules(settings);

	if (!exists) {
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
		return { path: relPath, action: "created" };
	}

	if (!changed) return { path: relPath, action: "unchanged" };

	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	return { path: relPath, action: "updated" };
}

/**
 * Scaffold agent config for the given agent type into `cwd`. Always writes the
 * markdown memory file; for Claude it also merges the permission rules.
 */
export function scaffoldAgentConfig(options: ScaffoldOptions): ScaffoldResult {
	const { cwd, agent } = options;
	const files: ScaffoldedFile[] = [];

	const mdName = markdownTargetFor(agent);
	files.push({
		path: mdName,
		action: upsertMarkdownBlock(join(cwd, mdName), TAROUT_AGENT_BLOCK),
	});

	if (agent === "claude") {
		files.push(mergeClaudeSettings(join(cwd, ".claude")));
	}

	return {
		agent,
		files,
		nextSteps: ["tarout up --json --yes"],
	};
}
