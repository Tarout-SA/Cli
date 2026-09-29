/**
 * @fileoverview The agent activity timeline, shared by `tarout agent events`
 * and the stdio MCP `agent_events` tool. Wraps the platform's
 * `dashboard.getAgentActivity`.
 *
 * What the feed holds: one row per MUTATION an agent made (plus guardrail
 * refusals), written by the platform's protectedProcedure middleware. Reads are
 * not logged. The scope is "agent", the `tarout` CLI and MCP surfaces, which is
 * what the dashboard's Agent page shows; dashboard (web) clicks and raw REST
 * integrations are left out.
 *
 * The procedure has no time filter and returns newest first, 100 rows a page at
 * most, with a cursor. `since` is therefore applied here, by paging back until a
 * row is older than the cutoff.
 *
 * Following is polling today. {@link watchAgentEvents} is the only place that
 * knows that: callers get batches through `onEvents`, so a server-sent stream
 * can replace the loop without touching them.
 * @module lib/agent-events
 */

import { approvalsDashboardUrl } from "./approvals.js";
import {
	CliError,
	InvalidArgumentError,
	isMissingProcedureError,
} from "./errors.js";
import { ExitCode } from "../utils/exit-codes.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

const PROCEDURE = "dashboard.getAgentActivity";

/** The server's page size cap. */
const PAGE_SIZE = 100;
export const DEFAULT_EVENTS_LIMIT = 30;
/** Also the default when `since` is given without a limit. */
export const MAX_EVENTS_LIMIT = 500;

/** Poll interval for `--follow`. Hardcoded on purpose: no env var. */
export const FOLLOW_INTERVAL_MS = 3000;
/**
 * A row is written after its request finishes, so one can become visible after
 * a newer one was already printed. Each poll rescans this far behind the newest
 * row it has seen, and ids already printed are skipped.
 */
export const FOLLOW_OVERLAP_MS = 30_000;
/** Pages read per poll at most (a 3s burst above 500 rows is cut). */
const FOLLOW_MAX_PAGES = 5;
/** Consecutive poll failures tolerated before giving up, as `logs --follow`. */
const FOLLOW_MAX_CONSECUTIVE_ERRORS = 3;

export interface AgentEvent {
	id: string;
	/** ISO timestamp. */
	at: string;
	/** tRPC path, e.g. `application.deployToCloud`. */
	procedure: string;
	/** `cli` or `mcp`. */
	surface: string;
	/** `ok` or `error`. */
	status: string;
	/** Display name of the key that made the call. */
	keyName: string | null;
	apiKeyId: string | null;
	resourceId: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	durationMs: number | null;
	/** The call's input as the platform stored it (secrets already redacted). */
	input?: unknown;
}

interface RawActivityItem {
	id?: unknown;
	router?: unknown;
	proc?: unknown;
	surface?: unknown;
	status?: unknown;
	at?: unknown;
	apiKeyId?: unknown;
	keyName?: unknown;
	resourceId?: unknown;
	errorCode?: unknown;
	errorMessage?: unknown;
	durationMs?: unknown;
	input?: unknown;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function toAgentEvent(item: RawActivityItem): AgentEvent {
	const router = str(item.router) ?? "";
	const proc = str(item.proc);
	const event: AgentEvent = {
		id: String(item.id ?? ""),
		at: str(item.at) ?? new Date(0).toISOString(),
		procedure: proc ? `${router}.${proc}` : router,
		surface: str(item.surface) ?? "api",
		status: str(item.status) ?? "ok",
		keyName: str(item.keyName),
		apiKeyId: str(item.apiKeyId),
		resourceId: str(item.resourceId),
		errorCode: str(item.errorCode),
		errorMessage: str(item.errorMessage),
		durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
	};
	if (item.input !== undefined) event.input = item.input;
	return event;
}

function eventTime(event: AgentEvent): number {
	const ms = Date.parse(event.at);
	return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Oldest first. The server sends newest first (id breaks timestamp ties), so
 * the reverse is already ordered; the stable sort only fixes batches that
 * were gathered across polls.
 */
function oldestFirst(newestFirst: AgentEvent[]): AgentEvent[] {
	return [...newestFirst]
		.reverse()
		.sort((a, b) => eventTime(a) - eventTime(b));
}

/** 1 to {@link MAX_EVENTS_LIMIT}; undefined when not given. */
export function parseEventsLimit(
	value: unknown,
	max = MAX_EVENTS_LIMIT,
): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const raw = String(value).trim();
	const limit = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isInteger(limit) || limit < 1 || limit > max) {
		throw new InvalidArgumentError(
			`--limit must be a whole number from 1 to ${max}.`,
		);
	}
	return limit;
}

/**
 * `90s`, `15m`, `2h`, `7d`, `1h30m`; a bare number is seconds. Returns
 * milliseconds.
 */
export function parseSinceDuration(value: unknown, flag = "--since"): number {
	const raw = String(value ?? "")
		.trim()
		.toLowerCase();
	let seconds: number | undefined;
	if (/^\d+$/.test(raw)) {
		seconds = Number.parseInt(raw, 10);
	} else if (/^(\d+[dhms])+$/.test(raw)) {
		seconds = 0;
		for (const [, amount, unit] of raw.matchAll(/(\d+)([dhms])/g)) {
			const multiplier =
				unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
			seconds += Number.parseInt(amount ?? "0", 10) * multiplier;
		}
	}
	if (seconds === undefined || seconds <= 0) {
		throw new InvalidArgumentError(
			`${flag} must be a duration such as 15m, 2h, 7d or 1h30m (a bare number is seconds).`,
		);
	}
	return seconds * 1000;
}

/**
 * An older server without the procedure, as a readable NOT_FOUND. Refusals
 * (FORBIDDEN) pass through untouched: the CLI command and the MCP runtime each
 * explain them in their own envelope.
 */
function readError(err: unknown): unknown {
	if (!isMissingProcedureError(err)) return err;
	return new CliError(
		`This Tarout server has no agent activity feed yet (${PROCEDURE} is missing). The dashboard's Agent page shows it: ${approvalsDashboardUrl()}`,
		ExitCode.NOT_FOUND,
		undefined,
		{
			procedure: PROCEDURE,
			reason: "procedure_unavailable",
			dashboardUrl: approvalsDashboardUrl(),
		},
	);
}

async function queryPage(
	client: TrpcClient,
	limit: number,
	cursor: string | undefined,
): Promise<{ items: AgentEvent[]; nextCursor?: string }> {
	let page: { items?: unknown; nextCursor?: unknown } | undefined;
	try {
		page = await client.dashboard.getAgentActivity.query({
			scope: "agent",
			limit,
			...(cursor ? { cursor } : {}),
		});
	} catch (err) {
		throw readError(err);
	}
	const items = Array.isArray(page?.items) ? page.items : [];
	return {
		items: items.map((item) => toAgentEvent((item ?? {}) as RawActivityItem)),
		nextCursor: str(page?.nextCursor) ?? undefined,
	};
}

export interface FetchAgentEventsOptions {
	/** Most rows to return. Default 30, or 500 when `sinceMs` is set. */
	limit?: number;
	/** Only rows newer than this many milliseconds ago. */
	sinceMs?: number;
	now?: () => number;
}

/** The effective row cap for a fetch. */
export function resolveEventsLimit(options: FetchAgentEventsOptions): number {
	return (
		options.limit ??
		(options.sinceMs !== undefined ? MAX_EVENTS_LIMIT : DEFAULT_EVENTS_LIMIT)
	);
}

/**
 * The most recent agent events, OLDEST FIRST (newest last, like a log). Pages
 * back until `limit` rows are collected, the feed ends, or a row is older than
 * `sinceMs`.
 */
export async function fetchAgentEvents(
	client: TrpcClient,
	options: FetchAgentEventsOptions = {},
): Promise<AgentEvent[]> {
	const limit = resolveEventsLimit(options);
	const now = options.now ?? Date.now;
	const cutoff =
		options.sinceMs !== undefined ? now() - options.sinceMs : undefined;
	const collected: AgentEvent[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await queryPage(
			client,
			Math.min(PAGE_SIZE, limit - collected.length),
			cursor,
		);
		for (const event of page.items) {
			if (cutoff !== undefined && eventTime(event) < cutoff) {
				return oldestFirst(collected);
			}
			collected.push(event);
			if (collected.length >= limit) return oldestFirst(collected);
		}
		if (!page.nextCursor || page.items.length === 0) break;
		cursor = page.nextCursor;
	}
	return oldestFirst(collected);
}

export interface WatchAgentEventsOptions extends FetchAgentEventsOptions {
	/** Called with the backlog, then with each batch of new rows, oldest first. */
	onEvents: (events: AgentEvent[]) => void;
	intervalMs?: number;
	/** Test seam, and the hook a caller uses to make Ctrl+C wake the loop. */
	sleep?: (ms: number) => Promise<void>;
	/** Checked after every poll and every sleep. */
	isInterrupted?: () => boolean;
}

/**
 * Prints the backlog (the same rows {@link fetchAgentEvents} returns), then
 * delivers only rows it has not delivered before until interrupted.
 *
 * Deduplication is by id. A row is new when it is unseen and not older than
 * the floor: the older of "the oldest backlog row" (rows the limit cut are old,
 * not new) and "newest seen minus {@link FOLLOW_OVERLAP_MS}" (late writes).
 * Seen ids below the floor are forgotten, so memory stays flat on a long tail.
 *
 * The backlog fetch fails loudly. After that, up to three consecutive poll
 * failures are tolerated; the third is thrown.
 */
export async function watchAgentEvents(
	client: TrpcClient,
	options: WatchAgentEventsOptions,
): Promise<void> {
	const now = options.now ?? Date.now;
	const intervalMs = options.intervalMs ?? FOLLOW_INTERVAL_MS;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const interrupted = () => options.isInterrupted?.() === true;

	const backlog = await fetchAgentEvents(client, options);
	const seen = new Map<string, number>();
	let newest = Number.NEGATIVE_INFINITY;
	for (const event of backlog) {
		seen.set(event.id, eventTime(event));
		newest = Math.max(newest, eventTime(event));
	}
	const oldestBacklog = backlog[0];
	let backlogFloor: number;
	if (oldestBacklog) {
		backlogFloor = eventTime(oldestBacklog);
	} else if (options.sinceMs !== undefined) {
		backlogFloor = now() - options.sinceMs;
	} else {
		// An empty feed: everything that appears from now on is new.
		backlogFloor = Number.NEGATIVE_INFINITY;
	}
	if (backlog.length > 0) options.onEvents(backlog);

	let consecutiveErrors = 0;
	for (;;) {
		if (interrupted()) return;
		await sleep(intervalMs);
		if (interrupted()) return;

		const floor = Math.max(backlogFloor, newest - FOLLOW_OVERLAP_MS);
		const fresh: AgentEvent[] = [];
		try {
			let cursor: string | undefined;
			scan: for (let pages = 0; pages < FOLLOW_MAX_PAGES; pages++) {
				const page = await queryPage(client, PAGE_SIZE, cursor);
				for (const event of page.items) {
					if (eventTime(event) < floor) break scan;
					if (!seen.has(event.id)) fresh.push(event);
				}
				if (!page.nextCursor || page.items.length === 0) break;
				cursor = page.nextCursor;
			}
			consecutiveErrors = 0;
		} catch (err) {
			consecutiveErrors++;
			if (consecutiveErrors >= FOLLOW_MAX_CONSECUTIVE_ERRORS) throw err;
			continue;
		}

		if (fresh.length > 0) {
			for (const event of fresh) {
				seen.set(event.id, eventTime(event));
				newest = Math.max(newest, eventTime(event));
			}
			options.onEvents(oldestFirst(fresh));
		}
		const keepFrom = Math.max(backlogFloor, newest - FOLLOW_OVERLAP_MS);
		for (const [id, at] of seen) {
			if (at < keepFrom) seen.delete(id);
		}
	}
}
