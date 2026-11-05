/**
 * @fileoverview Organization dashboard reads (`tarout dashboard`). Wraps the
 * platform's `dashboard` router — the same aggregations the web dashboard
 * renders, so an agent and the human supervising it see one story.
 *
 * Three of these are the agent-observability half: `agent-digest` is a
 * seven-day rollup of what agents did on the CLI and MCP surfaces (counts, a
 * per-day series, the busiest procedures, and read-time anomaly flags such as
 * a retry loop or a first-ever destructive call), `agent-deployments` shows the
 * in-flight deployments with whether an agent started each one, and
 * `action-items` is the severity-sorted "needs a human" list.
 *
 * There is no command for `dashboard.agentActivityStream`: it is a tRPC
 * subscription over a WebSocket, a dashboard-only transport the CLI's HTTP
 * client cannot consume, and the platform refuses it to API-key sessions
 * outright. Poll `tarout agent events` (per-call rows, with --follow) or
 * `tarout dashboard agent-digest` (the rollup) instead.
 * @module commands/dashboard
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	InvalidArgumentError,
} from "../lib/errors.js";
import {
	colors,
	getStatusBadge,
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
 * How urgent an action item is. The platform sorts by this; the CLI re-sorts
 * with the same ranking so a filtered or re-serialized list keeps the order.
 */
export const ACTION_ITEM_SEVERITIES = ["high", "medium", "low"] as const;
export type ActionItemSeverity = (typeof ACTION_ITEM_SEVERITIES)[number];

/** One row of `dashboard.getActionItems`. */
export interface ActionItem {
	id: string;
	kind: string;
	severity: string;
	resourceName?: string | null;
	href?: string;
	orderId?: string;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** `--severity`: one of high, medium, low. Undefined when the flag is absent. */
export function parseActionItemSeverity(
	value: unknown,
): ActionItemSeverity | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const normalized = String(value).trim().toLowerCase();
	const match = ACTION_ITEM_SEVERITIES.find(
		(severity) => severity === normalized,
	);
	if (!match) {
		const similar = findSimilar(normalized, [...ACTION_ITEM_SEVERITIES]);
		throw new InvalidArgumentError(
			`Invalid --severity "${String(value)}". Use one of: ${ACTION_ITEM_SEVERITIES.join(", ")}.${
				similar.length ? ` Did you mean "${similar[0]}"?` : ""
			}`,
		);
	}
	return match;
}

/**
 * Orders two action items most urgent first. An unknown severity sorts last
 * rather than first: a kind the CLI does not recognize must never outrank a
 * confirmed high-severity item.
 */
export function compareActionItemSeverity(a: ActionItem, b: ActionItem): number {
	const rankA = SEVERITY_RANK[a.severity] ?? ACTION_ITEM_SEVERITIES.length;
	const rankB = SEVERITY_RANK[b.severity] ?? ACTION_ITEM_SEVERITIES.length;
	return rankA - rankB;
}

/** A copy of the list, most urgent first, stable within one severity. */
export function sortActionItems(items: ActionItem[]): ActionItem[] {
	return [...items].sort(compareActionItemSeverity);
}

/** Applies `--severity`. The procedure takes no input, so it happens here. */
export function filterActionItems(
	items: ActionItem[],
	filters: { severity?: ActionItemSeverity } = {},
): ActionItem[] {
	if (!filters.severity) return items;
	return items.filter((item) => item.severity === filters.severity);
}

/** What one action item is asking for, and who can do it. No colors. */
export function describeActionItemKind(kind: string): string {
	switch (kind) {
		case "deploy_failed":
			return "An application is in the error state: its last deployment failed, so the app is not serving the new revision.";
		case "billing_past_due":
			return "A payment failed: the project's subscription or an invoice is past due, and paid resources stop being created once it stays unpaid.";
		case "checkout_pending":
			return "A checkout was started but never paid, so the plan change it would apply has not taken effect.";
		case "domain_unverified":
			return "A custom domain is not verified, or its certificate failed: DNS records are missing or the TLS issuance did not complete.";
		case "storage_blocked":
			return "A storage bucket is over its limit and uploads are blocked.";
		case "support_open":
			return "A support ticket is open and waiting on the conversation.";
		default:
			return `An item of kind "${kind}" needs attention.`;
	}
}

/** Counts by severity, for the footer and the `--json` envelope. */
export function summarizeActionItems(items: ActionItem[]): {
	total: number;
	high: number;
	medium: number;
	low: number;
} {
	const summary = { total: items.length, high: 0, medium: 0, low: 0 };
	for (const item of items) {
		if (item.severity === "high") summary.high++;
		else if (item.severity === "medium") summary.medium++;
		else if (item.severity === "low") summary.low++;
	}
	return summary;
}

/** The app-health block `dashboard.getRecentActivity` returns. */
export interface AppHealth {
	total?: number;
	running?: number;
	errored?: number;
	idle?: number;
}

/** One sentence of app health. No colors. */
export function summarizeAppHealth(health: AppHealth | null | undefined): string {
	const total = Number(health?.total) || 0;
	if (total === 0) return "No applications in this project yet.";
	const running = Number(health?.running) || 0;
	const errored = Number(health?.errored) || 0;
	const idle = Number(health?.idle) || 0;
	return `${total} application${total === 1 ? "" : "s"}: ${running} running, ${errored} errored, ${idle} idle.`;
}

/** One day of `dashboard.getAgentDigest`'s seven-day series. */
export interface DigestDay {
	day: string;
	count?: number;
	errors?: number;
}

/** One read-time anomaly flag the digest raised. */
export interface DigestAnomaly {
	kind: string;
	action: string;
	detail?: string;
	count?: number;
}

export interface AgentDigest {
	total?: number;
	errors?: number;
	byVerb?: Record<string, number>;
	perDay?: DigestDay[];
	topProcedures?: Array<{ action: string; count?: number }>;
	anomalies?: DigestAnomaly[];
}

/**
 * The digest's headline numbers: how much an agent did in the window, how much
 * of it failed, the busiest day, and the single most-called procedure.
 */
export function summarizeDigest(digest: AgentDigest | null | undefined): {
	total: number;
	errors: number;
	errorRate: number;
	days: number;
	busiestDay: string | null;
	topProcedure: string | null;
	anomalies: number;
} {
	const total = Number(digest?.total) || 0;
	const errors = Number(digest?.errors) || 0;
	const perDay = Array.isArray(digest?.perDay) ? digest.perDay : [];
	let busiestDay: string | null = null;
	let busiestCount = -1;
	for (const day of perDay) {
		const count = Number(day?.count) || 0;
		if (count > busiestCount) {
			busiestCount = count;
			busiestDay = day?.day ?? null;
		}
	}
	const top = Array.isArray(digest?.topProcedures)
		? digest.topProcedures[0]
		: undefined;
	return {
		total,
		errors,
		// One decimal place: a 7-day window of a few hundred calls makes a whole
		// percent too coarse to see a regression in.
		errorRate: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
		days: perDay.length,
		busiestDay: busiestCount > 0 ? busiestDay : null,
		topProcedure: top?.action ?? null,
		anomalies: Array.isArray(digest?.anomalies) ? digest.anomalies.length : 0,
	};
}

const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * The per-day series as one row of blocks, tallest = the busiest day. A day
 * with no agent activity prints as a dot, so an empty week never looks like a
 * flat-but-busy one.
 */
export function digestSparkline(days: DigestDay[] | null | undefined): string {
	const series = Array.isArray(days) ? days : [];
	if (!series.length) return "";
	const counts = series.map((day) => Number(day?.count) || 0);
	const max = Math.max(...counts);
	if (max <= 0) return counts.map(() => "·").join("");
	return counts
		.map((count) => {
			if (count <= 0) return "·";
			const level = Math.ceil((count / max) * SPARK_LEVELS.length) - 1;
			return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.max(0, level))];
		})
		.join("");
}

/** What an anomaly flag means, in plain words. No colors. */
export function describeDigestAnomaly(anomaly: DigestAnomaly): string {
	switch (anomaly.kind) {
		case "error_spike":
			return `${anomaly.action} failed ${anomaly.count ?? "several"} times in the last 10 minutes — the signature of an agent stuck retrying.`;
		case "first_destructive":
			return `${anomaly.action} is the first destructive agent action this organization has seen.`;
		default:
			return anomaly.detail || `${anomaly.kind} on ${anomaly.action}`;
	}
}

/**
 * How long a deployment has been running, as `4m 12s`. Returns "-" when the
 * platform has no start time for it yet (the row exists before the worker
 * picks it up).
 */
export function formatElapsed(
	startedAt: string | Date | null | undefined,
	now: number = Date.now(),
): string {
	if (!startedAt) return "-";
	const started = new Date(startedAt).getTime();
	if (!Number.isFinite(started)) return "-";
	const seconds = Math.max(0, Math.round((now - started) / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

function paintSeverity(severity: string): string {
	switch (severity) {
		case "high":
			return colors.error("high");
		case "medium":
			return colors.warn("medium");
		case "low":
			return colors.dim("low");
		default:
			return colors.dim(severity);
	}
}

function formatDateTime(value: string | Date | null | undefined): string {
	if (!value) return colors.dim("-");
	return new Date(value).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function registerDashboardCommands(program: Command) {
	const dashboard = program
		.command("dashboard")
		.description("View organization dashboard overview");

	// ── Overview ─────────────────────────────────────────────────────────────────
	dashboard
		.command("overview")
		.alias("status")
		.description("Show overall organization resource summary")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching dashboard...");
				const data = await client.dashboard.getOverview.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				const d = data as any;
				log("");
				log(colors.bold("Organization Overview"));
				log("");

				if (d.apps !== undefined || d.applications !== undefined) {
					log(
						`  Applications: ${colors.cyan(String(d.apps ?? d.applications ?? 0))}`,
					);
				}
				if (d.databases !== undefined || d.dbs !== undefined) {
					log(
						`  Databases:    ${colors.cyan(String(d.databases ?? d.dbs ?? 0))}`,
					);
				}
				if (d.deployments !== undefined) {
					log(`  Deployments:  ${colors.cyan(String(d.deployments ?? 0))}`);
				}
				if (d.domains !== undefined) {
					log(`  Domains:      ${colors.cyan(String(d.domains ?? 0))}`);
				}
				if (d.servers !== undefined) {
					log(`  Servers:      ${colors.cyan(String(d.servers ?? 0))}`);
				}
				if (d.storage !== undefined) {
					log(`  Storage:      ${colors.cyan(String(d.storage ?? 0))}`);
				}

				if (d.serverHealth !== undefined) {
					log("");
					log(
						`  Server health: ${d.serverHealth === "healthy" ? colors.success("healthy") : colors.warn(d.serverHealth || "unknown")}`,
					);
				}

				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Active plans ──────────────────────────────────────────────────────────────
	dashboard
		.command("plans")
		.description("Show active paid resources and plans")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching active plans...");
				const data = await client.dashboard.getActivePlans.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				const list = Array.isArray(data) ? data : (data as any)?.items || [];
				if (list.length === 0) {
					log("");
					log("No active paid resources.");
					return;
				}

				log("");
				log(colors.bold("Active Paid Resources"));
				log("");
				table(
					["NAME", "TYPE", "PLAN", "STATUS"],
					list.map((item: any) => [
						colors.bold(item.name || "-"),
						item.type || item.resourceType || "-",
						colors.cyan(item.plan || item.planKey || "-"),
						item.status === "running" || item.applicationStatus === "running"
							? colors.success(item.status || item.applicationStatus || "-")
							: colors.dim(item.status || item.applicationStatus || "-"),
					]),
				);
				log("");
				log(
					colors.dim(`${list.length} resource${list.length === 1 ? "" : "s"}`),
				);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Action items ──────────────────────────────────────────────────────────────
	dashboard
		.command("action-items")
		.alias("todo")
		.description(
			"List everything in the active organization and project that needs a human decision — failed deployments, a past-due payment, an unpaid checkout, an unverified domain, an upload-blocked bucket, an open support ticket — most urgent first",
		)
		.option(
			"-s, --severity <severity>",
			`Only items at this severity: ${ACTION_ITEM_SEVERITIES.join(", ")}`,
		)
		.addHelpText(
			"after",
			`
Each item carries a stable kind, a severity, the resource it is about, and the
dashboard link that resolves it. The list is scoped to the signed-in
organization and its active project; an agent credential sees its own project
scope. Nothing here is changed by reading it.

Examples:
  tarout dashboard action-items
  tarout dashboard action-items --severity high
  tarout dashboard action-items --json | jq -r '.data.items[].kind'`,
		)
		.action(async (options: { severity?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const severity = parseActionItemSeverity(options.severity);
				const client = getApiClient();

				const _spinner = startSpinner("Fetching action items...");
				const data = (await client.dashboard.getActionItems.query()) as {
					items?: ActionItem[];
					count?: number;
				} | null;
				succeedSpinner();

				const all = Array.isArray(data?.items) ? data.items : [];
				const items = sortActionItems(filterActionItems(all, { severity }));

				if (isJsonMode()) {
					outputData({
						items,
						count: items.length,
						summary: summarizeActionItems(items),
						totalItems: all.length,
					});
					return;
				}

				quietOutput(String(items.length));

				if (!items.length) {
					log("");
					log(
						all.length
							? `No ${severity ?? ""} action items.`.replace("  ", " ")
							: "Nothing needs a human right now.",
					);
					log("");
					return;
				}

				log("");
				table(
					["SEVERITY", "KIND", "RESOURCE", "WHERE"],
					items.map((item) => [
						paintSeverity(item.severity),
						colors.bold(item.kind),
						item.resourceName || colors.dim("-"),
						item.href ? colors.cyan(item.href) : colors.dim("-"),
					]),
				);
				log("");

				const summary = summarizeActionItems(items);
				log(
					colors.dim(
						`${summary.total} item${summary.total === 1 ? "" : "s"}: ${summary.high} high, ${summary.medium} medium, ${summary.low} low.`,
					),
				);
				log("");
				for (const item of items.slice(0, 5)) {
					log(
						`  ${paintSeverity(item.severity)} ${colors.bold(item.resourceName || item.kind)} — ${describeActionItemKind(item.kind)}`,
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Recent activity ───────────────────────────────────────────────────────────
	dashboard
		.command("activity")
		.alias("recent")
		.description(
			"Show the active project's most recent deployments and a running/errored/idle count of its applications — the operational snapshot, whoever triggered it",
		)
		.addHelpText(
			"after",
			`
This is the project's deployment history, not the agent audit trail. For what
an AGENT did, call by call, use \`tarout agent events\`; for a seven-day rollup
of agent behaviour use \`tarout dashboard agent-digest\`.

Examples:
  tarout dashboard activity
  tarout dashboard activity --json`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Fetching recent activity...");
				const data = (await client.dashboard.getRecentActivity.query()) as {
					deployments?: Array<{
						deploymentId: string;
						title?: string | null;
						status?: string;
						createdAt?: string | Date;
						applicationId?: string | null;
						appName?: string;
					}>;
					appHealth?: AppHealth;
				} | null;
				succeedSpinner();

				const deployments = Array.isArray(data?.deployments)
					? data.deployments
					: [];

				if (isJsonMode()) {
					outputData({
						deployments,
						appHealth: data?.appHealth ?? null,
						health: summarizeAppHealth(data?.appHealth),
					});
					return;
				}

				quietOutput(String(deployments.length));

				log("");
				log(colors.bold("Recent Activity"));
				log("");
				log(`  ${summarizeAppHealth(data?.appHealth)}`);
				log("");

				if (!deployments.length) {
					log("  No deployments in this project yet.");
					log("");
					return;
				}

				table(
					["APP", "DEPLOYMENT", "STATUS", "TITLE", "WHEN"],
					deployments.map((deployment) => [
						colors.bold(deployment.appName || "-"),
						colors.cyan(deployment.deploymentId),
						getStatusBadge(String(deployment.status ?? "")),
						deployment.title || colors.dim("-"),
						formatDateTime(deployment.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${deployments.length} deployment${deployments.length === 1 ? "" : "s"}, newest first (the platform returns the 8 most recent).`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Agent digest ──────────────────────────────────────────────────────────────
	dashboard
		.command("agent-digest")
		.alias("digest")
		.description(
			"Summarize seven days of agent activity on the CLI and MCP surfaces: how many calls, how many failed, a per-day series, the busiest procedures, and anomaly flags such as a retry loop or a first-ever destructive call",
		)
		.addHelpText(
			"after",
			`
Agent calls only: a human clicking in the dashboard is not recorded here, so
this is a fair read of what the agents did. The window is the last seven whole
UTC days and the platform caps it at 5000 calls — it is a summary, not an
export. For individual calls use \`tarout agent events\`.

Anomaly flags are computed at read time:
  error_spike        five or more failures of one procedure inside 10 minutes.
  first_destructive  the first delete/remove/terminate this organization has
                     ever had an agent make.

Examples:
  tarout dashboard agent-digest
  tarout dashboard agent-digest --json | jq '.data.summary.errorRate'`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Fetching the agent digest...");
				const digest =
					(await client.dashboard.getAgentDigest.query()) as AgentDigest | null;
				succeedSpinner();

				const summary = summarizeDigest(digest);
				const perDay = Array.isArray(digest?.perDay) ? digest.perDay : [];
				const anomalies = Array.isArray(digest?.anomalies)
					? digest.anomalies
					: [];

				if (isJsonMode()) {
					outputData({ ...(digest ?? {}), summary });
					return;
				}

				quietOutput(String(summary.total));

				log("");
				log(colors.bold("Agent Activity — last 7 days"));
				log("");
				if (summary.total === 0) {
					log("  No agent activity on the CLI or MCP surfaces this week.");
					log("");
					return;
				}

				log(`  Calls:      ${colors.cyan(String(summary.total))}`);
				log(
					`  Failed:     ${summary.errors > 0 ? colors.error(String(summary.errors)) : colors.dim("0")} ${colors.dim(`(${summary.errorRate}%)`)}`,
				);
				if (summary.topProcedure) {
					log(`  Busiest:    ${colors.cyan(summary.topProcedure)}`);
				}
				if (perDay.length) {
					log(
						`  Per day:    ${digestSparkline(perDay)} ${colors.dim(`${perDay[0]?.day ?? ""} → ${perDay[perDay.length - 1]?.day ?? ""}`)}`,
					);
				}
				log("");

				const topProcedures = Array.isArray(digest?.topProcedures)
					? digest.topProcedures
					: [];
				if (topProcedures.length) {
					table(
						["PROCEDURE", "CALLS"],
						topProcedures.map((entry) => [
							colors.cyan(entry.action),
							String(entry.count ?? 0),
						]),
					);
					log("");
				}

				const byVerb = digest?.byVerb ?? {};
				const verbs = Object.entries(byVerb).filter(([, count]) => count > 0);
				if (verbs.length) {
					log(
						colors.dim(
							`By verb: ${verbs
								.sort((a, b) => b[1] - a[1])
								.map(([verb, count]) => `${verb} ${count}`)
								.join(", ")}`,
						),
					);
					log("");
				}

				if (anomalies.length) {
					log(
						colors.warn(
							`${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"} worth a human glance:`,
						),
					);
					for (const anomaly of anomalies) {
						log(`  - ${describeDigestAnomaly(anomaly)}`);
					}
					log("");
				}
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Agent deployments ─────────────────────────────────────────────────────────
	dashboard
		.command("agent-deployments")
		.description(
			"List the deployments running right now in the active project, flagged with whether an agent started each one",
		)
		.addHelpText(
			"after",
			`
Attribution is best-effort: a deployment row records no trigger, so it counts
as agent-started when a CLI or MCP agent call in the last 24 hours recorded
that deployment or its application as the resource it acted on. Anything older
than that shows as unattributed, not as human-started.

Examples:
  tarout dashboard agent-deployments
  tarout dashboard agent-deployments --json`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Fetching in-flight deployments...");
				const data =
					(await client.dashboard.getActiveAgentDeployments.query()) as {
						deployments?: Array<{
							deploymentId: string;
							title?: string | null;
							startedAt?: string | Date | null;
							createdAt?: string | Date | null;
							applicationId?: string | null;
							appName?: string;
							agentTriggered?: boolean;
						}>;
					} | null;
				succeedSpinner();

				const deployments = Array.isArray(data?.deployments)
					? data.deployments
					: [];
				const agentStarted = deployments.filter(
					(deployment) => deployment.agentTriggered,
				).length;

				if (isJsonMode()) {
					outputData({
						deployments,
						count: deployments.length,
						agentTriggered: agentStarted,
					});
					return;
				}

				quietOutput(String(deployments.length));

				if (!deployments.length) {
					log("");
					log("Nothing is deploying in this project right now.");
					log("");
					return;
				}

				log("");
				table(
					["APP", "DEPLOYMENT", "TRIGGER", "RUNNING", "TITLE"],
					deployments.map((deployment) => [
						colors.bold(deployment.appName || "-"),
						colors.cyan(deployment.deploymentId),
						deployment.agentTriggered
							? colors.warn("agent")
							: colors.dim("unattributed"),
						formatElapsed(deployment.startedAt ?? deployment.createdAt),
						deployment.title || colors.dim("-"),
					]),
				);
				log("");
				log(
					colors.dim(
						`${deployments.length} deployment${deployments.length === 1 ? "" : "s"} in flight, ${agentStarted} started by an agent in the last 24h.`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Active deployment ─────────────────────────────────────────────────────────
	dashboard
		.command("active-deployment")
		.alias("deploying")
		.description(
			"Show the single newest deployment still running in the active project, with the commit it is building — the one-line answer to \"is anything deploying?\"",
		)
		.addHelpText(
			"after",
			`
Prints nothing but "nothing is deploying" when the project is idle, and in
--quiet mode the deployment id alone (or "none"), so a script can branch on it.
The commit message and SHA are only present when the deployment came from a
git push webhook. For every in-flight deployment, with agent attribution, use
\`tarout dashboard agent-deployments\`.

Examples:
  tarout dashboard active-deployment
  tarout dashboard active-deployment --quiet
  tarout dashboard active-deployment --json | jq -r '.data.deployment.appName'`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Checking for a running deployment...");
				const data = (await client.dashboard.getActiveDeployment.query()) as {
					deployment?: {
						deploymentId: string;
						applicationId?: string | null;
						appName?: string;
						commitMessage?: string | null;
						commitHash?: string | null;
						startedAt?: string | Date | null;
						createdAt?: string | Date | null;
					} | null;
				} | null;
				succeedSpinner();

				const deployment = data?.deployment ?? null;

				if (isJsonMode()) {
					outputData({ deployment, deploying: !!deployment });
					return;
				}

				quietOutput(deployment?.deploymentId ?? "none");

				if (!deployment) {
					log("");
					log("Nothing is deploying in this project right now.");
					log("");
					return;
				}

				log("");
				log(colors.bold(`Deploying ${deployment.appName || "-"}`));
				log("");
				log(`  Deployment:  ${colors.cyan(deployment.deploymentId)}`);
				if (deployment.applicationId) {
					log(`  Application: ${colors.cyan(deployment.applicationId)}`);
				}
				if (deployment.commitMessage) {
					log(`  Commit:      ${deployment.commitMessage}`);
				}
				if (deployment.commitHash) {
					log(`  SHA:         ${colors.dim(deployment.commitHash)}`);
				}
				log(
					`  Running for: ${formatElapsed(deployment.startedAt ?? deployment.createdAt)}`,
				);
				log(`  Started:     ${formatDateTime(deployment.startedAt)}`);
				log("");
				log(
					colors.dim(
						"Follow it: tarout deploy logs, or tarout dashboard agent-deployments for every in-flight deployment.",
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});
}
