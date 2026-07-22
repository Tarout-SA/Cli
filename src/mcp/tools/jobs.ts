/**
 * Curated MCP tools for scheduled tasks (cron): job_list, job_info, job_create,
 * job_update, job_delete, job_run, job_runs. All handlers route through
 * withAuth() and resolve the target application via resolveAppRef() so agents
 * can address apps by name OR id. They wrap the platform's `scheduledJob`
 * router.
 *
 * Two kinds of task, discriminated by `jobType`:
 *  - "HTTP"    — a signed request to the app's own public URL + targetPath.
 *                It runs INLINE, so `job_run` returns the real outcome and the
 *                timeout is capped at 60s.
 *  - "COMMAND" — a shell command executed inside the app's RUNNING container.
 *                It may run up to 15 minutes, so `job_run` only QUEUES it
 *                (`queued: true`) and the caller must poll `job_runs` for the
 *                result. The app must already be deployed.
 *
 * Annotations:
 * - readOnlyHint on job_list / job_info / job_runs
 * - destructiveHint on job_delete
 * - job_create / job_update / job_run are mutating but non-destructive (no hint)
 *
 * Note: `job_info` and `job_create` receive the task's `signingSecret` from the
 * platform, but the MCP result sanitizer redacts any `*secret*` key — read it
 * with `tarout jobs info <id>` in a terminal when an app needs to verify the
 * HMAC header.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAppRef } from "../../lib/env-core.js";
import { errorResult, withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");
const jobId = z.string().describe("Scheduled task id (from job_list).");
const jobType = z
	.enum(["HTTP", "COMMAND"])
	.describe(
		"HTTP = signed request to the app's public URL; COMMAND = shell command inside the app's running container.",
	);
const cron = z
	.string()
	.describe('5-field cron expression, e.g. "*/15 * * * *" or "0 2 * * *".');
const timezone = z
	.string()
	.describe('IANA timezone name, e.g. "Etc/UTC" or "Asia/Riyadh".');
const command = z
	.string()
	.max(4000)
	.describe(
		"Shell command run inside the container. REQUIRED when jobType is COMMAND, ignored otherwise.",
	);
const targetPath = z
	.string()
	.describe('Path on the app URL, must start with "/" (HTTP tasks).');
const httpMethod = z.enum(["POST", "GET", "PUT", "PATCH", "DELETE", "HEAD"]);
const timeoutSeconds = z
	.number()
	.int()
	.min(1)
	.max(900)
	.describe(
		"Per-run wall-clock budget. HTTP tasks are capped at 60; COMMAND tasks may use up to 900.",
	);
const failureThreshold = z
	.number()
	.int()
	.min(1)
	.max(20)
	.describe("Consecutive failures before the task starts alerting.");

/** Trimmed list shape — `job_info` returns the full object. */
function summarize(job: Record<string, unknown>) {
	return {
		id: job.id,
		name: job.name,
		applicationId: job.applicationId,
		app: (job.application as { name?: string } | undefined)?.name ?? null,
		jobType: job.jobType,
		cron: job.cron,
		timezone: job.timezone,
		target:
			job.jobType === "COMMAND"
				? job.command
				: `${job.httpMethod} ${job.targetPath}`,
		enabled: job.enabled,
		lastRunAt: job.lastRunAt,
		lastStatus: job.lastStatus,
		consecutiveFailures: job.consecutiveFailures,
	};
}

export function registerJobsTools(server: McpServer): void {
	server.registerTool(
		"job_list",
		{
			title: "List scheduled tasks (cron)",
			description:
				"Wraps scheduledJob.list; returns trimmed fields. Without `app` it lists every scheduled task in the active organization; pass `app` to scope it to one application, and `jobType` to see only HTTP or only COMMAND tasks.",
			inputSchema: {
				app: app.optional(),
				jobType: jobType.optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, jobType: type }) =>
			withAuth(async (client) => {
				const applicationId = appRef
					? (await resolveAppRef(client, appRef)).applicationId
					: undefined;
				const list = (await client.scheduledJob.list.query({
					...(applicationId ? { applicationId } : {}),
					...(type ? { jobType: type } : {}),
				})) as Array<Record<string, unknown>>;
				return { count: list.length, jobs: list.map(summarize) };
			}),
	);

	server.registerTool(
		"job_info",
		{
			title: "Full details for one scheduled task",
			description:
				"Wraps scheduledJob.get. Returns the whole task object. The HMAC `signingSecret` is part of the payload but is redacted from MCP responses — read it with `tarout jobs info <id>` in a terminal.",
			inputSchema: { id: jobId },
			annotations: { readOnlyHint: true },
		},
		async ({ id }) =>
			withAuth(async (client) => {
				const job = (await client.scheduledJob.get.query({ id })) as unknown;
				return { job };
			}),
	);

	server.registerTool(
		"job_create",
		{
			title: "Create a scheduled task on an application",
			description:
				"Wraps scheduledJob.create. jobType HTTP (default) fires a signed request at `targetPath` on the app's public URL — the app verifies the x-tarout-cron-signature header. jobType COMMAND runs `command` inside the app's running container, so the app MUST already be deployed (otherwise the server answers 'Deploy this application before adding a command task'). COMMAND requires a non-empty `command`; HTTP requires timeoutSeconds <= 60 (COMMAND may use up to 900). Plan limits apply: free = 2 tasks and at most one run per hour, paid = 20 tasks and one run per minute.",
			inputSchema: {
				app,
				name: z.string().min(1).max(100),
				cron,
				timezone: timezone.optional().default("Etc/UTC"),
				jobType: jobType.optional().default("HTTP"),
				command: command.optional(),
				targetPath: targetPath.optional().default("/"),
				httpMethod: httpMethod.optional().default("POST"),
				timeoutSeconds: timeoutSeconds.optional().default(30),
				failureThreshold: failureThreshold.optional().default(3),
				enabled: z.boolean().optional().default(true),
			},
		},
		async ({
			app: appRef,
			name,
			cron: cronExpr,
			timezone: tz,
			jobType: type,
			command: cmd,
			targetPath: path,
			httpMethod: method,
			timeoutSeconds: timeout,
			failureThreshold: threshold,
			enabled,
		}) => {
			const kind = type ?? "HTTP";
			// Rejected BEFORE withAuth so the caller sees the argument problem
			// rather than an auth error when unauthenticated.
			if (kind === "COMMAND" && !cmd?.trim()) {
				return errorResult({
					error: "COMMAND tasks require a non-empty `command`.",
					code: "INVALID_ARGUMENTS",
					remediation:
						"Pass `command` with the shell command to run inside the container, or use jobType 'HTTP'.",
				});
			}
			return withAuth(async (client) => {
				const { applicationId, name: appName } = await resolveAppRef(
					client,
					appRef,
				);
				const job = (await client.scheduledJob.create.mutate({
					applicationId,
					name,
					cron: cronExpr,
					timezone: tz ?? "Etc/UTC",
					jobType: kind,
					...(kind === "COMMAND" ? { command: cmd?.trim() } : {}),
					targetPath: path ?? "/",
					httpMethod: method ?? "POST",
					timeoutSeconds: timeout ?? 30,
					failureThreshold: threshold ?? 3,
					enabled: enabled ?? true,
				})) as Record<string, unknown>;
				return { created: true, app: { applicationId, name: appName }, job };
			});
		},
	);

	server.registerTool(
		"job_update",
		{
			title: "Update a scheduled task",
			description:
				"Wraps scheduledJob.update — a partial update, only the fields you send change. Use `enabled` to pause/resume a task without deleting it. The server validates the MERGED shape, so switching an HTTP task to COMMAND must send `command` in the same call, and the app must be deployed.",
			inputSchema: {
				id: jobId,
				name: z.string().min(1).max(100).optional(),
				cron: cron.optional(),
				timezone: timezone.optional(),
				jobType: jobType.optional(),
				command: command.optional(),
				targetPath: targetPath.optional(),
				httpMethod: httpMethod.optional(),
				timeoutSeconds: timeoutSeconds.optional(),
				failureThreshold: failureThreshold.optional(),
				enabled: z.boolean().optional(),
			},
		},
		async ({ id, ...changes }) =>
			withAuth(async (client) => {
				const updates = Object.fromEntries(
					Object.entries(changes).filter(([, v]) => v !== undefined),
				);
				const job = (await client.scheduledJob.update.mutate({
					id,
					...updates,
				})) as unknown;
				return { updated: true, job };
			}),
	);

	server.registerTool(
		"job_delete",
		{
			title: "Delete a scheduled task (irreversible)",
			description:
				"Wraps scheduledJob.delete. Also drops the task's run history. To pause a task instead, call job_update with enabled=false.",
			inputSchema: { id: jobId },
			annotations: { destructiveHint: true },
		},
		async ({ id }) =>
			withAuth(async (client) => {
				const result = (await client.scheduledJob.delete.mutate({
					id,
				})) as unknown;
				return { deleted: true, id, result };
			}),
	);

	server.registerTool(
		"job_run",
		{
			title: "Run a scheduled task immediately",
			description:
				"Wraps scheduledJob.runNow. HTTP tasks run inline: the result comes back with queued=false plus ok/statusCode/durationMs. COMMAND tasks can run for up to 15 minutes, so they are QUEUED — the result is queued=true, status='queued' and NOTHING about the outcome. In that case poll `job_runs` with the same id (every few seconds) until a run newer than the previous one appears, and read its exitCode/output from there.",
			inputSchema: { id: jobId },
		},
		async ({ id }) =>
			withAuth(async (client) => {
				const result = (await client.scheduledJob.runNow.mutate({
					id,
				})) as Record<string, unknown>;
				return {
					...result,
					nextStep:
						result.queued === true
							? `Command task queued — poll job_runs with id "${id}" for the exitCode and output.`
							: null,
				};
			}),
	);

	server.registerTool(
		"job_runs",
		{
			title: "Run history for a scheduled task",
			description:
				"Wraps scheduledJob.runs — newest first. Each run carries ranAt, ok, statusCode (HTTP tasks), exitCode (COMMAND tasks), durationMs, error, output (captured stdout/stderr, COMMAND only) and trigger ('schedule' or 'manual'). This is how you collect the result of a COMMAND task queued by job_run.",
			inputSchema: {
				id: jobId,
				limit: z.number().int().min(1).max(100).optional().default(20),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ id, limit }) =>
			withAuth(async (client) => {
				const runs = (await client.scheduledJob.runs.query({
					id,
					limit: limit ?? 20,
				})) as Array<Record<string, unknown>>;
				return { count: runs.length, runs };
			}),
	);
}
