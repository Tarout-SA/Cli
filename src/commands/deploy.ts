import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	analyzeDeploymentError,
	BuildFailedError,
	DeploymentFailedError,
	DeploymentTimeoutError,
	findSimilar,
	handleError,
	NotFoundError,
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
import { streamDeploymentLogs } from "../lib/websocket.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

export function registerDeployCommands(program: Command) {
	// Deploy command
	program
		.command("deploy")
		.argument("<app>", "Application ID or name")
		.description("Deploy an application")
		.option("-r, --region <region>", "Deployment region", "me-central1")
		.option("-w, --wait", "Wait for deployment to complete and stream logs")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Finding application...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				updateSpinner(`Deploying ${app.name}...`);

				// Trigger deployment
				const result = await client.application.deployToCloud.mutate({
					applicationId: app.applicationId,
					region: options.region,
				});

				if (options.wait) {
					// Stream logs and wait for completion
					await streamDeploymentWithLogs(
						client,
						result.deploymentId,
						app.name,
						app.applicationId,
					);
					return;
				}

				succeedSpinner("Deployment started!");

				if (isJsonMode()) {
					outputData({
						deploymentId: result.deploymentId,
						status: "deploying",
					});
				} else {
					quietOutput(result.deploymentId);
					log("");
					log(`Deployment ID: ${colors.cyan(result.deploymentId)}`);
					log("");
					log("Deployment is running in the background.");
					log(
						`Check status: ${colors.dim(`tarout deploy:status ${app.applicationId.slice(0, 8)}`)}`,
					);
					log(
						`View logs: ${colors.dim(`tarout deploy:logs ${result.deploymentId.slice(0, 8)}`)}`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy status command
	program
		.command("deploy:status")
		.argument("<app>", "Application ID or name")
		.description("Check deployment status")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Fetching status...");
				const apps = await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				const app = await client.application.one.query({
					applicationId: appSummary.applicationId,
				});

				const cloudStatus =
					await client.application.getCloudDeploymentStatus.query({
						applicationId: appSummary.applicationId,
					});

				succeedSpinner();

				if (isJsonMode()) {
					outputData({
						applicationId: app.applicationId,
						name: app.name,
						status: app.applicationStatus,
						url: app.cloudServiceUrl,
						cloudStatus,
					});
					return;
				}

				log("");
				log(`${colors.bold(app.name)}`);
				log("");
				log(`Status: ${getStatusBadge(app.applicationStatus)}`);

				if (app.cloudServiceUrl) {
					log(`URL: ${colors.cyan(app.cloudServiceUrl)}`);
				}

				if (cloudStatus) {
					log(`Provider: ${cloudStatus.provider}`);
					log(`Region: ${cloudStatus.region}`);
					log(`Updated: ${new Date(cloudStatus.updatedAt).toLocaleString()}`);
				}

				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy cancel command
	program
		.command("deploy:cancel")
		.argument("<app>", "Application ID or name")
		.description("Cancel a running deployment")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Cancelling deployment...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				await client.application.cancelDeployment.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner("Deployment cancelled");

				if (isJsonMode()) {
					outputData({ cancelled: true, applicationId: app.applicationId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy list command
	program
		.command("deploy:list")
		.argument("<app>", "Application ID or name")
		.description("List recent deployments")
		.option("-n, --limit <number>", "Number of deployments to show", "10")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Fetching deployments...");
				const apps = await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				// Get deployments
				const deployments = await client.deployment.all.query({
					applicationId: appSummary.applicationId,
				});

				succeedSpinner();

				const limitedDeployments = deployments.slice(
					0,
					Number.parseInt(options.limit, 10),
				);

				if (isJsonMode()) {
					outputData(limitedDeployments);
					return;
				}

				if (limitedDeployments.length === 0) {
					log("");
					log("No deployments found.");
					log("");
					log(
						`Deploy with: ${colors.dim(`tarout deploy ${appSummary.applicationId.slice(0, 8)}`)}`,
					);
					return;
				}

				log("");
				table(
					["ID", "STATUS", "TITLE", "CREATED"],
					limitedDeployments.map((d: any) => [
						colors.cyan(d.deploymentId.slice(0, 8)),
						getStatusBadge(d.status),
						d.title || colors.dim("-"),
						formatDate(d.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${limitedDeployments.length} deployment${limitedDeployments.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy logs command - view logs for a specific deployment
	program
		.command("deploy:logs")
		.argument("<deployment-id>", "Deployment ID")
		.description("View deployment logs")
		.option(
			"-f, --follow",
			"Stream logs in real-time (for running deployments)",
		)
		.option("--no-stream", "Fetch logs via HTTP instead of WebSocket")
		.action(async (deploymentId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Get deployment details
				const _spinner = startSpinner("Fetching deployment...");
				let deployment: any;
				try {
					deployment = await client.deployment.one.query({ deploymentId });
				} catch {
					// Deployment not found
					failSpinner();
					throw new NotFoundError("Deployment", deploymentId);
				}

				succeedSpinner();

				const isRunning = deployment.status === "running";

				// Determine whether to stream or fetch
				const shouldStream =
					options.follow || (isRunning && options.stream !== false);

				if (shouldStream && deployment.logPath) {
					// Stream logs via WebSocket
					log("");
					log(
						colors.dim(
							`Streaming logs for deployment ${colors.cyan(deployment.deploymentId.slice(0, 8))}...`,
						),
					);
					log(colors.dim("Press Ctrl+C to stop"));
					log("");

					const logLines: string[] = [];
					const errors: string[] = [];
					let finalStatus = deployment.status;

					const { cleanup, done } = streamDeploymentLogs(deployment.logPath, {
						onData: (line) => {
							logLines.push(line);
							if (isErrorLine(line)) {
								errors.push(line);
							}
							if (!isJsonMode()) {
								printLogLine(line);
							}
						},
						onError: (error) => {
							if (!isJsonMode()) {
								log(colors.error(`WebSocket error: ${error.message}`));
							}
						},
					});

					// Handle Ctrl+C gracefully
					process.on("SIGINT", () => {
						cleanup();
						if (!isJsonMode()) {
							log("");
							log(colors.dim("Log streaming stopped"));
						}
						process.exit(0);
					});

					// Wait for stream to end (deployment complete or error)
					await done;

					// Get final deployment status
					const finalDeployment = await client.deployment.one.query({
						deploymentId,
					});
					finalStatus = finalDeployment.status;

					// Output JSON result if in JSON mode
					if (isJsonMode()) {
						const analysis =
							finalStatus === "error"
								? analyzeDeploymentError(logLines, finalDeployment.errorMessage)
								: undefined;

						outputData({
							deploymentId: deployment.deploymentId,
							status: finalStatus,
							logs: logLines,
							errors: errors.length > 0 ? errors : undefined,
							errorAnalysis: analysis,
							application: deployment.application,
						});
					} else {
						log("");
						log(
							`Final status: ${getStatusBadge(finalStatus)} ${finalStatus === "error" && finalDeployment.errorMessage ? `- ${finalDeployment.errorMessage}` : ""}`,
						);
					}
				} else {
					// Fetch logs via HTTP
					const logsResult = await client.deployment.getDeploymentLogs.query({
						deploymentId,
						offset: 0,
						limit: 5000,
					});

					if (isJsonMode()) {
						const errors = logsResult.lines.filter(isErrorLine);
						const analysis =
							deployment.status === "error"
								? analyzeDeploymentError(
										logsResult.lines,
										deployment.errorMessage,
									)
								: undefined;

						outputData({
							deploymentId: deployment.deploymentId,
							status: deployment.status,
							logs: logsResult.lines,
							totalLines: logsResult.totalLines,
							errors: errors.length > 0 ? errors : undefined,
							errorAnalysis: analysis,
							application: deployment.application,
						});
						return;
					}

					if (logsResult.lines.length === 0) {
						log("");
						log("No logs available for this deployment.");
						return;
					}

					log("");
					log(
						colors.dim(
							`Logs for deployment ${colors.cyan(deployment.deploymentId.slice(0, 8))} (${logsResult.totalLines} lines):`,
						),
					);
					log("");

					for (const line of logsResult.lines) {
						printLogLine(line);
					}

					if (logsResult.hasMore) {
						log("");
						log(
							colors.dim(
								`Showing ${logsResult.lines.length} of ${logsResult.totalLines} lines`,
							),
						);
					}

					log("");
					log(`Status: ${getStatusBadge(deployment.status)}`);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy rollback command - rollback to a previous deployment
	program
		.command("deploy:rollback")
		.argument("<app>", "Application ID or name")
		.description("Rollback to a previous deployment")
		.option("--to <deployment-id>", "Specific deployment ID to rollback to")
		.option("--previous", "Rollback to the immediately previous deployment")
		.option("-w, --wait", "Wait for rollback to complete")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Finding application...");
				const apps = await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				// Get deployments
				const deployments = await client.deployment.all.query({
					applicationId: appSummary.applicationId,
				});

				succeedSpinner();

				// Filter to only successful deployments
				const successfulDeployments = deployments.filter(
					(d: any) => d.status === "done",
				);

				if (successfulDeployments.length === 0) {
					log("");
					log("No successful deployments found to rollback to.");
					return;
				}

				let targetDeploymentId: string;

				if (options.to) {
					// Use specific deployment ID
					const targetDeployment = successfulDeployments.find(
						(d: any) =>
							d.deploymentId === options.to ||
							d.deploymentId.startsWith(options.to),
					);

					if (!targetDeployment) {
						throw new NotFoundError("Deployment", options.to);
					}

					targetDeploymentId = targetDeployment.deploymentId;
				} else if (options.previous) {
					// Use the second most recent successful deployment (first is current)
					if (successfulDeployments.length < 2) {
						log("");
						log("No previous deployment to rollback to.");
						log("There must be at least 2 successful deployments.");
						return;
					}

					targetDeploymentId = successfulDeployments[1].deploymentId;
				} else {
					// Interactive selection
					log("");
					log(
						`Select a deployment to rollback to for ${colors.cyan(appSummary.name)}:`,
					);
					log("");

					const choices = successfulDeployments
						.slice(0, 10)
						.map((d: any, index: number) => ({
							name: `${colors.cyan(d.deploymentId.slice(0, 8))} - ${d.title || "Deployment"} (${formatDate(d.createdAt)})${index === 0 ? colors.dim(" [current]") : ""}`,
							value: d.deploymentId,
						}));

					const { select } = await import("../utils/prompts.js");
					targetDeploymentId = await select("Select deployment:", choices);
				}

				// Confirm rollback
				if (!options.yes) {
					const targetDeployment = successfulDeployments.find(
						(d: any) => d.deploymentId === targetDeploymentId,
					);

					log("");
					log(`Rolling back ${colors.cyan(appSummary.name)} to:`);
					log(`  Deployment: ${colors.cyan(targetDeploymentId.slice(0, 8))}`);
					log(`  Title: ${targetDeployment?.title || "Deployment"}`);
					log(`  Created: ${formatDate(targetDeployment?.createdAt)}`);
					log("");

					const { confirm } = await import("../utils/prompts.js");
					const confirmed = await confirm(
						"Are you sure you want to rollback?",
						false,
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				// Perform rollback
				const _rollbackSpinner = startSpinner("Initiating rollback...");

				const result = await client.deployment.rollback.mutate({
					applicationId: appSummary.applicationId,
					targetDeploymentId,
				});

				if (options.wait) {
					// Stream logs and wait for completion
					await streamDeploymentWithLogs(
						client,
						result.deploymentId,
						appSummary.name,
						appSummary.applicationId,
					);
					return;
				}

				succeedSpinner("Rollback initiated!");

				if (isJsonMode()) {
					outputData({
						deploymentId: result.deploymentId,
						rollbackFrom: targetDeploymentId,
						status: "running",
					});
				} else {
					quietOutput(result.deploymentId);
					log("");
					log(`Deployment ID: ${colors.cyan(result.deploymentId)}`);
					log(`Rolling back to: ${colors.dim(targetDeploymentId.slice(0, 8))}`);
					log("");
					log("Rollback is running in the background.");
					log(
						`Check status: ${colors.dim(`tarout deploy:status ${appSummary.applicationId.slice(0, 8)}`)}`,
					);
					log(
						`View logs: ${colors.dim(`tarout deploy:logs ${result.deploymentId.slice(0, 8)}`)}`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});
}

// Register logs command separately
export function registerLogsCommand(program: Command) {
	program
		.command("logs")
		.argument("<app>", "Application ID or name")
		.description("View application logs")
		.option(
			"-l, --level <level>",
			"Log level (ALL, ERROR, WARN, INFO, DEBUG)",
			"ALL",
		)
		.option("-f, --follow", "Stream logs continuously")
		.option("-n, --limit <number>", "Number of logs to show", "100")
		.option("--since <duration>", "Show logs since (e.g., 1h, 30m, 2d)")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Fetching logs...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				// Parse time range
				let timeRange: { start: string | null; end: string | null } | undefined;
				if (options.since) {
					const since = parseDuration(options.since);
					if (since) {
						timeRange = {
							start: new Date(Date.now() - since).toISOString(),
							end: null,
						};
					}
				}

				const logs = await client.logs.getCloudRunLogs.query({
					applicationId: app.applicationId,
					level: options.level.toUpperCase() as
						| "ALL"
						| "ERROR"
						| "WARN"
						| "INFO"
						| "DEBUG",
					limit: Number.parseInt(options.limit, 10),
					timeRange,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(logs);
					return;
				}

				if (!logs.entries || logs.entries.length === 0) {
					log("");
					log("No logs found.");
					return;
				}

				log("");

				for (const entry of logs.entries) {
					printLogEntry(entry);
				}

				// Follow mode - poll for new logs
				if (options.follow) {
					log("");
					log(colors.dim("Streaming logs... (Ctrl+C to stop)"));
					log("");

					let lastTimestamp =
						logs.entries.length > 0
							? new Date(
									logs.entries[logs.entries.length - 1].timestamp,
								).getTime()
							: Date.now();

					while (true) {
						await sleep(2000);

						const newLogs = await client.logs.getCloudRunLogs.query({
							applicationId: app.applicationId,
							level: options.level.toUpperCase() as
								| "ALL"
								| "ERROR"
								| "WARN"
								| "INFO"
								| "DEBUG",
							limit: 50,
							timeRange: {
								start: new Date(lastTimestamp + 1).toISOString(),
								end: null,
							},
						});

						if (newLogs.entries && newLogs.entries.length > 0) {
							for (const entry of newLogs.entries) {
								const entryTime = new Date(entry.timestamp).getTime();
								if (entryTime > lastTimestamp) {
									printLogEntry(entry);
									lastTimestamp = entryTime;
								}
							}
						}
					}
				}
			} catch (err) {
				handleError(err);
			}
		});
}

// Helper functions
function findApp(
	apps: Array<{ applicationId: string; name: string; appName?: string }>,
	identifier: string,
) {
	const lowerIdentifier = identifier.toLowerCase();

	return apps.find(
		(app) =>
			app.applicationId === identifier ||
			app.applicationId.startsWith(identifier) ||
			app.name.toLowerCase() === lowerIdentifier ||
			app.appName?.toLowerCase() === lowerIdentifier,
	);
}

function formatDate(date: Date | string): string {
	const d = new Date(date);
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDuration(duration: string): number | null {
	const match = duration.match(/^(\d+)(s|m|h|d)$/);
	if (!match) return null;

	const value = Number.parseInt(match[1], 10);
	const unit = match[2];

	const multipliers: Record<string, number> = {
		s: 1000,
		m: 60 * 1000,
		h: 60 * 60 * 1000,
		d: 24 * 60 * 60 * 1000,
	};

	return value * (multipliers[unit] || 0);
}

function printLogEntry(entry: {
	timestamp: string;
	severity: string;
	message: string;
}) {
	const time = new Date(entry.timestamp);
	const timeStr = time.toLocaleTimeString("en-US", {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

	const levelColors: Record<string, (s: string) => string> = {
		ERROR: colors.error,
		WARN: colors.warn,
		INFO: colors.info,
		DEBUG: colors.dim,
		DEFAULT: colors.dim,
	};

	const colorFn = levelColors[entry.severity] || levelColors.DEFAULT;
	const level = entry.severity.padEnd(5);

	console.log(`${colors.dim(timeStr)}  ${colorFn(level)}  ${entry.message}`);
}

/**
 * Stream deployment logs and wait for completion.
 * Used by `deploy --wait` to show real-time logs.
 */
async function streamDeploymentWithLogs(
	client: any,
	deploymentId: string,
	appName: string,
	applicationId: string,
): Promise<void> {
	// Get deployment details to get logPath
	stopSpinner();

	let deployment: any;
	try {
		deployment = await client.deployment.one.query({ deploymentId });
	} catch {
		throw new NotFoundError("Deployment", deploymentId);
	}

	const logLines: string[] = [];
	const errors: string[] = [];
	const startTime = Date.now();
	let wsConnected = false;
	let lastStatus = deployment.status;

	if (!isJsonMode()) {
		log("");
		log(
			`${colors.bold(appName)} - Deployment ${colors.cyan(deploymentId.slice(0, 8))}`,
		);
		log(colors.dim("─".repeat(50)));
		log("");
	}

	// Start streaming logs if logPath is available
	let cleanup: (() => void) | null = null;

	if (deployment.logPath) {
		const stream = streamDeploymentLogs(deployment.logPath, {
			onData: (line) => {
				logLines.push(line);
				if (isErrorLine(line)) {
					errors.push(line);
				}
				if (!isJsonMode()) {
					printLogLine(line);
				}
			},
			onOpen: () => {
				wsConnected = true;
			},
			onError: () => {
				// WebSocket errors are not fatal - we'll fall back to polling
				if (!isJsonMode() && wsConnected) {
					log(colors.dim("[WebSocket reconnecting...]"));
				}
			},
		});
		cleanup = stream.cleanup;
	}

	// Poll for deployment status
	const maxWaitMs = 600000; // 10 minutes
	const pollIntervalMs = 3000;

	try {
		while (Date.now() - startTime < maxWaitMs) {
			await sleep(pollIntervalMs);

			// Get updated deployment status
			const updatedDeployment = await client.deployment.one.query({
				deploymentId,
			});
			lastStatus = updatedDeployment.status;

			if (lastStatus === "done") {
				// Give WebSocket a moment to flush remaining logs
				await sleep(500);
				cleanup?.();

				// Get final application info for URL
				const finalApp = await client.application.one.query({ applicationId });
				const duration = Math.round((Date.now() - startTime) / 1000);

				if (isJsonMode()) {
					outputData({
						success: true,
						data: {
							deploymentId,
							status: "done",
							url: finalApp.cloudServiceUrl,
							duration,
							logs: logLines,
						},
					});
				} else {
					log("");
					log(colors.dim("─".repeat(50)));
					log(colors.success("✓ Deployment successful!"));
					log("");
					log(`URL: ${colors.cyan(finalApp.cloudServiceUrl || "Pending...")}`);
					log(`Duration: ${colors.dim(`${duration}s`)}`);
					log("");
				}
				return;
			}

			if (lastStatus === "error" || lastStatus === "cancelled") {
				cleanup?.();

				const errorAnalysis = analyzeDeploymentError(
					logLines,
					updatedDeployment.errorMessage,
				);
				const duration = Math.round((Date.now() - startTime) / 1000);

				if (isJsonMode()) {
					outputData({
						success: false,
						error: {
							code:
								errorAnalysis.category === "build_script" ||
								errorAnalysis.category === "npm_install" ||
								errorAnalysis.category === "typescript"
									? "BUILD_FAILED"
									: "DEPLOYMENT_FAILED",
							message: updatedDeployment.errorMessage || "Deployment failed",
							deploymentId,
							duration,
							logs: logLines,
							errors: errors.length > 0 ? errors : undefined,
							errorAnalysis,
						},
					});
				} else {
					log("");
					log(colors.dim("─".repeat(50)));
					log(colors.error("✗ Deployment failed"));
					log("");

					if (updatedDeployment.errorMessage) {
						log(`Error: ${colors.error(updatedDeployment.errorMessage)}`);
					}

					if (errorAnalysis.category !== "unknown") {
						log("");
						log(colors.bold("Error Analysis:"));
						log(`  Category: ${errorAnalysis.category}`);
						log(`  Type: ${errorAnalysis.type}`);
						log("");
						log(colors.bold("Possible Causes:"));
						for (const cause of errorAnalysis.possibleCauses.slice(0, 3)) {
							log(`  • ${cause}`);
						}
						log("");
						log(colors.bold("Suggested Fixes:"));
						for (const fix of errorAnalysis.suggestedFixes.slice(0, 3)) {
							log(`  • ${fix}`);
						}
					}
					log("");
				}

				// Throw appropriate error for exit code
				if (
					errorAnalysis.category === "build_script" ||
					errorAnalysis.category === "npm_install" ||
					errorAnalysis.category === "typescript" ||
					errorAnalysis.category === "docker_build"
				) {
					throw new BuildFailedError(
						updatedDeployment.errorMessage || "Build failed",
						deploymentId,
						errorAnalysis,
					);
				}
				throw new DeploymentFailedError(
					updatedDeployment.errorMessage || "Deployment failed",
					deploymentId,
					errorAnalysis,
				);
			}
		}

		// Timeout
		cleanup?.();
		const duration = Math.round((Date.now() - startTime) / 1000);

		if (isJsonMode()) {
			outputData({
				success: false,
				error: {
					code: "DEPLOYMENT_TIMEOUT",
					message: "Deployment timed out",
					deploymentId,
					duration,
					logs: logLines,
					errors: errors.length > 0 ? errors : undefined,
				},
			});
		} else {
			log("");
			log(colors.dim("─".repeat(50)));
			log(colors.warn("⚠ Deployment timed out"));
			log("");
			log(
				`The deployment is still running. Check status with: ${colors.dim(`tarout deploy:status ${applicationId.slice(0, 8)}`)}`,
			);
			log("");
		}

		throw new DeploymentTimeoutError(
			"Deployment timed out after 10 minutes",
			deploymentId,
		);
	} finally {
		// Ensure cleanup is called
		cleanup?.();
	}
}

/**
 * Check if a log line contains an error indicator.
 */
function isErrorLine(line: string): boolean {
	const errorPatterns = [
		/error/i,
		/ERR!/i,
		/failed/i,
		/fatal/i,
		/exception/i,
		/ENOENT/i,
		/EACCES/i,
		/EPERM/i,
	];
	return errorPatterns.some((pattern) => pattern.test(line));
}

/**
 * Print a log line with appropriate formatting.
 */
function printLogLine(line: string): void {
	// Detect log level from content
	if (isErrorLine(line)) {
		console.log(colors.error(line));
	} else if (/warn/i.test(line)) {
		console.log(colors.warn(line));
	} else if (/step|stage|building|installing|deploying/i.test(line)) {
		console.log(colors.info(line));
	} else {
		console.log(line);
	}
}
