/**
 * `tarout agent init`: scaffold AI-agent config into the current project.
 *
 * Local-only (no auth, no network): drops a Tarout instruction block into the
 * agent's memory file (CLAUDE.md / AGENTS.md) and, for Claude, allowlists
 * `Bash(tarout:*)` in `.claude/settings.local.json` so the agent can run the
 * CLI without per-command approval prompts. Mirrors `specific init --agent`.
 *
 * `tarout agent setup`: machine-wide. Installs the Tarout skills and registers
 * the Tarout MCP server in every coding agent found under HOME (hosted OAuth
 * endpoint by default, the local `tarout-mcp` with --local). No sign-in needed:
 * the hosted server signs in through the agent's own OAuth flow.
 */

import { resolve } from "node:path";
import type { Command } from "commander";
import { connectAgentFromHandoff } from "../lib/agent-handoff.js";
import {
	defaultSetupIO,
	displayPath,
	hasPendingChanges,
	type McpOutcome,
	runAgentSetup,
	type SetupReport,
	type SkillOutcome,
} from "../lib/agent-install.js";
import {
	AGENT_TYPES,
	type AgentType,
	scaffoldAgentConfig,
} from "../lib/agent-scaffold.js";
import {
	AGENT_TARGETS,
	type AgentTargetId,
	resolveTargetIds,
} from "../lib/agent-targets.js";
import { CliError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	shouldSkipConfirmation,
	success,
	warn,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { confirm } from "../utils/prompts.js";

interface AgentInitOptions {
	agent?: string;
}

interface AgentSetupOptions {
	local?: boolean;
	agents?: string;
	skillsOnly?: boolean;
	mcpOnly?: boolean;
	dryRun?: boolean;
}

function parseSetupAgents(value: string | undefined): AgentTargetId[] | undefined {
	if (value === undefined) return undefined;
	const { ids, unknown } = resolveTargetIds(value.split(","));
	if (unknown.length > 0 || ids.length === 0) {
		throw new CliError(
			`Unknown agent${unknown.length === 1 ? "" : "s"} "${unknown.join('", "') || value}". Use one or more of: ${AGENT_TARGETS.map((target) => target.id).join(", ")}.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	return ids;
}

type Paint = (text: string) => string;

function skillLabel(skill: SkillOutcome): [string, Paint] {
	switch (skill.status) {
		case "would-write":
			return [skill.change === "update" ? "update" : "create", colors.cyan];
		case "written":
			return [skill.change === "update" ? "updated" : "written", colors.success];
		case "unchanged":
			return ["unchanged", colors.dim];
		case "skipped":
			return ["skipped", colors.warn];
		case "error":
			return ["error", colors.error];
	}
}

function mcpLabel(mcp: McpOutcome): [string, Paint] {
	switch (mcp.status) {
		case "would-register":
			return ["register", colors.cyan];
		case "would-update":
			return ["replace", colors.cyan];
		case "registered":
			return ["registered", colors.success];
		case "updated":
			return ["replaced", colors.success];
		case "unchanged":
			return ["unchanged", colors.dim];
		case "skipped":
			return ["skipped", colors.warn];
		case "snippet":
			return ["manual", colors.warn];
		case "error":
			return ["error", colors.error];
	}
}

/** Pad before painting, so ANSI codes do not count toward the width. */
function column([text, paint]: [string, Paint]): string {
	return paint(text.padEnd(11));
}

function renderSetupReport(report: SetupReport, home: string): void {
	const server =
		report.mode === "hosted"
			? `hosted MCP ${report.server} (OAuth)`
			: `local MCP ${report.server} (stdio)`;
	log(colors.bold(`Tarout agent setup: ${server}`));
	log("");

	for (const target of report.targets.filter((t) => t.detected)) {
		log(`${colors.bold(target.name)} ${colors.dim(`(${target.detectedBy})`)}`);
		for (const skill of target.skills) {
			log(`  skill  ${column(skillLabel(skill))}${displayPath(skill.path, home)}`);
			if (skill.reason) log(`         ${colors.dim(skill.reason)}`);
		}
		const mcp = target.mcp;
		if (mcp) {
			const where = mcp.command ?? (mcp.path ? displayPath(mcp.path, home) : "");
			log(`  mcp    ${column(mcpLabel(mcp))}${where}`);
			if (mcp.status === "would-update" || mcp.status === "updated" || (mcp.status === "skipped" && mcp.before !== undefined && mcp.after !== undefined)) {
				log(colors.error(`         - "tarout": ${JSON.stringify(mcp.before)}`));
				log(colors.success(`         + "tarout": ${JSON.stringify(mcp.after)}`));
			} else if (mcp.status === "would-register") {
				log(colors.success(`         + "tarout": ${JSON.stringify(mcp.after)}`));
			}
			if (mcp.reason) log(`         ${colors.dim(mcp.reason)}`);
			if (mcp.snippet && mcp.status !== "unchanged") {
				for (const line of mcp.snippet.split("\n")) {
					log(`           ${line}`);
				}
			}
		}
	}

	const missing = report.targets.filter((t) => !t.detected).map((t) => t.name);
	if (missing.length > 0) {
		log("");
		log(colors.dim(`Not found on this machine: ${missing.join(", ")}`));
	}
	for (const note of report.notes) {
		log("");
		warn(note);
	}
	log("");
}

function renderNextSteps(report: SetupReport): void {
	const steps = report.targets.flatMap((target) =>
		target.nextSteps.map((step) => `${target.name}: ${step}`),
	);
	if (steps.length === 0) return;
	log("Next steps:");
	for (const step of steps) log(`  ${colors.dim(step)}`);
	log("");
}

function parseAgent(value: string | undefined): AgentType {
	const agent = (value ?? "claude").toLowerCase();
	if ((AGENT_TYPES as readonly string[]).includes(agent)) {
		return agent as AgentType;
	}
	throw new CliError(
		`Invalid agent "${value}". Use one of: ${AGENT_TYPES.join(", ")}.`,
		ExitCode.INVALID_ARGUMENTS,
	);
}

export function registerAgentCommands(program: Command): void {
	const agent = program
		.command("agent")
		.description("Configure coding agents to use the Tarout CLI");

	agent
		.command("connect")
		.description(
			"Connect the signed-in dashboard account and write a dynamic AI.md identity",
		)
		.requiredOption("--handoff <payload>", "Single-use dashboard handoff")
		.option("--path <directory>", "Project directory", process.cwd())
		.option(
			"--global",
			"Store the credential machine-wide instead of in this project's .tarout/auth.json",
		)
		.action(
			async (options: { handoff: string; path: string; global?: boolean }) => {
				try {
					const cwd = resolve(options.path);
					const result = await connectAgentFromHandoff(options.handoff, cwd, {
						scope: options.global ? "global" : "project",
					});

					if (isJsonMode()) {
						outputData(result);
						return;
					}

					success(
						result.reusedExistingCredential
							? "Tarout CLI was already linked to this account"
							: "Tarout CLI connected to this account",
					);
					box("Agent identity", [
						`Account: ${colors.cyan(result.identity.userEmail)}`,
						`Organization: ${colors.bold(result.identity.organizationName)}`,
						`Project: ${colors.bold(result.identity.projectName || "None")}`,
						result.scope === "project"
							? `Credential: ${colors.bold(".tarout/auth.json")} ${colors.dim("(this project only)")}`
							: `Credential: ${colors.bold("machine-wide CLI profile")}`,
						`${colors.bold(result.identityFile.action)} ${result.identityFile.path}`,
					]);
					if (result.scope === "project") {
						log(
							colors.dim(
								"This key applies only in this directory. Other projects keep their own credential.",
							),
						);
					}
					log("");
				} catch (err) {
					handleError(err);
				}
			},
		);

	agent
		.command("init")
		.argument("[path]", "Project directory (defaults to current)")
		.description(
			"Write agent instructions (CLAUDE.md/AGENTS.md) and a Bash(tarout:*) permission allowlist so a coding agent can drive Tarout",
		)
		.option(
			"--agent <type>",
			`Coding agent to configure: ${AGENT_TYPES.join(", ")}`,
			"claude",
		)
		.action(async (cwdArg: string | undefined, options: AgentInitOptions) => {
			try {
				const cwd = cwdArg ? resolve(cwdArg) : process.cwd();
				const agentType = parseAgent(options.agent);

				const result = scaffoldAgentConfig({ cwd, agent: agentType });

				if (isJsonMode()) {
					for (const file of result.files) {
						outputJsonLine({
							type: "event",
							event: "file_written",
							path: file.path,
							action: file.action,
							...(file.reason ? { reason: file.reason } : {}),
						});
					}
					// The terminal envelope must be the same `{success, data}` shape
					// every other command emits and the README documents. This used to
					// be a bespoke `{type:"result", ok:true, …}`, so an agent that
					// checked `.success` (as it does for every other Tarout command)
					// read a successful scaffold as a failure.
					outputData({
						agent: result.agent,
						files: result.files,
						nextSteps: result.nextSteps,
					});
					return;
				}

				success("Coding agents configured");
				box(
					`Agent: ${colors.cyan(result.agent)}`,
					result.files.map((file) => {
						const label = `${colors.bold(file.action)} ${file.path}`;
						return file.reason
							? `${label} (${colors.dim(file.reason)})`
							: label;
					}),
				);
				for (const file of result.files) {
					if (file.action === "skipped") {
						warn(`${file.path} was left untouched (${file.reason}).`);
					}
				}
				log("Next steps:");
				for (const step of result.nextSteps) {
					log(`  ${colors.dim(step)}`);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	agent
		.command("setup")
		.description(
			"Install the Tarout skills and register the Tarout MCP server in every coding agent on this machine (Claude Code, Codex, Cursor, VS Code, Devin/Windsurf, OpenCode, Gemini CLI)",
		)
		.option(
			"--local",
			"Register the local stdio server (tarout-mcp) instead of the hosted OAuth endpoint",
		)
		.option(
			"--agents <list>",
			`Only these agents, comma-separated: ${AGENT_TARGETS.map((target) => target.id).join(", ")}`,
		)
		.option("--skills-only", "Install the skills, skip MCP registration")
		.option("--mcp-only", "Register the MCP server, skip the skills")
		.option("--dry-run", "Show the plan and the changes, write nothing")
		.addHelpText(
			"after",
			`
Only agents already installed here are touched. Other MCP servers are never
modified, and an existing "tarout" entry with different settings is replaced
only with --yes. Re-running reports "unchanged".

  --yes     apply without the confirmation prompt (required when not on a TTY)
  --json    one machine-readable result, per agent

Examples:
  tarout agent setup                  # hosted MCP (OAuth) + skills, asks once
  tarout agent setup --dry-run        # show what would change
  tarout agent setup --local --yes    # stdio tarout-mcp, no prompt
  tarout agent setup --agents claude,cursor --mcp-only`,
		)
		.action(async (options: AgentSetupOptions) => {
			try {
				if (options.skillsOnly && options.mcpOnly) {
					throw new CliError(
						"--skills-only and --mcp-only cannot be combined.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const agents = parseSetupAgents(options.agents);
				const io = defaultSetupIO();
				const yes = shouldSkipConfirmation();
				const base = {
					mode: options.local ? ("local" as const) : ("hosted" as const),
					agents,
					skills: !options.mcpOnly,
					mcp: !options.skillsOnly,
					replace: yes,
				};

				const plan = runAgentSetup({ ...base, apply: false }, io);
				const detected = plan.targets.filter((target) => target.detected);

				if (options.dryRun) {
					if (isJsonMode()) {
						outputData({ ...plan, dryRun: true });
						return;
					}
					renderSetupReport(plan, io.home);
					log(colors.dim("Dry run: nothing was written."));
					return;
				}

				if (detected.length === 0) {
					if (isJsonMode()) {
						outputData({ ...plan, dryRun: false });
						return;
					}
					warn(
						`No supported coding agent was found under ${io.home}. Supported: ${AGENT_TARGETS.map((target) => target.name).join(", ")}.`,
					);
					return;
				}

				if (!hasPendingChanges(plan)) {
					if (isJsonMode()) {
						outputData({ ...plan, dryRun: false });
						return;
					}
					renderSetupReport(plan, io.home);
					success("Everything is already set up; nothing to change.");
					renderNextSteps(plan);
					return;
				}

				if (!yes) {
					if (!isJsonMode()) renderSetupReport(plan, io.home);
					const confirmed = await confirm("Apply these changes?", true, {
						field: "confirm_agent_setup",
						flag: "--yes",
						context: { plan: plan.targets.filter((target) => target.detected) },
					});
					if (!confirmed) {
						log("Cancelled. Nothing was written.");
						return;
					}
				}

				const result = runAgentSetup({ ...base, apply: true }, io);
				const failed = result.targets.filter((target) => target.errors.length > 0);

				if (!isJsonMode()) {
					renderSetupReport(result, io.home);
				}
				if (failed.length > 0) {
					outputError(
						"AGENT_SETUP_INCOMPLETE",
						`Setup finished with errors for ${failed.map((target) => target.name).join(", ")}; the other agents were configured.`,
						{ ...result, dryRun: false },
					);
					exit(ExitCode.GENERAL_ERROR);
				}
				if (isJsonMode()) {
					outputData({ ...result, dryRun: false });
					return;
				}
				success("Coding agents configured");
				renderNextSteps(result);
			} catch (err) {
				handleError(err);
			}
		});
}
