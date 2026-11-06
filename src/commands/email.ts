/**
 * @fileoverview Tarout Email (`tarout email`). Wraps the platform's `email`
 * router: the sending service, sending domains, email API keys, event
 * webhooks, the suppression list, delivery logs and the daily quota.
 *
 * Every procedure is scoped to the session's ACTIVE PROJECT — none of them
 * takes a project id — so these commands act on whatever `tarout projects use`
 * (or `--project`) selected. The service auto-provisions the first time any of
 * them touches it, so there is nothing to create: `email status` always
 * answers, and a brand-new project answers `sandbox`.
 *
 * The product is gated behind a server-side launch flag. Until it flips, every
 * procedure answers PRECONDITION_FAILED with a "coming soon" message for every
 * caller except Tarout root admins. `handleEmailError` turns that one refusal
 * into a plain-language explanation (and an `EMAIL_NOT_LAUNCHED` envelope under
 * `--json`) instead of leaking a raw tRPC error, and every subcommand routes
 * its catch through it. Nothing here hardcodes the gate: it is detected from
 * the server's answer, so the day the flag flips these commands simply start
 * working.
 * @module commands/email
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	InvalidArgumentError,
	NotFoundError,
	handleError,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	outputError,
	quietOutput,
	shouldSkipConfirmation,
	success,
	table,
	warn,
} from "../lib/output.js";
import { confirm } from "../utils/prompts.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import {
	startSpinner,
	stopSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

// ---------------------------------------------------------------------------
// Vocabulary (mirrors src/server/validations/email.ts)
// ---------------------------------------------------------------------------

/** The eight customer-visible webhook events, in the server's order. */
export const EMAIL_WEBHOOK_EVENTS = [
	"email.sent",
	"email.delivered",
	"email.delivery_delayed",
	"email.bounced",
	"email.complained",
	"email.failed",
	"email.opened",
	"email.clicked",
] as const;

/** The ten states a logged message can be in. */
export const EMAIL_LOG_STATUSES = [
	"queued",
	"scheduled",
	"sent",
	"delivered",
	"delivery_delayed",
	"bounced",
	"complained",
	"failed",
	"canceled",
	"suppressed",
] as const;

/** The five states a sending domain can be in. */
export const EMAIL_DOMAIN_STATUSES = [
	"not_started",
	"pending",
	"verified",
	"temporary_failure",
	"failed",
] as const;

/** API key scopes. `full_access` manages the service; `sending_access` only sends. */
export const EMAIL_API_KEY_SCOPES = ["full_access", "sending_access"] as const;

/** Why an address is on the do-not-send list. */
export const EMAIL_SUPPRESSION_REASONS = [
	"manual",
	"bounce",
	"complaint",
] as const;

/** Hours a domain has to verify before the platform marks it `failed`. */
export const DOMAIN_VERIFY_WINDOW_HOURS = 72;

/** `listSuppressions` is hard-capped at this many rows, with no cursor and no filter. */
export const SUPPRESSION_LIST_CAP = 500;

/** Most active email API keys a project may hold. */
export const MAX_EMAIL_API_KEYS = 20;

/** Most active webhook endpoints a project may hold. */
export const MAX_EMAIL_WEBHOOKS = 10;

/** Hours the previous webhook signing secret keeps being honoured after a rotation. */
export const WEBHOOK_ROTATION_GRACE_HOURS = 24;

/** `listLogs` / `listDeliveries` row defaults and ceiling. */
export const DEFAULT_ROW_LIMIT = 50;
export const MAX_ROW_LIMIT = 100;

/**
 * Safety stop for `email logs --all`. The log feed has no end for a busy
 * project, and an agent that asked for "everything" should get a bounded
 * answer rather than an unbounded walk.
 */
export const ALL_PAGES_ROW_CAP = 2000;

/** `email domains verify --wait` polling defaults, in seconds. */
export const DEFAULT_VERIFY_TIMEOUT_SECONDS = 300;
export const DEFAULT_VERIFY_INTERVAL_SECONDS = 15;

export type EmailWebhookEvent = (typeof EMAIL_WEBHOOK_EVENTS)[number];
export type EmailLogStatus = (typeof EMAIL_LOG_STATUSES)[number];
export type EmailApiKeyScope = (typeof EMAIL_API_KEY_SCOPES)[number];
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

// ---------------------------------------------------------------------------
// The launch gate
// ---------------------------------------------------------------------------

/** Error code in the `--json` envelope when the product has not launched yet. */
export const EMAIL_NOT_LAUNCHED_CODE = "EMAIL_NOT_LAUNCHED";

/**
 * The launch gate's wording, as two independent phrases so a reworded server
 * message still matches. Deliberately NOT keyed on the feature flag or any
 * build-time constant: the flag lives on the server and flips with no CLI
 * change, and the only honest signal the CLI has is the refusal itself.
 */
const LAUNCH_REFUSAL_PHRASE = /\bcoming soon\b|\bnot open yet\b/i;

/** Agent-facing guidance attached to the refusal. */
const NOT_LAUNCHED_HINT =
	"Stop here and tell the user that Tarout Email has not launched yet. Do not retry, do not switch project, organization or credential, and do not go looking for a REST or dashboard workaround: the refusal comes from the platform's own launch gate and applies to the whole account, so every `tarout email` command will answer exactly the same way until Tarout opens it.";

/** The structured payload carried in the `--json` error envelope. */
export interface EmailLaunchRefusal {
	/** Prose for a human operator and for an agent's transcript. */
	message: string;
	details: {
		reason: "not_launched";
		feature: "email";
		launched: false;
		/** Verbatim server text, so the operator can see who refused. */
		serverMessage: string;
		hint: string;
	};
}

/** The tRPC error code, from either the client or the server error shape. */
function trpcErrorCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as {
		code?: unknown;
		data?: { code?: unknown } | null;
		shape?: { data?: { code?: unknown } | null } | null;
	};
	const code = e.data?.code ?? e.shape?.data?.code ?? e.code;
	return typeof code === "string" ? code : undefined;
}

function errorMessageOf(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string") return message;
	}
	return "";
}

/**
 * The launch refusal, or null for every other failure.
 *
 * Narrow on purpose. The email router answers PRECONDITION_FAILED for three
 * other, genuinely actionable reasons — no active project, the per-project
 * kill switch is off, no shared sending domain configured — and those must
 * keep their own message instead of being reported as "not launched yet".
 */
export function emailLaunchRefusal(err: unknown): EmailLaunchRefusal | null {
	if (trpcErrorCode(err) !== "PRECONDITION_FAILED") return null;
	const serverMessage = errorMessageOf(err);
	if (!LAUNCH_REFUSAL_PHRASE.test(serverMessage)) return null;
	return {
		message: `Tarout Email has not launched yet, so the platform refuses every \`tarout email\` command for this account. Nothing is wrong with your login, your project or this command — the product is built, and the gate that holds it closed is server-side. The server said: "${serverMessage}"`,
		details: {
			reason: "not_launched",
			feature: "email",
			launched: false,
			serverMessage,
			hint: NOT_LAUNCHED_HINT,
		},
	};
}

/**
 * Every `email` subcommand's catch routes through here.
 *
 * A launch refusal is reported as itself: prose on stderr in human mode, an
 * `EMAIL_NOT_LAUNCHED` envelope with `reason: "not_launched"` under `--json`.
 * The exit code is INVALID_ARGUMENTS (2) — the same code `handleError` already
 * gives every PRECONDITION_FAILED, so a caller that keys on the code sees no
 * special case. Anything else is handed to the shared handler untouched.
 */
export function handleEmailError(err: unknown): never {
	const refusal = emailLaunchRefusal(err);
	if (refusal) {
		outputError(EMAIL_NOT_LAUNCHED_CODE, refusal.message, refusal.details);
		exit(ExitCode.INVALID_ARGUMENTS);
	}
	handleError(err);
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/** Rows out of an untyped tRPC answer, never undefined. */
export function asRows<T>(raw: unknown): T[] {
	return Array.isArray(raw) ? (raw as T[]) : [];
}

function listed(values: readonly string[]): string {
	return values.join(", ");
}

/**
 * One `--event` value (or a comma-separated group) into a canonical event name.
 * Accepts the bare tail (`bounced`), hyphens for underscores
 * (`delivery-delayed`) and any casing, because those are what an operator
 * actually types; everything else is refused by name.
 */
function canonicalWebhookEvent(raw: string): EmailWebhookEvent {
	const cleaned = raw.trim().toLowerCase().replace(/-/g, "_");
	const qualified = cleaned.startsWith("email.")
		? cleaned
		: `email.${cleaned}`;
	const match = EMAIL_WEBHOOK_EVENTS.find((event) => event === qualified);
	if (!match) {
		throw new InvalidArgumentError(
			`Unknown webhook event "${raw.trim()}". Tarout Email publishes exactly these eight: ${listed(EMAIL_WEBHOOK_EVENTS)}. The \`email.\` prefix is optional.`,
		);
	}
	return match;
}

/**
 * The `--event` values for a create or a replace, deduped and returned in the
 * server's canonical order. An empty result is legal and means "no events".
 */
export function parseWebhookEvents(
	values: string[] | undefined,
): EmailWebhookEvent[] {
	if (!values?.length) return [];
	const picked = new Set<EmailWebhookEvent>();
	for (const value of values) {
		for (const part of value.split(",")) {
			if (!part.trim()) continue;
			picked.add(canonicalWebhookEvent(part));
		}
	}
	return EMAIL_WEBHOOK_EVENTS.filter((event) => picked.has(event));
}

/**
 * Read-modify-write for `--add-event`: the endpoint's current events plus the
 * new ones. `updateWebhook.events` REPLACES the list server-side, so the merge
 * has to happen here or subscribing to one more event would silently drop
 * every other one.
 */
export function mergeWebhookEvents(
	current: readonly string[] | undefined,
	added: string[] | undefined,
): EmailWebhookEvent[] {
	const picked = new Set<EmailWebhookEvent>();
	for (const event of current ?? []) {
		const match = EMAIL_WEBHOOK_EVENTS.find((known) => known === event);
		// An event the server knows and this CLI does not is kept out rather
		// than guessed at; it would fail the server's own enum on write anyway.
		if (match) picked.add(match);
	}
	for (const event of parseWebhookEvents(added)) picked.add(event);
	return EMAIL_WEBHOOK_EVENTS.filter((event) => picked.has(event));
}

/** `--scope`, defaulting to the server's own default. */
export function parseApiKeyScope(raw: string | undefined): EmailApiKeyScope {
	if (raw === undefined) return "full_access";
	const cleaned = raw.trim().toLowerCase().replace(/[-\s]/g, "_");
	const expanded =
		cleaned === "full"
			? "full_access"
			: cleaned === "sending" || cleaned === "send"
				? "sending_access"
				: cleaned;
	const match = EMAIL_API_KEY_SCOPES.find((scope) => scope === expanded);
	if (!match) {
		throw new InvalidArgumentError(
			`Unknown API key scope "${raw.trim()}". Use ${listed(EMAIL_API_KEY_SCOPES)} — full_access manages the whole email service, sending_access can only send mail.`,
		);
	}
	return match;
}

/** `--reason` on a suppression, defaulting to the server's own default. */
export function parseSuppressionReason(
	raw: string | undefined,
): EmailSuppressionReason {
	if (raw === undefined) return "manual";
	const cleaned = raw.trim().toLowerCase();
	const match = EMAIL_SUPPRESSION_REASONS.find((reason) => reason === cleaned);
	if (!match) {
		throw new InvalidArgumentError(
			`Unknown suppression reason "${raw.trim()}". Use ${listed(EMAIL_SUPPRESSION_REASONS)}.`,
		);
	}
	return match;
}

/** `--status` on the log list. */
export function parseLogStatus(
	raw: string | undefined,
): EmailLogStatus | undefined {
	if (raw === undefined) return undefined;
	const cleaned = raw.trim().toLowerCase().replace(/-/g, "_");
	const match = EMAIL_LOG_STATUSES.find((status) => status === cleaned);
	if (!match) {
		throw new InvalidArgumentError(
			`Unknown message status "${raw.trim()}". A logged message is one of: ${listed(EMAIL_LOG_STATUSES)}.`,
		);
	}
	return match;
}

/** `-n/--limit`, within the server's 1-100 window. */
export function parseRowLimit(
	raw: string | number | undefined,
	fallback = DEFAULT_ROW_LIMIT,
): number {
	if (raw === undefined || raw === "") return fallback;
	const value = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > MAX_ROW_LIMIT) {
		throw new InvalidArgumentError(
			`--limit must be a whole number between 1 and ${MAX_ROW_LIMIT} (got "${raw}").`,
		);
	}
	return value;
}

/** A plain seconds option, used by the verify poller. */
export function parseSecondsOption(
	raw: string | number | undefined,
	options: { flag: string; min: number; max: number; fallback: number },
): number {
	if (raw === undefined || raw === "") return options.fallback;
	const value = typeof raw === "number" ? raw : Number(raw);
	if (
		!Number.isInteger(value) ||
		value < options.min ||
		value > options.max
	) {
		throw new InvalidArgumentError(
			`${options.flag} must be a whole number of seconds between ${options.min} and ${options.max} (got "${raw}").`,
		);
	}
	return value;
}

// Same shape the server's Zod schema enforces, anchored and lowercased here.
const FQDN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * The `<domain>` of `email domains add`, normalized the way the server
 * normalizes it (trimmed, lowercased, trailing dot dropped).
 *
 * A one-label-too-short name is refused locally: a sending domain has to be a
 * true subdomain of a domain the organization registered through Tarout, so a
 * bare `example.com` can never qualify and there is no reason to spend a round
 * trip learning that. Which registered domain it must sit under is the
 * server's call — `mail.example.co.uk` passes here and may still be refused
 * there.
 */
export function parseSendingDomain(raw: string): string {
	const cleaned = raw.trim().toLowerCase().replace(/\.+$/, "");
	if (!cleaned) {
		throw new InvalidArgumentError(
			"Pass the sending domain to add, for example `tarout email domains add mail.example.com`.",
		);
	}
	if (cleaned.includes("@")) {
		throw new InvalidArgumentError(
			`"${raw.trim()}" looks like an email address. Pass only the sending domain, for example mail.example.com.`,
		);
	}
	if (cleaned.length > 253 || !FQDN.test(cleaned)) {
		throw new InvalidArgumentError(
			`"${raw.trim()}" is not a valid domain name. Use a hostname such as mail.example.com.`,
		);
	}
	if (cleaned.split(".").length < 3) {
		throw new InvalidArgumentError(
			`"${cleaned}" is an apex domain, and Tarout Email only sends from a subdomain of a domain your organization registered through Tarout. Use something like mail.${cleaned} instead.`,
		);
	}
	return cleaned;
}

// Deliberately loose: the server owns the real rule, this only catches typos
// before a round trip.
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** An email address argument (`send-test <to>`, `suppressions add <address>`). */
export function parseEmailAddress(raw: string, label: string): string {
	const cleaned = raw.trim();
	if (!EMAIL_ADDRESS.test(cleaned) || cleaned.length > 254) {
		throw new InvalidArgumentError(
			`"${raw.trim()}" is not a valid ${label}. Pass a single address such as person@example.com.`,
		);
	}
	return cleaned;
}

const LOOPBACK_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"::1",
	"[::1]",
	"0.0.0.0",
]);

/**
 * A webhook `<url>`. The server requires a PUBLIC https endpoint and re-checks
 * at delivery time (it refuses anything resolving to a private, loopback or
 * metadata address); this catches the two mistakes worth catching for free.
 */
export function parseWebhookUrl(raw: string): string {
	const cleaned = raw.trim();
	let parsed: URL;
	try {
		parsed = new URL(cleaned);
	} catch {
		throw new InvalidArgumentError(
			`"${cleaned}" is not a valid URL. Pass a full https endpoint, for example https://example.com/hooks/tarout-email.`,
		);
	}
	if (parsed.protocol !== "https:") {
		throw new InvalidArgumentError(
			`Webhook URLs must use https:// (got "${parsed.protocol}//"). Tarout Email signs and posts events over TLS only.`,
		);
	}
	if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
		throw new InvalidArgumentError(
			`"${parsed.hostname}" is a loopback address, which Tarout cannot reach. Use a publicly resolvable https endpoint (a tunnel URL works while developing).`,
		);
	}
	return cleaned;
}

/**
 * The `updateWebhook` input for the flags that were actually passed.
 *
 * `--event` REPLACES the subscription list, because that is what the procedure
 * does; `--add-event` is the read-modify-write sugar over the same field, so
 * the two are mutually exclusive.
 */
export function buildWebhookUpdate(
	webhookId: string,
	currentEvents: readonly string[] | undefined,
	options: {
		url?: string;
		event?: string[];
		addEvent?: string[];
		enable?: boolean;
		disable?: boolean;
	},
): {
	webhookId: string;
	url?: string;
	events?: EmailWebhookEvent[];
	status?: "active" | "disabled";
} {
	if (options.enable && options.disable) {
		throw new InvalidArgumentError(
			"Pass either --enable or --disable, not both.",
		);
	}
	if (options.event?.length && options.addEvent?.length) {
		throw new InvalidArgumentError(
			"Pass either --event (which replaces the whole event list) or --add-event (which keeps the current events and adds to them), not both.",
		);
	}

	const update: {
		webhookId: string;
		url?: string;
		events?: EmailWebhookEvent[];
		status?: "active" | "disabled";
	} = { webhookId };

	if (options.url !== undefined) update.url = parseWebhookUrl(options.url);
	if (options.event?.length) update.events = parseWebhookEvents(options.event);
	if (options.addEvent?.length) {
		update.events = mergeWebhookEvents(currentEvents, options.addEvent);
	}
	if (options.enable) update.status = "active";
	if (options.disable) update.status = "disabled";

	if (
		update.url === undefined &&
		update.events === undefined &&
		update.status === undefined
	) {
		throw new InvalidArgumentError(
			"Nothing to change. Pass --url, --event/--add-event, or --enable/--disable.",
		);
	}
	return update;
}

// ---------------------------------------------------------------------------
// Identifier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a human-typed identifier against a list the way `findBucket` does in
 * commands/storage.ts: exact id, then exact label (case-insensitive), then a
 * unique id prefix. Ambiguity is refused with the candidates named rather than
 * resolved by luck, and a miss lists what does exist.
 */
export function resolveEmailRecord<T>(
	rows: T[],
	identifier: string,
	read: (row: T) => { id: string; label: string },
	kind: string,
): T {
	const wanted = identifier.trim();
	if (!wanted) {
		throw new InvalidArgumentError(`Pass the ${kind.toLowerCase()} to act on.`);
	}
	const entries = rows.map((row) => {
		const { id, label } = read(row);
		return { row, id: String(id ?? ""), label: String(label ?? "") };
	});

	const exactId = entries.find((entry) => entry.id === wanted);
	if (exactId) return exactId.row;

	const lower = wanted.toLowerCase();
	const byLabel = entries.filter((entry) => entry.label.toLowerCase() === lower);
	if (byLabel.length === 1 && byLabel[0]) return byLabel[0].row;
	if (byLabel.length > 1) {
		throw ambiguousEmailRecord(wanted, "name", kind, byLabel);
	}

	const byPrefix = entries.filter(
		(entry) => entry.id !== "" && entry.id.startsWith(wanted),
	);
	if (byPrefix.length === 1 && byPrefix[0]) return byPrefix[0].row;
	if (byPrefix.length > 1) {
		throw ambiguousEmailRecord(wanted, "id prefix", kind, byPrefix);
	}

	throw new NotFoundError(
		kind,
		wanted,
		entries
			.map((entry) => entry.label || entry.id)
			.filter(Boolean)
			.slice(0, 10),
	);
}

function ambiguousEmailRecord(
	identifier: string,
	by: "name" | "id prefix",
	kind: string,
	matches: Array<{ id: string; label: string }>,
): InvalidArgumentError {
	const candidates = matches
		.map((match) => `${match.id} (${match.label})`)
		.join(", ");
	return new InvalidArgumentError(
		`${kind} ${by} "${identifier}" matches ${matches.length} records: ${candidates}. Pass the full id instead.`,
	);
}

// ---------------------------------------------------------------------------
// Log pagination
// ---------------------------------------------------------------------------

/** One `listLogs` answer. */
export interface EmailLogPage {
	items?: unknown;
	nextCursor?: string | null;
}

export interface CollectLogsOptions {
	/** Follow `nextCursor` to the end of the feed. */
	all?: boolean;
	/** Hard stop for `--all` (default ALL_PAGES_ROW_CAP). */
	maxRows?: number;
	/** Called after each extra page with the running row count. */
	onPage?: (rows: number) => void;
}

export interface CollectedLogs<T> {
	items: T[];
	/** The server had rows we did not read. */
	hasMore: boolean;
	pages: number;
	/** `--all` stopped at `maxRows` instead of at the end of the feed. */
	capped: boolean;
}

/**
 * Walk `listLogs`. It is the only cursor-paginated procedure in the router and
 * this CLI has no `--cursor` precedent, so the cursor never reaches the user:
 * one page by default, and `--all` loops here until `nextCursor` comes back
 * null (or the row cap trips). A page that returns no rows also ends the walk,
 * so a server that kept handing back a cursor could not spin forever.
 */
export async function collectLogPages<T>(
	fetchPage: (cursor: string | undefined) => Promise<EmailLogPage>,
	options: CollectLogsOptions = {},
): Promise<CollectedLogs<T>> {
	const maxRows = options.maxRows ?? ALL_PAGES_ROW_CAP;
	const items: T[] = [];
	let cursor: string | undefined;
	let pages = 0;
	let hasMore = false;
	let capped = false;

	for (;;) {
		const page = await fetchPage(cursor);
		pages += 1;
		const rows = asRows<T>(page?.items);
		items.push(...rows);
		const next =
			typeof page?.nextCursor === "string" && page.nextCursor
				? page.nextCursor
				: null;

		if (!options.all) {
			hasMore = next !== null;
			break;
		}
		if (next === null || rows.length === 0) break;
		if (items.length >= maxRows) {
			hasMore = true;
			capped = true;
			break;
		}
		cursor = next;
		options.onPage?.(items.length);
	}

	return { items, hasMore, pages, capped };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** What a log status means, in plain words. No colors. */
export function describeLogStatus(status: string): string {
	switch (status) {
		case "queued":
			return "accepted and waiting for a sending slot";
		case "scheduled":
			return "accepted and held until its scheduled time";
		case "sent":
			return "handed to the receiving mail server";
		case "delivered":
			return "the receiving mail server accepted it";
		case "delivery_delayed":
			return "temporarily rejected; delivery is still being retried";
		case "bounced":
			return "permanently rejected; the address is now suppressed";
		case "complained":
			return "the recipient marked it as spam; the address is now suppressed";
		case "failed":
			return "it could not be sent at all";
		case "canceled":
			return "cancelled before it was sent";
		case "suppressed":
			return "not sent: the recipient was on this project's suppression list";
		default:
			return "unknown status";
	}
}

export function formatLogStatus(status: string): string {
	switch (status) {
		case "queued":
			return colors.dim("○ queued");
		case "scheduled":
			return colors.dim("○ scheduled");
		case "sent":
			return colors.info("◐ sent");
		case "delivered":
			return colors.success("✓ delivered");
		case "delivery_delayed":
			return colors.warn("◐ delayed");
		case "bounced":
			return colors.error("✗ bounced");
		case "complained":
			return colors.error("✗ complained");
		case "failed":
			return colors.error("✗ failed");
		case "canceled":
			return colors.dim("○ canceled");
		case "suppressed":
			return colors.warn("○ suppressed");
		default:
			return status;
	}
}

export function formatDomainStatus(status: string): string {
	switch (status) {
		case "not_started":
			return colors.dim("○ not started");
		case "pending":
			return colors.warn("○ pending");
		case "verified":
			return colors.success("✓ verified");
		case "temporary_failure":
			return colors.warn("◐ temporary failure");
		case "failed":
			return colors.error("✗ failed");
		default:
			return status;
	}
}

function formatWebhookStatus(status: string): string {
	switch (status) {
		case "active":
			return colors.success("✓ active");
		case "disabled":
			return colors.dim("○ disabled");
		default:
			return status;
	}
}

/** `to`/`cc`/`bcc` are JSON columns: an array, a bare string, or nothing. */
export function formatRecipients(value: unknown): string {
	if (Array.isArray(value)) {
		const list = value.map((entry) => String(entry)).filter(Boolean);
		if (!list.length) return "-";
		return list.length === 1 && list[0]
			? list[0]
			: `${list[0]} +${list.length - 1} more`;
	}
	if (typeof value === "string" && value.trim()) return value.trim();
	return "-";
}

function shortId(id: string | null | undefined): string {
	if (!id) return colors.dim("-");
	return colors.cyan(id.slice(0, 8));
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

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 3)}...`;
}

// ---------------------------------------------------------------------------
// Row shapes (as selected by the router)
// ---------------------------------------------------------------------------

export interface EmailDomainRow {
	domainId: string;
	name: string;
	status: string;
	statusMessage?: string | null;
	dnsRecords?: unknown;
	verifiedAt?: string | Date | null;
	lastCheckedAt?: string | Date | null;
	createdAt?: string | Date | null;
}

export interface EmailApiKeyRow {
	apiKeyId: string;
	name: string;
	permission: string;
	keyPrefix?: string | null;
	lastUsedAt?: string | Date | null;
	createdAt?: string | Date | null;
}

export interface EmailWebhookRow {
	webhookId: string;
	url: string;
	events?: string[];
	status: string;
	consecutiveFailures?: number;
	disabledAt?: string | Date | null;
	disabledReason?: string | null;
	createdAt?: string | Date | null;
}

export interface EmailSuppressionRow {
	suppressionId: string;
	address: string;
	reason: string;
	sourceLogId?: string | null;
	smtpCode?: number | null;
	detail?: string | null;
	createdAt?: string | Date | null;
}

export interface EmailLogRow {
	logId: string;
	from?: string;
	subject?: string;
	to?: unknown;
	status: string;
	scheduledAt?: string | Date | null;
	sentAt?: string | Date | null;
	deliveredAt?: string | Date | null;
	createdAt?: string | Date | null;
}

interface EmailDnsRecord {
	type?: string;
	name?: string;
	value?: string;
}

/** Prints the DNS records a pending domain is waiting on. */
function printDnsRecords(records: unknown): boolean {
	const rows = asRows<EmailDnsRecord>(records);
	if (!rows.length) return false;
	log("");
	log(colors.bold("DNS records to publish"));
	table(
		["TYPE", "NAME", "VALUE"],
		rows.map((record) => [
			colors.cyan(record.type || "-"),
			record.name || "@",
			truncate(String(record.value ?? "-"), 70),
		]),
	);
	return true;
}

const SANDBOX_RULES =
	"In sandbox the project may only send to active members of your own organization, capped at 100 recipients a day. Verifying your first sending domain turns sandbox off and raises the cap to 1000 a day.";

export function registerEmailCommands(program: Command) {
	const email = program
		.command("email")
		.description(
			"Manage Tarout Email: sending domains, API keys, event webhooks, suppressions and delivery logs",
		)
		.addHelpText(
			"after",
			`
Tarout Email is the platform's transactional email API, scoped to the project
you have selected (every command here acts on it; none takes a project id).
The service provisions itself the first time any of these commands touches it,
so there is nothing to create — \`tarout email status\` always answers.

A new project starts in SANDBOX mode. ${SANDBOX_RULES}

A sending domain must be a SUBDOMAIN of a domain your organization registered
through Tarout, on Tarout-managed DNS (mail.example.com, never example.com).

Examples:
  tarout email status
  tarout email domains add mail.example.com
  tarout email domains verify mail.example.com --wait
  tarout email keys create "production sender" --scope sending_access
  tarout email logs --status bounced -n 20
  tarout email send-test you@example.com`,
		);

	registerServiceCommands(email);
	registerDomainCommands(email);
	registerKeyCommands(email);
	registerWebhookCommands(email);
	registerLogCommands(email);
	registerSuppressionCommands(email);
	registerSendTest(email);
}

// ---------------------------------------------------------------------------
// email status / email usage
// ---------------------------------------------------------------------------

interface EmailServiceState {
	emailServiceId: string;
	sharedPrefix?: string | null;
	sharedSendingDomain?: string | null;
	sandboxMode: boolean;
	enabled: boolean;
	betaApproved: boolean;
	defaultFromName?: string | null;
	defaultReplyTo?: string | null;
}

function registerServiceCommands(email: Command) {
	email
		.command("status")
		.alias("info")
		.description(
			"Show this project's email service: whether it is enabled, whether it is still in sandbox mode, and the shared sending address it may send from. The service provisions itself on this call, so it always answers for a project you can see",
		)
		.addHelpText(
			"after",
			`
Reads email.getService. The one scalar quiet mode prints is the mode:
\`sandbox\` or \`live\`.

A null shared sending domain means Tarout has not configured a shared sending
root at all, so shared sending is CLOSED for everyone: until you verify a
custom domain, there is no address this project can send from.`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching email service...");
				const service = (await client.email.getService.query(
					{},
				)) as EmailServiceState;
				succeedSpinner();

				if (isJsonMode()) {
					outputData(service);
					return;
				}

				quietOutput(service.sandboxMode ? "sandbox" : "live");

				log("");
				log(colors.bold("Tarout Email"));
				log("");
				log(
					`  Service:        ${
						service.enabled
							? colors.success("✓ enabled")
							: colors.error("✗ disabled")
					}`,
				);
				log(
					`  Mode:           ${
						service.sandboxMode
							? colors.warn("○ sandbox")
							: colors.success("✓ live")
					}`,
				);
				log(
					`  Shared sender:  ${
						service.sharedSendingDomain
							? colors.cyan(`anything@${service.sharedSendingDomain}`)
							: colors.dim("none (shared sending is closed)")
					}`,
				);
				log(
					`  Beta approved:  ${service.betaApproved ? "yes" : colors.dim("no")}`,
				);
				log(`  Default name:   ${service.defaultFromName || colors.dim("-")}`);
				log(`  Default reply:  ${service.defaultReplyTo || colors.dim("-")}`);
				log(`  Service ID:     ${colors.dim(service.emailServiceId)}`);
				log("");
				if (!service.enabled) {
					log(
						colors.warn(
							"This project's email service is switched off by Tarout, so no send will be accepted. Contact support if that is unexpected.",
						),
					);
					log("");
				}
				if (service.sandboxMode) {
					log(SANDBOX_RULES);
					log(
						`Leave sandbox: ${colors.dim("tarout email domains add mail.example.com")}`,
					);
					log("");
				}
				if (!service.sharedSendingDomain) {
					warn(
						"No shared sending domain is configured on this platform, so a verified custom domain is the only way this project can send.",
					);
				}
				log(`Daily quota: ${colors.dim("tarout email usage")}`);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	email
		.command("usage")
		.alias("quota")
		.description(
			"Show today's send quota for this project: the daily recipient limit, how much of it has been used, and how much is left. The window is a UTC day and resets at midnight UTC",
		)
		.addHelpText(
			"after",
			`
Reads email.getUsage. Quiet mode prints the remaining count alone, so a CI
step can gate on it.

The limit follows the mode: 100 recipients a day in sandbox, 1000 once sandbox
is off or the project is beta-approved, or whatever override Tarout set for
this project.`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching email usage...");
				const usage = (await client.email.getUsage.query({})) as {
					limit: number;
					used: number;
					remaining: number;
				};
				succeedSpinner();

				if (isJsonMode()) {
					outputData(usage);
					return;
				}

				quietOutput(String(usage.remaining));

				const share = usage.limit > 0 ? usage.used / usage.limit : 0;
				log("");
				log(colors.bold("Today's send quota"));
				log("");
				log(`  Limit:      ${usage.limit} recipients (UTC day)`);
				log(`  Used:       ${usage.used}`);
				log(
					`  Remaining:  ${
						usage.remaining === 0
							? colors.error("0")
							: share >= 0.8
								? colors.warn(String(usage.remaining))
								: colors.success(String(usage.remaining))
					}`,
				);
				log("");
				if (usage.remaining === 0) {
					log(
						colors.warn(
							"The quota is spent for today; further sends are refused until midnight UTC.",
						),
					);
					log("");
				}
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});
}

// ---------------------------------------------------------------------------
// email domains
// ---------------------------------------------------------------------------

/** The project's sending domains, used for identifier resolution. */
async function listDomains(client: {
	email: { listDomains: { query: (input: unknown) => Promise<unknown> } };
}): Promise<EmailDomainRow[]> {
	return asRows<EmailDomainRow>(await client.email.listDomains.query({}));
}

function resolveDomain(
	rows: EmailDomainRow[],
	identifier: string,
): EmailDomainRow {
	return resolveEmailRecord(
		rows,
		identifier,
		(row) => ({ id: row.domainId, label: row.name }),
		"Sending domain",
	);
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

function registerDomainCommands(email: Command) {
	const domains = email
		.command("domains")
		.description("Manage the sending domains this project may send mail from");

	domains
		.command("list")
		.alias("ls")
		.description(
			"List this project's sending domains with their verification state, newest first. The shared sending address is not a domain and never appears here; `tarout email status` shows it",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching sending domains...");
				const rows = await listDomains(client);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(rows);
					return;
				}

				if (!rows.length) {
					log("");
					log("No sending domains in this project.");
					log("");
					log(
						`Add one: ${colors.dim("tarout email domains add mail.example.com")}`,
					);
					log("");
					return;
				}

				log("");
				table(
					["ID", "DOMAIN", "STATUS", "VERIFIED", "CHECKED"],
					rows.map((row) => [
						shortId(row.domainId),
						row.name,
						formatDomainStatus(row.status),
						formatDateTime(row.verifiedAt),
						formatDateTime(row.lastCheckedAt),
					]),
				);
				log("");
				log(colors.dim(`${rows.length} domain${rows.length === 1 ? "" : "s"}`));
				if (
					rows.some(
						(row) => row.status === "pending" || row.status === "not_started",
					)
				) {
					log(
						`Check one now: ${colors.dim("tarout email domains verify <domain>")}`,
					);
				}
				if (rows.some((row) => row.status === "failed")) {
					log(
						`A failed domain restarts its ${DOMAIN_VERIFY_WINDOW_HOURS}h window with: ${colors.dim("tarout email domains rearm <domain>")}`,
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	domains
		.command("add")
		.argument(
			"<domain>",
			"Sending subdomain to add, e.g. mail.example.com (never the apex)",
		)
		.description(
			"Add a sending domain and print the DNS records to publish. It must be a subdomain of a domain your organization registered through Tarout, on Tarout-managed DNS; it lands `pending` and verifies once those records are live",
		)
		.addHelpText(
			"after",
			`
Calls email.addDomain. Quiet mode prints the new domain id.

Publish every record exactly as printed, then run
\`tarout email domains verify <domain>\`. The domain has
${DOMAIN_VERIFY_WINDOW_HOURS} hours to verify before the platform marks it
\`failed\`; \`tarout email domains rearm\` restarts that window.

Verifying the FIRST domain in this project also turns sandbox mode off, which
is what lifts the recipient restriction and the 100-a-day cap.

Limits: an apex domain is refused (use mail.example.com), and one Cloudflare
zone may hold 30 sending subdomains.`,
		)
		.action(async (domainArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const name = parseSendingDomain(domainArg);
				const client = getApiClient();
				const _spinner = startSpinner(`Adding sending domain ${name}...`);
				const created = (await client.email.addDomain.mutate({
					domain: name,
				})) as EmailDomainRow;
				succeedSpinner("Sending domain added.");

				if (isJsonMode()) {
					outputData(created);
					return;
				}

				quietOutput(created.domainId);

				log("");
				log(
					`${colors.bold(created.name)} is ${formatDomainStatus(created.status)} ${colors.dim(created.domainId)}`,
				);
				const printed = printDnsRecords(created.dnsRecords);
				log("");
				if (printed) {
					log("Publish those records on the domain's DNS, then verify it:");
				} else {
					warn(
						"The platform returned no DNS records for this domain. Check it in the dashboard before verifying.",
					);
				}
				log(
					`  ${colors.dim(`tarout email domains verify ${created.name} --wait`)}`,
				);
				log("");
				log(
					colors.dim(
						`Verification has ${DOMAIN_VERIFY_WINDOW_HOURS} hours before the domain is marked failed. The first verified domain in this project also turns sandbox mode off.`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	domains
		.command("verify")
		.argument("<domain>", "Sending domain name, id, or unique id prefix")
		.description(
			"Check a pending domain's DNS now and flip it to verified if the records are live. Verifying the first domain in this project also turns sandbox mode off, lifting the recipient restriction and raising the daily cap",
		)
		.option(
			"--wait",
			"Keep re-checking until the domain verifies, fails, or the timeout is reached (every check re-reads DNS at the edge)",
		)
		.option(
			"--timeout <seconds>",
			`How long --wait keeps checking, 30 to 3600 (default ${DEFAULT_VERIFY_TIMEOUT_SECONDS})`,
		)
		.option(
			"--interval <seconds>",
			`Seconds between --wait checks, 5 to 300 (default ${DEFAULT_VERIFY_INTERVAL_SECONDS})`,
		)
		.addHelpText(
			"after",
			`
Calls email.verifyDomain. Quiet mode prints the resulting status.

Exit codes:
  0   the domain is verified
  1   the domain is \`failed\`: its ${DOMAIN_VERIFY_WINDOW_HOURS}h window closed,
      so restart it with \`tarout email domains rearm <domain>\`
  2   invalid input, or the platform refused the call
  11  --wait gave up while the domain was still pending; nothing was lost and
      nothing was cancelled, so run it again once DNS has propagated`,
		)
		.action(
			async (
				domainArg: string,
				options: { wait?: boolean; timeout?: string; interval?: string },
			) => {
				let code: number = ExitCode.SUCCESS;
				try {
					if (!isLoggedIn()) throw new AuthError();
					const timeoutSeconds = parseSecondsOption(options.timeout, {
						flag: "--timeout",
						min: 30,
						max: 3600,
						fallback: DEFAULT_VERIFY_TIMEOUT_SECONDS,
					});
					const intervalSeconds = parseSecondsOption(options.interval, {
						flag: "--interval",
						min: 5,
						max: 300,
						fallback: DEFAULT_VERIFY_INTERVAL_SECONDS,
					});

					const client = getApiClient();
					const _spinner = startSpinner("Finding sending domain...");
					const domain = resolveDomain(await listDomains(client), domainArg);

					updateSpinner(`Checking DNS for ${domain.name}...`);
					let result = (await client.email.verifyDomain.mutate({
						domainId: domain.domainId,
					})) as { transitioned: boolean; nextStatus: string };

					const deadline = Date.now() + timeoutSeconds * 1000;
					while (
						options.wait &&
						result.nextStatus !== "verified" &&
						result.nextStatus !== "failed" &&
						Date.now() + intervalSeconds * 1000 <= deadline
					) {
						updateSpinner(
							`${domain.name} is ${result.nextStatus}; re-checking in ${intervalSeconds}s...`,
						);
						await sleep(intervalSeconds * 1000);
						result = (await client.email.verifyDomain.mutate({
							domainId: domain.domainId,
						})) as { transitioned: boolean; nextStatus: string };
					}
					succeedSpinner();

					const payload = {
						domainId: domain.domainId,
						name: domain.name,
						status: result.nextStatus,
						transitioned: result.transitioned,
					};

					if (result.nextStatus === "verified") {
						if (isJsonMode()) {
							outputData(payload);
						} else {
							quietOutput(result.nextStatus);
							success(
								`${domain.name} is verified and can send mail from this project.`,
							);
							log("");
							log(
								colors.dim(
									"If that was this project's first verified domain, sandbox mode is now off: the recipient restriction is gone and the daily cap is 1000. Confirm with `tarout email status`.",
								),
							);
							log("");
						}
					} else if (result.nextStatus === "failed") {
						outputError(
							"EMAIL_DOMAIN_FAILED",
							`${domain.name} did not verify within ${DOMAIN_VERIFY_WINDOW_HOURS} hours, so the platform marked it failed and stopped checking. Publish the DNS records, then restart the window with \`tarout email domains rearm ${domain.name}\`.`,
							{
								...payload,
								nextCommand: `tarout email domains rearm ${domain.name}`,
							},
						);
						code = ExitCode.GENERAL_ERROR;
					} else if (options.wait) {
						outputError(
							"EMAIL_DOMAIN_PENDING",
							`${domain.name} is still ${result.nextStatus} after ${timeoutSeconds}s. Nothing failed and nothing was cancelled: DNS may not have propagated yet. Check the records are published, then run this again.`,
							{
								...payload,
								stillPending: true,
								nextCommand: `tarout email domains verify ${domain.name} --wait`,
							},
						);
						code = ExitCode.DEPLOYMENT_TIMEOUT;
					} else if (isJsonMode()) {
						outputData(payload);
					} else {
						quietOutput(result.nextStatus);
						log("");
						log(
							`${colors.bold(domain.name)} is ${formatDomainStatus(result.nextStatus)}`,
						);
						printDnsRecords(domain.dnsRecords);
						log("");
						log(
							`Keep checking until it verifies: ${colors.dim(`tarout email domains verify ${domain.name} --wait`)}`,
						);
						log("");
					}
				} catch (err) {
					stopSpinner();
					handleEmailError(err);
				}
				if (code !== ExitCode.SUCCESS) exit(code);
			},
		);

	domains
		.command("rearm")
		.argument("<domain>", "Sending domain name, id, or unique id prefix")
		.description(
			`Put a failed domain back to pending and restart its ${DOMAIN_VERIFY_WINDOW_HOURS}-hour verification window. Use it after fixing the DNS records; an already verified domain is left untouched`,
		)
		.action(async (domainArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding sending domain...");
				const domain = resolveDomain(await listDomains(client), domainArg);
				updateSpinner(`Re-arming ${domain.name}...`);
				await client.email.reArmDomain.mutate({ domainId: domain.domainId });
				succeedSpinner("Verification window restarted.");

				if (isJsonMode()) {
					outputData({
						domainId: domain.domainId,
						name: domain.name,
						status: "pending",
						rearmed: true,
					});
					return;
				}

				quietOutput(domain.domainId);
				log("");
				log(
					`${colors.bold(domain.name)} is ${formatDomainStatus("pending")} again, with a fresh ${DOMAIN_VERIFY_WINDOW_HOURS}-hour window.`,
				);
				printDnsRecords(domain.dnsRecords);
				log("");
				log(
					`Check it: ${colors.dim(`tarout email domains verify ${domain.name} --wait`)}`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	domains
		.command("rm")
		.alias("delete")
		.argument("<domain>", "Sending domain name, id, or unique id prefix")
		.description(
			"Permanently delete a sending domain. This also REVOKES every Tarout Email API key scoped to it: those keys are not re-pointed anywhere, so anything still sending with one fails from that moment. The domain name is released and can be added again later",
		)
		.addHelpText(
			"after",
			`
Calls email.deleteDomain. The global --yes skips the confirmation.

The key revocation is deliberate, not a side effect to work around: a key
restricted to one domain must not quietly inherit the right to send from the
shared identity and every other verified domain, so a scoped key dies with its
domain. Check \`tarout email keys list\` first and re-issue what you still
need.`,
		)
		.action(async (domainArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding sending domain...");
				const domain = resolveDomain(await listDomains(client), domainArg);
				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Domain: ${colors.bold(domain.name)}`);
					log(`ID:     ${colors.dim(domain.domainId)}`);
					log(`Status: ${formatDomainStatus(domain.status)}`);
					log("");
					log(
						colors.warn(
							"Warning: deleting this domain permanently revokes every Tarout Email API key scoped to it. Revoked keys cannot be restored, and any sender still using one starts failing immediately.",
						),
					);
					log("");
					const confirmed = await confirm(
						`Delete sending domain "${domain.name}" and revoke every API key scoped to it?`,
						false,
						{
							field: "confirm_delete_email_domain",
							flag: "--yes",
							context: { domain: domain.name, domainId: domain.domainId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting sending domain...");
				await client.email.deleteDomain.mutate({ domainId: domain.domainId });
				succeedSpinner("Sending domain deleted.");

				if (isJsonMode()) {
					outputData({
						deleted: true,
						domainId: domain.domainId,
						name: domain.name,
						scopedKeysRevoked: true,
					});
					return;
				}

				quietOutput(domain.domainId);
				log("");
				log(
					`Every API key scoped to ${colors.bold(domain.name)} is now revoked. See what is left: ${colors.dim("tarout email keys list")}`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});
}

// ---------------------------------------------------------------------------
// email keys
// ---------------------------------------------------------------------------

function registerKeyCommands(email: Command) {
	const keys = email
		.command("keys")
		.description(
			"Manage the Tarout Email API keys that authenticate the send API",
		);

	keys
		.command("list")
		.alias("ls")
		.description(
			"List this project's active Tarout Email API keys, newest first. Only the key prefix is stored, so a key's secret can never be read back here — a lost key is replaced, not recovered",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching email API keys...");
				const rows = asRows<EmailApiKeyRow>(
					await client.email.listApiKeys.query({}),
				);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(rows);
					return;
				}

				if (!rows.length) {
					log("");
					log("No active Tarout Email API keys in this project.");
					log("");
					log(
						`Create one: ${colors.dim('tarout email keys create "production sender"')}`,
					);
					log("");
					return;
				}

				log("");
				table(
					["ID", "NAME", "SCOPE", "PREFIX", "LAST USED", "CREATED"],
					rows.map((row) => [
						shortId(row.apiKeyId),
						truncate(row.name ?? "-", 30),
						row.permission === "sending_access"
							? colors.dim("sending_access")
							: row.permission,
						colors.dim(row.keyPrefix || "-"),
						formatDateTime(row.lastUsedAt),
						formatDateTime(row.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${rows.length} of ${MAX_EMAIL_API_KEYS} active key${rows.length === 1 ? "" : "s"}`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	keys
		.command("create")
		.argument("<name>", "Human-readable name, e.g. \"production sender\"")
		.description(
			"Create a Tarout Email API key and print the secret ONCE. Tarout stores only a hash, so this is the only time the token is ever shown: save it to your secret store immediately",
		)
		.option(
			"--scope <scope>",
			`What the key may do: ${listed(EMAIL_API_KEY_SCOPES)} (default full_access, which also manages domains, webhooks and suppressions; sending_access can only send mail)`,
		)
		.addHelpText(
			"after",
			`
Calls email.createApiKey, which mints a live sending credential. Quiet mode
prints the key ID only — the secret is never written to bare quiet stdout.
Under --json the token is in the envelope, because the caller has nowhere else
to read it from; treat that output as a secret.

A project may hold ${MAX_EMAIL_API_KEYS} active keys. Prefer
--scope sending_access for anything that only sends mail: a full_access key can
also delete your sending domains.`,
		)
		.action(async (name: string, options: { scope?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const keyName = name.trim();
				if (!keyName) {
					throw new InvalidArgumentError(
						"Pass a name for the key, e.g. `tarout email keys create \"production sender\"`.",
					);
				}
				const scope = parseApiKeyScope(options.scope);
				const client = getApiClient();
				const _spinner = startSpinner("Creating email API key...");
				const created = (await client.email.createApiKey.mutate({
					name: keyName,
					scope,
				})) as {
					apiKeyId: string;
					name: string;
					permission: string;
					keyPrefix?: string | null;
					token: string;
				};
				succeedSpinner("Email API key created.");

				if (isJsonMode()) {
					outputData(created);
					return;
				}

				// The secret goes to the human box only: quiet mode is a machine
				// stream that lands in logs and CI output.
				quietOutput(created.apiKeyId);
				box("Tarout Email API key", [
					colors.warn("Save this key now — Tarout cannot show it again."),
					"",
					`Key:    ${colors.cyan(created.token)}`,
					`Name:   ${created.name}`,
					`Scope:  ${created.permission}`,
					`ID:     ${colors.dim(created.apiKeyId)}`,
				]);
				log(
					colors.dim(
						"Send mail with it against the Tarout Email REST API; revoke it with `tarout email keys revoke <key>`.",
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	keys
		.command("revoke")
		.argument("<key>", "Key name, id, or unique id prefix")
		.description(
			"Revoke a Tarout Email API key immediately and permanently. Anything still sending with it starts failing at once, and the key cannot be restored — issue a new one instead",
		)
		.action(async (keyArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding email API key...");
				const rows = asRows<EmailApiKeyRow>(
					await client.email.listApiKeys.query({}),
				);
				const key = resolveEmailRecord(
					rows,
					keyArg,
					(row) => ({ id: row.apiKeyId, label: row.name }),
					"Email API key",
				);
				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Key:    ${colors.bold(key.name)}`);
					log(`Scope:  ${key.permission}`);
					log(`Prefix: ${colors.dim(key.keyPrefix || "-")}`);
					log(`Used:   ${formatDateTime(key.lastUsedAt)}`);
					log("");
					const confirmed = await confirm(
						`Revoke email API key "${key.name}"? Anything using it stops sending immediately.`,
						false,
						{
							field: "confirm_revoke_email_key",
							flag: "--yes",
							context: { name: key.name, apiKeyId: key.apiKeyId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _revokeSpinner = startSpinner("Revoking email API key...");
				await client.email.revokeApiKey.mutate({ keyId: key.apiKeyId });
				succeedSpinner("Email API key revoked.");

				if (isJsonMode()) {
					outputData({
						revoked: true,
						apiKeyId: key.apiKeyId,
						name: key.name,
					});
					return;
				}

				quietOutput(key.apiKeyId);
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});
}

// ---------------------------------------------------------------------------
// email webhooks
// ---------------------------------------------------------------------------

async function listWebhooks(client: {
	email: { listWebhooks: { query: (input: unknown) => Promise<unknown> } };
}): Promise<EmailWebhookRow[]> {
	return asRows<EmailWebhookRow>(await client.email.listWebhooks.query({}));
}

function resolveWebhook(
	rows: EmailWebhookRow[],
	identifier: string,
): EmailWebhookRow {
	return resolveEmailRecord(
		rows,
		identifier,
		(row) => ({ id: row.webhookId, label: row.url }),
		"Webhook endpoint",
	);
}

function formatEvents(events: string[] | undefined): string {
	if (!events?.length) return colors.warn("none");
	if (events.length === EMAIL_WEBHOOK_EVENTS.length) return "all 8";
	return events.map((event) => event.replace(/^email\./, "")).join(",");
}

function registerWebhookCommands(email: Command) {
	const webhooks = email
		.command("webhooks")
		.description(
			"Manage the HTTPS endpoints Tarout Email posts delivery events to",
		)
		.addHelpText(
			"after",
			`
The eight events are: ${listed(EMAIL_WEBHOOK_EVENTS)}.

Every request is signed with the endpoint's secret, which is shown once at
create time and once per rotation.`,
		);

	webhooks
		.command("list")
		.alias("ls")
		.description(
			"List this project's webhook endpoints with the events each is subscribed to and its consecutive-failure count. An endpoint Tarout disabled after repeated failures shows why",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching webhook endpoints...");
				const rows = await listWebhooks(client);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(rows);
					return;
				}

				if (!rows.length) {
					log("");
					log("No webhook endpoints in this project.");
					log("");
					log(
						`Create one: ${colors.dim("tarout email webhooks create https://example.com/hooks/email --event email.bounced")}`,
					);
					log("");
					return;
				}

				log("");
				table(
					["ID", "URL", "STATUS", "EVENTS", "FAILURES", "CREATED"],
					rows.map((row) => [
						shortId(row.webhookId),
						truncate(row.url ?? "-", 44),
						formatWebhookStatus(row.status),
						formatEvents(row.events),
						row.consecutiveFailures
							? colors.warn(String(row.consecutiveFailures))
							: colors.dim("0"),
						formatDateTime(row.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${rows.length} endpoint${rows.length === 1 ? "" : "s"} (limit ${MAX_EMAIL_WEBHOOKS} active)`,
					),
				);
				for (const row of rows) {
					if (row.status === "disabled" && row.disabledReason) {
						log(
							colors.warn(
								`${row.url} is disabled: ${row.disabledReason} (${formatDateTime(row.disabledAt)})`,
							),
						);
					}
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	webhooks
		.command("create")
		.argument("<url>", "Public https endpoint Tarout should POST events to")
		.description(
			"Create a webhook endpoint and print its signing secret ONCE. The URL must be a public https endpoint: Tarout refuses anything that resolves to a private, loopback or metadata address, both now and at delivery time",
		)
		.option(
			"-e, --event <event>",
			`Event to subscribe to; repeat the flag or comma-separate values. One of: ${listed(EMAIL_WEBHOOK_EVENTS)} (the \`email.\` prefix is optional). Omitting it creates an endpoint subscribed to nothing`,
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.addHelpText(
			"after",
			`
Calls email.createWebhook. Quiet mode prints the endpoint id only; the secret
is never written to bare quiet stdout. Under --json the secret is in the
envelope, because the caller has nowhere else to read it from.

Verify every incoming request against that secret, and keep it: the only way
to see another one is \`tarout email webhooks rotate-secret\`.

A project may hold ${MAX_EMAIL_WEBHOOKS} active endpoints.

Examples:
  tarout email webhooks create https://example.com/hooks/email --event bounced --event complained
  tarout email webhooks create https://example.com/hooks/email -e email.sent,email.delivered`,
		)
		.action(async (url: string, options: { event?: string[] }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const endpoint = parseWebhookUrl(url);
				const events = parseWebhookEvents(options.event);
				if (!events.length) {
					warn(
						"No --event was passed, so this endpoint is subscribed to nothing and will never be called. Add events later with `tarout email webhooks update <webhook> --add-event <event>`.",
					);
				}
				const client = getApiClient();
				const _spinner = startSpinner("Creating webhook endpoint...");
				const created = (await client.email.createWebhook.mutate({
					url: endpoint,
					events,
				})) as {
					webhookId: string;
					url: string;
					events?: string[];
					status: string;
					secret: string;
				};
				succeedSpinner("Webhook endpoint created.");

				if (isJsonMode()) {
					outputData(created);
					return;
				}

				quietOutput(created.webhookId);
				box("Tarout Email webhook signing secret", [
					colors.warn("Save this secret now — Tarout cannot show it again."),
					"",
					`Secret: ${colors.cyan(created.secret)}`,
					`URL:    ${created.url}`,
					`Events: ${formatEvents(created.events)}`,
					`ID:     ${colors.dim(created.webhookId)}`,
				]);
				log(
					colors.dim(
						"Reject any request whose signature does not verify against this secret.",
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	webhooks
		.command("update")
		.argument("<webhook>", "Endpoint URL, id, or unique id prefix")
		.description(
			"Change a webhook endpoint's URL, event subscription or enabled state. Re-enabling an endpoint Tarout disabled also clears its failure count",
		)
		.option("--url <url>", "New public https endpoint to POST events to")
		.option(
			"-e, --event <event>",
			`REPLACES the whole event list with the values given (anything not listed is unsubscribed). Repeat the flag or comma-separate. One of: ${listed(EMAIL_WEBHOOK_EVENTS)}`,
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option(
			"--add-event <event>",
			"Keeps the endpoint's current events and adds this one (read-modify-write over the same field --event replaces). Repeatable; cannot be combined with --event",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option("--enable", "Re-enable the endpoint and reset its failure count")
		.option("--disable", "Stop delivering events to the endpoint, keeping it")
		.addHelpText(
			"after",
			`
Calls email.updateWebhook. Quiet mode prints the endpoint id.

Note the asymmetry, which is the server's behaviour and not something this CLI
can soften: \`--event\` REPLACES the entire subscription list. Use
\`--add-event\` to add one without dropping the rest; it reads the endpoint's
current events and writes the union back.`,
		)
		.action(
			async (
				webhookArg: string,
				options: {
					url?: string;
					event?: string[];
					addEvent?: string[];
					enable?: boolean;
					disable?: boolean;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Finding webhook endpoint...");
					const webhook = resolveWebhook(
						await listWebhooks(client),
						webhookArg,
					);
					const update = buildWebhookUpdate(
						webhook.webhookId,
						webhook.events,
						options,
					);

					updateSpinner("Updating webhook endpoint...");
					const updated = (await client.email.updateWebhook.mutate(
						update,
					)) as EmailWebhookRow;
					succeedSpinner("Webhook endpoint updated.");

					if (isJsonMode()) {
						outputData(updated);
						return;
					}

					quietOutput(updated.webhookId ?? webhook.webhookId);
					log("");
					log(colors.bold(updated.url ?? webhook.url));
					log("");
					log(
						`  Status: ${formatWebhookStatus(updated.status ?? webhook.status)}`,
					);
					log(`  Events: ${formatEvents(updated.events ?? webhook.events)}`);
					log(`  ID:     ${colors.dim(webhook.webhookId)}`);
					log("");
					if (update.events && !update.events.length) {
						warn(
							"This endpoint is now subscribed to nothing, so it will never be called again.",
						);
					}
				} catch (err) {
					stopSpinner();
					handleEmailError(err);
				}
			},
		);

	webhooks
		.command("rotate-secret")
		.argument("<webhook>", "Endpoint URL, id, or unique id prefix")
		.description(
			`Mint a new signing secret for an endpoint and print it ONCE. The previous secret keeps being honoured for ${WEBHOOK_ROTATION_GRACE_HOURS} hours, so deploy the new one inside that window or events will start failing verification`,
		)
		.addHelpText(
			"after",
			`
Calls email.rotateWebhookSecret. Quiet mode prints the endpoint id only; the
secret is never written to bare quiet stdout. Under --json it is in the
envelope.

Rotate, deploy the new secret to your receiver, and accept either secret until
the grace window closes.`,
		)
		.action(async (webhookArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding webhook endpoint...");
				const webhook = resolveWebhook(await listWebhooks(client), webhookArg);
				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Endpoint: ${colors.bold(webhook.url)}`);
					log(`ID:       ${colors.dim(webhook.webhookId)}`);
					log("");
					log(
						colors.warn(
							`The current secret stops being honoured in ${WEBHOOK_ROTATION_GRACE_HOURS} hours. Any receiver still verifying with it after that rejects every event.`,
						),
					);
					log("");
					const confirmed = await confirm(
						`Rotate the signing secret for "${webhook.url}"?`,
						false,
						{
							field: "confirm_rotate_email_webhook_secret",
							flag: "--yes",
							context: { url: webhook.url, webhookId: webhook.webhookId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _rotateSpinner = startSpinner("Rotating signing secret...");
				const rotated = (await client.email.rotateWebhookSecret.mutate({
					webhookId: webhook.webhookId,
				})) as { secret: string };
				succeedSpinner("Signing secret rotated.");

				if (isJsonMode()) {
					outputData({
						webhookId: webhook.webhookId,
						url: webhook.url,
						...rotated,
						previousSecretHonouredForHours: WEBHOOK_ROTATION_GRACE_HOURS,
					});
					return;
				}

				quietOutput(webhook.webhookId);
				box("New Tarout Email webhook signing secret", [
					colors.warn("Save this secret now — Tarout cannot show it again."),
					"",
					`Secret: ${colors.cyan(rotated.secret)}`,
					`URL:    ${webhook.url}`,
					`ID:     ${colors.dim(webhook.webhookId)}`,
				]);
				log(
					colors.dim(
						`The previous secret keeps verifying for ${WEBHOOK_ROTATION_GRACE_HOURS} hours; accept both until your receiver is deployed.`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	webhooks
		.command("rm")
		.alias("delete")
		.argument("<webhook>", "Endpoint URL, id, or unique id prefix")
		.description(
			"Permanently delete a webhook endpoint and its delivery history. Events stop reaching it at once and are not replayed later; use `--disable` on update instead if you only want to pause it",
		)
		.action(async (webhookArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding webhook endpoint...");
				const webhook = resolveWebhook(await listWebhooks(client), webhookArg);
				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Endpoint: ${colors.bold(webhook.url)}`);
					log(`Events:   ${formatEvents(webhook.events)}`);
					log(`ID:       ${colors.dim(webhook.webhookId)}`);
					log("");
					const confirmed = await confirm(
						`Delete webhook endpoint "${webhook.url}"? Its delivery history goes with it.`,
						false,
						{
							field: "confirm_delete_email_webhook",
							flag: "--yes",
							context: { url: webhook.url, webhookId: webhook.webhookId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting webhook endpoint...");
				await client.email.deleteWebhook.mutate({
					webhookId: webhook.webhookId,
				});
				succeedSpinner("Webhook endpoint deleted.");

				if (isJsonMode()) {
					outputData({
						deleted: true,
						webhookId: webhook.webhookId,
						url: webhook.url,
					});
					return;
				}

				quietOutput(webhook.webhookId);
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	webhooks
		.command("deliveries")
		.argument("<webhook>", "Endpoint URL, id, or unique id prefix")
		.description(
			"Show recent delivery attempts for one endpoint, newest first, with the HTTP status Tarout got back and the error when it failed. Use it to tell 'Tarout never sent it' apart from 'my receiver rejected it'",
		)
		.option(
			"-n, --limit <n>",
			`How many attempts to show, 1 to ${MAX_ROW_LIMIT} (default ${DEFAULT_ROW_LIMIT})`,
		)
		.addHelpText(
			"after",
			`
Calls email.listDeliveries. Retention is bounded by the platform: roughly the
last 50 attempts per endpoint, and nothing older than 30 days, so this is a
recent-history view and not an audit log.`,
		)
		.action(async (webhookArg: string, options: { limit?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const limit = parseRowLimit(options.limit);
				const client = getApiClient();
				const _spinner = startSpinner("Finding webhook endpoint...");
				const webhook = resolveWebhook(await listWebhooks(client), webhookArg);

				updateSpinner("Fetching webhook deliveries...");
				const rows = asRows<{
					deliveryId: string;
					event: string;
					ok: boolean;
					statusCode?: number | null;
					attempts?: number;
					error?: string | null;
					deliveredAt?: string | Date | null;
					createdAt?: string | Date | null;
				}>(
					await client.email.listDeliveries.query({
						webhookId: webhook.webhookId,
						limit,
					}),
				);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(rows);
					return;
				}

				if (!rows.length) {
					log("");
					log(`No delivery attempts recorded for ${webhook.url}.`);
					log("");
					return;
				}

				log("");
				table(
					["ID", "EVENT", "RESULT", "CODE", "ATTEMPTS", "WHEN"],
					rows.map((row) => [
						shortId(row.deliveryId),
						row.event?.replace(/^email\./, "") || "-",
						row.ok ? colors.success("✓ ok") : colors.error("✗ failed"),
						row.statusCode ? String(row.statusCode) : colors.dim("-"),
						String(row.attempts ?? 0),
						formatDateTime(row.deliveredAt || row.createdAt),
					]),
				);
				log("");
				const failed = rows.filter((row) => !row.ok);
				for (const row of failed.slice(0, 5)) {
					if (row.error) {
						log(
							colors.dim(
								`${row.deliveryId.slice(0, 8)}: ${truncate(row.error, 120)}`,
							),
						);
					}
				}
				log(
					colors.dim(
						`${rows.length} attempt${rows.length === 1 ? "" : "s"}${failed.length ? `, ${failed.length} failed` : ""}`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});
}

// ---------------------------------------------------------------------------
// email logs
// ---------------------------------------------------------------------------

function registerLogCommands(email: Command) {
	const logs = email
		.command("logs")
		.description(
			"List messages this project sent, newest first, with the state each one reached",
		)
		.option(
			"-s, --status <status>",
			`Only messages in this state: ${listed(EMAIL_LOG_STATUSES)}`,
		)
		.option(
			"-n, --limit <n>",
			`Rows per request, 1 to ${MAX_ROW_LIMIT} (default ${DEFAULT_ROW_LIMIT})`,
		)
		.option(
			"--all",
			`Keep following the feed until it ends instead of stopping after one page, up to ${ALL_PAGES_ROW_CAP} rows`,
		)
		.addHelpText(
			"after",
			`
Calls email.listLogs, the one paginated procedure in this group. The cursor is
deliberately not exposed as a flag: one page comes back by default, and --all
follows the server's cursor for you until the feed ends or ${ALL_PAGES_ROW_CAP}
rows have been read.

In --json the envelope carries { items, count, hasMore }. \`hasMore: true\`
means rows were left unread — raise --limit or pass --all rather than looking
for a --cursor.

Examples:
  tarout email logs
  tarout email logs --status bounced -n 20
  tarout email logs --status suppressed --all --json`,
		)
		.action(
			async (options: { status?: string; limit?: string; all?: boolean }) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const status = parseLogStatus(options.status);
					const limit = parseRowLimit(options.limit);
					const client = getApiClient();

					const _spinner = startSpinner("Fetching email logs...");
					const collected = await collectLogPages<EmailLogRow>(
						(cursor) =>
							client.email.listLogs.query({
								limit,
								...(status ? { status } : {}),
								...(cursor ? { cursor } : {}),
							}) as Promise<EmailLogPage>,
						{
							all: options.all,
							onPage: (rows) => updateSpinner(`Fetched ${rows} messages...`),
						},
					);
					succeedSpinner();

					const rows = collected.items;

					if (isJsonMode()) {
						outputData({
							items: rows,
							count: rows.length,
							hasMore: collected.hasMore,
						});
						return;
					}

					if (!rows.length) {
						log("");
						log(
							status
								? `No ${status} messages in this project.`
								: "No messages have been sent from this project yet.",
						);
						log("");
						return;
					}

					log("");
					table(
						["ID", "TO", "SUBJECT", "STATUS", "CREATED"],
						rows.map((row) => [
							shortId(row.logId),
							truncate(formatRecipients(row.to), 30),
							truncate(row.subject || "-", 34),
							formatLogStatus(row.status),
							formatDateTime(row.createdAt),
						]),
					);
					log("");
					log(
						colors.dim(
							`${rows.length} message${rows.length === 1 ? "" : "s"}${collected.pages > 1 ? ` across ${collected.pages} pages` : ""}`,
						),
					);
					if (collected.capped) {
						log(
							colors.warn(
								`Stopped at the ${ALL_PAGES_ROW_CAP}-row ceiling for --all; narrow it with --status.`,
							),
						);
					} else if (collected.hasMore) {
						log(
							colors.dim(
								"More messages are available; pass --all to read the rest.",
							),
						);
					}
					log(`Inspect one: ${colors.dim("tarout email logs view <log-id>")}`);
					log("");
				} catch (err) {
					stopSpinner();
					handleEmailError(err);
				}
			},
		);

	logs
		.command("view")
		.alias("get")
		.argument("<log-id>", "Full message id, as printed by `tarout email logs`")
		.description(
			"Show everything recorded about one message: recipients, status, per-recipient results, the error if it failed, tags, headers and a preview of the body. The id must be exact — the log feed is paginated, so there is no prefix matching here",
		)
		.action(async (logId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const wanted = logId.trim();
				if (!wanted) {
					throw new InvalidArgumentError(
						"Pass the full message id, as printed by `tarout email logs --json`.",
					);
				}
				const client = getApiClient();
				const _spinner = startSpinner("Fetching message...");
				const row = (await client.email.getLog.query({
					logId: wanted,
				})) as EmailLogRow & {
					cc?: unknown;
					bcc?: unknown;
					replyTo?: unknown;
					providerMessageId?: string | null;
					perRecipient?: unknown;
					errorCode?: string | null;
					error?: string | null;
					htmlPreview?: string | null;
					textPreview?: string | null;
					tags?: unknown;
					attemptCount?: number;
					canceledAt?: string | Date | null;
					lastEventAt?: string | Date | null;
				};
				succeedSpinner();

				if (isJsonMode()) {
					outputData(row);
					return;
				}

				quietOutput(row.status);

				log("");
				log(colors.bold(row.subject || "(no subject)"));
				log(colors.dim(row.logId));
				log("");
				log(`  Status:    ${formatLogStatus(row.status)}`);
				log(`  Meaning:   ${describeLogStatus(row.status)}`);
				log(`  From:      ${row.from || colors.dim("-")}`);
				log(`  To:        ${formatRecipients(row.to)}`);
				if (row.cc) log(`  Cc:        ${formatRecipients(row.cc)}`);
				if (row.bcc) log(`  Bcc:       ${formatRecipients(row.bcc)}`);
				if (row.replyTo) {
					log(`  Reply-To:  ${formatRecipients(row.replyTo)}`);
				}
				log(`  Created:   ${formatDateTime(row.createdAt)}`);
				if (row.scheduledAt) {
					log(`  Scheduled: ${formatDateTime(row.scheduledAt)}`);
				}
				if (row.sentAt) log(`  Sent:      ${formatDateTime(row.sentAt)}`);
				if (row.deliveredAt) {
					log(`  Delivered: ${formatDateTime(row.deliveredAt)}`);
				}
				if (row.canceledAt) {
					log(`  Cancelled: ${formatDateTime(row.canceledAt)}`);
				}
				if (row.attemptCount) log(`  Attempts:  ${row.attemptCount}`);
				if (row.providerMessageId) {
					log(`  Provider:  ${colors.dim(row.providerMessageId)}`);
				}
				if (row.error || row.errorCode) {
					log("");
					log(
						`  Error:     ${colors.error(`${row.errorCode ? `${row.errorCode}: ` : ""}${row.error || "no detail recorded"}`)}`,
					);
				}
				const preview = row.textPreview || row.htmlPreview;
				if (preview) {
					log("");
					log(colors.bold("Preview"));
					log(`  ${truncate(preview.replace(/\s+/g, " "), 240)}`);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});
}

// ---------------------------------------------------------------------------
// email suppressions
// ---------------------------------------------------------------------------

function formatSuppressionReason(reason: string): string {
	switch (reason) {
		case "manual":
			return "manual";
		case "bounce":
			return colors.error("bounce");
		case "complaint":
			return colors.error("complaint");
		default:
			return reason;
	}
}

function registerSuppressionCommands(email: Command) {
	const suppressions = email
		.command("suppressions")
		.description(
			"Manage this project's do-not-send list, which the send pipeline strips recipients against",
		)
		.addHelpText(
			"after",
			`
The bounce and complaint pipeline fills this list automatically: a hard bounce
or a spam complaint suppresses that address, and every later send to it is
dropped before delivery and logged as \`suppressed\`. Removing an address tells
Tarout to try it again, so only do it when you know why it bounced.`,
		);

	suppressions
		.command("list")
		.alias("ls")
		.description(
			`List suppressed addresses, newest first. The platform caps this at ${SUPPRESSION_LIST_CAP} rows with no cursor and no filter, so a busy project's oldest entries cannot be listed at all`,
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching suppressions...");
				const rows = asRows<EmailSuppressionRow>(
					await client.email.listSuppressions.query({}),
				);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(rows);
					return;
				}

				if (!rows.length) {
					log("");
					log("No suppressed addresses in this project.");
					log("");
					return;
				}

				log("");
				table(
					["ID", "ADDRESS", "REASON", "CODE", "ADDED"],
					rows.map((row) => [
						shortId(row.suppressionId),
						truncate(row.address, 40),
						formatSuppressionReason(row.reason),
						row.smtpCode ? String(row.smtpCode) : colors.dim("-"),
						formatDateTime(row.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${rows.length} address${rows.length === 1 ? "" : "es"}`,
					),
				);
				if (rows.length >= SUPPRESSION_LIST_CAP) {
					warn(
						`This is the newest ${SUPPRESSION_LIST_CAP} entries, which is everything the platform will return: the procedure has no cursor and no filter. Older entries exist but cannot be listed, and can only be removed by their suppression id.`,
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	suppressions
		.command("add")
		.argument("<address>", "Email address to stop sending to")
		.description(
			"Add an address to this project's do-not-send list. Every later send to it is dropped before delivery and logged as `suppressed`, which is the safe way to honour an unsubscribe or a complaint you heard about out of band",
		)
		.option(
			"--reason <reason>",
			`Why it is suppressed: ${listed(EMAIL_SUPPRESSION_REASONS)} (default manual)`,
		)
		.action(async (address: string, options: { reason?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const wanted = parseEmailAddress(address, "email address");
				const reason = parseSuppressionReason(options.reason);
				const client = getApiClient();
				const _spinner = startSpinner("Adding suppression...");
				await client.email.addSuppression.mutate({
					address: wanted,
					reason,
				});
				succeedSpinner("Address suppressed.");

				if (isJsonMode()) {
					outputData({ suppressed: true, address: wanted, reason });
					return;
				}

				quietOutput(wanted);
				log("");
				log(
					`${colors.bold(wanted)} will no longer receive mail from this project (${formatSuppressionReason(reason)}).`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});

	suppressions
		.command("rm")
		.alias("delete")
		.argument(
			"<address-or-id>",
			"Suppressed address, or its suppression id when the address is past the list cap",
		)
		.description(
			"Remove an address from the do-not-send list so Tarout will try it again. Only do this when you know why it was suppressed: re-sending to a hard-bounced or complaining address damages the sending reputation shared by every Tarout customer",
		)
		.addHelpText(
			"after",
			`
Calls email.removeSuppression, which takes a suppressionId and not an address,
so an address is resolved through email.listSuppressions first.

That lookup is the catch: the list procedure is hard-capped at
${SUPPRESSION_LIST_CAP} rows with no cursor and no filter, so an address older
than the newest ${SUPPRESSION_LIST_CAP} entries CANNOT be found by name. When
that happens, read the suppressionId from the dashboard (or from a
\`--json\` listing taken while it was still inside the cap) and pass the id
here instead — this command accepts a raw id unchanged.`,
		)
		.action(async (identifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const wanted = identifier.trim();
				if (!wanted) {
					throw new InvalidArgumentError(
						"Pass the suppressed address, or its suppression id.",
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Finding suppression...");
				const rows = asRows<EmailSuppressionRow>(
					await client.email.listSuppressions.query({}),
				);
				const lower = wanted.toLowerCase();
				const byAddress = rows.find(
					(row) => row.address.toLowerCase() === lower,
				);

				let suppressionId: string;
				let label: string;
				if (byAddress) {
					suppressionId = byAddress.suppressionId;
					label = byAddress.address;
				} else if (wanted.includes("@")) {
					// Only an address can miss for the cap reason; say so plainly
					// instead of reporting a flat "not found".
					throw new CliError(
						rows.length >= SUPPRESSION_LIST_CAP
							? `"${wanted}" is not in the newest ${SUPPRESSION_LIST_CAP} suppressions, which is every row the platform will return. It may still be suppressed: the list procedure has no cursor and no address filter, so an older entry cannot be looked up by name. Find its suppression id in the dashboard and pass that id here instead.`
							: `"${wanted}" is not suppressed in this project, so there is nothing to remove.`,
						ExitCode.NOT_FOUND,
						rows.slice(0, 10).map((row) => row.address),
						{
							address: wanted,
							listed: rows.length,
							listCap: SUPPRESSION_LIST_CAP,
							atListCap: rows.length >= SUPPRESSION_LIST_CAP,
						},
					);
				} else {
					// A raw id: resolve a prefix when we can see it, otherwise send it
					// through untouched and let the server decide.
					const byPrefix = rows.filter((row) =>
						row.suppressionId.startsWith(wanted),
					);
					if (byPrefix.length > 1) {
						throw new InvalidArgumentError(
							`Suppression id prefix "${wanted}" matches ${byPrefix.length} entries: ${byPrefix
								.map((row) => `${row.suppressionId} (${row.address})`)
								.join(", ")}. Pass the full id instead.`,
						);
					}
					const matched = byPrefix[0];
					suppressionId = matched?.suppressionId ?? wanted;
					label = matched?.address ?? wanted;
				}
				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Address: ${colors.bold(label)}`);
					log(`ID:      ${colors.dim(suppressionId)}`);
					log("");
					log(
						colors.warn(
							"Tarout will try to deliver to this address again. If it hard-bounced or complained, sending to it again hurts the sending reputation shared with every other Tarout customer.",
						),
					);
					log("");
					const confirmed = await confirm(
						`Remove "${label}" from the do-not-send list?`,
						false,
						{
							field: "confirm_remove_email_suppression",
							flag: "--yes",
							context: { address: label, suppressionId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _removeSpinner = startSpinner("Removing suppression...");
				await client.email.removeSuppression.mutate({ suppressionId });
				succeedSpinner("Suppression removed.");

				if (isJsonMode()) {
					outputData({ removed: true, suppressionId, address: label });
					return;
				}

				quietOutput(label);
			} catch (err) {
				stopSpinner();
				handleEmailError(err);
			}
		});
}

// ---------------------------------------------------------------------------
// email send-test
// ---------------------------------------------------------------------------

function registerSendTest(email: Command) {
	email
		.command("send-test")
		.argument("<to>", "The one recipient address to send the fixed test to")
		.description(
			"Send Tarout Email's built-in test message to a single recipient. This is NOT a general send API: the body is fixed and there is exactly one recipient, so only the sender and the subject can be changed. Use it to prove a sending identity, DNS and the suppression list behave end to end",
		)
		.option(
			"--from <address>",
			"Sender address; must be at a verified sending domain in this project, or at the shared sending domain. Defaults to test@<shared sending domain>, and is REQUIRED when no shared domain is configured",
		)
		.option(
			"--subject <subject>",
			'Subject line (default "Test email from Tarout")',
		)
		.addHelpText(
			"after",
			`
Calls email.sendTestEmail, which goes through the same accept pipeline as the
real send API: sender verification, the sandbox recipient rule, the suppression
list and the daily quota all apply. Quiet mode prints the message id, which
\`tarout email logs view <log-id>\` then resolves.

The body is hardcoded platform-side. Do not script this as a way to send mail:
send real mail with a Tarout Email API key against the REST API.

It refuses outright when the project's email service is switched off, and when
no shared sending domain is configured and --from was omitted — in that case
verify a domain and name a sender explicitly.

While the project is in sandbox the recipient must be an active member of your
own organization; any other address is refused.`,
		)
		.action(
			async (to: string, options: { from?: string; subject?: string }) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const recipient = parseEmailAddress(to, "recipient address");
					const from = options.from
						? parseEmailAddress(options.from, "--from address")
						: undefined;
					const subject = options.subject?.trim();
					if (options.subject !== undefined && !subject) {
						throw new InvalidArgumentError(
							"--subject cannot be empty; omit the flag to use the default subject.",
						);
					}

					const client = getApiClient();
					const _spinner = startSpinner(`Sending test email to ${recipient}...`);
					const sent = (await client.email.sendTestEmail.mutate({
						to: recipient,
						...(from ? { from } : {}),
						...(subject ? { subject } : {}),
					})) as { logId: string };
					succeedSpinner("Test email accepted.");

					if (isJsonMode()) {
						outputData({ ...sent, to: recipient, ...(from ? { from } : {}) });
						return;
					}

					quietOutput(sent.logId);
					log("");
					log(
						`Accepted for delivery to ${colors.bold(recipient)} ${colors.dim(sent.logId)}`,
					);
					log("");
					log(
						`Follow it: ${colors.dim(`tarout email logs view ${sent.logId}`)}`,
					);
					log(
						colors.dim(
							"Accepted is not delivered: watch the message status until it reaches delivered, bounced or failed.",
						),
					);
					log("");
				} catch (err) {
					stopSpinner();
					handleEmailError(err);
				}
			},
		);
}
