/**
 * @fileoverview Agent approval requests (`tarout approvals`). Wraps the
 * platform's `approvals` router through lib/approvals.
 *
 * An operator-tier API key that calls a destructive procedure gets FORBIDDEN
 * with `NEEDS_APPROVAL:<id>`: the call is parked until a human approves or
 * denies it in the dashboard. These commands let the agent see and wait on
 * that decision. There is deliberately no approve or deny command: the
 * platform refuses both to API keys, because an agent must never approve its
 * own request.
 * @module commands/approvals
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import {
	APPROVAL_STATUSES,
	type Approval,
	type ApprovalWaitResult,
	approvalsDashboardUrl,
	DEFAULT_APPROVALS_LIMIT,
	DEFAULT_POLL_INTERVAL_SECONDS,
	DEFAULT_WAIT_MS,
	formatWaitDuration,
	getApproval,
	listApprovals,
	parseApprovalStatus,
	parseApprovalsLimit,
	parsePollInterval,
	parseWaitTimeout,
	waitForApproval,
} from "../lib/approvals.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, approvalWaitCommand, handleError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	outputError,
	quietOutput,
	success,
	table,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import {
	startSpinner,
	stopSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

export function registerApprovalsCommands(program: Command) {
	const approvals = program
		.command("approvals")
		.description("See and wait on approval requests for agent actions")
		.addHelpText(
			"after",
			() =>
				`\nNote: a human approves or denies requests in the dashboard (${approvalsDashboardUrl()}); an agent cannot approve its own request.`,
		);

	approvals
		.command("list")
		.alias("ls")
		.description("List approval requests, pending first")
		.option(
			"-s, --status <status>",
			`Only this status: ${APPROVAL_STATUSES.join(", ")} (filters the most recent requests)`,
		)
		.option(
			"-n, --limit <n>",
			`How many to show, 1 to 50 (default ${DEFAULT_APPROVALS_LIMIT})`,
		)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const status = parseApprovalStatus(options.status);
				const limit = parseApprovalsLimit(options.limit);
				const client = getApiClient();

				const _spinner = startSpinner("Fetching approval requests...");
				const rows = await listApprovals(client, { status, limit });
				succeedSpinner();

				if (isJsonMode()) {
					outputData(rows);
					return;
				}

				if (!rows.length) {
					log("");
					log(
						status
							? `No ${status} approval requests.`
							: "No approval requests.",
					);
					return;
				}

				log("");
				table(
					["ID", "PROCEDURE", "STATUS", "REQUESTED BY", "CREATED", "EXPIRES"],
					rows.map((row) => [
						colors.cyan(row.id),
						row.procedure,
						formatApprovalStatus(row.status),
						describeRequester(row),
						formatDateTime(row.createdAt),
						row.status === "pending"
							? formatDateTime(row.expiresAt)
							: colors.dim("-"),
					]),
				);
				log("");
				log(
					colors.dim(`${rows.length} request${rows.length === 1 ? "" : "s"}`),
				);
				if (rows.some((row) => row.status === "pending")) {
					log(
						`Approve or deny pending requests at ${colors.cyan(approvalsDashboardUrl())}`,
					);
					log(`Wait for one: ${colors.dim("tarout approvals wait <id>")}`);
				}
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	approvals
		.command("get")
		.alias("info")
		.argument("<id>", "Approval request ID (from the NEEDS_APPROVAL error)")
		.description("Show one approval request and its outcome")
		.action(async (id: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching approval request...");
				const approval = await getApproval(client, id, { withKeyName: true });
				succeedSpinner();

				if (isJsonMode()) {
					outputData(approval);
					return;
				}

				quietOutput(approval.status);
				printApproval(approval);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	approvals
		.command("wait")
		.argument("<id>", "Approval request ID (from the NEEDS_APPROVAL error)")
		.description(
			"Wait until a human decides; exits 0 only when the action was executed",
		)
		.option(
			"--timeout <duration>",
			"How long to wait: 30m, 90s, 2h or 1h30m; a bare number is seconds (default 30m, max 24h)",
		)
		.option(
			"--interval <seconds>",
			`Seconds between checks (default ${DEFAULT_POLL_INTERVAL_SECONDS})`,
		)
		.action(
			async (id: string, options: { timeout?: string; interval?: string }) => {
				// Ctrl+C only flips a flag and wakes the current sleep; the loop then
				// reports the request as still pending. Exiting 0 from the handler
				// would read as "executed" to a script.
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

				let timeoutMs: number;
				let result: ApprovalWaitResult;
				try {
					if (!isLoggedIn()) throw new AuthError();

					timeoutMs =
						options.timeout === undefined
							? DEFAULT_WAIT_MS
							: parseWaitTimeout(options.timeout);
					const intervalMs = parsePollInterval(options.interval);
					const client = getApiClient();

					log(
						`Waiting up to ${formatWaitDuration(timeoutMs)} for a human to decide on approval ${colors.cyan(id)}.`,
					);
					log(
						`Approve or deny it at ${colors.cyan(approvalsDashboardUrl())} ${colors.dim("(Ctrl+C stops waiting; the request stays open)")}`,
					);
					const _spinner = startSpinner("Waiting for a decision...");

					process.once("SIGINT", onSigint);
					result = await waitForApproval(client, id, {
						timeoutMs,
						intervalMs,
						sleep,
						isInterrupted: () => interrupted,
						onStatus: (approval) =>
							updateSpinner(
								approval.status === "approved"
									? `Approved; running ${approval.procedure}...`
									: `Waiting for a decision on ${approval.procedure}...`,
							),
					});
				} catch (err) {
					stopSpinner();
					handleError(err);
				} finally {
					process.removeListener("SIGINT", onSigint);
				}

				const code = reportWaitResult(result, timeoutMs);
				if (code !== ExitCode.SUCCESS) exit(code);
			},
		);
}

/**
 * Prints the outcome of `approvals wait` (one envelope in --json) and returns
 * the exit code:
 *   executed           0  SUCCESS
 *   denied             5  PERMISSION_DENIED (a human refused it)
 *   expired / failed   1  GENERAL_ERROR (it did not run, or errored when run)
 *   still pending     11  DEPLOYMENT_TIMEOUT (timeout or Ctrl+C; resumable)
 */
export function reportWaitResult(
	result: ApprovalWaitResult,
	timeoutMs: number,
): number {
	const { approval } = result;
	stopSpinner();
	const details = { ...approval, dashboardUrl: approvalsDashboardUrl() };

	if (result.outcome !== "terminal") {
		const interrupted = result.outcome === "interrupted";
		outputError(
			"APPROVAL_PENDING",
			interrupted
				? `Stopped waiting. Approval ${approval.id} (${approval.procedure}) is still ${approval.status}; nothing was cancelled.`
				: `Approval ${approval.id} (${approval.procedure}) is still ${approval.status} after ${formatWaitDuration(timeoutMs)}.`,
			{
				...details,
				stillPending: true,
				...(interrupted ? { interrupted: true } : {}),
				nextCommand: approvalWaitCommand(approval.id),
			},
		);
		return ExitCode.DEPLOYMENT_TIMEOUT;
	}

	switch (approval.status) {
		case "executed":
			if (isJsonMode()) {
				outputData(approval);
			} else {
				quietOutput("executed");
				success(`Approved and executed: ${approval.procedure}`);
				log(`  ${approval.resultSummary || "Executed successfully"}`);
			}
			return ExitCode.SUCCESS;
		case "denied":
			outputError(
				"APPROVAL_DENIED",
				`A human denied ${approval.procedure} (approval ${approval.id}), so it did not run. Do not retry it; ask the user how to proceed.`,
				details,
			);
			return ExitCode.PERMISSION_DENIED;
		case "expired":
			outputError(
				"APPROVAL_EXPIRED",
				`Nobody decided on ${approval.procedure} (approval ${approval.id}) within 24 hours, so it expired and did not run. If it is still needed, check with the user, then run the action again to request a new approval.`,
				details,
			);
			return ExitCode.GENERAL_ERROR;
		default:
			outputError(
				"APPROVAL_FAILED",
				`${approval.procedure} was approved but failed when it ran: ${approval.resultSummary || "no error was recorded"}`,
				details,
			);
			return ExitCode.GENERAL_ERROR;
	}
}

function printApproval(approval: Approval): void {
	log("");
	log(colors.bold(`Approval ${approval.id}`));
	log("");
	log(`  Procedure:     ${colors.cyan(approval.procedure)}`);
	log(`  Status:        ${formatApprovalStatus(approval.status)}`);
	log(`  Requested by:  ${describeRequester(approval)}`);
	if (approval.reason) log(`  Reason:        ${approval.reason}`);
	const input = formatInput(approval.input);
	if (input) log(`  Input:         ${input}`);
	log(`  Created:       ${formatDateTime(approval.createdAt)}`);
	if (approval.status === "pending" || approval.status === "approved") {
		log(`  Expires:       ${formatDateTime(approval.expiresAt)}`);
	}
	if (approval.decidedAt) {
		log(`  Decided:       ${formatDateTime(approval.decidedAt)}`);
	}
	if (approval.executedAt) {
		log(`  Executed:      ${formatDateTime(approval.executedAt)}`);
	}
	if (approval.status === "executed") {
		log(`  Result:        ${approval.resultSummary || "Executed successfully"}`);
	} else if (approval.status === "failed") {
		log(
			`  Error:         ${colors.error(approval.resultSummary || "no error was recorded")}`,
		);
	}
	log("");
	if (approval.status === "pending") {
		log(
			`A human approves or denies it at ${colors.cyan(approvalsDashboardUrl())}`,
		);
		log(
			`Wait for the decision: ${colors.dim(approvalWaitCommand(approval.id))}`,
		);
		log("");
	}
}

function formatApprovalStatus(status: string): string {
	switch (status) {
		case "pending":
			return colors.warn("○ pending");
		case "approved":
			return colors.info("◐ approved");
		case "executed":
			return colors.success("✓ executed");
		case "failed":
			return colors.error("✗ failed");
		case "denied":
			return colors.error("✗ denied");
		case "expired":
			return colors.dim("○ expired");
		default:
			return status;
	}
}

/** The key's name when known, else a short key id. */
function describeRequester(approval: Approval): string {
	if (approval.keyName) return approval.keyName;
	if (approval.apiKeyId) return `key ${approval.apiKeyId.slice(0, 8)}`;
	return colors.dim("-");
}

function formatInput(input: unknown): string | undefined {
	if (input === undefined || input === null) return undefined;
	let text: string;
	try {
		text = JSON.stringify(input);
	} catch {
		return undefined;
	}
	if (!text || text === "{}") return undefined;
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
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
