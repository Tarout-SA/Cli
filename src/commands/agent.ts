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
 *
 * `tarout agent manifest`: reads the account. Prints the active project's apps,
 * databases, buckets and domains in one call, so it takes the normal sign-in
 * and project gates (see `AGENT_GATED_LEAF`).
 *
 * `tarout agent sessions` and `tarout agent events`: also read the account, at
 * the organization level (sign-in gate only, no project). `sessions` lists the
 * agent credentials (OAuth connections and API keys) without key material;
 * `events` shows what agents did, and `--follow` tails it. Revoking or pausing
 * a credential stays a human action in the dashboard, so neither offers it.
 */

import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import {
	type AgentEvent,
	FOLLOW_INTERVAL_MS,
	fetchAgentEvents,
	MAX_EVENTS_LIMIT,
	parseEventsLimit,
	parseSinceDuration,
	resolveEventsLimit,
	watchAgentEvents,
} from "../lib/agent-events.js";
import { connectAgentFromHandoff } from "../lib/agent-handoff.js";
import {
	fetchAgentManifest,
	renderAgentManifest,
} from "../lib/agent-manifest.js";
import {
	defaultSetupIO,
	displayPath,
	hasPendingChanges,
	looksLikeTaroutEntry,
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
	type AgentSession,
	type AgentSessionList,
	listAgentSessions,
} from "../lib/agent-sessions.js";
import {
	AGENT_TARGETS,
	type AgentTargetId,
	resolveTargetIds,
} from "../lib/agent-targets.js";
import { getApiClient, getRequestProjectId } from "../lib/api.js";
import { agentDashboardUrl } from "../lib/approvals.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	handleError,
	rejectionReasonHint,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	isQuietMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	success,
	table,
	warn,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { confirm } from "../utils/prompts.js";
import { startSpinner, stopSpinner, succeedSpinner } from "../utils/spinner.js";

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

	const found = report.targets.filter((t) => t.detected);
	const missing = report.targets.filter((t) => !t.detected);
	log(
		`Found: ${found.length > 0 ? found.map((t) => `${t.name} ${colors.dim(`(${t.detectedBy})`)}`).join(", ") : "none"}`,
	);
	log("");

	// Several agents share one skills directory; show each directory once.
	const skillDirs = new Map<string, { agents: string[]; skills: SkillOutcome[] }>();
	for (const target of found) {
		for (const skill of target.skills) {
			const dir = dirname(dirname(skill.path));
			const entry = skillDirs.get(dir) ?? { agents: [], skills: [] };
			if (target.id !== "agents" && !entry.agents.includes(target.name)) {
				entry.agents.push(target.name);
			}
			if (!entry.skills.some((s) => s.skill === skill.skill)) entry.skills.push(skill);
			skillDirs.set(dir, entry);
		}
	}
	if (skillDirs.size > 0) {
		log(colors.bold("Skills"));
		for (const [dir, entry] of skillDirs) {
			const readers = entry.agents.length > 0 ? entry.agents.join(", ") : "shared";
			log(`  ${displayPath(dir, home)} ${colors.dim(`(${readers})`)}`);
			let lastReason: string | undefined;
			for (const skill of entry.skills) {
				log(`    ${column(skillLabel(skill))}${skill.skill}`);
				if (skill.reason && skill.reason !== lastReason) {
					log(`               ${colors.dim(skill.reason)}`);
				}
				lastReason = skill.reason;
			}
		}
		log("");
	}

	const withMcp = found.filter((t) => t.mcp);
	if (withMcp.length > 0) {
		log(colors.bold("MCP server"));
		for (const target of withMcp) {
			const mcp = target.mcp as McpOutcome;
			const where = mcp.command ?? (mcp.path ? displayPath(mcp.path, home) : "");
			log(`  ${target.name}`);
			log(`    ${column(mcpLabel(mcp))}${where}`);
			const replacing =
				mcp.status === "would-update" ||
				mcp.status === "updated" ||
				(mcp.status === "skipped" && looksLikeTaroutEntry(mcp.before));
			if (replacing && mcp.before !== undefined) {
				log(colors.error(`               - "tarout": ${JSON.stringify(mcp.before)}`));
				log(colors.success(`               + "tarout": ${JSON.stringify(mcp.after)}`));
			} else if (mcp.status === "would-register") {
				log(colors.success(`               + "tarout": ${JSON.stringify(mcp.after)}`));
			}
			if (mcp.reason) log(`               ${colors.dim(mcp.reason)}`);
			const showSnippet =
				mcp.status === "snippet" ||
				mcp.status === "error" ||
				(mcp.status === "skipped" && !replacing);
			if (mcp.snippet && showSnippet && mcp.snippet !== where) {
				for (const line of mcp.snippet.split("\n")) {
					log(`                 ${line}`);
				}
			}
		}
		log("");
	}

	if (missing.length > 0) {
		log(colors.dim(`Not found on this machine: ${missing.map((t) => t.name).join(", ")}`));
		log("");
	}
	for (const note of report.notes) {
		warn(note);
	}
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

/**
 * A FORBIDDEN from one of the agent reads (an organization agent-policy deny
 * rule, or a member without project access), as a readable PERMISSION_DENIED
 * (exit 5) that names the dashboard page, instead of a bare tRPC error. Returns
 * undefined for anything that is not a refusal.
 */
export function agentReadRefusal(
	err: unknown,
	options: { what: string; procedure: string },
): CliError | undefined {
	if (!err || typeof err !== "object" || err instanceof CliError) {
		return undefined;
	}
	const e = err as {
		message?: unknown;
		data?: { code?: unknown; reason?: unknown } | null;
		shape?: { data?: { code?: unknown; reason?: unknown } | null } | null;
	};
	const code = e.data?.code ?? e.shape?.data?.code;
	if (code !== "FORBIDDEN") return undefined;
	const rawMessage =
		typeof e.message === "string" && e.message.trim()
			? e.message.trim()
			: "the platform refused the request";
	const serverMessage = /[.!?]$/.test(rawMessage)
		? rawMessage
		: `${rawMessage}.`;
	const reasonValue = e.data?.reason ?? e.shape?.data?.reason;
	const reason =
		typeof reasonValue === "string" && reasonValue ? reasonValue : undefined;
	const reasonHint = rejectionReasonHint(reason);
	const dashboardUrl = agentDashboardUrl();
	return new CliError(
		`${options.what} is not available to this credential: ${serverMessage} A signed-in human can see it on the Agent page of the dashboard: ${dashboardUrl}`,
		ExitCode.PERMISSION_DENIED,
		undefined,
		{
			procedure: options.procedure,
			...(reason ? { reason } : {}),
			dashboardUrl,
			hint: reasonHint
				? `${reasonHint.charAt(0).toUpperCase()}${reasonHint.slice(1)}`
				: "Retrying or re-authenticating will not help. Tell the user what was refused; they can review agent access in the dashboard.",
		},
	);
}

function formatWhen(value: string | null): string {
	if (!value) return colors.dim("-");
	return new Date(value).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatTier(tier: string): string {
	return tier === "read_only" ? "read-only" : tier;
}

function formatSessionStatus(session: AgentSession): string {
	switch (session.status) {
		case "active":
			return colors.success("● active");
		case "paused":
			return colors.warn("○ paused");
		default:
			return colors.dim("○ expired");
	}
}

function renderAgentSessions(list: AgentSessionList): void {
	const total = list.oauthConnections.length + list.keys.length;
	if (total === 0) {
		log("");
		log("No agent credentials for this account in this organization.");
	}
	if (list.oauthConnections.length > 0) {
		log("");
		log(colors.bold(`OAuth connections (${list.oauthConnections.length})`));
		table(
			["CLIENT", "TIER", "STATUS", "CREATED", "LAST USED", "EXPIRES"],
			list.oauthConnections.map((session) => [
				session.name,
				formatTier(session.tier),
				formatSessionStatus(session),
				formatWhen(session.createdAt),
				session.lastUsedAt ? formatWhen(session.lastUsedAt) : colors.dim("never"),
				session.expiresAt ? formatWhen(session.expiresAt) : colors.dim("never"),
			]),
		);
	}
	if (list.keys.length > 0) {
		log("");
		log(colors.bold(`API keys (${list.keys.length})`));
		table(
			["NAME", "PREFIX", "TIER", "STATUS", "LAST USED"],
			list.keys.map((session) => [
				session.name,
				session.prefix ?? colors.dim("-"),
				formatTier(session.tier),
				formatSessionStatus(session),
				session.lastUsedAt ? formatWhen(session.lastUsedAt) : colors.dim("never"),
			]),
		);
	}
	log("");
	log(
		`Revoke or pause any of these in the dashboard (Agent > Keys): ${colors.cyan(list.dashboardUrl)}`,
	);
}

const EVENT_COLUMNS = { time: 17, agent: 22, procedure: 36, surface: 8, status: 8 };

function cell(text: string, width: number): string {
	const clipped = text.length > width - 1 ? `${text.slice(0, width - 2)}…` : text;
	return clipped.padEnd(width);
}

function eventErrorSummary(event: AgentEvent): string {
	if (event.status !== "error") return "";
	const text = [event.errorCode, event.errorMessage]
		.filter(Boolean)
		.join(": ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return "";
	return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

function eventAgentName(event: AgentEvent): string {
	if (event.keyName) return event.keyName;
	if (event.apiKeyId) return `key ${event.apiKeyId.slice(0, 8)}`;
	return "-";
}

function eventTimeLabel(event: AgentEvent): string {
	return new Date(event.at).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function printAgentEventsHeader(): void {
	log(
		colors.dim(
			`${"TIME".padEnd(EVENT_COLUMNS.time)}${"AGENT".padEnd(EVENT_COLUMNS.agent)}${"PROCEDURE".padEnd(EVENT_COLUMNS.procedure)}${"SURFACE".padEnd(EVENT_COLUMNS.surface)}${"STATUS".padEnd(EVENT_COLUMNS.status)}ERROR`,
		),
	);
}

/** One line per event; tab-separated plain fields in quiet mode. */
function printAgentEvents(events: AgentEvent[]): void {
	for (const event of events) {
		const error = eventErrorSummary(event);
		if (isQuietMode()) {
			quietOutput(
				[
					event.at,
					eventAgentName(event),
					event.procedure,
					event.surface,
					event.status,
					error,
				].join("\t"),
			);
			continue;
		}
		const status =
			event.status === "error"
				? colors.error(cell("✗ error", EVENT_COLUMNS.status))
				: colors.success(cell("✓ ok", EVENT_COLUMNS.status));
		log(
			`${colors.dim(cell(eventTimeLabel(event), EVENT_COLUMNS.time))}${cell(eventAgentName(event), EVENT_COLUMNS.agent)}${colors.cyan(cell(event.procedure, EVENT_COLUMNS.procedure))}${cell(event.surface, EVENT_COLUMNS.surface)}${status}${error ? colors.error(error) : ""}`,
		);
	}
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
		.description(
			"Set up coding agents, and see their credentials and activity",
		);

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
					const needsYes = detected.some(
						(target) =>
							target.mcp?.status === "skipped" &&
							looksLikeTaroutEntry(target.mcp.before),
					);
					if (needsYes) {
						warn(
							"Nothing else to change. Re-run with --yes to replace the tarout entries shown above.",
						);
					} else {
						success("Everything is already set up; nothing to change.");
					}
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

	// `--project` is deliberately not declared here: the root program owns it
	// and consumes it wherever it appears, so the preAction hook has already
	// resolved it (slug or id) into the request project by the time this runs.
	agent
		.command("manifest")
		.description(
			"Show the active project's apps, databases, buckets and domains in one read (signed in)",
		)
		.option(
			"--env-names",
			"List each app's environment variable names instead of a count (values are never shown)",
		)
		.addHelpText(
			"after",
			`
Pick another project with the global --project <slugOrId>. --json prints the
full manifest (every app's env var names included, never values).

Examples:
  tarout agent manifest
  tarout agent manifest --env-names
  tarout agent manifest --project api --json`,
		)
		.action(async (options: { envNames?: boolean }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const manifest = await fetchAgentManifest(
					client,
					getRequestProjectId() ?? undefined,
				);
				if (isJsonMode()) {
					outputData(manifest);
					return;
				}
				log("");
				for (const line of renderAgentManifest(manifest, {
					envNames: options.envNames === true,
				})) {
					log(line);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	agent
		.command("sessions")
		.description(
			"List the agent credentials of this account in the organization: OAuth connections and API keys (no key material)",
		)
		.addHelpText(
			"after",
			`
Shows each OAuth connection (client, tier, status, created, last used,
expires) and each API key (name, prefix, tier, status, last used). The key
itself is never shown. Revoking or pausing is done by a human in the
dashboard (Agent > Keys); this command deliberately does not.

Examples:
  tarout agent sessions
  tarout agent sessions --json`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				startSpinner("Fetching agent sessions...");
				const list = await listAgentSessions(client);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(list);
					return;
				}
				renderAgentSessions(list);
			} catch (err) {
				stopSpinner();
				handleError(
					agentReadRefusal(err, {
						what: "Listing agent sessions",
						procedure: "user.listApiKeys",
					}) ?? err,
				);
			}
		});

	agent
		.command("events")
		.description(
			"Show the agent activity timeline: what the CLI and MCP agents changed, oldest first",
		)
		.option(
			"-n, --limit <n>",
			`How many recent events, 1 to ${MAX_EVENTS_LIMIT} (default 30, or ${MAX_EVENTS_LIMIT} with --since)`,
		)
		.option(
			"--since <duration>",
			"Only events newer than this: 15m, 2h, 7d or 1h30m (a bare number is seconds)",
		)
		.option(
			"-f, --follow",
			`Keep printing new events (polls every ${FOLLOW_INTERVAL_MS / 1000}s; Ctrl+C to stop)`,
		)
		.addHelpText(
			"after",
			`
Each row: time, the key or OAuth client that acted, the procedure, the
surface (cli or mcp), ok or error, and the error. Only changes are recorded,
not reads. --json prints one envelope; with --follow it prints one JSON
object per event per line (NDJSON) instead.

Examples:
  tarout agent events
  tarout agent events --since 1h
  tarout agent events --follow
  tarout agent events --follow --json | jq .procedure`,
		)
		.action(
			async (options: { limit?: string; since?: string; follow?: boolean }) => {
				let interrupted = false;
				let wake: (() => void) | undefined;
				const onSigint = () => {
					interrupted = true;
					wake?.();
				};
				const sleep = (ms: number) =>
					new Promise<void>((resolve) => {
						const timer = setTimeout(() => {
							wake = undefined;
							resolve();
						}, ms);
						wake = () => {
							clearTimeout(timer);
							wake = undefined;
							resolve();
						};
					});

				try {
					if (!isLoggedIn()) throw new AuthError();
					const limit = parseEventsLimit(options.limit);
					const sinceMs =
						options.since === undefined
							? undefined
							: parseSinceDuration(options.since);
					const client = getApiClient();

					if (options.follow) {
						if (!isJsonMode()) {
							log(
								colors.dim(
									`Following agent activity (polling every ${FOLLOW_INTERVAL_MS / 1000}s). Press Ctrl+C to stop.`,
								),
							);
							printAgentEventsHeader();
						}
						process.once("SIGINT", onSigint);
						await watchAgentEvents(client, {
							limit,
							sinceMs,
							sleep,
							isInterrupted: () => interrupted,
							onEvents: (events) => {
								if (isJsonMode()) {
									for (const event of events) {
										outputJsonLine({ type: "agent_event", ...event });
									}
									return;
								}
								printAgentEvents(events);
							},
						});
						log(colors.dim("Stopped following agent activity."));
						return;
					}

					startSpinner("Fetching agent activity...");
					const events = await fetchAgentEvents(client, { limit, sinceMs });
					succeedSpinner();
					if (isJsonMode()) {
						outputData({ count: events.length, events });
						return;
					}
					if (events.length === 0) {
						log("");
						log(
							options.since
								? `No agent activity in the last ${options.since}.`
								: "No agent activity yet.",
						);
						return;
					}
					log("");
					printAgentEventsHeader();
					printAgentEvents(events);
					log("");
					const cap = resolveEventsLimit({ limit, sinceMs });
					log(
						colors.dim(
							`${events.length} event${events.length === 1 ? "" : "s"}, oldest first${events.length >= cap ? ` (the ${cap} most recent)` : ""}. Follow new ones: tarout agent events --follow`,
						),
					);
				} catch (err) {
					stopSpinner();
					handleError(
						agentReadRefusal(err, {
							what: "Reading the agent activity feed",
							procedure: "dashboard.getAgentActivity",
						}) ?? err,
					);
				} finally {
					process.removeListener("SIGINT", onSigint);
				}
			},
		);
}
