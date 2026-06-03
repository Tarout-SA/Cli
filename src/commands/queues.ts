import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, select } from "../utils/prompts.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerQueuesCommands(program: Command) {
	const queues = program
		.command("queues")
		.description("Manage background job queues");

	// Get overall queue statistics
	queues
		.command("stats")
		.description("Show statistics for all queues")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching queue stats...");
				const stats = await client.queues.getQueueStats.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(stats);
					return;
				}
				const list = Array.isArray(stats)
					? stats
					: (stats as any)?.queues || [];
				if (!list.length) {
					log("\nNo queue data available.\n");
					return;
				}
				log("");
				table(
					["QUEUE", "WAITING", "ACTIVE", "COMPLETED", "FAILED", "PAUSED"],
					list.map((q: any) => [
						colors.cyan(q.name || q.queueName || "-"),
						String(q.waiting ?? q.waitingCount ?? 0),
						String(q.active ?? q.activeCount ?? 0),
						colors.success(String(q.completed ?? q.completedCount ?? 0)),
						colors.error(String(q.failed ?? q.failedCount ?? 0)),
						q.isPaused ? colors.warn("yes") : colors.dim("no"),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// List jobs in a queue
	queues
		.command("jobs")
		.argument("<queue>", "Queue name")
		.option(
			"-s, --status <status>",
			"Filter by status: waiting, active, completed, failed, delayed",
			"failed",
		)
		.option("-n, --limit <n>", "Number of jobs to show", "20")
		.description("List jobs in a queue")
		.action(async (queueName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching jobs...");
				const jobs = await client.queues.getQueueJobs.query({
					queueName,
					status: options.status,
					limit: Number.parseInt(options.limit || "20"),
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(jobs);
					return;
				}
				const list = Array.isArray(jobs) ? jobs : (jobs as any)?.jobs || [];
				if (!list.length) {
					log(`\nNo ${options.status} jobs in queue "${queueName}".\n`);
					return;
				}
				log("");
				table(
					["JOB ID", "NAME", "STATUS", "ATTEMPTS", "CREATED"],
					list.map((j: any) => [
						colors.cyan(String(j.id || j.jobId || "-").slice(0, 12)),
						j.name || j.jobName || "-",
						j.status === "completed"
							? colors.success(j.status)
							: j.status === "failed"
								? colors.error(j.status)
								: j.status === "active"
									? colors.info(j.status)
									: colors.dim(j.status || "-"),
						String(j.attemptsMade ?? j.attempts ?? 0),
						j.timestamp ? new Date(j.timestamp).toLocaleString() : "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get job details
	queues
		.command("job")
		.argument("<queue>", "Queue name")
		.argument("<job-id>", "Job ID")
		.description("Get details of a specific job")
		.action(async (queueName, jobId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching job...");
				const job = await client.queues.getJobDetails.query({
					queueName,
					jobId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(job);
					return;
				}
				const j = job as any;
				log("");
				log(colors.bold(`Job: ${j.name || jobId}`));
				log(`  ID:       ${colors.dim(String(j.id || jobId))}`);
				log(`  Status:   ${j.status || "-"}`);
				log(`  Attempts: ${j.attemptsMade ?? 0} / ${j.opts?.attempts ?? "-"}`);
				if (j.failedReason) log(`  Error:    ${colors.error(j.failedReason)}`);
				if (j.data) {
					log("");
					log(colors.dim("Data:"));
					log(`  ${JSON.stringify(j.data).slice(0, 200)}`);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Retry a failed job
	queues
		.command("retry")
		.argument("<queue>", "Queue name")
		.argument("<job-id>", "Job ID to retry")
		.description("Retry a failed job")
		.action(async (queueName, jobId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Retrying job...");
				await client.queues.retryJob.mutate({ queueName, jobId } as any);
				succeedSpinner("Job queued for retry!");
				if (isJsonMode()) outputData({ retried: true, jobId });
			} catch (err) {
				handleError(err);
			}
		});

	// Retry all failed jobs in a queue
	queues
		.command("retry-all")
		.argument("<queue>", "Queue name")
		.description("Retry all failed jobs in a queue")
		.action(async (queueName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Retry all failed jobs in queue "${queueName}"?`,
						false,
						{
							field: "confirm_retry_all_failed_jobs",
							flag: "--yes",
							context: { queueName },
						},
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Retrying all failed jobs...");
				const result = await client.queues.retryAllFailed.mutate({
					queueName,
				} as any);
				succeedSpinner("All failed jobs queued for retry!");
				if (isJsonMode()) outputData(result);
				else {
					const count =
						(result as any)?.count ?? (result as any)?.retried ?? "all";
					log(`\n${colors.success(`${count} job(s) queued for retry.`)}\n`);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Pause a queue
	queues
		.command("pause")
		.argument("<queue>", "Queue name")
		.description("Pause a queue (stops processing new jobs)")
		.action(async (queueName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(`Pause queue "${queueName}"?`, false, {
						field: "confirm_pause_queue",
						flag: "--yes",
						context: { queueName },
					});
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Pausing queue...");
				await client.queues.pauseQueue.mutate({ queueName } as any);
				succeedSpinner(`Queue "${queueName}" paused!`);
				if (isJsonMode()) outputData({ paused: true, queueName });
			} catch (err) {
				handleError(err);
			}
		});

	// Resume a queue
	queues
		.command("resume")
		.argument("<queue>", "Queue name")
		.description("Resume a paused queue")
		.action(async (queueName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Resuming queue...");
				await client.queues.resumeQueue.mutate({ queueName } as any);
				succeedSpinner(`Queue "${queueName}" resumed!`);
				if (isJsonMode()) outputData({ resumed: true, queueName });
			} catch (err) {
				handleError(err);
			}
		});

	// Clean completed/failed jobs from a queue
	queues
		.command("clean")
		.argument("<queue>", "Queue name")
		.option(
			"-s, --status <status>",
			"Job status to clean: completed, failed",
			"completed",
		)
		.option("--older-than <ms>", "Clean jobs older than N milliseconds", "0")
		.description("Remove completed or failed jobs from a queue")
		.action(async (queueName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const status =
					options.status ||
					(await select(
						"Clean which jobs?",
						[
							{ name: "Completed", value: "completed" },
							{ name: "Failed", value: "failed" },
						],
						{ field: "clean_job_status", flag: "--status" },
					));
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Clean ${status} jobs from "${queueName}"?`,
						false,
						{
							field: "confirm_clean_queue",
							flag: "--yes",
							context: { queueName, status },
						},
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Cleaning jobs...");
				const result = await client.queues.cleanJobs.mutate({
					queueName,
					status,
					olderThan: Number.parseInt(options.olderThan || "0"),
				} as any);
				succeedSpinner("Jobs cleaned!");
				if (isJsonMode()) outputData(result);
				else {
					const count =
						(result as any)?.count ?? (result as any)?.cleaned ?? "?";
					log(`\n${colors.success(`${count} ${status} job(s) removed.`)}\n`);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Remove a specific job
	queues
		.command("remove")
		.argument("<queue>", "Queue name")
		.argument("<job-id>", "Job ID to remove")
		.description("Remove a specific job from a queue")
		.action(async (queueName, jobId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Remove job "${jobId}" from queue "${queueName}"?`,
						false,
						{
							field: "confirm_remove_job",
							flag: "--yes",
							context: { queueName, jobId },
						},
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Removing job...");
				await client.queues.removeJob.mutate({ queueName, jobId } as any);
				succeedSpinner("Job removed!");
				if (isJsonMode()) outputData({ removed: true, jobId });
			} catch (err) {
				handleError(err);
			}
		});
}
