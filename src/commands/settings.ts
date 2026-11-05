import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	handleError,
	InvalidArgumentError,
} from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	table,
} from "../lib/output.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
} from "../utils/spinner.js";

/**
 * One entry of `settings.getAgentToolCatalog`: the MCP tool catalog exactly as
 * an agent sees it. `destructive` marks a procedure on the platform's fixed
 * destructive list — the one an operator-tier key has parked for human
 * approval instead of executed. Input schemas are deliberately not returned.
 */
export interface AgentTool {
	name: string;
	path: string;
	router: string;
	description: string;
	/** "query" or "mutation". */
	type: string;
	readOnly: boolean;
	destructive: boolean;
}

export interface AgentToolFilters {
	router?: string;
	search?: string;
	destructiveOnly?: boolean;
	/** true = mutations only, false = queries only, undefined = both. */
	writes?: boolean;
}

/**
 * Validates the `settings agent-tools` flags into one filter object.
 * `--writes` and `--read-only` are opposite halves of the same split, so
 * passing both is a mistake worth reporting rather than silently resolving.
 */
export function buildAgentToolFilters(
	options: {
		router?: string;
		search?: string;
		destructive?: boolean;
		writes?: boolean;
		readOnly?: boolean;
	} = {},
): AgentToolFilters {
	if (options.writes && options.readOnly) {
		throw new InvalidArgumentError(
			"Pass either --writes or --read-only, not both: every tool is one or the other.",
		);
	}
	const router = options.router?.trim();
	const search = options.search?.trim();
	return {
		...(router ? { router } : {}),
		...(search ? { search } : {}),
		...(options.destructive ? { destructiveOnly: true } : {}),
		...(options.writes ? { writes: true } : {}),
		...(options.readOnly ? { writes: false } : {}),
	};
}

/**
 * Applies the catalog filters client-side — the procedure takes no input.
 * `router` matches exactly (case-insensitively); `search` is a substring of
 * the tool path or its description.
 */
export function filterAgentTools(
	tools: AgentTool[],
	filters: AgentToolFilters = {},
): AgentTool[] {
	const router = filters.router?.toLowerCase();
	const search = filters.search?.toLowerCase();
	return tools.filter((tool) => {
		if (router && String(tool.router).toLowerCase() !== router) return false;
		if (filters.destructiveOnly && !tool.destructive) return false;
		if (filters.writes === true && tool.readOnly) return false;
		if (filters.writes === false && !tool.readOnly) return false;
		if (search) {
			const haystack = `${tool.path} ${tool.name} ${tool.description}`.toLowerCase();
			if (!haystack.includes(search)) return false;
		}
		return true;
	});
}

/** Catalog totals, for the footer and the `--json` envelope. */
export function summarizeAgentTools(tools: AgentTool[]): {
	total: number;
	readOnly: number;
	writes: number;
	destructive: number;
	routers: number;
} {
	const routers = new Set<string>();
	let readOnly = 0;
	let destructive = 0;
	for (const tool of tools) {
		routers.add(String(tool.router));
		if (tool.readOnly) readOnly++;
		if (tool.destructive) destructive++;
	}
	return {
		total: tools.length,
		readOnly,
		writes: tools.length - readOnly,
		destructive,
		routers: routers.size,
	};
}

/** Tool rows grouped by router, then by path, so the catalog reads as a map. */
export function sortAgentTools(tools: AgentTool[]): AgentTool[] {
	return [...tools].sort(
		(a, b) =>
			String(a.router).localeCompare(String(b.router)) ||
			String(a.path).localeCompare(String(b.path)),
	);
}

function truncateDescription(text: string, max = 64): string {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function registerSettingsCommands(program: Command) {
	const settings = program
		.command("settings")
		.description("Platform settings and information");

	// ── Platform version ─────────────────────────────────────────────────────────
	settings
		.command("version")
		.description("Show the Tarout platform version")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching version...");
				const data = await client.settings.getTaroutVersion.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const v = data as any;
				log("");
				log(
					`Platform version: ${colors.cyan(v.version || v.taroutVersion || String(data))}`,
				);
				if (v.releaseTag) log(`Release tag:      ${colors.dim(v.releaseTag)}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Release tag ──────────────────────────────────────────────────────────────
	settings
		.command("release-tag")
		.description("Show the current release tag")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching release tag...");
				const data = await client.settings.getReleaseTag.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				log(`Release tag: ${colors.cyan(String(data))}`);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Health check ─────────────────────────────────────────────────────────────
	settings
		.command("health")
		.description("Check platform health status")
		.action(async () => {
			try {
				const client = getApiClient();
				const _spinner = startSpinner("Checking health...");
				const data = await client.settings.health.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const h = data as any;
				log("");
				log(colors.bold("Platform Health"));
				log(
					`  Status:   ${h.status === "ok" || h.healthy ? colors.success("healthy") : colors.error("unhealthy")}`,
				);
				if (h.db !== undefined)
					log(
						`  Database: ${h.db ? colors.success("ok") : colors.error("error")}`,
					);
				if (h.redis !== undefined)
					log(
						`  Redis:    ${h.redis ? colors.success("ok") : colors.error("error")}`,
					);
				if (h.version) log(`  Version:  ${colors.dim(h.version)}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Is cloud ─────────────────────────────────────────────────────────────────
	settings
		.command("is-cloud")
		.description("Check if running in Tarout Cloud mode")
		.action(async () => {
			try {
				const client = getApiClient();
				const _spinner = startSpinner("Checking deployment mode...");
				const data = await client.settings.isCloud.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const isCloud = (data as any)?.isCloud ?? data;
				log(
					`Cloud mode: ${isCloud ? colors.success("yes") : colors.dim("no")}`,
				);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Subscription check ────────────────────────────────────────────────────────
	// Subscriptions are per-project. This reads the ACTIVE project's subscription
	// (same source as `tarout billing status`). It used to call
	// `settings.isUserSubscribed`, which only returns "does the org own any app?"
	// — a boolean that is NOT plan/billing status and was surfaced misleadingly.
	settings
		.command("subscription-status")
		.description("Check the active project's subscription status")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking subscription...");
				const sub = await client.subscription.getCurrent.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(sub);
					return;
				}
				log("");
				log(colors.bold("Subscription Status"));
				const profile = getCurrentProfile();
				if (profile?.projectName) {
					log(`  ${colors.dim(`Project: ${profile.projectName}`)}`);
				}
				if (!sub?.planKey) {
					log(`  Plan:   ${colors.dim("No active subscription (free tier)")}`);
				} else {
					log(`  Plan:   ${colors.cyan(sub.planKey)}`);
					log(`  Status: ${sub.status || colors.dim("active")}`);
					if (sub.currentPeriodEnd)
						log(
							`  Renews: ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`,
						);
				}
				log("");
				log(colors.dim("Manage your plan with: tarout billing"));
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Agent tool catalog ────────────────────────────────────────────────────────
	settings
		.command("agent-tools")
		.alias("agent-catalog")
		.description(
			"List every platform action an agent can call, exactly as the MCP server presents it: the tool name, whether it only reads, and whether it is destructive (a destructive call from an operator-tier key is parked for a human to approve instead of running)",
		)
		.option(
			"-r, --router <router>",
			"Only tools from this router, e.g. application, postgres, domain",
		)
		.option(
			"-s, --search <text>",
			"Only tools whose path or description contains this text",
		)
		.option(
			"-d, --destructive",
			"Only the destructive tools — the ones an operator-tier key has parked for human approval unless a policy rule always allows them",
		)
		.option("-w, --writes", "Only tools that change something (mutations)")
		.option("--read-only", "Only tools that read (queries)")
		.addHelpText(
			"after",
			`
This is the same catalog the MCP server generates, so it can never drift from
what an agent is really offered. It says what EXISTS; what a given credential
may actually do also depends on its key tier, its project and area scope, the
organization's agent policy rules (\`tarout agent-policies list\`) and resource
protection. Input schemas are not included — read one with
\`tarout call --describe <procedure>\`.

Examples:
  tarout settings agent-tools --destructive
  tarout settings agent-tools --router postgres
  tarout settings agent-tools --read-only --json | jq -r '.data.tools[].path'`,
		)
		.action(
			async (options: {
				router?: string;
				search?: string;
				destructive?: boolean;
				writes?: boolean;
				readOnly?: boolean;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					const filters = buildAgentToolFilters(options);
					const client = getApiClient();

					const _spinner = startSpinner("Fetching the agent tool catalog...");
					const raw = (await client.settings.getAgentToolCatalog.query()) as
						| AgentTool[]
						| null;
					succeedSpinner();

					const all = Array.isArray(raw) ? raw : [];
					const tools = sortAgentTools(filterAgentTools(all, filters));

					if (isJsonMode()) {
						outputData({
							tools,
							summary: summarizeAgentTools(tools),
							totalTools: all.length,
						});
						return;
					}

					quietOutput(String(tools.length));

					if (!tools.length) {
						log("");
						log(
							all.length
								? "No agent tools match those filters."
								: "The platform reported no agent tools.",
						);
						log("");
						return;
					}

					log("");
					table(
						["TOOL", "PROCEDURE", "KIND", "RISK", "DESCRIPTION"],
						tools.map((tool) => [
							colors.bold(tool.name),
							colors.cyan(tool.path),
							tool.readOnly ? colors.dim("read") : colors.warn("write"),
							tool.destructive
								? colors.error("destructive")
								: colors.dim("-"),
							truncateDescription(tool.description),
						]),
					);
					log("");

					const summary = summarizeAgentTools(tools);
					log(
						colors.dim(
							`${summary.total} tool${summary.total === 1 ? "" : "s"} across ${summary.routers} router${summary.routers === 1 ? "" : "s"}: ${summary.readOnly} read-only, ${summary.writes} write${summary.writes === 1 ? "" : "s"}, ${summary.destructive} destructive.`,
						),
					);
					if (all.length > tools.length) {
						log(
							colors.dim(
								`${all.length} tools in the full catalog. Drop the filters to see them all.`,
							),
						);
					}
					log("");
					log(
						colors.dim(
							"A destructive call from an operator-tier key is parked for a human unless a policy rule always allows it: tarout agent-policies catalog",
						),
					);
					log("");
				} catch (err) {
					stopSpinner();
					handleError(err);
				}
			},
		);

	// ── OpenAPI document ──────────────────────────────────────────────────────────
	settings
		.command("openapi")
		.description("Output the OpenAPI specification document")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching OpenAPI spec...");
				const data = await client.settings.getOpenApiDocument.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				log(JSON.stringify(data, null, 2));
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
