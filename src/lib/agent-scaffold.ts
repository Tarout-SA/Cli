/**
 * @fileoverview Engine for `tarout agent init` — scaffolds AI-agent config into
 * a user's project so a coding agent can drive the Tarout CLI hands-free.
 *
 * Writes an instruction block to the agent's memory file (CLAUDE.md for Claude,
 * AGENTS.md for codex/cursor/other) and, for Claude, merges a `Bash(tarout:*)`
 * permission into `.claude/settings.local.json`. Pure file I/O, no auth/network —
 * all paths are derived from the passed `cwd` so tests can run against a temp dir.
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

Run Tarout commands with \`--json\` for machine-readable output. New apps and
databases automatically use your org's **subscribed tier** — don't pass
\`--plan free\` / \`--database-plan free\`. \`tarout login\` opens the browser for you;
the user just signs in. A \`NEEDS_UPGRADE\` error means the org is out of slots for
its tier: surface the two options (buy the add-on vs upgrade the plan) and let the
user pick — the chosen command opens the payment page and waits until it's confirmed.
Ask before destructive actions (delete, rollback, revealing secrets).
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
	permissions?: { allow?: unknown[] } & Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * True when `.claude/settings.local.json` under `cwd` already allowlists
 * `Bash(tarout:*)` — i.e. an agent can run tarout commands without per-command
 * approval. Used to decide whether onboarding still needs `tarout agent init`.
 */
export function hasTaroutAllowlist(cwd: string): boolean {
	const settingsPath = join(cwd, ".claude", "settings.local.json");
	if (!existsSync(settingsPath)) return false;
	try {
		const settings = JSON.parse(
			readFileSync(settingsPath, "utf-8"),
		) as ClaudeSettings;
		const allow = settings?.permissions?.allow;
		return Array.isArray(allow) && allow.includes(TAROUT_ALLOW_ENTRY);
	} catch {
		return false;
	}
}

/**
 * Ensure `.claude/settings.local.json` allows `Bash(tarout:*)`. Merges into any
 * existing file (preserving other keys and allow entries) and never destroys a
 * file whose JSON can't be parsed — that case returns "skipped" with a reason.
 */
export function mergeClaudeSettings(claudeDir: string): ScaffoldedFile {
	const settingsPath = join(claudeDir, "settings.local.json");
	const relPath = join(".claude", "settings.local.json");

	if (!existsSync(settingsPath)) {
		mkdirSync(claudeDir, { recursive: true });
		const settings: ClaudeSettings = {
			permissions: { allow: [TAROUT_ALLOW_ENTRY] },
		};
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
		return { path: relPath, action: "created" };
	}

	let settings: ClaudeSettings;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as ClaudeSettings;
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

	const permissions = (settings.permissions ??= {});
	const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
	if (allow.includes(TAROUT_ALLOW_ENTRY)) {
		return { path: relPath, action: "unchanged" };
	}

	permissions.allow = [...allow, TAROUT_ALLOW_ENTRY];
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	return { path: relPath, action: "updated" };
}

/**
 * Scaffold agent config for the given agent type into `cwd`. Always writes the
 * markdown memory file; for Claude it also merges the permission allowlist.
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
