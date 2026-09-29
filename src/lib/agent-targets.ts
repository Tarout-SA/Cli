/**
 * @fileoverview The coding agents `tarout agent setup` knows how to configure:
 * where each one keeps user-level (global) skills, and how it registers an MCP
 * server. Pure data plus path helpers; the engine that reads and writes these
 * locations lives in `agent-install.ts`.
 *
 * Every path and config shape here was checked against the vendor's own docs
 * or source on 2026-09-29 (URLs in `sources`). Where a vendor documents more
 * than one skill directory, the target points at the shared `~/.agents/skills`
 * whenever the agent is documented to read it, so one copy serves several
 * agents instead of the same skill showing up twice. Claude Code does not read
 * `~/.agents/skills`, and Codex, Cursor, VS Code, Devin, OpenCode and Gemini do
 * not all read `~/.claude/skills`, so those are the two directories ever
 * written. Agents that read both (Cursor, VS Code, OpenCode) will list each
 * Tarout skill twice when Claude Code is also set up; that is unavoidable
 * without leaving one of the two agents without the skill.
 * @module lib/agent-targets
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Hosted Tarout MCP endpoint: Streamable HTTP, OAuth 2.1 with DCR + PKCE. */
export const HOSTED_MCP_URL = "https://tarout.sa/api/mcp";

/** The local stdio server shipped as a bin of this package. */
export const LOCAL_MCP_COMMAND = "tarout-mcp";

/** Name the server is registered under in every agent. */
export const MCP_SERVER_NAME = "tarout";

/** Skills vendored in `cli/skills/` from the Tarout-SA/skills plugin. */
export const TAROUT_SKILLS = ["tarout-deploy", "tarout-domains"] as const;

export type TaroutSkill = (typeof TAROUT_SKILLS)[number];

/** `hosted` registers the OAuth URL (default); `local` registers `tarout-mcp`. */
export type McpMode = "hosted" | "local";

/** The machine being configured. Injected so tests can run on a temp HOME. */
export interface SetupHost {
	home: string;
	platform: NodeJS.Platform;
	env: Readonly<Record<string, string | undefined>>;
}

export type AgentTargetId =
	| "claude"
	| "codex"
	| "cursor"
	| "vscode"
	| "devin"
	| "windsurf"
	| "opencode"
	| "gemini"
	| "agents";

export type McpMethod =
	/** `claude mcp add --scope user`, state read from `.claude.json`. */
	| { kind: "claude-cli" }
	/** `~/.codex/config.toml`, via `codex mcp` where that returns promptly. */
	| { kind: "codex" }
	/** A JSON file with a server map under `key`. */
	| {
			kind: "json";
			/**
			 * Candidate files, most preferred first. The first that exists is
			 * edited; when none exists the first is created.
			 */
			files: (host: SetupHost) => string[];
			key: string;
			entry: (mode: McpMode) => Record<string, unknown>;
	  };

export interface AgentTarget {
	id: AgentTargetId;
	name: string;
	/** Directories whose existence means the agent is installed. */
	detectDirs: (host: SetupHost) => string[];
	/** Binaries on PATH that also count as the agent being installed. */
	detectBins?: readonly string[];
	/** Directory that receives `<skill>/SKILL.md`; null means no skills. */
	skillsDir: ((host: SetupHost) => string) | null;
	/** A reason to leave the skills out on this machine, or null. */
	skipSkills?: (host: SetupHost) => string | null;
	mcp: McpMethod | null;
	/**
	 * When this other target is detected, skip this target's MCP entry: the
	 * other one is the same product under its new name, and registering in
	 * both places would give the agent two servers called `tarout`.
	 */
	supersededBy?: AgentTargetId;
	nextSteps: (mode: McpMode) => string[];
	/** Where the encoded facts were verified. */
	sources: readonly string[];
}

/** `~/.claude`, or `$CLAUDE_CONFIG_DIR`, which moves every `~/.claude` path. */
export function claudeConfigDir(host: SetupHost): string {
	return host.env.CLAUDE_CONFIG_DIR || join(host.home, ".claude");
}

/**
 * Where Claude Code keeps user-scoped MCP servers (top-level `mcpServers`).
 * Observed with Claude Code 2.1.284: `claude mcp add --scope user` writes
 * `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set.
 */
export function claudeUserConfigFile(host: SetupHost): string {
	return host.env.CLAUDE_CONFIG_DIR
		? join(host.env.CLAUDE_CONFIG_DIR, ".claude.json")
		: join(host.home, ".claude.json");
}

/** `$CODEX_HOME` (defaults to `~/.codex`). */
export function codexHome(host: SetupHost): string {
	return host.env.CODEX_HOME || join(host.home, ".codex");
}

/** The shared user skills directory several agents read. */
export function sharedSkillsDir(host: SetupHost): string {
	return join(host.home, ".agents", "skills");
}

/** VS Code's default-profile user directory (settings.json lives here). */
export function vscodeUserDir(host: SetupHost): string {
	if (host.platform === "darwin") {
		return join(host.home, "Library", "Application Support", "Code", "User");
	}
	if (host.platform === "win32") {
		const appData =
			host.env.APPDATA || join(host.home, "AppData", "Roaming");
		return join(appData, "Code", "User");
	}
	return join(host.home, ".config", "Code", "User");
}

/** Devin Desktop / Devin CLI user config directory. */
export function devinConfigDir(host: SetupHost): string {
	if (host.platform === "win32") {
		const appData =
			host.env.APPDATA || join(host.home, "AppData", "Roaming");
		return join(appData, "devin");
	}
	return join(host.home, ".config", "devin");
}

/**
 * True when the Tarout Claude Code plugin (`claude plugin install
 * tarout@tarout`) is installed. It already ships both skills as
 * `tarout:tarout-deploy` / `tarout:tarout-domains`, so personal copies would
 * load every skill twice. Reads Claude Code's plugin registry; an unreadable
 * or missing registry means "not installed".
 */
function hasTaroutClaudePlugin(host: SetupHost): boolean {
	try {
		const path = join(claudeConfigDir(host), "plugins", "installed_plugins.json");
		if (!existsSync(path)) return false;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			plugins?: Record<string, unknown>;
		};
		return Object.keys(parsed?.plugins ?? {}).some((key) =>
			key.startsWith("tarout@"),
		);
	} catch {
		return false;
	}
}

export const AGENT_TARGETS: readonly AgentTarget[] = [
	{
		id: "claude",
		name: "Claude Code",
		detectDirs: (host) => [claudeConfigDir(host)],
		detectBins: ["claude"],
		// Personal skills: ~/.claude/skills/<name>/SKILL.md. Claude Code does not
		// read ~/.agents/skills.
		skillsDir: (host) => join(claudeConfigDir(host), "skills"),
		skipSkills: (host) =>
			hasTaroutClaudePlugin(host)
				? "the Tarout Claude Code plugin already provides these skills"
				: null,
		mcp: { kind: "claude-cli" },
		nextSteps: (mode) =>
			mode === "hosted"
				? ["In Claude Code, run /mcp and authorize tarout (a browser opens to sign in)"]
				: ["Start a new Claude Code session so it picks up tarout"],
		sources: [
			"https://code.claude.com/docs/en/skills",
			"https://code.claude.com/docs/en/mcp",
			"https://code.claude.com/docs/en/claude-directory",
		],
	},
	{
		id: "codex",
		name: "Codex",
		detectDirs: (host) => [codexHome(host)],
		detectBins: ["codex"],
		// Codex reads user skills from $HOME/.agents/skills; $CODEX_HOME/skills
		// is the deprecated location, kept only for backward compatibility.
		skillsDir: sharedSkillsDir,
		mcp: { kind: "codex" },
		nextSteps: (mode) =>
			mode === "hosted"
				? ["Run `codex mcp login tarout` to sign in"]
				: ["Restart Codex so it picks up tarout"],
		sources: [
			"https://learn.chatgpt.com/docs/build-skills",
			"https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
			"https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs",
		],
	},
	{
		id: "cursor",
		name: "Cursor",
		detectDirs: (host) => [join(host.home, ".cursor")],
		// Cursor reads ~/.agents/skills, ~/.cursor/skills, ~/.claude/skills and
		// ~/.codex/skills at user level.
		skillsDir: sharedSkillsDir,
		mcp: {
			kind: "json",
			files: (host) => [join(host.home, ".cursor", "mcp.json")],
			key: "mcpServers",
			// A remote entry takes `url` and no `type`.
			entry: (mode) =>
				mode === "hosted"
					? { url: HOSTED_MCP_URL }
					: { command: LOCAL_MCP_COMMAND },
		},
		nextSteps: (mode) =>
			mode === "hosted"
				? ["Restart Cursor, then follow its sign-in prompt for tarout"]
				: ["Restart Cursor so it picks up tarout"],
		sources: [
			"https://cursor.com/docs/skills",
			"https://cursor.com/docs/mcp",
			"https://cursor.com/help/customization/mcp",
		],
	},
	{
		id: "vscode",
		name: "VS Code (GitHub Copilot)",
		detectDirs: (host) => [vscodeUserDir(host)],
		// Personal skills: ~/.copilot/skills, ~/.claude/skills, ~/.agents/skills.
		skillsDir: sharedSkillsDir,
		mcp: {
			kind: "json",
			// The default profile's mcp.json. Other profiles keep their own file
			// under User/profiles/<id>/ and are not touched.
			files: (host) => [join(vscodeUserDir(host), "mcp.json")],
			key: "servers",
			entry: (mode) =>
				mode === "hosted"
					? { type: "http", url: HOSTED_MCP_URL }
					: { type: "stdio", command: LOCAL_MCP_COMMAND },
		},
		nextSteps: (mode) =>
			mode === "hosted"
				? [
						"Open Copilot Chat in agent mode; VS Code starts tarout and opens the browser to sign in on first use",
					]
				: ["Open Copilot Chat in agent mode and trust the tarout server when asked"],
		sources: [
			"https://code.visualstudio.com/docs/agent-customization/agent-skills",
			"https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
			"https://code.visualstudio.com/docs/configure/settings",
		],
	},
	{
		id: "devin",
		name: "Devin Desktop (formerly Windsurf)",
		detectDirs: (host) => [devinConfigDir(host)],
		// Devin Desktop and Devin CLI both discover ~/.agents/skills.
		skillsDir: sharedSkillsDir,
		mcp: {
			kind: "json",
			files: (host) => [join(devinConfigDir(host), "mcp_config.json")],
			key: "mcpServers",
			// `url` is the one spelling both Cascade and Devin CLI document.
			entry: (mode) =>
				mode === "hosted"
					? { url: HOSTED_MCP_URL }
					: { command: LOCAL_MCP_COMMAND },
		},
		nextSteps: (mode) =>
			mode === "hosted"
				? ["Run `devin mcp login tarout`, or sign in when Devin first uses tarout"]
				: ["Restart Devin Desktop so it picks up tarout"],
		sources: [
			"https://docs.devin.ai/desktop/devin-desktop-faq",
			"https://docs.devin.ai/desktop/cascade/mcp",
			"https://docs.devin.ai/desktop/cascade/skills",
			"https://docs.devin.ai/cli/extensibility/mcp/configuration",
		],
	},
	{
		id: "windsurf",
		name: "Windsurf",
		detectDirs: (host) => [join(host.home, ".codeium", "windsurf")],
		// Devin Desktop (Windsurf since 2026-06-02) reads ~/.agents/skills.
		// Builds from before the rename are only documented to read
		// ~/.codeium/windsurf/skills; not written, to avoid a duplicate copy on
		// current installs.
		skillsDir: sharedSkillsDir,
		mcp: {
			kind: "json",
			files: (host) => [
				join(host.home, ".codeium", "windsurf", "mcp_config.json"),
			],
			key: "mcpServers",
			entry: (mode) =>
				mode === "hosted"
					? { serverUrl: HOSTED_MCP_URL }
					: { command: LOCAL_MCP_COMMAND },
		},
		supersededBy: "devin",
		nextSteps: (mode) =>
			mode === "hosted"
				? ["Restart Windsurf (or press refresh in its MCP panel) and sign in when prompted"]
				: ["Restart Windsurf (or press refresh in its MCP panel)"],
		sources: [
			"https://web.archive.org/web/20260401121400/https://docs.windsurf.com/windsurf/cascade/mcp",
			"https://docs.devin.ai/windsurf/plugins/cascade/mcp",
		],
	},
	{
		id: "opencode",
		name: "OpenCode",
		detectDirs: (host) => [join(host.home, ".config", "opencode")],
		// OpenCode reads ~/.config/opencode/skills, ~/.claude/skills and
		// ~/.agents/skills.
		skillsDir: sharedSkillsDir,
		mcp: {
			kind: "json",
			// OpenCode merges config.json, opencode.json, then opencode.jsonc, so
			// .jsonc wins on conflicts and is the file to edit when it exists. It
			// also creates opencode.jsonc itself on first run.
			files: (host) => [
				join(host.home, ".config", "opencode", "opencode.jsonc"),
				join(host.home, ".config", "opencode", "opencode.json"),
			],
			key: "mcp",
			entry: (mode) =>
				mode === "hosted"
					? { type: "remote", url: HOSTED_MCP_URL, enabled: true }
					: { type: "local", command: [LOCAL_MCP_COMMAND], enabled: true },
		},
		nextSteps: (mode) =>
			mode === "hosted"
				? ["Run `opencode mcp auth tarout` (OpenCode also prompts on first use)"]
				: ["Restart OpenCode so it picks up tarout"],
		sources: [
			"https://opencode.ai/docs/skills",
			"https://opencode.ai/docs/mcp-servers",
			"https://opencode.ai/docs/config",
		],
	},
	{
		id: "gemini",
		name: "Gemini CLI",
		detectDirs: (host) => [join(host.home, ".gemini")],
		// User skills: ~/.gemini/skills or the ~/.agents/skills alias.
		skillsDir: sharedSkillsDir,
		mcp: {
			kind: "json",
			files: (host) => [join(host.home, ".gemini", "settings.json")],
			key: "mcpServers",
			// `httpUrl` is what `gemini mcp add --transport http` writes on older
			// releases and still takes priority in current source (newer releases
			// also accept `url` + `type: "http"`, treated as the same entry).
			entry: (mode) =>
				mode === "hosted"
					? { httpUrl: HOSTED_MCP_URL }
					: { command: LOCAL_MCP_COMMAND },
		},
		nextSteps: (mode) =>
			mode === "hosted"
				? ["In Gemini CLI, run `/mcp auth tarout`"]
				: ["Restart Gemini CLI so it picks up tarout"],
		sources: [
			"https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md",
			"https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md",
			"https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-client.ts",
		],
	},
	{
		id: "agents",
		name: "Shared skills (~/.agents/skills)",
		detectDirs: (host) => [join(host.home, ".agents")],
		// The cross-client user directory recommended by agentskills.io.
		skillsDir: sharedSkillsDir,
		mcp: null,
		nextSteps: () => [],
		sources: ["https://agentskills.io/client-implementation/adding-skills-support"],
	},
];

/** Extra spellings accepted by `--agents`. */
const TARGET_ALIASES: Readonly<Record<string, AgentTargetId>> = {
	"claude-code": "claude",
	copilot: "vscode",
	"github-copilot": "vscode",
	"gemini-cli": "gemini",
	universal: "agents",
};

/**
 * Resolve a user-supplied `--agents` value to target ids. Returns the ids plus
 * any names that matched nothing, so the caller can report them.
 */
export function resolveTargetIds(values: readonly string[]): {
	ids: AgentTargetId[];
	unknown: string[];
} {
	const ids: AgentTargetId[] = [];
	const unknown: string[] = [];
	for (const raw of values) {
		const value = raw.trim().toLowerCase();
		if (!value) continue;
		const id =
			TARGET_ALIASES[value] ??
			AGENT_TARGETS.find((target) => target.id === value)?.id;
		if (!id) {
			unknown.push(raw.trim());
		} else if (!ids.includes(id)) {
			ids.push(id);
		}
	}
	return { ids, unknown };
}
