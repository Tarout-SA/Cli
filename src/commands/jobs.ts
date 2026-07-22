/**
 * @fileoverview Scheduled tasks (`tarout jobs`) — cron jobs attached to an
 * application. Wraps the platform's `scheduledJob` tRPC router.
 *
 * Two kinds, discriminated by `jobType`:
 *  - HTTP    — a signed request to the app's public URL + targetPath. Runs
 *              inline (timeout capped at 60s) so `run` returns the outcome.
 *  - COMMAND — a shell command run inside the app's running container. May run
 *              up to 15 minutes, so `run` QUEUES it and the result has to be
 *              polled from the run history (`jobs runs`, or `jobs run --wait`).
 * @module commands/jobs
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import {
	getProjectConfig,
	isLoggedIn,
	isProjectLinked,
} from "../lib/config.js";
import {
	AuthError,
	CliError,
	findSimilar,
	handleError,
	InvalidArgumentError,
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
import { ExitCode } from "../utils/exit-codes.js";
import { confirm, input } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

interface AppSummary {
	appName?: string;
	applicationId: string;
	name: string;
}

interface ScheduledJob {
	id: string;
	applicationId: string;
	name: string;
	cron: string;
	timezone: string;
	jobType: string;
	targetPath: string;
	httpMethod: string;
	command: string | null;
	timeoutSeconds: number;
	enabled: boolean;
	lastRunAt: string | Date | null;
	lastStatus: string | null;
	lastStatusCode: number | null;
	consecutiveFailures: number;
	failureThreshold: number;
	signingSecret?: string;
	createdAt?: string | Date;
	application?: { name: string; appName: string };
}

interface ScheduledJobRun {
	id: string;
	ranAt: string | Date;
	ok: boolean;
	statusCode: number | null;
	exitCode: number | null;
	durationMs: number;
	error: string | null;
	output: string | null;
	trigger: string;
}

interface RunNowResult {
	queued: boolean;
	ok: boolean;
	status: string;
	statusCode: number | null;
	exitCode: number | null;
	durationMs: number;
	output: string | null;
	error: string | null;
}

/** The server caps an HTTP fire at 60s (it runs inline in the scanner tick). */
const MAX_HTTP_TIMEOUT_SECONDS = 60;
/** COMMAND fires run on the queue and may use the full range. */
const MAX_COMMAND_TIMEOUT_SECONDS = 900;

/** `jobs run --wait` polling cadence / default budget for a queued COMMAND. */
const RUN_POLL_INTERVAL_MS = 3000;
const DEFAULT_WAIT_SECONDS = 300;

export function registerJobsCommands(program: Command) {
	const jobs = program
		.command("jobs")
		.description("Manage scheduled tasks (cron) for applications");

	// List scheduled tasks
	jobs
		.command("list")
		.alias("ls")
		.description("List scheduled tasks")
		.option(
			"-a, --app <app>",
			"Application ID or name (defaults to the linked app)",
		)
		.option("-t, --type <type>", "Filter by task type: http or command")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const jobType = parseJobType(options.type);
				const client = getApiClient();

				const _spinner = startSpinner("Fetching scheduled tasks...");
				const app = await resolveAppOptional(client, options.app);

				const items = (await client.scheduledJob.list.query({
					...(app ? { applicationId: app.applicationId } : {}),
					...(jobType ? { jobType } : {}),
				})) as ScheduledJob[];

				succeedSpinner();

				if (isJsonMode()) {
					outputData(items);
					return;
				}

				if (!items.length) {
					log("");
					log(
						app
							? `No scheduled tasks for ${colors.cyan(app.name)}.`
							: "No scheduled tasks in this organization.",
					);
					log("");
					log(
						`Add one with: ${colors.dim(`tarout jobs create --name daily --schedule "0 2 * * *"`)}`,
					);
					return;
				}

				log("");
				log(
					app
						? `Scheduled tasks for ${colors.cyan(app.name)}:`
						: "Scheduled tasks:",
				);
				log("");
				table(
					[
						"ID",
						"NAME",
						"TYPE",
						"SCHEDULE",
						"TARGET",
						"LAST RUN",
						"STATUS",
						"ENABLED",
					],
					items.map((job) => [
						colors.cyan(job.id),
						job.name,
						formatJobType(job.jobType),
						job.cron,
						truncate(describeTarget(job), 28),
						formatDateTime(job.lastRunAt),
						formatJobStatus(job.lastStatus),
						job.enabled ? colors.success("yes") : colors.dim("no"),
					]),
				);
				log("");
				log(colors.dim(`${items.length} task${items.length === 1 ? "" : "s"}`));
			} catch (err) {
				handleError(withJobGuidance(err));
			}
		});

	// Show one task (includes the signing secret)
	jobs
		.command("info")
		.argument("<id>", "Scheduled task ID")
		.description("Show a scheduled task, including its signing secret")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching scheduled task...");

				const job = (await client.scheduledJob.get.query({
					id,
				})) as ScheduledJob;

				succeedSpinner();

				if (isJsonMode()) {
					outputData(job);
					return;
				}

				quietOutput(job.id);

				log("");
				log(colors.bold(job.name));
				log("");
				log(`  ID: ${colors.cyan(job.id)}`);
				log(`  Application: ${job.application?.name || job.applicationId}`);
				log(`  Type: ${formatJobType(job.jobType)}`);
				log(`  Schedule: ${job.cron} ${colors.dim(`(${job.timezone})`)}`);
				if (job.jobType === "COMMAND") {
					log(`  Command: ${colors.cyan(job.command || "-")}`);
				} else {
					log(`  Target: ${job.httpMethod} ${colors.cyan(job.targetPath)}`);
				}
				log(`  Timeout: ${job.timeoutSeconds}s`);
				log(
					`  Enabled: ${job.enabled ? colors.success("yes") : colors.dim("no")}`,
				);
				log(`  Last run: ${formatDateTime(job.lastRunAt)}`);
				log(`  Last status: ${formatJobStatus(job.lastStatus)}`);
				log(
					`  Failures: ${job.consecutiveFailures}/${job.failureThreshold} before alerting`,
				);
				log("");
				if (job.jobType === "HTTP" && job.signingSecret) {
					printSigningSecret(job.signingSecret);
				}
			} catch (err) {
				handleError(withJobGuidance(err));
			}
		});

	// Create a scheduled task
	jobs
		.command("create")
		.description("Create a scheduled task")
		.option(
			"-a, --app <app>",
			"Application ID or name (defaults to the linked app)",
		)
		.option("-n, --name <name>", "Task name")
		.option("-s, --schedule <cron>", "Cron schedule, 5 fields (e.g. 0 2 * * *)")
		.option("-t, --type <type>", "Task type: http or command", "http")
		.option("-c, --command <command>", "Shell command to run (command tasks)")
		.option("-p, --path <path>", "Path on the app's URL (http tasks)", "/")
		.option("-m, --method <method>", "HTTP method (http tasks)", "POST")
		.option("--timezone <tz>", "IANA timezone", "Etc/UTC")
		.option("--timeout <seconds>", "Per-run timeout in seconds")
		.option("--failure-threshold <n>", "Consecutive failures before alerting")
		.option("--disabled", "Create the task without enabling it")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const jobType = parseJobType(options.type) || "HTTP";
				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const app = await resolveApp(client, options.app);
				succeedSpinner();

				const name =
					options.name ||
					(await input("Task name:", undefined, {
						field: "job_name",
						flag: "--name",
						context: { applicationId: app.applicationId, appName: app.name },
					}));

				const cron =
					options.schedule ||
					(await input(
						'Cron schedule (5 fields, e.g. "0 2 * * *"):',
						undefined,
						{
							field: "job_schedule",
							flag: "--schedule",
							context: { applicationId: app.applicationId },
						},
					));

				// A command task without a command is rejected by the server; ask (or,
				// in agent/non-interactive mode, emit needs_input) instead.
				let command: string | undefined;
				if (jobType === "COMMAND") {
					command =
						options.command ||
						(await input(
							"Command to run inside the app's container:",
							undefined,
							{
								field: "job_command",
								flag: "--command",
								context: { applicationId: app.applicationId },
							},
						));
					if (!command?.trim()) {
						throw new InvalidArgumentError(
							"Command tasks require a command. Pass --command '<shell command>'.",
						);
					}
				} else if (options.command) {
					throw new InvalidArgumentError(
						"--command only applies to command tasks. Add --type command, or drop --command.",
					);
				}

				const timeoutSeconds = parseTimeout(options.timeout, jobType);
				const failureThreshold = parseIntOption(
					options.failureThreshold,
					"--failure-threshold",
				);

				const _createSpinner = startSpinner("Creating scheduled task...");

				const job = (await client.scheduledJob.create.mutate({
					applicationId: app.applicationId,
					name,
					cron,
					timezone: options.timezone || "Etc/UTC",
					jobType,
					targetPath: normalizePath(options.path),
					httpMethod: (options.method || "POST").toUpperCase(),
					...(command ? { command: command.trim() } : {}),
					...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
					...(failureThreshold !== undefined ? { failureThreshold } : {}),
					enabled: !options.disabled,
				})) as ScheduledJob;

				succeedSpinner("Scheduled task created!");

				if (isJsonMode()) {
					outputData(job);
					return;
				}

				quietOutput(job.id);

				box("Scheduled Task Created", [
					`ID: ${colors.cyan(job.id)}`,
					`Name: ${job.name}`,
					`Application: ${app.name}`,
					`Type: ${formatJobType(job.jobType)}`,
					`Schedule: ${job.cron} ${colors.dim(`(${job.timezone})`)}`,
					`Target: ${describeTarget(job)}`,
					`Enabled: ${job.enabled ? colors.success("yes") : colors.dim("no")}`,
				]);

				if (job.jobType === "HTTP" && job.signingSecret) {
					printSigningSecret(job.signingSecret);
				}
				log(`Run it now with: ${colors.dim(`tarout jobs run ${job.id}`)}`);
				log("");
			} catch (err) {
				handleError(withJobGuidance(err));
			}
		});

	// Update a scheduled task
	jobs
		.command("update")
		.argument("<id>", "Scheduled task ID")
		.description("Update a scheduled task")
		.option("-n, --name <name>", "New task name")
		.option("-s, --schedule <cron>", "New cron schedule")
		.option("-t, --type <type>", "Task type: http or command")
		.option("-c, --command <command>", "Shell command to run (command tasks)")
		.option("-p, --path <path>", "Path on the app's URL (http tasks)")
		.option("-m, --method <method>", "HTTP method (http tasks)")
		.option("--timezone <tz>", "IANA timezone")
		.option("--timeout <seconds>", "Per-run timeout in seconds")
		.option("--failure-threshold <n>", "Consecutive failures before alerting")
		.option("--enable", "Enable the task")
		.option("--disable", "Disable the task")
		.action(async (id, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const jobType = parseJobType(options.type);
				if (jobType === "COMMAND" && !options.command) {
					// Switching an HTTP task to COMMAND needs a command in the same
					// call — the server validates the MERGED shape and would reject it.
					const existing = await getApiClient().scheduledJob.get.query({ id });
					if (!(existing as ScheduledJob).command) {
						throw new InvalidArgumentError(
							"Switching a task to --type command requires --command '<shell command>'.",
						);
					}
				}

				const updates: Record<string, unknown> = { id };
				if (options.name) updates.name = options.name;
				if (options.schedule) updates.cron = options.schedule;
				if (options.timezone) updates.timezone = options.timezone;
				if (jobType) updates.jobType = jobType;
				if (options.command) updates.command = options.command.trim();
				if (options.path) updates.targetPath = normalizePath(options.path);
				if (options.method) updates.httpMethod = options.method.toUpperCase();
				const timeoutSeconds = parseTimeout(options.timeout, jobType);
				if (timeoutSeconds !== undefined) {
					updates.timeoutSeconds = timeoutSeconds;
				}
				const failureThreshold = parseIntOption(
					options.failureThreshold,
					"--failure-threshold",
				);
				if (failureThreshold !== undefined) {
					updates.failureThreshold = failureThreshold;
				}
				if (options.enable) updates.enabled = true;
				if (options.disable) updates.enabled = false;

				if (Object.keys(updates).length === 1) {
					throw new InvalidArgumentError(
						"Nothing to update. Pass at least one of --name, --schedule, --type, --command, --path, --method, --timezone, --timeout, --failure-threshold, --enable, --disable.",
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Updating scheduled task...");

				const job = (await client.scheduledJob.update.mutate(
					updates,
				)) as ScheduledJob;

				succeedSpinner("Scheduled task updated!");

				if (isJsonMode()) {
					outputData(job);
					return;
				}

				quietOutput(job.id);

				log("");
				log(colors.success(`Updated ${job.name}.`));
				log(
					`  ${formatJobType(job.jobType)} ${colors.dim("·")} ${job.cron} ${colors.dim(`(${job.timezone})`)} ${colors.dim("·")} ${describeTarget(job)}`,
				);
				log(
					`  Enabled: ${job.enabled ? colors.success("yes") : colors.dim("no")}`,
				);
				log("");
			} catch (err) {
				handleError(withJobGuidance(err));
			}
		});

	// Delete a scheduled task
	jobs
		.command("delete")
		.alias("rm")
		.argument("<id>", "Scheduled task ID to delete")
		.description("Delete a scheduled task and its run history")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete scheduled task "${id}"? Its run history goes with it.`,
						false,
						{
							field: "confirm_delete_job",
							flag: "--yes",
							context: { id },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting scheduled task...");

				await client.scheduledJob.delete.mutate({ id });

				succeedSpinner("Scheduled task deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, id });
				} else {
					quietOutput(id);
				}
			} catch (err) {
				handleError(withJobGuidance(err));
			}
		});

	// Enable / disable — thin wrappers over update
	jobs
		.command("enable")
		.argument("<id>", "Scheduled task ID")
		.description("Enable a scheduled task")
		.action(async (id) => {
			await setEnabled(id, true);
		});

	jobs
		.command("disable")
		.argument("<id>", "Scheduled task ID")
		.description("Disable a scheduled task")
		.action(async (id) => {
			await setEnabled(id, false);
		});

	// Run a task now
	jobs
		.command("run")
		.argument("<id>", "Scheduled task ID to run now")
		.description("Run a scheduled task immediately")
		.option(
			"-w, --wait",
			"For command tasks, poll the run history until the run finishes",
		)
		.option(
			"--wait-timeout <seconds>",
			`How long to wait with --wait (default ${DEFAULT_WAIT_SECONDS})`,
		)
		.action(async (id, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const waitSeconds =
					parseIntOption(options.waitTimeout, "--wait-timeout") ??
					DEFAULT_WAIT_SECONDS;

				const client = getApiClient();

				// Remember the newest run BEFORE firing so --wait can tell the new run
				// apart from the previous one.
				const previous = options.wait
					? ((await client.scheduledJob.runs
							.query({ id, limit: 1 })
							.catch(() => [])) as ScheduledJobRun[])
					: [];
				const baselineRunId = previous[0]?.id;

				const _spinner = startSpinner("Running scheduled task...");

				const result = (await client.scheduledJob.runNow.mutate({
					id,
				})) as RunNowResult;

				// HTTP tasks run inline and carry their real outcome.
				if (!result.queued) {
					succeedSpinner("Run finished!");

					if (isJsonMode()) {
						outputData(result);
						return;
					}

					quietOutput(result.ok ? "ok" : "error");
					printRunOutcome(result);
					return;
				}

				if (!options.wait) {
					succeedSpinner("Run queued!");

					if (isJsonMode()) {
						outputData(result);
						return;
					}

					quietOutput("queued");
					log("");
					log(
						colors.info(
							"Command tasks run in the background (up to 15 minutes).",
						),
					);
					log(
						`Check the result with: ${colors.dim(`tarout jobs runs ${id}`)} ${colors.dim("(or re-run with --wait)")}`,
					);
					log("");
					return;
				}

				succeedSpinner("Run queued!");
				const _waitSpinner = startSpinner(
					`Waiting for the run to finish (up to ${waitSeconds}s)...`,
				);

				const run = await waitForNewRun(client, id, baselineRunId, waitSeconds);

				if (!run) {
					failSpinner();
					throw new CliError(
						`The run did not finish within ${waitSeconds}s. It may still be running.`,
						ExitCode.GENERAL_ERROR,
						[
							`Check again with: tarout jobs runs ${id}`,
							"Or wait longer with --wait-timeout <seconds>",
						],
					);
				}

				succeedSpinner("Run finished!");

				if (isJsonMode()) {
					outputData({ ...result, run });
					return;
				}

				quietOutput(run.ok ? "ok" : "error");
				printRun(run);
			} catch (err) {
				handleError(withJobGuidance(err));
			}
		});

	// Run history
	jobs
		.command("runs")
		.argument("<id>", "Scheduled task ID")
		.description("Show the recent run history for a scheduled task")
		.option("-n, --limit <n>", "Number of runs to show (default 20)")
		.action(async (id, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const limit = parseIntOption(options.limit, "--limit");
				const client = getApiClient();
				const _spinner = startSpinner("Fetching run history...");

				const runs = (await client.scheduledJob.runs.query({
					id,
					...(limit !== undefined ? { limit } : {}),
				})) as ScheduledJobRun[];

				succeedSpinner();

				if (isJsonMode()) {
					outputData(runs);
					return;
				}

				if (!runs.length) {
					log("");
					log("No runs yet for this scheduled task.");
					log("");
					log(`Run it now with: ${colors.dim(`tarout jobs run ${id}`)}`);
					return;
				}

				log("");
				table(
					["TIME", "RESULT", "CODE", "DURATION", "TRIGGER", "ERROR"],
					runs.map((run) => [
						formatDateTime(run.ranAt),
						run.ok ? colors.success("ok") : colors.error("error"),
						formatRunCode(run),
						formatDuration(run.durationMs),
						run.trigger,
						run.error || colors.dim("-"),
					]),
				);
				log("");

				// Command runs capture stdout/stderr — show it, newest first.
				for (const run of runs) {
					if (!run.output) continue;
					log(
						`${colors.dim("── output ")}${formatDateTime(run.ranAt)} ${colors.dim(`(${formatRunCode(run)})`)}`,
					);
					log(run.output.trimEnd());
					log("");
				}
			} catch (err) {
				handleError(withJobGuidance(err));
			}
		});
}

/** `jobs enable` / `jobs disable` — the same update call with one field. */
async function setEnabled(id: string, enabled: boolean): Promise<void> {
	try {
		if (!isLoggedIn()) throw new AuthError();

		const client = getApiClient();
		const _spinner = startSpinner(
			enabled ? "Enabling scheduled task..." : "Disabling scheduled task...",
		);

		const job = (await client.scheduledJob.update.mutate({
			id,
			enabled,
		})) as ScheduledJob;

		succeedSpinner(enabled ? "Scheduled task enabled!" : "Scheduled task disabled!");

		if (isJsonMode()) {
			outputData(job);
			return;
		}

		quietOutput(job.id);

		log("");
		log(
			enabled
				? colors.success(`${job.name} is enabled (${job.cron}).`)
				: colors.warn(`${job.name} is disabled — it will not fire.`),
		);
		log("");
	} catch (err) {
		handleError(withJobGuidance(err));
	}
}

/**
 * Polls the run history until a run newer than `baselineRunId` shows up.
 * Returns null when the budget elapses (the run may still be going).
 */
async function waitForNewRun(
	// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
	client: any,
	id: string,
	baselineRunId: string | undefined,
	timeoutSeconds: number,
): Promise<ScheduledJobRun | null> {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));
		const runs = (await client.scheduledJob.runs
			.query({ id, limit: 1 })
			.catch(() => [])) as ScheduledJobRun[];
		const latest = runs[0];
		if (latest && latest.id !== baselineRunId) return latest;
	}
	return null;
}

// Helper functions

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

/**
 * Resolves the target application: an explicit `--app` wins, otherwise the
 * directory's linked app (`.tarout/project.json`) is used, matching
 * `tarout dev` / `tarout build`. Returns null when neither exists — callers
 * that can operate org-wide (list) treat that as "no filter".
 */
async function resolveAppOptional(
	// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
	client: any,
	appIdentifier?: string,
): Promise<AppSummary | null> {
	if (appIdentifier) {
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
		return app;
	}

	if (isProjectLinked()) {
		const config = getProjectConfig();
		if (!config) {
			throw new CliError(
				"Project config is corrupted. Run 'tarout link' to relink.",
			);
		}
		return { applicationId: config.applicationId, name: config.name };
	}

	return null;
}

/** Same as {@link resolveAppOptional} but an app is mandatory. */
async function resolveApp(
	// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
	client: any,
	appIdentifier?: string,
): Promise<AppSummary> {
	const app = await resolveAppOptional(client, appIdentifier);
	if (!app) {
		failSpinner();
		throw new InvalidArgumentError(
			"No linked application. Run 'tarout link' first or use the --app flag.",
		);
	}
	return app;
}

export function parseJobType(value?: string): "HTTP" | "COMMAND" | undefined {
	if (!value) return undefined;
	const upper = value.trim().toUpperCase();
	if (upper === "HTTP" || upper === "COMMAND") return upper;
	throw new InvalidArgumentError(
		`Invalid --type "${value}". Use "http" (signed request to the app's URL) or "command" (shell command in the app's container).`,
	);
}

function parseIntOption(value: unknown, flag: string): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number.parseInt(String(value), 10);
	if (Number.isNaN(parsed)) {
		throw new InvalidArgumentError(`${flag} must be a number.`);
	}
	return parsed;
}

/**
 * Timeouts are capped per kind by the server (HTTP fires run inline). Reject
 * an over-long HTTP timeout here so the caller gets the actionable message
 * without a round trip. On `update` the kind is often unknown (only --timeout
 * was passed) — then the cap is left to the server, which validates the MERGED
 * shape and knows the stored jobType.
 */
export function parseTimeout(
	value: unknown,
	jobType: "HTTP" | "COMMAND" | undefined,
): number | undefined {
	const seconds = parseIntOption(value, "--timeout");
	if (seconds === undefined) return undefined;
	if (jobType === "HTTP" && seconds > MAX_HTTP_TIMEOUT_SECONDS) {
		throw new InvalidArgumentError(
			`HTTP tasks must use --timeout ${MAX_HTTP_TIMEOUT_SECONDS} or less. Use --type command for longer work (up to ${MAX_COMMAND_TIMEOUT_SECONDS}s).`,
		);
	}
	if (seconds > MAX_COMMAND_TIMEOUT_SECONDS) {
		throw new InvalidArgumentError(
			`--timeout must be ${MAX_COMMAND_TIMEOUT_SECONDS} seconds or less.`,
		);
	}
	return seconds;
}

/** The server requires a leading slash; accept `cron/daily` too. */
export function normalizePath(path?: string): string {
	const value = (path || "/").trim();
	if (!value) return "/";
	return value.startsWith("/") ? value : `/${value}`;
}

/**
 * The scheduled-job router rejects a handful of situations with a precise
 * message but no next step. Re-throw those as a CliError carrying the
 * actionable suggestion, so `--json` gets `suggestions` and humans get a hint.
 * Anything else is passed through to handleError() untouched.
 */
export function withJobGuidance(err: unknown): unknown {
	if (err instanceof CliError) return err;
	const raw = err as {
		message?: string;
		code?: string;
		data?: { code?: string };
	};
	const message = typeof raw?.message === "string" ? raw.message : "";
	if (!message) return err;

	let suggestions: string[] | undefined;
	if (/before adding a command task/i.test(message)) {
		suggestions = [
			"Deploy the application first: tarout deploy",
			"Command tasks run inside the app's container, so one has to exist",
		];
	} else if (/HTTP tasks must use a timeout/i.test(message)) {
		suggestions = [
			`Lower --timeout to ${MAX_HTTP_TIMEOUT_SECONDS} or less`,
			`Or use --type command for longer work (up to ${MAX_COMMAND_TIMEOUT_SECONDS}s)`,
		];
	} else if (/limit of \d+ scheduled job/i.test(message)) {
		suggestions = [
			"Delete a task you no longer need: tarout jobs delete <id>",
			"Or add capacity: tarout billing upgrade",
		];
	} else if (/fires more often than your plan allows/i.test(message)) {
		suggestions = [
			'Use a less frequent schedule (e.g. --schedule "0 * * * *")',
			"Or add capacity: tarout billing upgrade",
		];
	} else if (/command is required for command tasks/i.test(message)) {
		suggestions = ["Pass --command '<shell command>'"];
	} else if (/Invalid cron expression/i.test(message)) {
		suggestions = ['Cron takes 5 fields, e.g. --schedule "*/15 * * * *"'];
	} else if (/Invalid timezone/i.test(message)) {
		suggestions = ['Use an IANA name, e.g. --timezone "Asia/Riyadh"'];
	}

	if (!suggestions) return err;

	const code = raw.data?.code ?? (typeof raw.code === "string" ? raw.code : "");
	const exitCode =
		code === "FORBIDDEN"
			? ExitCode.PERMISSION_DENIED
			: code === "NOT_FOUND"
				? ExitCode.NOT_FOUND
				: code === "BAD_REQUEST"
					? ExitCode.INVALID_ARGUMENTS
					: ExitCode.GENERAL_ERROR;
	return new CliError(message, exitCode, suggestions);
}

function printSigningSecret(secret: string): void {
	log(`Signing secret: ${colors.cyan(secret)}`);
	log(
		colors.dim(
			"Each fire carries x-tarout-cron-timestamp and x-tarout-cron-signature: sha256=HMAC_SHA256(secret, `<timestamp>.{}`). Verify it before doing work.",
		),
	);
	log("");
}

function printRunOutcome(result: RunNowResult): void {
	log("");
	if (result.ok) {
		log(
			colors.success(
				`✓ Run succeeded${result.statusCode ? ` (HTTP ${result.statusCode})` : ""} in ${formatDuration(result.durationMs)}`,
			),
		);
	} else {
		log(
			colors.error(
				`✗ Run failed${result.statusCode ? ` (HTTP ${result.statusCode})` : ""}: ${result.error || "unknown error"}`,
			),
		);
	}
	if (result.output) {
		log("");
		log(result.output.trimEnd());
	}
	log("");
}

function printRun(run: ScheduledJobRun): void {
	log("");
	if (run.ok) {
		log(
			colors.success(
				`✓ Run succeeded (${formatRunCode(run)}) in ${formatDuration(run.durationMs)}`,
			),
		);
	} else {
		log(
			colors.error(
				`✗ Run failed (${formatRunCode(run)}) after ${formatDuration(run.durationMs)}: ${run.error || "unknown error"}`,
			),
		);
	}
	if (run.output) {
		log("");
		log(run.output.trimEnd());
	}
	log("");
}

function describeTarget(job: ScheduledJob): string {
	if (job.jobType === "COMMAND") return job.command || "-";
	return `${job.httpMethod} ${job.targetPath}`;
}

function formatJobType(jobType: string): string {
	return jobType === "COMMAND" ? colors.info("command") : colors.dim("http");
}

function formatJobStatus(status: string | null | undefined): string {
	if (!status) return colors.dim("never run");
	switch (status.toLowerCase()) {
		case "ok":
			return colors.success("● ok");
		case "error":
			return colors.error("✗ error");
		case "skipped":
			return colors.warn("○ skipped");
		default:
			return status;
	}
}

/** HTTP runs report a status code, command runs an exit code. */
function formatRunCode(run: ScheduledJobRun): string {
	if (run.exitCode !== null && run.exitCode !== undefined) {
		return `exit ${run.exitCode}`;
	}
	if (run.statusCode !== null && run.statusCode !== undefined) {
		return `HTTP ${run.statusCode}`;
	}
	return colors.dim("-");
}

function formatDuration(ms: number | null | undefined): string {
	if (!ms) return "0ms";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatDateTime(date: Date | string | null | undefined): string {
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
