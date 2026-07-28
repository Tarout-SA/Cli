/**
 * `tarout agent init` — scaffold AI-agent config into the current project.
 *
 * Local-only (no auth, no network): drops a Tarout instruction block into the
 * agent's memory file (CLAUDE.md / AGENTS.md) and, for Claude, allowlists
 * `Bash(tarout:*)` in `.claude/settings.local.json` so the agent can run the
 * CLI without per-command approval prompts. Mirrors `specific init --agent`.
 */

import { resolve } from "node:path";
import type { Command } from "commander";
import { connectAgentFromHandoff } from "../lib/agent-handoff.js";
import {
	AGENT_TYPES,
	type AgentType,
	scaffoldAgentConfig,
} from "../lib/agent-scaffold.js";
import { CliError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	outputJsonLine,
	success,
	warn,
} from "../lib/output.js";
import { ExitCode } from "../utils/exit-codes.js";

interface AgentInitOptions {
	agent?: string;
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
					outputJsonLine({
						type: "result",
						ok: true,
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
							? `${label} — ${colors.dim(file.reason)}`
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
}
