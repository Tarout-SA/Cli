import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	NotFoundError,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

interface AppSummary {
	appName?: string;
	applicationId: string;
	name: string;
}

export function registerMonitorCommands(program: Command) {
	const monitor = program
		.command("monitor")
		.description("Manage uptime monitors for applications");

	// List monitors for an app
	monitor
		.command("list")
		.alias("ls")
		.argument("<app>", "Application ID or name")
		.description("List uptime monitors for an application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching monitors...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				const monitors = await client.uptimeMonitor.list.query({
					applicationId: app.applicationId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(monitors);
					return;
				}

				const items = monitors?.monitors || monitors || [];

				if (!Array.isArray(items) || items.length === 0) {
					log("");
					log(`No monitors for ${colors.cyan(app.name)}.`);
					log("");
					log(`Add one with: ${colors.dim(`tarout monitor add ${app.name}`)}`);
					return;
				}

				log("");
				log(`Monitors for ${colors.cyan(app.name)}:`);
				log("");
				table(
					["ID", "NAME", "URL", "INTERVAL", "STATUS", "ENABLED"],
					items.map((m: any) => [
						colors.cyan((m.monitorId || m.id || "").slice(0, 8)),
						m.name,
						truncate(m.url || "", 35),
						m.checkInterval || "5m",
						formatMonitorStatus(m.status),
						m.enabled !== false ? colors.success("yes") : colors.dim("no"),
					]),
				);
				log("");
				log(
					colors.dim(`${items.length} monitor${items.length === 1 ? "" : "s"}`),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Add a monitor
	monitor
		.command("add")
		.argument("<app>", "Application ID or name")
		.description("Add an uptime monitor to an application")
		.option("-n, --name <name>", "Monitor name")
		.option("-u, --url <url>", "URL to monitor")
		.option("-m, --method <method>", "HTTP method: GET, POST, HEAD", "GET")
		.option(
			"-i, --interval <interval>",
			"Check interval: 1m, 5m, 15m, 30m, 1h",
			"5m",
		)
		.option("--status <code>", "Expected HTTP status code", Number.parseInt)
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				succeedSpinner();

				// Interactive mode
				let monitorName = options.name;
				let monitorUrl = options.url;

				if (!monitorName) {
					monitorName = await input(
						`Monitor name (default: ${app.name} uptime):`,
						undefined,
						{
							field: "monitor_name",
							flag: "--name",
							context: { applicationId: app.applicationId, appName: app.name },
						},
					);
					if (!monitorName) monitorName = `${app.name} uptime`;
				}

				if (!monitorUrl) {
					monitorUrl = await input(
						"URL to monitor (e.g., https://example.com/health):",
						undefined,
						{
							field: "monitor_url",
							flag: "--url",
							context: { applicationId: app.applicationId },
						},
					);
				}

				const _createSpinner = startSpinner("Creating monitor...");

				const result = await client.uptimeMonitor.create.mutate({
					applicationId: app.applicationId,
					name: monitorName,
					url: monitorUrl,
					method: options.method?.toUpperCase() || "GET",
					checkInterval: options.interval || "5m",
					expectedStatus: options.status || 200,
				});

				succeedSpinner("Monitor created!");

				const monitorId = result.monitorId || result.id;

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(monitorId || monitorName);

				box("Monitor Created", [
					`ID: ${colors.cyan(monitorId || "")}`,
					`Name: ${monitorName}`,
					`URL: ${colors.cyan(monitorUrl)}`,
					`Interval: ${options.interval || "5m"}`,
				]);
			} catch (err) {
				handleError(err);
			}
		});

	// Monitor stats
	monitor
		.command("stats")
		.argument("<monitor-id>", "Monitor ID")
		.description("Show uptime statistics for a monitor")
		.action(async (monitorId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching stats...");

				const [stats, details] = await Promise.all([
					client.uptimeMonitor.getStats.query({ monitorId }),
					client.uptimeMonitor.one.query({ monitorId }).catch(() => null),
				]);

				succeedSpinner();

				if (isJsonMode()) {
					outputData({ stats, monitor: details });
					return;
				}

				log("");
				if (details) {
					log(colors.bold(details.name));
					log(`  URL: ${colors.cyan(details.url)}`);
					log(`  Status: ${formatMonitorStatus(details.status)}`);
					log("");
				}

				if (stats) {
					log(colors.bold("Uptime Statistics"));
					if (stats.uptime24h !== undefined) {
						log(`  24h uptime: ${formatUptime(stats.uptime24h)}`);
					}
					if (stats.uptime7d !== undefined) {
						log(`  7d uptime: ${formatUptime(stats.uptime7d)}`);
					}
					if (stats.uptime30d !== undefined) {
						log(`  30d uptime: ${formatUptime(stats.uptime30d)}`);
					}
					if (stats.avgResponseTime !== undefined) {
						log(`  Avg response: ${colors.cyan(`${stats.avgResponseTime}ms`)}`);
					}
					if (stats.totalChecks !== undefined) {
						log(`  Total checks: ${stats.totalChecks}`);
					}
					if (stats.failedChecks !== undefined) {
						log(`  Failed checks: ${stats.failedChecks}`);
					}
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Delete monitor
	monitor
		.command("delete")
		.alias("rm")
		.argument("<monitor-id>", "Monitor ID to delete")
		.description("Delete an uptime monitor")
		.action(async (monitorId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete monitor "${monitorId}"?`,
						false,
						{
							field: "confirm_delete_monitor",
							flag: "--yes",
							context: { monitorId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting monitor...");

				await client.uptimeMonitor.delete.mutate({ monitorId });

				succeedSpinner("Monitor deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, monitorId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Update monitor settings
	monitor
		.command("update")
		.argument("<monitor-id>", "Monitor ID to update")
		.description("Update an uptime monitor")
		.option("-n, --name <name>", "New monitor name")
		.option("-u, --url <url>", "New URL to monitor")
		.option("--enable", "Enable the monitor")
		.option("--disable", "Disable the monitor")
		.option("-i, --interval <interval>", "Check interval: 1m, 5m, 15m, 30m, 1h")
		.action(async (monitorId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const updates: Record<string, any> = { monitorId };

				if (options.name) updates.name = options.name;
				if (options.url) updates.url = options.url;
				if (options.interval) updates.checkInterval = options.interval;
				if (options.enable) updates.enabled = true;
				if (options.disable) updates.enabled = false;

				const client = getApiClient();
				const _spinner = startSpinner("Updating monitor...");

				await client.uptimeMonitor.update.mutate(updates);

				succeedSpinner("Monitor updated!");

				if (isJsonMode()) {
					outputData({ updated: true, monitorId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Run immediate check
	monitor
		.command("check")
		.argument("<monitor-id>", "Monitor ID to check now")
		.description("Run an immediate uptime check")
		.action(async (monitorId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Running check...");

				const result = await client.uptimeMonitor.performCheck.mutate({
					monitorId,
				});

				succeedSpinner("Check completed!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");
				if (result?.success || result?.status === "up") {
					log(
						colors.success(
							`✓ Check passed (${result.responseTime || result.duration || "?"}ms)`,
						),
					);
				} else {
					log(
						colors.error(
							`✗ Check failed: ${result?.error || result?.message || "unknown error"}`,
						),
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// View check logs
	monitor
		.command("logs")
		.argument("<monitor-id>", "Monitor ID")
		.description("View recent check logs for a monitor")
		.option("-n, --limit <n>", "Number of logs to show", Number.parseInt)
		.action(async (monitorId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching logs...");

				const logs = await client.uptimeMonitor.getLogs.query({
					monitorId,
					limit: options.limit || 50,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(logs);
					return;
				}

				const items = logs?.logs || logs || [];

				if (!Array.isArray(items) || items.length === 0) {
					log("");
					log("No logs found for this monitor.");
					return;
				}

				log("");
				table(
					["TIME", "STATUS", "CODE", "RESPONSE TIME", "ERROR"],
					items.map((l: any) => [
						formatDateTime(l.checkedAt || l.createdAt),
						l.isUp || l.status === "up"
							? colors.success("up")
							: colors.error("down"),
						String(l.statusCode || l.httpStatus || "-"),
						l.responseTime ? `${l.responseTime}ms` : colors.dim("-"),
						l.error || l.errorMessage || colors.dim("-"),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}

function findApp(apps: AppSummary[], identifier: string) {
	const lower = identifier.toLowerCase();
	return apps.find(
		(app) =>
			app.applicationId === identifier ||
			app.applicationId.startsWith(identifier) ||
			app.name.toLowerCase() === lower ||
			app.appName?.toLowerCase() === lower,
	);
}

function formatMonitorStatus(status: string | null | undefined): string {
	if (!status) return colors.dim("unknown");
	switch (status.toLowerCase()) {
		case "up":
			return colors.success("● up");
		case "down":
			return colors.error("✗ down");
		case "pending":
			return colors.info("◐ pending");
		default:
			return status;
	}
}

function formatUptime(pct: number): string {
	const rounded = pct.toFixed(2);
	if (pct >= 99.9) return colors.success(`${rounded}%`);
	if (pct >= 99.0) return colors.warn(`${rounded}%`);
	return colors.error(`${rounded}%`);
}

function formatDateTime(date: Date | string): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 3)}...`;
}
