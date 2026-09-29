/**
 * @fileoverview Agent approval requests, shared by `tarout approvals` and the
 * stdio MCP tools. Wraps the platform's `approvals` router.
 *
 * When an operator-tier API key calls a destructive procedure, the platform
 * parks the call as a pending approval and refuses it with FORBIDDEN, reason
 * `needs_approval`, message `NEEDS_APPROVAL:<id>: ...`. A human then approves
 * or denies it in the dashboard; approving replays the call with the human's
 * privileges. Requests expire after 24 hours.
 *
 * Only `approvals.list` and `approvals.get` are callable with an API key.
 * `approve` and `deny` require a signed-in human session by design (an agent
 * must never approve its own request), so the CLI deliberately has no command
 * for them.
 * @module lib/approvals
 */

import { getApiUrl } from "./config.js";
import { InvalidArgumentError } from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/**
 * Statuses a caller can filter on. `approved` also exists, but only for the
 * moment between a human's click and the replay finishing, so it is not a
 * useful filter.
 */
export const APPROVAL_STATUSES = [
	"pending",
	"executed",
	"failed",
	"denied",
	"expired",
] as const;

export type ApprovalFilterStatus = (typeof APPROVAL_STATUSES)[number];

/** A request in one of these will never change again. */
const TERMINAL_STATUSES = new Set(["executed", "failed", "denied", "expired"]);

/** The server's `list` input: `limit` applies to each group, max 50. */
export const DEFAULT_APPROVALS_LIMIT = 20;
export const MAX_APPROVALS_LIMIT = 50;

/** Requests expire after 24h, so waiting longer than that is never useful. */
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_WAIT_MS = 30 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const MAX_POLL_INTERVAL_SECONDS = 3600;

export interface Approval {
	id: string;
	procedure: string;
	input?: unknown;
	reason?: string | null;
	status: string;
	resultSummary?: string | null;
	apiKeyId?: string | null;
	/** Present on `list` rows; `get` returns it only when looked up. */
	keyName?: string | null;
	decidedAt?: string | Date | null;
	executedAt?: string | Date | null;
	createdAt: string | Date;
	expiresAt: string | Date;
}

export function isTerminalApprovalStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status);
}

/** Where a human approves or denies requests (the Agent page's approvals card). */
export function approvalsDashboardUrl(): string {
	let base = "https://tarout.sa";
	try {
		base = getApiUrl();
	} catch {
		// A rejected TAROUT_API_URL must not hide the link; the default host is
		// still where the dashboard lives.
	}
	return `${base.replace(/\/+$/, "")}/dashboard/agent`;
}

export function parseApprovalStatus(
	value: unknown,
): ApprovalFilterStatus | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const normalized = String(value).trim().toLowerCase();
	const match = APPROVAL_STATUSES.find((status) => status === normalized);
	if (!match) {
		throw new InvalidArgumentError(
			`Invalid --status "${String(value)}". Use one of: ${APPROVAL_STATUSES.join(", ")}.`,
		);
	}
	return match;
}

export function parseApprovalsLimit(value: unknown): number {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_APPROVALS_LIMIT;
	}
	const raw = String(value).trim();
	const limit = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_APPROVALS_LIMIT) {
		throw new InvalidArgumentError(
			`--limit must be a whole number from 1 to ${MAX_APPROVALS_LIMIT}.`,
		);
	}
	return limit;
}

/**
 * `30m`, `90s`, `2h`, `1h30m`; a bare number is seconds. Returns milliseconds.
 * Capped at 24h because a request expires by then.
 */
export function parseWaitTimeout(value: unknown, flag = "--timeout"): number {
	const raw = String(value ?? "")
		.trim()
		.toLowerCase();
	let seconds: number | undefined;
	if (/^\d+$/.test(raw)) {
		seconds = Number.parseInt(raw, 10);
	} else if (/^(\d+[hms])+$/.test(raw)) {
		seconds = 0;
		for (const [, amount, unit] of raw.matchAll(/(\d+)([hms])/g)) {
			const multiplier = unit === "h" ? 3600 : unit === "m" ? 60 : 1;
			seconds += Number.parseInt(amount ?? "0", 10) * multiplier;
		}
	}
	if (seconds === undefined || seconds <= 0) {
		throw new InvalidArgumentError(
			`${flag} must be a duration such as 30m, 90s, 2h or 1h30m (a bare number is seconds).`,
		);
	}
	const ms = seconds * 1000;
	if (ms > MAX_WAIT_MS) {
		throw new InvalidArgumentError(
			`${flag} cannot exceed 24h: approval requests expire after 24 hours.`,
		);
	}
	return ms;
}

/** Whole seconds between polls, 1 to 3600. Returns milliseconds. */
export function parsePollInterval(value: unknown, flag = "--interval"): number {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_POLL_INTERVAL_SECONDS * 1000;
	}
	const raw = String(value).trim();
	const seconds = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (
		!Number.isInteger(seconds) ||
		seconds < 1 ||
		seconds > MAX_POLL_INTERVAL_SECONDS
	) {
		throw new InvalidArgumentError(
			`${flag} must be a whole number of seconds from 1 to ${MAX_POLL_INTERVAL_SECONDS}.`,
		);
	}
	return seconds * 1000;
}

/** Milliseconds as the shortest `1h30m` / `45s` form, for messages. */
export function formatWaitDuration(ms: number): string {
	let seconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	seconds -= hours * 3600;
	const minutes = Math.floor(seconds / 60);
	seconds -= minutes * 60;
	const parts = [
		hours ? `${hours}h` : "",
		minutes ? `${minutes}m` : "",
		seconds ? `${seconds}s` : "",
	].filter(Boolean);
	return parts.length ? parts.join("") : "0s";
}

/**
 * Pending requests first, then decided history, as one list. The server has
 * no status filter and applies `limit` to each group, so `status` filters the
 * rows it returned and the result is cut back to `limit`.
 */
export async function listApprovals(
	client: TrpcClient,
	options: { status?: ApprovalFilterStatus; limit?: number } = {},
): Promise<Approval[]> {
	const limit = options.limit ?? DEFAULT_APPROVALS_LIMIT;
	const result = (await client.approvals.list.query({ limit })) as {
		pending?: Approval[];
		decided?: Approval[];
	};
	const rows = [...(result?.pending ?? []), ...(result?.decided ?? [])];
	const filtered = options.status
		? rows.filter((row) => row.status === options.status)
		: rows;
	return filtered.slice(0, limit);
}

/**
 * One request by id. `get` does not return the requesting key's name, so
 * `withKeyName` looks it up from the recent list (best-effort: a request older
 * than the 50 most recent keeps only its `apiKeyId`).
 */
export async function getApproval(
	client: TrpcClient,
	id: string,
	options: { withKeyName?: boolean } = {},
): Promise<Approval> {
	const approval = (await client.approvals.get.query({ id })) as Approval;
	if (!options.withKeyName || approval.keyName !== undefined) return approval;
	try {
		const recent = await listApprovals(client, { limit: MAX_APPROVALS_LIMIT });
		const match = recent.find((row) => row.id === approval.id);
		return { ...approval, keyName: match?.keyName ?? null };
	} catch {
		return approval;
	}
}

export type ApprovalWaitOutcome = "terminal" | "timeout" | "interrupted";

export interface ApprovalWaitResult {
	outcome: ApprovalWaitOutcome;
	/** The last state seen; terminal when `outcome` is "terminal". */
	approval: Approval;
}

export interface WaitForApprovalOptions {
	timeoutMs: number;
	intervalMs: number;
	/** Test seam, and the hook a caller uses to make Ctrl+C wake the loop. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Checked after every poll and every sleep. */
	isInterrupted?: () => boolean;
	/** Called with the first state and again whenever the status changes. */
	onStatus?: (approval: Approval) => void;
}

/**
 * Polls `approvals.get` until the request is executed, failed, denied or
 * expired. Polls once immediately, so an already-decided id returns at once,
 * and once more at the deadline. `approved` (a human clicked, the replay is
 * still running) keeps it polling. API errors propagate: a NOT_FOUND or a
 * rejected credential will not fix itself by waiting, and transport blips are
 * already retried by the client's fetch.
 */
export async function waitForApproval(
	client: TrpcClient,
	id: string,
	options: WaitForApprovalOptions,
): Promise<ApprovalWaitResult> {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const interrupted = () => options.isInterrupted?.() === true;
	const deadline = now() + options.timeoutMs;
	let lastStatus: string | undefined;

	for (;;) {
		const approval = await getApproval(client, id);
		if (approval.status !== lastStatus) {
			lastStatus = approval.status;
			options.onStatus?.(approval);
		}
		if (isTerminalApprovalStatus(approval.status)) {
			return { outcome: "terminal", approval };
		}
		if (interrupted()) return { outcome: "interrupted", approval };
		const remaining = deadline - now();
		if (remaining <= 0) return { outcome: "timeout", approval };
		await sleep(Math.min(options.intervalMs, remaining));
		if (interrupted()) return { outcome: "interrupted", approval };
	}
}
