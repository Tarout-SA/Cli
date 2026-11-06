import { type Command, InvalidArgumentError } from "commander";
import { getApiClient } from "../lib/api.js";
import {
	type BillingChangeResult,
	emitBillingResult,
	finalizeBillingMutation,
	performBillingChange,
	pollCheckoutUntilTerminal,
	resolveCheckoutAmountDisplay,
	storageSlotTierForAddonKey,
} from "../lib/billing-upgrade.js";
import {
	paymentBrowserOpener,
	shouldAutoConfirmPaidCheckout,
} from "../lib/browser.js";
import { getApiUrl, getCurrentProfile, isLoggedIn } from "../lib/config.js";
// NOTE: this module already imports Commander's `InvalidArgumentError` (used by
// the argParsers below, where Commander catches it and exits 2 itself). The CLI
// error class of the same name is aliased so it can be thrown from inside
// `.action()` bodies, where only `handleError` is watching and only a `CliError`
// maps onto the INVALID_ARGUMENTS exit code / JSON envelope.
import {
	AuthError,
	CliError,
	handleError,
	InvalidArgumentError as CliInvalidArgumentError,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	isNonInteractiveMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import {
	buildPlanAddonCart,
	isPaidFamily,
	planFamily,
} from "../lib/plan-cart.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { confirm, input, select } from "../utils/prompts.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
} from "../utils/spinner.js";

// Re-exported for back-compat: callers (e.g. deploy.ts dynamic import, tests)
// historically imported the poll helper from this module before it moved into
// the shared billing engine.
export { pollCheckoutUntilTerminal };

/**
 * Map a billing-engine result to output + exit. Centralizes the
 * `emitBillingResult` + `exit(code)` pattern used by every billing-mutating
 * command so the agent JSON envelope and exit codes stay identical everywhere.
 */
function reportBillingResult(result: BillingChangeResult, label: string): void {
	const code = emitBillingResult(result, { label });
	if (code !== ExitCode.SUCCESS) exit(code);
}

/** Read a plan's key across the catalog's field variants. */
export function planKeyOf(p: unknown): string {
	const o = p as { planKey?: string; key?: string; name?: string };
	return (o?.planKey || o?.key || o?.name || "").toString();
}

/**
 * Classify a target plan relative to the current one using catalog `sortOrder`.
 * Missing keys and `free` rank as the lowest baseline (-1). Throws on an unknown
 * target so `billing downgrade` fails loudly instead of guessing.
 */
export function classifyPlanDirection(
	plans: unknown[],
	currentPlanKey: string | null | undefined,
	targetPlanKey: string,
): "upgrade" | "same" | "downgrade" {
	const rankOf = (key: string | null | undefined): number | null => {
		const k = (key ?? "").toString();
		if (!k) return -1;
		const match = plans.find(
			(x) => planKeyOf(x).toLowerCase() === k.toLowerCase(),
		) as { sortOrder?: number } | undefined;
		if (match && typeof match.sortOrder === "number") return match.sortOrder;
		if (k.toLowerCase() === "free") return -1;
		return null;
	};
	const targetRank = rankOf(targetPlanKey);
	if (targetRank === null) {
		throw new CliError(
			`Unknown plan "${targetPlanKey}". Run \`tarout billing plans\` to see available plans.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	const currentRank = rankOf(currentPlanKey) ?? -1;
	if (targetRank > currentRank) return "upgrade";
	if (targetRank === currentRank) return "same";
	return "downgrade";
}

/** True when a tRPC error carries a CONFLICT code (either v10 shape). */
function isConflictError(err: unknown): boolean {
	const e = err as { code?: string; data?: { code?: string } };
	return (e?.code ?? e?.data?.code) === "CONFLICT";
}

/**
 * Best-effort prorated amount-due (in halalas) for adding `quantity` of an
 * addon. Used only to decide whether an agent context can auto-confirm the
 * hosted checkout (a positive charge sends consent to the payment page). Returns
 * `undefined` if the preview can't be fetched — callers then fall back to the
 * explicit confirm prompt rather than auto-confirming.
 */
async function previewAddonAmountDue(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	addonKey: string,
	quantity: number,
): Promise<number | undefined> {
	try {
		// Per-tier storage bucket slots aren't `purchaseAddons` lines (that path
		// rejects them via `assertResourceAddonsMatchPlan`), so price them from the
		// catalog instead — enough to know it's a paid checkout for auto-confirm.
		if (storageSlotTierForAddonKey(addonKey)) {
			const catalog = await client.subscription.getCatalog.query();
			const addon = (catalog?.addons ?? []).find(
				(a: any) => (a.key ?? a.addonKey) === addonKey,
			);
			return typeof addon?.priceHalalas === "number"
				? addon.priceHalalas * quantity
				: undefined;
		}
		const preview = await client.subscription.previewAddonsPurchase.query({
			items: [{ addonKey, quantity }],
		});
		return typeof preview?.totalProratedHalalas === "number"
			? preview.totalProratedHalalas
			: undefined;
	} catch {
		return undefined;
	}
}

// ── Billing analytics window helpers ────────────────────────────────────────
// `billing.getUsageBreakdown`, `billing.getDetailedResourceUsage` and
// `billing.getDailyCostTrend` all take the SAME optional input and nothing
// else: `{ startDate?: string; endDate?: string }`. Zod strips every other key
// silently, so a made-up flag (the old `{ days }`) never reaches the server and
// the response comes back on the default window with no warning. Any window the
// CLI offers therefore has to be resolved here into that one pair.

/**
 * Validate a `--from`/`--to` value and normalise it to an ISO string.
 * A bare `YYYY-MM-DD` is anchored in UTC so the window does not drift with the
 * operator's timezone; `--to` is pushed to the end of that day, otherwise it
 * would cut off at 00:00 and silently drop a full day of usage.
 */
function parseDateFlag(raw: string, flag: string, endOfDay: boolean): string {
	const value = String(raw).trim();
	const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
		? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`)
		: new Date(value);
	if (!value || Number.isNaN(parsed.getTime())) {
		throw new InvalidArgumentError(
			`Invalid ${flag} value "${raw}". Expected a date like 2026-07-01.`,
		);
	}
	return parsed.toISOString();
}

/** Commander argParser for `--from`. */
function parseFromDate(raw: string): string {
	return parseDateFlag(raw, "--from", false);
}

/** Commander argParser for `--to`. */
function parseToDate(raw: string): string {
	return parseDateFlag(raw, "--to", true);
}

/** Commander argParser for `--days`. */
function parseDaysOption(raw: string): number {
	const n = Number.parseInt(String(raw).trim(), 10);
	if (!Number.isFinite(n) || n <= 0) {
		throw new InvalidArgumentError(
			`Invalid --days value "${raw}". Expected a positive integer.`,
		);
	}
	return n;
}

/**
 * Build the optional `{ startDate, endDate }` argument. Returns `undefined`
 * when neither bound is set so the procedure keeps its own default window
 * instead of being handed an empty object.
 */
function dateRangeArg(
	from?: string,
	to?: string,
): { startDate?: string; endDate?: string } | undefined {
	if (!from && !to) return undefined;
	return {
		...(from ? { startDate: from } : {}),
		...(to ? { endDate: to } : {}),
	};
}

/**
 * Resolve `tarout billing trend`'s window. `--days N` is CLI-side sugar — the
 * procedure only understands startDate/endDate — so N becomes a real
 * `[now - N days, now]` pair. Combining it with `--from`/`--to` is rejected
 * instead of letting one silently win.
 */
function resolveTrendRange(options: {
	days?: number;
	from?: string;
	to?: string;
}): { startDate?: string; endDate?: string } | undefined {
	if (options.days !== undefined && (options.from || options.to)) {
		throw new CliInvalidArgumentError(
			"Use either --days or --from/--to, not both.",
		);
	}
	if (options.days !== undefined) {
		const now = new Date();
		const start = new Date(now.getTime() - options.days * 24 * 60 * 60 * 1000);
		return { startDate: start.toISOString(), endDate: now.toISOString() };
	}
	return dateRangeArg(options.from, options.to);
}

/** Print the window the server actually used, under an analytics heading. */
function logBillingPeriod(period: unknown): void {
	const p = period as { start?: string; end?: string } | undefined;
	if (!p?.start || !p?.end) return;
	log(colors.dim(`  ${formatDate(p.start)} → ${formatDate(p.end)}`));
}

/** The `resourceType` enum `billing.getResourceEstimate` actually accepts. */
const ESTIMATE_RESOURCE_TYPES = [
	"application",
	"dedicated_server",
	"postgres",
	"mysql",
	"storage",
	"cloud_server",
] as const;

/** Friendly spellings mapped onto that enum (there is no "domain" estimate). */
const ESTIMATE_TYPE_ALIASES: Record<string, string> = {
	app: "application",
	apps: "application",
	server: "dedicated_server",
	"dedicated-server": "dedicated_server",
	database: "postgres",
	db: "postgres",
	pg: "postgres",
	vm: "cloud_server",
	"cloud-server": "cloud_server",
};

/** Commander argParser for `estimate --type`. */
function parseEstimateType(raw: string): string {
	const value = String(raw).trim().toLowerCase();
	const mapped = ESTIMATE_TYPE_ALIASES[value] ?? value;
	if (!(ESTIMATE_RESOURCE_TYPES as readonly string[]).includes(mapped)) {
		throw new InvalidArgumentError(
			`Invalid --type "${raw}". Expected one of: ${ESTIMATE_RESOURCE_TYPES.join(", ")}.`,
		);
	}
	return mapped;
}

/** `estimate --plan` maps onto the schema's `appPlan` enum, not a plan key. */
function parseAppPlan(raw: string): "FREE" | "SHARED" | "DEDICATED" | "CUSTOM" {
	const value = String(raw).trim().toUpperCase();
	if (
		value === "FREE" ||
		value === "SHARED" ||
		value === "DEDICATED" ||
		value === "CUSTOM"
	) {
		return value;
	}
	throw new CliInvalidArgumentError(
		`Invalid --plan "${raw}". Expected free, shared, dedicated or custom.`,
	);
}

// ── Ops-recovery helpers ────────────────────────────────────────────────────
// Everything below backs the headless recovery surface: billing standing, the
// renewal retry, the monthly/yearly interval switch, and the shared→dedicated
// app migration. They are pure (or read only the global output flags) so the
// contracts can be unit-tested without a network client.

/**
 * Render an integer halala amount as SAR. Every money field on the wire is an
 * integer count of halalas (1 SAR = 100 halalas); the VAT parenthetical is NOT
 * computed here — it comes from the server's own `tax` block via
 * `resolveCheckoutAmountDisplay`, which renders the actual rate (0 while Tarout
 * is not VAT-registered) instead of a hardcoded 15%.
 */
export function formatSarAmount(halalas: number | null | undefined): string {
	if (typeof halalas !== "number" || !Number.isFinite(halalas)) return "-";
	return `${(halalas / 100).toFixed(2)} SAR`;
}

/** The two intervals `subscription.changeBillingPeriod` accepts. */
export const BILLING_PERIOD_TARGETS = ["monthly", "yearly"] as const;
export type BillingPeriodTarget = (typeof BILLING_PERIOD_TARGETS)[number];

/**
 * Validate the target interval for `period:preview` / `period:set`. The
 * procedure's zod input is `{ targetPeriod: "monthly" | "yearly" }` with no
 * default, so an unnamed or misspelled interval has to fail here rather than
 * being guessed — guessing "yearly" would charge a year up front.
 */
export function parseBillingPeriodTarget(raw: unknown): BillingPeriodTarget {
	const value = String(raw ?? "")
		.trim()
		.toLowerCase();
	const match = BILLING_PERIOD_TARGETS.find((period) => period === value);
	if (!match) {
		throw new CliInvalidArgumentError(
			`Invalid billing period "${String(raw ?? "")}". Expected monthly or yearly; the procedure has no default, so the target interval must be named explicitly.`,
		);
	}
	return match;
}

/** The exact input both billing-period procedures validate. */
export function billingPeriodChangeArg(raw: unknown): {
	targetPeriod: BillingPeriodTarget;
} {
	return { targetPeriod: parseBillingPeriodTarget(raw) };
}

/** What `subscription.changeBillingPeriod` answers with. */
export interface BillingPeriodChangeResponse {
	status?: string;
	effectiveAt?: string | Date | null;
	chargeTodayHalalas?: number | null;
	paymentUrl?: string | null;
	publicPaymentUrl?: string | null;
	orderId?: string | null;
}

/**
 * Re-shape a `changeBillingPeriod` result into the field names
 * `finalizeBillingMutation` reads, so the interval switch rides the SAME
 * classify-and-poll path as `billing upgrade` instead of growing a second
 * payment plumbing.
 *
 * - `scheduled` (yearly→monthly): no charge, no order, no refund — the rollover
 *   queue applies it at term end, so it classifies as `deferred`.
 * - `checkout` (monthly→yearly): carries orderId + payment URLs, the ordinary
 *   hosted-checkout shape.
 * - `applied`: net-zero/instant apply.
 *
 * `chargeTodayHalalas` is mapped onto `proratedChargeHalalas` because that is
 * the key the engine's amount reader looks for; the value is unchanged, so the
 * amount `period:preview` showed is the amount reported here.
 */
export function billingPeriodMutationShape(
	raw: BillingPeriodChangeResponse | null | undefined,
): {
	applied: boolean;
	proratedChargeHalalas: number;
	effectiveAt?: string | Date;
	orderId?: string;
	paymentUrl?: string;
	publicPaymentUrl?: string;
} {
	const charge =
		typeof raw?.chargeTodayHalalas === "number" ? raw.chargeTodayHalalas : 0;
	return {
		applied: raw?.status === "applied",
		proratedChargeHalalas: charge,
		...(raw?.effectiveAt ? { effectiveAt: raw.effectiveAt } : {}),
		...(raw?.orderId ? { orderId: raw.orderId } : {}),
		...(raw?.paymentUrl ? { paymentUrl: raw.paymentUrl } : {}),
		...(raw?.publicPaymentUrl
			? { publicPaymentUrl: raw.publicPaymentUrl }
			: {}),
	};
}

/** What `subscription.getStanding` answers with (null when healthy). */
export interface BillingStanding {
	kind?: string;
	severity?: string;
	daysLeft?: number;
}

/**
 * Exit code for `billing standing`. A `danger` severity (PAUSED or CANCELED —
 * the states where resources are already being cut off) exits non-zero so a CI
 * job or a cron can gate on `tarout billing standing` without parsing JSON. A
 * `warning` (PAST_DUE inside the grace window) and a healthy/absent standing
 * both exit 0: those are reportable, not yet failing.
 */
export function exitCodeForStanding(
	standing: BillingStanding | null | undefined,
): number {
	return standing?.severity === "danger"
		? ExitCode.GENERAL_ERROR
		: ExitCode.SUCCESS;
}

/** The dashboard page where a human adds or replaces the card on file. */
export function addCardDashboardUrl(): string {
	let base = "https://tarout.sa";
	try {
		base = getApiUrl();
	} catch {
		// A rejected TAROUT_API_URL must not hide the link; the default host is
		// still where the dashboard lives.
	}
	return `${base.replace(/\/+$/, "")}/dashboard/billing/add-card`;
}

/**
 * How `billing retry-renewal` must collect consent.
 *
 * This deliberately does NOT use `shouldAutoConfirmPaidCheckout`. That helper
 * exists because a paid plan change ends on a hosted Moyasar page where the
 * human reads the amount and types card details — that page IS the consent
 * surface, so a local y/n only halts the agent. A renewal retry has no such
 * page: it charges the already-saved card server-side, immediately. Nothing
 * downstream asks the human anything, so the CLI is the only place consent can
 * be taken.
 *
 *   skip    `--yes` was passed: consent is explicit and on the record.
 *   refuse  `--json` / `--non-interactive` without `--yes`: refuse up front.
 *   confirm interactive TTY: ask.
 */
export type RenewalConsent = "skip" | "refuse" | "confirm";

export function renewalConsentGate(): RenewalConsent {
	if (shouldSkipConfirmation()) return "skip";
	if (isJsonMode() || isNonInteractiveMode()) return "refuse";
	return "confirm";
}

/** What `subscription.retryRenewal` answers with. */
export interface RetryRenewalResult {
	status?: string;
	reason?: string | null;
}

export interface RetryRenewalReport {
	/** Error code for the JSON envelope; null on success. */
	code: string | null;
	message: string;
	exitCode: number;
}

/**
 * Map a `retryRenewal` outcome onto an operator-readable report and an exit
 * code. The procedure cannot choose its own amount and cannot double-charge (a
 * Postgres advisory lock plus a deterministic provider order id), so the only
 * question left is what happened:
 *
 *   charged  the saved card was charged and the period rolled → exit 0
 *   no_card  nothing to charge against → exit 1, pointing at the dashboard
 *   failed   the provider declined (or the charge errored) → exit 1
 *   skipped  the server refused to charge (not due, catalog defect) → exit 1
 *
 * `skipped` is deliberately non-zero: no money moved, so a recovery script that
 * treated it as success would mark the incident resolved while the
 * subscription is still unpaid.
 */
export function describeRetryRenewal(
	result: RetryRenewalResult | null | undefined,
	addCardUrl: string,
): RetryRenewalReport {
	const status = result?.status ?? "unknown";
	const reason = result?.reason ? String(result.reason) : "";
	switch (status) {
		case "charged":
			return {
				code: null,
				message:
					reason === "promo_free_cycle"
						? "A running promo covered the whole cycle, so the renewal was applied without a charge."
						: "The renewal was charged to the card on file and the billing period rolled forward.",
				exitCode: ExitCode.SUCCESS,
			};
		case "no_card":
			return {
				code: "NO_PAYMENT_METHOD",
				message: `There is no usable card on file for this subscription, so there is nothing to charge. A human has to add one at ${addCardUrl} and then re-run this command; the CLI cannot add or read a card (those procedures are deliberately off the agent surface).`,
				exitCode: ExitCode.GENERAL_ERROR,
			};
		case "failed":
			return {
				code: "RENEWAL_CHARGE_FAILED",
				message: `The renewal charge did not go through${reason ? ` (${reason})` : ""}. The saved card was attempted and declined or errored; nothing was captured. A manual retry does not advance the dunning ladder, so retrying is safe, but a repeated decline needs a different card at ${addCardUrl}.`,
				exitCode: ExitCode.GENERAL_ERROR,
			};
		case "skipped":
			return {
				code: "RENEWAL_NOT_CHARGED",
				message: `The server declined to charge this renewal${reason ? ` (${reason})` : ""}, so no money moved and the subscription is unchanged. This is not a payment failure: the subscription was not actually due, or its plan price is unusable.`,
				exitCode: ExitCode.GENERAL_ERROR,
			};
		default:
			return {
				code: "RENEWAL_UNKNOWN_STATUS",
				message: `The platform returned an unrecognised renewal status "${status}". Treat the renewal as unresolved and check \`tarout billing invoices\` before retrying.`,
				exitCode: ExitCode.GENERAL_ERROR,
			};
	}
}

/** What `subscription.getActiveMigration` answers with. */
export interface ActiveMigrationResponse {
	active?: boolean;
	mode?: string;
	stage?: string;
	startedAt?: string | Date | null;
	canCutover?: boolean;
	progressPct?: number;
	host?: { name?: string | null; status?: string | null } | null;
	counts?: {
		copied?: number;
		failed?: number;
		provisioning?: number;
		ready?: number;
		total?: number;
	};
}

export interface MigrationSummary {
	active: boolean;
	stage: string | null;
	headline: string;
	/** Extra context an operator should read before acting, when there is any. */
	note?: string;
	/** The command that moves this migration forward, when one applies. */
	nextCommand?: string;
	/** Whole days since the earliest copy row, or null when unknown. */
	ageDays: number | null;
}

/** A `ready_to_cutover` older than this is worth calling out explicitly. */
const MIGRATION_OLD_AFTER_DAYS = 7;

/**
 * Turn an `getActiveMigration` payload into one line an operator (or an agent
 * polling it) can act on, plus the command that moves it forward.
 *
 * The normal path is automatic: the queue worker cuts over on its own once
 * every copied app is healthy on the new host. `migrate:cutover` and
 * `migrate:rollback` are the retry/fallback for when that did not happen.
 *
 * `COPIED` rows are deliberately never aged out server-side — their only exit
 * is a cutover — so a legitimately months-old `ready_to_cutover` exists in
 * production. That is reported as old, never as "nothing is happening".
 */
export function summarizeMigration(
	migration: ActiveMigrationResponse | null | undefined,
	now: Date = new Date(),
): MigrationSummary {
	if (!migration?.active) {
		return {
			active: false,
			stage: null,
			headline:
				"No shared-to-dedicated app migration is in flight for this project.",
			ageDays: null,
		};
	}

	const counts = migration.counts ?? {};
	const copied = counts.copied ?? 0;
	const failed = counts.failed ?? 0;
	const provisioning = counts.provisioning ?? 0;
	const ready = counts.ready ?? 0;
	const total = counts.total ?? 0;
	const hostName = migration.host?.name || "the dedicated host";
	const progress =
		typeof migration.progressPct === "number" ? migration.progressPct : 0;
	const started = migration.startedAt ? new Date(migration.startedAt) : null;
	const ageDays =
		started && !Number.isNaN(started.getTime())
			? Math.floor((now.getTime() - started.getTime()) / 86_400_000)
			: null;
	const stage = migration.stage ?? null;

	if (stage === "ready_to_cutover") {
		const old =
			ageDays !== null && ageDays >= MIGRATION_OLD_AFTER_DAYS
				? `This move has been waiting ${ageDays} days. Copied apps are never aged out server-side — their only exit is a cutover — so an old ready_to_cutover is real and still actionable, not a stale record. Both hosts are being paid for until it finishes.`
				: undefined;
		if (migration.canCutover) {
			return {
				active: true,
				stage,
				headline: `${copied} of ${total} app(s) are copied onto ${hostName} and ${ready} are healthy there, waiting for the traffic cutover.`,
				...(old ? { note: old } : {}),
				nextCommand: "tarout billing migrate:cutover",
				ageDays,
			};
		}
		return {
			active: true,
			stage,
			headline: `${copied} of ${total} app(s) are copied onto ${hostName} but none are healthy there yet, so the cutover would be refused.`,
			note:
				old ??
				"Cutover promotes only apps the new host reports healthy; wait for one to come up, or fix the app and re-check.",
			nextCommand: "tarout billing migrate:status",
			ageDays,
		};
	}

	if (stage === "failed") {
		return {
			active: true,
			stage,
			headline: `Every copy in this move failed (${failed} app(s)); nothing has been cut over and traffic is still on the shared pool.`,
			note: "Roll back to release the dedicated host's migration claim, then start the move again once the cause is fixed.",
			nextCommand: "tarout billing migrate:rollback",
			ageDays,
		};
	}

	return {
		active: true,
		stage: stage ?? "copying",
		headline: `Copying ${provisioning || total} app(s) onto ${hostName} — ${progress}% of the way to a cutover.`,
		note: "A queue worker cuts over automatically once every copied app is healthy on the new host; the manual cutover command is only the retry path.",
		nextCommand: "tarout billing migrate:status",
		ageDays,
	};
}

/** Which checkout a `payment.getCheckoutOrder` id belongs to. */
export function orderIdKind(
	orderId: string,
): "subscription" | "wallet" | "domain" | "unknown" {
	const id = String(orderId ?? "").trim();
	if (id.startsWith("sub_")) return "subscription";
	if (id.startsWith("top_")) return "wallet";
	if (id.startsWith("dom_")) return "domain";
	return "unknown";
}

/**
 * Refuse a non-subscription order id before it reaches
 * `subscription.cancelCheckout`, which matches on subscription checkouts only
 * and would answer `cancelled: false` for a wallet or domain order — reading as
 * "already settled" when the real problem is the wrong command.
 */
export function assertSubscriptionCheckoutOrderId(orderId: string): void {
	const kind = orderIdKind(orderId);
	if (kind === "wallet") {
		throw new CliInvalidArgumentError(
			`"${orderId}" is a wallet top-up order, not a subscription checkout. Abandon it with \`tarout wallet cancel ${orderId}\` instead.`,
		);
	}
	if (kind === "domain") {
		throw new CliInvalidArgumentError(
			`"${orderId}" is a domain order, not a subscription checkout. Subscription checkouts created by \`tarout billing upgrade\` look like "sub_…".`,
		);
	}
}

/**
 * Exit code for `billing order`. A checkout the platform says is still payable
 * exits CHECKOUT_PENDING (13) so an agent can tell "this order is resumable,
 * hand the URL to a human or poll it" apart from a plain read. Terminal and
 * in-flight-but-unpayable orders exit 0: reporting history is not a failure.
 */
export function exitCodeForCheckoutOrder(
	order: { canPay?: boolean } | null | undefined,
): number {
	return order?.canPay === true
		? ExitCode.CHECKOUT_PENDING
		: ExitCode.SUCCESS;
}

export function registerBillingCommands(program: Command) {
	const billing = program
		.command("billing")
		.description("Manage subscription and billing");

	// Show current subscription status
	billing
		.command("status")
		.description("Show current subscription and entitlements")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching subscription...");

				const subscription = await client.subscription.getCurrent.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(subscription);
					return;
				}

				// Quiet mode: emit the active plan key (or "free" when none).
				quietOutput(subscription?.planKey || "free");

				log("");
				log(colors.bold("Current Subscription"));
				// Subscriptions are per-project — name the project this plan belongs
				// to so a multi-project user knows which one they're looking at.
				const profile = getCurrentProfile();
				if (profile?.projectName) {
					log(`  ${colors.dim(`Project: ${profile.projectName}`)}`);
				}
				log("");

				if (!subscription || !subscription.planKey) {
					log(`  Plan: ${colors.dim("No active subscription (free tier)")}`);
				} else {
					log(`  Plan: ${colors.cyan(subscription.planKey)}`);
					if (subscription.planQuantity && subscription.planQuantity > 1) {
						log(`  Quantity: ${subscription.planQuantity}`);
					}
					log(`  Status: ${formatSubStatus(subscription.status || "active")}`);
					if (subscription.currentPeriodEnd) {
						log(`  Renews: ${formatDate(subscription.currentPeriodEnd)}`);
					}
					if (subscription.cancelAtPeriodEnd) {
						log(`  ${colors.warn("⚠ Cancels at end of billing period")}`);
					}
				}

				// Addons
				if (subscription?.items && subscription.items.length > 0) {
					log("");
					log(colors.bold("Add-ons"));
					table(
						["ADDON", "QUANTITY"],
						subscription.items.map((item: any) => [
							colors.cyan(item.addonKey || item.key || ""),
							String(item.quantity || 1),
						]),
					);
				}

				log("");
				log(`To view available plans: ${colors.dim("tarout billing plans")}`);
			} catch (err) {
				handleError(err);
			}
		});

	// List available plans
	billing
		.command("plans")
		.description("List available subscription plans")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching plans...");

				const catalog = await client.subscription.getCatalog.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(catalog);
					return;
				}

				log("");
				log(colors.bold("Available Plans"));
				log("");

				const plans = catalog?.plans || catalog || [];

				if (!Array.isArray(plans) || plans.length === 0) {
					log("No plans available.");
					return;
				}

				table(
					["PLAN", "PRICE", "DESCRIPTION"],
					plans.map((p: any) => [
						colors.cyan(p.planKey || p.key || p.name || ""),
						p.priceHalalas
							? `${(p.priceHalalas / 100).toFixed(2)} SAR/mo`
							: colors.dim("Free"),
						p.description || "",
					]),
				);

				log("");
				log(`To upgrade: ${colors.dim("tarout billing upgrade <plan>")}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Upgrade / change plan
	billing
		.command("upgrade")
		.argument("[plan]", "Plan key to switch to (alias: --plan)")
		.description("Upgrade or change subscription plan")
		.option(
			"--plan <key>",
			"Plan key (alias for the positional argument; useful for agent invocations)",
		)
		.option(
			"-q, --quantity <n>",
			"Plan quantity (for multi-slot plans)",
			Number.parseInt,
		)
		.option(
			"--billing-period <period>",
			"Billing period: monthly or yearly (yearly = 10× monthly, 2 months free)",
			parseBillingPeriod,
		)
		.option(
			"--addon <key[:qty]>",
			"Bundled addon to purchase with the plan change (repeatable, e.g. --addon db.standard:2)",
			collectAddon,
			[] as Array<{ addonKey: string; quantity: number }>,
		)
		.option(
			"--wait",
			"Wait/poll until the hosted checkout is confirmed (this is the default)",
		)
		.option(
			"--no-wait",
			"Return as soon as the hosted checkout opens, without polling for confirmation (default: wait until paid)",
		)
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.option(
			"--no-open",
			"Do not auto-open the payment URL in the default browser",
		)
		.action(async (planKey, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Fetch catalog if no plan specified
				let targetPlan: string | undefined = planKey || options.plan;
				const billingPeriod = options.billingPeriod as
					| "monthly"
					| "yearly"
					| undefined;
				let planQuantity = options.quantity as number | undefined;
				// Explicit `--addon` flags take priority; otherwise we may build the
				// bundled cart interactively below (estimator parity).
				let addons: Array<{ addonKey: string; quantity: number }> | undefined =
					Array.isArray(options.addon) && options.addon.length > 0
						? options.addon
						: undefined;

				if (!targetPlan) {
					const _spinner = startSpinner("Fetching plans...");
					const catalog = await client.subscription.getCatalog.query();
					succeedSpinner();

					const plans = catalog?.plans || catalog || [];
					if (!Array.isArray(plans) || plans.length === 0) {
						log("No plans available.");
						return;
					}

					targetPlan = await select<string>(
						"Select a plan:",
						plans.map((p: any) => ({
							name: `${p.planKey || p.key || p.name} ${p.priceHalalas ? `(${(p.priceHalalas / 100).toFixed(2)} SAR/mo)` : "(Free)"}`,
							value: p.planKey || p.key || p.name,
						})),
						{
							field: "plan",
							flag: "--plan",
							context: {
								available: plans.map((p: any) => ({
									key: p.planKey || p.key || p.name,
									priceHalalas: p.priceHalalas ?? 0,
								})),
							},
						},
					);
				}

				if (!targetPlan) {
					// Defensive — select() either returns a value or exits the
					// process (NEEDS_INPUT path). This branch is unreachable.
					throw new Error("No plan selected");
				}

				// Estimator parity: when run interactively without explicit `--addon`
				// flags, offer to bundle databases + storage into the same checkout —
				// exactly like the dashboard plan-card estimator. This is what makes
				// `tarout billing upgrade shared` actually grant a DB/storage slot
				// instead of an app-only plan. Agent / --json / --yes mode stays
				// explicit: we never silently add paid addons there.
				if (
					!isJsonMode() &&
					!isNonInteractiveMode() &&
					!shouldSkipConfirmation() &&
					!addons &&
					isPaidFamily(targetPlan)
				) {
					const databases = parsePositiveInt(
						await input("How many databases to include?", "1"),
						0,
					);
					const storageGb = parsePositiveInt(
						await input("Object storage to include (GB, 0 for none)?", "5"),
						0,
					);

					const cart = buildPlanAddonCart(targetPlan, { databases, storageGb });
					if (cart.length > 0) addons = cart;
				}

				// Preview the change
				const _previewSpinner = startSpinner("Calculating change...");
				let preview: any;
				try {
					preview = await client.subscription.previewPlanChange.query({
						planKey: targetPlan,
						planQuantity,
						billingPeriod,
						addons,
					});
					succeedSpinner();
				} catch {
					failSpinner();
					preview = null;
				}

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Plan: ${colors.cyan(targetPlan)}`);
					if (planQuantity) log(`Quantity: ${planQuantity}`);
					if (billingPeriod) log(`Billing period: ${billingPeriod}`);
					if (addons && addons.length > 0) {
						log(
							`Addons: ${addons
								.map((a) => `${a.addonKey}×${a.quantity}`)
								.join(", ")}`,
						);
					}
					// `previewPlanChange` returns `proratedChargeHalalas` (amount due
					// now) and `newPeriodTotalHalalas` (new recurring total). There is
					// no `amountDue` field — reading it left this line permanently
					// blank.
					const amountDueHalalas: number | undefined =
						typeof preview?.proratedChargeHalalas === "number"
							? preview.proratedChargeHalalas
							: undefined;
					// Show the grossed-up total the gateway actually charges and the
					// ACTUAL VAT rate from the preview (0 while Tarout isn't VAT-
					// registered → no VAT shown), never a hardcoded 15%.
					const { amountHalalas: displayDueHalalas, vatNote } =
						resolveCheckoutAmountDisplay(preview?.tax, amountDueHalalas);
					if (displayDueHalalas !== undefined) {
						log(
							`Amount due now: ${colors.bold(`${(displayDueHalalas / 100).toFixed(2)} SAR`)}${vatNote ? ` ${vatNote}` : ""}`,
						);
					}
					if (typeof preview?.newPeriodTotalHalalas === "number") {
						log(
							`New recurring total: ${(preview.newPeriodTotalHalalas / 100).toFixed(2)} SAR`,
						);
					}
					log("");

					// Agent path: a paid upgrade goes through the hosted Moyasar
					// checkout, where the user reviews the amount and enters card
					// details in the browser — that page is the real consent surface.
					// So when we're driving an agent (non-TTY) that can open a browser
					// and this is a positive charge, skip the local y/n (which would
					// otherwise halt with `needs_input`) and let the payment page below
					// collect consent. `--json` agents keep the structured handoff;
					// net-zero/free changes (no amount due) still confirm, since those
					// apply instantly with no payment page to gate them.
					if (shouldAutoConfirmPaidCheckout(amountDueHalalas)) {
						log(
							"Opening the secure payment page in your browser to complete the upgrade...",
						);
					} else {
						const confirmed = await confirm(
							`Switch to plan "${targetPlan}"?`,
							false,
							{
								field: "confirm_upgrade",
								flag: "--yes",
								context: {
									plan: targetPlan,
									quantity: planQuantity,
									billingPeriod,
									addons,
									amountDueHalalas,
								},
							},
						);

						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}
				}

				const _changeSpinner = startSpinner("Changing plan...");

				const result = await performBillingChange(client, {
					kind: "plan",
					planKey: targetPlan,
					quantity: planQuantity,
					billingPeriod,
					addons,
					wait: options.wait,
					timeoutMs: options.timeout * 1000,
					openBrowser: paymentBrowserOpener({ noOpen: options.open === false }),
					onCheckoutOpened: ({ orderId, paymentUrl }) => {
						if (isJsonMode()) {
							outputJsonLine({
								type: "event",
								event: "checkout_started",
								orderId,
								paymentUrl,
							});
						} else {
							log("");
							log("Open this URL to complete payment:");
							log(`  ${colors.cyan(paymentUrl)}`);
							log(`Order ID: ${colors.dim(orderId)}`);
							log(`Polling for confirmation (up to ${options.timeout}s)...`);
						}
					},
				});

				succeedSpinner("Plan change processed.");
				reportBillingResult(result, `Plan: ${targetPlan}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Downgrade to a lower plan (deferred to end of billing period)
	billing
		.command("downgrade")
		.argument("[plan]", "Plan key to downgrade to (alias: --plan)")
		.description("Downgrade to a lower subscription plan (applies at the end of the billing period)")
		.option("--plan <key>", "Plan key (alias for the positional argument)")
		.option(
			"--billing-period <period>",
			"Billing period: monthly or yearly",
			parseBillingPeriod,
		)
		.action(async (planArg, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching subscription...");
				const [subscription, catalog] = await Promise.all([
					client.subscription.getCurrent.query(),
					client.subscription.getCatalog.query(),
				]);
				succeedSpinner();
				if (!subscription || !subscription.planKey) {
					throw new CliError("No active subscription to downgrade.", ExitCode.INVALID_ARGUMENTS);
				}
				const plans: unknown[] = catalog?.plans || catalog || [];
				let targetPlan: string | undefined = planArg || options.plan;

				if (!targetPlan) {
					const lower = plans.filter((p) => {
						try {
							return (
								classifyPlanDirection(plans, subscription.planKey, planKeyOf(p)) === "downgrade"
							);
						} catch {
							return false;
						}
					});
					if (lower.length === 0) {
						log("You are already on the lowest plan.");
						return;
					}
					targetPlan = await select<string>(
						"Downgrade to:",
						lower.map((p) => {
							const price = (p as { priceHalalas?: number }).priceHalalas;
							return {
								name: `${planKeyOf(p)}${price ? ` (${(price / 100).toFixed(2)} SAR/mo)` : " (Free)"}`,
								value: planKeyOf(p),
							};
						}),
						{
							field: "plan",
							flag: "--plan",
							context: { current: subscription.planKey, available: lower.map((p) => planKeyOf(p)) },
						},
					);
				}
				if (!targetPlan) {
					throw new CliError("No plan selected.", ExitCode.INVALID_ARGUMENTS);
				}

				const direction = classifyPlanDirection(plans, subscription.planKey, targetPlan);
				if (direction === "same") {
					log(`Already on plan "${targetPlan}".`);
					return;
				}
				if (direction === "upgrade") {
					throw new CliError(
						`"${targetPlan}" is higher than your current plan "${subscription.planKey}". Use \`tarout billing upgrade ${targetPlan}\` to move up.`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Downgrade from "${subscription.planKey}" to "${targetPlan}"? Takes effect at the end of the current billing period; no refund for the remainder.`,
						false,
						{
							field: "confirm_downgrade",
							flag: "--yes",
							context: { from: subscription.planKey, to: targetPlan },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _c = startSpinner("Scheduling downgrade...");
				const result = await performBillingChange(client, {
					kind: "plan",
					planKey: targetPlan,
					billingPeriod: options.billingPeriod,
				});
				succeedSpinner("Downgrade processed.");
				reportBillingResult(result, `Plan: ${targetPlan}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Manual confirm escape hatch — useful for headless test runs where the
	// user cannot complete the browser hand-off (e.g. CI with mock payments).
	// Calls subscription.confirmCheckout directly.
	billing
		.command("confirm")
		.argument("<orderId>", "Order ID returned by `billing upgrade`")
		.description("Manually confirm a pending checkout (skips browser flow)")
		.action(async (orderId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _s = startSpinner("Confirming checkout...");
				const result = await client.subscription.confirmCheckout.mutate({
					orderId,
				});
				succeedSpinner("Checkout confirmed.");
				const mapped: BillingChangeResult = {
					status: result?.applied ? "paid" : "payment_required",
					kind: "plan",
					target: orderId,
					orderId,
					...(result?.paymentUrl ? { paymentUrl: result.paymentUrl } : {}),
				};
				reportBillingResult(mapped, `Order ${orderId.slice(0, 8)}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Poll an existing checkout until it terminates. Useful when --wait
	// timed out and you want to resume waiting from a later session.
	billing
		.command("wait")
		.argument("<orderId>", "Order ID to wait on")
		.description("Poll a pending checkout until it resolves")
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.action(async (orderId: string, options: { timeout: number }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				if (isJsonMode()) {
					outputJsonLine({
						type: "event",
						event: "checkout_polling_started",
						orderId,
						timeoutSeconds: options.timeout,
					});
				}
				const final = await pollCheckoutUntilTerminal(client, orderId, {
					timeoutMs: options.timeout * 1000,
					intervalMs: 4000,
				});
				const result: BillingChangeResult = {
					status:
						final.status === "PAID"
							? "paid"
							: final.status === "FAILED"
								? "failed"
								: final.status === "EXPIRED"
									? "expired"
									: "pending_timeout",
					kind: "plan",
					target: orderId,
					orderId,
					failureReason: final.failureReason,
				};
				reportBillingResult(result, `Order ${orderId.slice(0, 8)}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Cancel subscription
	billing
		.command("cancel")
		.description("Cancel current subscription (at period end)")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					log("");
					log(
						colors.warn(
							"Cancelling your subscription will downgrade to free tier at the end of the billing period.",
						),
					);
					log("");

					const confirmed = await confirm(
						"Are you sure you want to cancel your subscription?",
						false,
						{ field: "confirm_cancel", flag: "--yes" },
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Cancelling subscription...");

				await client.subscription.cancel.mutate();

				succeedSpinner("Subscription scheduled for cancellation");

				if (isJsonMode()) {
					outputData({ cancelled: true });
				} else {
					log("");
					log(
						"Your subscription will remain active until the end of the current billing period.",
					);
					log(`To undo: ${colors.dim("tarout billing resume")}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Resume cancelled subscription
	billing
		.command("resume")
		.description("Resume a cancelled subscription")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Resuming subscription...");

				await client.subscription.resume.mutate();

				succeedSpinner("Subscription resumed!");

				if (isJsonMode()) {
					outputData({ resumed: true });
				} else {
					log("");
					log(
						colors.success(
							"Your subscription has been resumed and will continue normally.",
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Add addon
	billing
		.command("addon:add")
		.argument("<addon>", "Addon key to add")
		.option("-q, --quantity <n>", "Addon quantity", Number.parseInt)
		.option(
			"--wait",
			"Wait/poll until the hosted checkout is confirmed (this is the default)",
		)
		.option(
			"--no-wait",
			"Return as soon as the hosted checkout opens, without polling for confirmation (default: wait until paid)",
		)
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.option("--no-open", "Do not auto-open the payment URL in the browser")
		.description("Add a new addon line (extra db/storage/etc. slot)")
		.action(async (addonKey, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const quantity = options.quantity || 1;
				const client = getApiClient();

				if (!shouldSkipConfirmation()) {
					const amountDueHalalas = await previewAddonAmountDue(
						client,
						addonKey,
						quantity,
					);
					if (shouldAutoConfirmPaidCheckout(amountDueHalalas)) {
						log(
							`\nAdding ${colors.cyan(addonKey)} × ${quantity} — opening the secure payment page...`,
						);
					} else {
						log("");
						log(`Addon: ${colors.cyan(addonKey)}`);
						log(`Quantity: ${quantity}`);
						log("");

						const confirmed = await confirm(
							`Add addon "${addonKey}" × ${quantity}?`,
							false,
							{
								field: "confirm_addon_add",
								flag: "--yes",
								context: { addonKey, quantity, amountDueHalalas },
							},
						);

						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}
				}

				const _spinner = startSpinner("Adding addon...");

				// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC result.
				let raw: any;
				try {
					raw = await client.subscription.addAddon.mutate({
						addonKey,
						quantity,
					});
				} catch (err) {
					failSpinner();
					// `addAddon` is create-only — it rejects with CONFLICT when the
					// addon already exists. Translate that into the actionable path
					// instead of leaking a raw tRPC error.
					if (isConflictError(err)) {
						const nextCommand = `tarout billing addon:quantity ${addonKey} <newQty>`;
						outputError(
							"ADDON_EXISTS",
							`Addon "${addonKey}" is already on your subscription — change its quantity instead of adding it again.`,
							{ addonKey, nextCommand },
						);
						if (!isJsonMode()) {
							box("Addon already present", [
								`Use: ${colors.dim(nextCommand)}`,
								`Or buy more slots: ${colors.dim(`tarout billing addon:buy ${addonKey} --wait`)}`,
							]);
						}
						exit(ExitCode.INVALID_ARGUMENTS);
						return;
					}
					throw err;
				}

				succeedSpinner("Addon processed.");

				const result = await finalizeBillingMutation(client, raw, {
					kind: "addon",
					target: addonKey,
					wait: options.wait,
					timeoutMs: options.timeout * 1000,
					openBrowser: paymentBrowserOpener({ noOpen: options.open === false }),
				});
				reportBillingResult(result, `Addon: ${addonKey} ×${quantity}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Remove addon
	billing
		.command("addon:remove")
		.argument("<addon>", "Addon key to remove")
		.description("Remove an addon")
		.action(async (addonKey) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Remove addon "${addonKey}"?`,
						false,
						{
							field: "confirm_addon_remove",
							flag: "--yes",
							context: { addonKey },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Removing addon...");

				await client.subscription.removeAddon.mutate({ addonKey });

				succeedSpinner("Addon removed!");

				if (isJsonMode()) {
					outputData({ removed: true, addonKey });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Set plan quantity (adds/removes app slots on the quantity-aware plan)
	billing
		.command("plan:quantity")
		.argument("<quantity>", "New plan quantity", Number.parseInt)
		.option(
			"--wait",
			"Wait/poll until the hosted checkout is confirmed (this is the default)",
		)
		.option(
			"--no-wait",
			"Return as soon as the hosted checkout opens, without polling for confirmation (default: wait until paid)",
		)
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.option("--no-open", "Do not auto-open the payment URL in the browser")
		.description("Set quantity for a multi-slot plan (adds/removes app slots)")
		.action(async (quantity, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Updating plan quantity...");
				const result = await performBillingChange(client, {
					kind: "plan_quantity",
					quantity,
					wait: options.wait,
					timeoutMs: options.timeout * 1000,
					openBrowser: paymentBrowserOpener({ noOpen: options.open === false }),
				});
				succeedSpinner("Plan quantity processed.");
				reportBillingResult(result, `Plan quantity: ${quantity}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Update addon quantity
	billing
		.command("addon:quantity")
		.argument("<addon>", "Addon key")
		.argument("<quantity>", "New quantity", Number.parseInt)
		.description("Update quantity for an existing addon")
		.action(async (addonKey, quantity) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Updating addon quantity...");
				const result = await client.subscription.updateAddonQuantity.mutate({
					addonKey,
					quantity,
				} as any);
				succeedSpinner("Addon quantity updated!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	// Preview addons purchase
	billing
		.command("addon:preview")
		.argument("<addon>", "Addon key")
		.option("-q, --quantity <n>", "Quantity", Number.parseInt)
		.description("Preview cost of purchasing addons")
		.action(async (addonKey, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Calculating preview...");
				const preview = await client.subscription.previewAddonsPurchase.query({
					items: [{ addonKey, quantity: options.quantity || 1 }],
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(preview);
					return;
				}
				// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC result.
				const p = preview as any;
				// `previewAddonsPurchase` returns `totalProratedHalalas` (due now)
				// and `newPeriodTotalHalalas` (new recurring total) — there is no
				// `amountDue` field, so the old read never printed anything.
				log("");
				log(colors.bold("Addon Purchase Preview"));
				log(`  Addon:      ${colors.cyan(addonKey)}`);
				log(`  Quantity:   ${options.quantity || 1}`);
				const { amountHalalas: dueHalalas, vatNote } =
					resolveCheckoutAmountDisplay(
						p?.tax,
						typeof p?.totalProratedHalalas === "number"
							? p.totalProratedHalalas
							: undefined,
					);
				if (dueHalalas !== undefined) {
					log(
						`  Amount Due: ${colors.bold(`${(dueHalalas / 100).toFixed(2)} SAR`)}${vatNote ? ` ${vatNote}` : ""}`,
					);
				}
				if (typeof p?.newPeriodTotalHalalas === "number") {
					log(
						`  New total:  ${(p.newPeriodTotalHalalas / 100).toFixed(2)} SAR`,
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Purchase addon slots (extra db/storage/etc.) — the canonical
	// engine-driven purchase path with hosted-checkout + --wait support.
	billing
		.command("addon:buy")
		.argument("<addon>", "Addon key")
		.option("-q, --quantity <n>", "Quantity", Number.parseInt)
		.option(
			"--wait",
			"Wait/poll until the hosted checkout is confirmed (this is the default)",
		)
		.option(
			"--no-wait",
			"Return as soon as the hosted checkout opens, without polling for confirmation (default: wait until paid)",
		)
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.option("--no-open", "Do not auto-open the payment URL in the browser")
		.description("Purchase addon slots (extra db/storage/etc.)")
		.action(async (addonKey, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const quantity = options.quantity || 1;
				const client = getApiClient();

				if (!shouldSkipConfirmation()) {
					const amountDueHalalas = await previewAddonAmountDue(
						client,
						addonKey,
						quantity,
					);
					// Parity with `billing upgrade`: a paid addon goes through the
					// hosted Moyasar checkout, which is the real consent surface. In
					// a non-TTY agent context that can open a browser, skip the local
					// y/n (it would otherwise halt with `needs_input`) and let the
					// payment page collect consent. `--json` keeps the structured
					// handoff; net-zero charges still confirm.
					if (shouldAutoConfirmPaidCheckout(amountDueHalalas)) {
						log(
							`\nPurchasing ${quantity}× ${colors.cyan(addonKey)} — opening the secure payment page...`,
						);
					} else {
						log(`\nPurchase ${quantity}× ${colors.cyan(addonKey)}?`);
						const confirmed = await confirm("Proceed?", false, {
							field: "confirm_addon_buy",
							flag: "--yes",
							context: { addonKey, quantity, amountDueHalalas },
						});
						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}
				}
				const _spinner = startSpinner("Purchasing addon...");
				const result = await performBillingChange(client, {
					kind: "addon",
					addonKey,
					quantity,
					wait: options.wait,
					timeoutMs: options.timeout * 1000,
					openBrowser: paymentBrowserOpener({ noOpen: options.open === false }),
				});
				succeedSpinner("Addon purchase processed.");
				reportBillingResult(result, `Addon: ${addonKey} ×${quantity}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Cancel pending plan change
	billing
		.command("plan:cancel-pending")
		.description("Cancel a pending plan change (keeps current plan)")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						"Cancel the pending plan change?",
						false,
						{ field: "confirm_pending_cancel", flag: "--yes" },
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Cancelling pending change...");
				await client.subscription.cancelPendingPlanChange.mutate();
				succeedSpinner("Pending plan change cancelled!");
				if (isJsonMode()) outputData({ cancelled: true });
			} catch (err) {
				handleError(err);
			}
		});

	// Billing analytics — usage breakdown
	billing
		.command("usage")
		.description("Show resource usage breakdown")
		.option("--from <date>", "Window start (e.g. 2026-07-01)", parseFromDate)
		.option("--to <date>", "Window end (e.g. 2026-07-31)", parseToDate)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching usage...");
				// `getUsageBreakdown` accepts an optional `{ startDate, endDate }`.
				// Omitting the argument entirely (not `{}`) keeps the server default —
				// the current calendar month.
				const range = dateRangeArg(options.from, options.to);
				const data = await client.billing.getUsageBreakdown.query(range);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				// Real shape: { period, breakdown: [{ resourceType, label,
				// totalCostHalalas, totalCostSAR, usageCount }], totalHalalas,
				// totalSAR }. The old renderer read apps/databases/storage/domains,
				// which the procedure has never returned — every row printed "-".
				const d = data as any;
				const rows: any[] = Array.isArray(d?.breakdown) ? d.breakdown : [];
				log("");
				log(colors.bold("Usage Breakdown"));
				logBillingPeriod(d?.period);
				if (!rows.length) {
					log("\nNo usage recorded for this period.\n");
					return;
				}
				table(
					["RESOURCE", "RECORDS", "COST (SAR)"],
					rows.map((r: any) => [
						r.label?.en || r.resourceType || "-",
						String(r.usageCount ?? "-"),
						((r.totalCostHalalas ?? 0) / 100).toFixed(2),
					]),
				);
				log(
					`  Total: ${colors.bold(`${((d?.totalHalalas ?? 0) / 100).toFixed(2)} SAR`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Detailed resource usage
	billing
		.command("resources")
		.description("Show detailed resource usage and costs")
		.option("--from <date>", "Window start (e.g. 2026-07-01)", parseFromDate)
		.option("--to <date>", "Window end (e.g. 2026-07-31)", parseToDate)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching resource usage...");
				const range = dateRangeArg(options.from, options.to);
				const data =
					await client.billing.getDetailedResourceUsage.query(range);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				// Real shape: { period, resources: [{ resourceId, resourceType,
				// resourceName, totalCostHalalas, totalCostSAR, usageCount }] }.
				// The old renderer read type/name/cost — none of which exist.
				const list: any[] = Array.isArray((data as any)?.resources)
					? (data as any).resources
					: [];
				log("");
				log(colors.bold("Resource Usage"));
				logBillingPeriod((data as any)?.period);
				if (!list.length) {
					log("\nNo resource usage recorded for this period.\n");
					return;
				}
				table(
					["TYPE", "NAME", "RECORDS", "COST (SAR)"],
					list.map((r: any) => [
						r.resourceType || "-",
						r.resourceName || r.resourceId || "-",
						String(r.usageCount ?? "-"),
						((r.totalCostHalalas ?? 0) / 100).toFixed(2),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Daily cost trend
	billing
		.command("trend")
		.description("Show daily cost trend")
		.option("--days <n>", "Number of days back from now", parseDaysOption)
		.option("--from <date>", "Window start (e.g. 2026-07-01)", parseFromDate)
		.option("--to <date>", "Window end (e.g. 2026-07-31)", parseToDate)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				// `getDailyCostTrend` only accepts `{ startDate, endDate }` — a `days`
				// key is stripped by zod, so the old `{ days } as any` call always got
				// the server's own 30-day default back while pretending to honour
				// `--days`. Resolve the window client-side instead.
				const range = resolveTrendRange(options);
				const _spinner = startSpinner("Fetching cost trend...");
				const data = await client.billing.getDailyCostTrend.query(range);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				// Real shape: { period, data: [{ date, breakdown,
				// totalCostHalalas, totalCostSAR }] } — not a bare array, and not
				// `trend`/`cost`, which is why this table used to render blank.
				const list: any[] = Array.isArray((data as any)?.data)
					? (data as any).data
					: [];
				log("");
				log(colors.bold("Daily Cost Trend"));
				logBillingPeriod((data as any)?.period);
				if (!list.length) {
					log("\nNo cost data found.\n");
					return;
				}
				table(
					["DATE", "COST (SAR)"],
					list.map((d: any) => [
						d.date || "-",
						((d.totalCostHalalas ?? 0) / 100).toFixed(2),
					]),
				);
				const total = list.reduce(
					(sum: number, d: any) => sum + (d.totalCostHalalas ?? 0),
					0,
				);
				log(`  Total: ${colors.bold(`${(total / 100).toFixed(2)} SAR`)}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Resource estimate
	billing
		.command("estimate")
		.description("Estimate cost for a resource type")
		.option(
			"--type <type>",
			`Resource type (${ESTIMATE_RESOURCE_TYPES.join(", ")})`,
			parseEstimateType,
		)
		.option("--plan <plan>", "App plan: free, shared, dedicated or custom")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!options.type) {
					throw new CliInvalidArgumentError(
						`--type is required. Expected one of: ${ESTIMATE_RESOURCE_TYPES.join(", ")}.`,
					);
				}
				const client = getApiClient();
				const _spinner = startSpinner("Calculating estimate...");
				// The schema is `{ resourceType: <public enum>, appPlan?, storageGb?,
				// … }` — there is no `planKey`, so the old cast sent a key zod threw
				// away. `--plan` only means anything for an application estimate.
				const data = await client.billing.getResourceEstimate.query({
					resourceType: options.type,
					...(options.plan && options.type === "application"
						? { appPlan: parseAppPlan(options.plan) }
						: {}),
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				// Real shape: { resourceType, hourlyHalalas, hourlySAR, dailyHalalas,
				// dailySAR, monthlyHalalas, monthlySAR, breakdown: [{ item, halalas,
				// sar }] } — the old `monthly`/`hourly` reads printed "-".
				const d = data as any;
				log("");
				log(colors.bold("Resource Estimate"));
				log(`  Type:    ${d.resourceType ?? options.type}`);
				log(
					`  Monthly: ${typeof d.monthlyHalalas === "number" ? `${(d.monthlyHalalas / 100).toFixed(2)} SAR` : "-"}`,
				);
				log(
					`  Daily:   ${typeof d.dailyHalalas === "number" ? `${(d.dailyHalalas / 100).toFixed(2)} SAR` : "-"}`,
				);
				log(
					`  Hourly:  ${typeof d.hourlyHalalas === "number" ? `${(d.hourlyHalalas / 100).toFixed(4)} SAR` : "-"}`,
				);
				const breakdown: any[] = Array.isArray(d.breakdown) ? d.breakdown : [];
				if (breakdown.length) {
					log("");
					table(
						["ITEM", "COST (SAR)"],
						breakdown.map((b: any) => [
							b.item || "-",
							((b.halalas ?? 0) / 100).toFixed(2),
						]),
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Active resources
	billing
		.command("active-resources")
		.description("List all active billable resources")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching active resources...");
				const data = await client.billing.getActiveResources.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data)
					? data
					: (data as any)?.resources || [];
				if (!list.length) {
					log("\nNo active billable resources.\n");
					return;
				}
				log("");
				table(
					["TYPE", "NAME", "STATUS", "PLAN"],
					list.map((r: any) => [
						r.type || "-",
						r.name || "-",
						r.status || "-",
						r.plan || r.planKey || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── Invoices ──────────────────────────────────────────────────────────────
	billing
		.command("invoices")
		.description("List invoices")
		.option("-n, --limit <n>", "Max invoices to show", (v) =>
			Number.parseInt(v, 10),
		)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching invoices...");
				const invoices = await client.payment.listInvoices.query(
					options.limit ? { take: options.limit } : undefined,
				);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(invoices);
					return;
				}
				const list = Array.isArray(invoices) ? invoices : [];
				if (!list.length) {
					log("\nNo invoices.\n");
					return;
				}
				log("");
				table(
					["NUMBER", "STATUS", "TOTAL", "ISSUED", "PAID"],
					list.map((inv: any) => [
						colors.cyan(inv.externalNumber || (inv.id || "").slice(0, 8)),
						inv.status || "-",
						`${((inv.totalHalalas ?? 0) / 100).toFixed(2)} SAR`,
						inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : "-",
						inv.paidAt
							? new Date(inv.paidAt).toLocaleDateString()
							: colors.dim("—"),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	billing
		.command("invoice")
		.argument("<invoice-id>", "Invoice ID")
		.description("Show invoice details")
		.action(async (invoiceId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching invoice...");
				const inv: any = await client.payment.getInvoice.query({ invoiceId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(inv);
					return;
				}
				quietOutput(String(inv.externalNumber || inv.id));
				log("");
				log(colors.bold(`Invoice ${inv.externalNumber || inv.id}`));
				log(`  Status:   ${inv.status || "-"}`);
				log(`  Subtotal: ${((inv.subtotalHalalas ?? 0) / 100).toFixed(2)} SAR`);
				log(`  VAT:      ${((inv.taxHalalas ?? 0) / 100).toFixed(2)} SAR`);
				log(
					`  Total:    ${colors.bold(`${((inv.totalHalalas ?? 0) / 100).toFixed(2)} SAR`)}`,
				);
				log(
					`  Issued:   ${inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : "-"}`,
				);
				if (inv.paidAt)
					log(`  Paid:     ${new Date(inv.paidAt).toLocaleDateString()}`);
				else if (inv.dueAt)
					log(`  Due:      ${new Date(inv.dueAt).toLocaleDateString()}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	billing
		.command("invoice-pdf")
		.argument("<invoice-id>", "Invoice ID")
		.option("--locale <locale>", "PDF locale: en or ar", "en")
		.description("Get a link to the invoice PDF")
		.action(async (invoiceId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching PDF link...");
				const res: any = await client.payment.getInvoicePdfUrl.query({
					invoiceId,
					locale: options.locale === "ar" ? "ar" : "en",
				});
				succeedSpinner();
				const rawUrl = res?.url ? String(res.url) : "";
				const url = rawUrl.startsWith("http")
					? rawUrl
					: rawUrl
						? `${getApiUrl()}${rawUrl}`
						: "";
				if (isJsonMode()) {
					outputData({ url });
					return;
				}
				// Quiet mode: emit the bare PDF URL for scripting/piping.
				quietOutput(url);
				log("");
				log(`PDF: ${colors.cyan(url || "-")}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	billing
		.command("pay-invoice")
		.argument("<invoice-id>", 'Invoice ID, or "pending" for an overdue renewal')
		.description("Pay what is owed with the saved card (org owner only)")
		.action(async (invoiceId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Submitting payment...");
				const res: any = await client.payment.payInvoiceNow.mutate({
					invoiceId,
				});
				succeedSpinner(
					res?.status === "already_paid"
						? "Nothing to pay: already paid."
						: "Payment complete.",
				);
				if (isJsonMode()) outputData(res);
			} catch (err) {
				handleError(err);
			}
		});

	// ── Ops recovery: standing, renewal retry, interval switch ───────────────

	billing
		.command("summary")
		.description(
			"Show the team-visible plan label for the active project. Unlike `billing status`, this reads the member-visible summary procedure, so it works for a non-owner credential; in exchange it deliberately carries no prices, no renewal date and no add-on lines.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching plan summary...");
				const summary = await client.subscription.getSummary.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(summary);
					return;
				}

				quietOutput(summary?.planKey || "free");

				log("");
				log(colors.bold("Plan Summary"));
				const profile = getCurrentProfile();
				if (profile?.projectName) {
					log(`  ${colors.dim(`Project: ${profile.projectName}`)}`);
				}
				log("");
				if (!summary) {
					log(
						`  Plan: ${colors.dim("No subscription on this project (free tier)")}`,
					);
					log("");
					return;
				}
				log(`  Plan:     ${colors.cyan(summary.planKey || "free")}`);
				if (summary.planName) log(`  Name:     ${summary.planName}`);
				if (summary.planQuantityAware) {
					log(`  Quantity: ${summary.planQuantity ?? 1}`);
				}
				log("");
				log(
					`Owner-only detail (price, renewal, add-ons): ${colors.dim("tarout billing status")}`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("standing")
		.description(
			"Report whether the active project's billing is in good standing, and exit non-zero when it is not, so CI or a cron can gate on it. A PAST_DUE subscription inside its grace window is a warning and still exits 0; PAUSED or CANCELED is a danger and exits 1. A healthy project (or a free one) prints nothing to worry about.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking billing standing...");
				const standing = (await client.subscription.getStanding.query()) as
					| BillingStanding
					| null;
				succeedSpinner();

				const code = exitCodeForStanding(standing);

				if (isJsonMode()) {
					outputData({
						standing: standing ?? null,
						ok: standing === null || standing === undefined,
					});
					if (code !== ExitCode.SUCCESS) exit(code);
					return;
				}

				quietOutput(standing?.kind || "ok");

				if (!standing) {
					log("");
					log(colors.success("Billing is in good standing."));
					log("");
					return;
				}

				log("");
				log(colors.bold("Billing Standing"));
				log(
					`  Issue:    ${standing.severity === "danger" ? colors.error(standing.kind || "unknown") : colors.warn(standing.kind || "unknown")}`,
				);
				log(`  Severity: ${standing.severity || "-"}`);
				if (typeof standing.daysLeft === "number") {
					log(`  Grace:    ${standing.daysLeft} day(s) left`);
				}
				log("");
				log(
					`Recover a failed renewal: ${colors.dim("tarout billing retry-renewal --yes")}`,
				);
				log("");
				if (code !== ExitCode.SUCCESS) exit(code);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("discount")
		.description(
			"Show the automatic email-domain discount this account qualifies for, if any. It is not tied to a plan: checkout re-checks the discount's own plan and billing-period limits, so an eligible discount here can still be declined for a specific plan.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking eligible discount...");
				const discount = await client.subscription.eligibleDiscount.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(discount);
					return;
				}

				quietOutput(discount?.code || "");

				if (!discount) {
					log("");
					log("No automatic discount applies to this account.");
					log("");
					return;
				}

				log("");
				log(colors.bold("Eligible Discount"));
				log(`  Code:     ${colors.cyan(discount.code || "-")}`);
				log(
					`  Discount: ${discount.discountType === "PERCENT" ? `${discount.discountValue}%` : formatSarAmount(discount.discountValue)}`,
				);
				log(`  Status:   ${discount.status || "-"}`);
				log(
					`  Applied:  ${discount.running ? colors.success("yes, already discounting renewals") : colors.dim("not yet")}`,
				);
				if (discount.durationCycles) {
					log(`  Cycles:   ${discount.durationCycles}`);
				}
				if (Array.isArray(discount.planKeys) && discount.planKeys.length) {
					log(`  Plans:    ${discount.planKeys.join(", ")}`);
				}
				if (
					Array.isArray(discount.billingPeriods) &&
					discount.billingPeriods.length
				) {
					log(`  Periods:  ${discount.billingPeriods.join(", ")}`);
				}
				if (discount.description) log(`  Details:  ${discount.description}`);
				log("");
				if (discount.status === "verify_email") {
					log(
						colors.warn(
							"The address this discount is keyed to is not verified yet — verify it before checkout or the discount will not apply.",
						),
					);
					log("");
				}
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("order")
		.argument(
			"<orderId>",
			'Checkout order ID: "sub_…" for a subscription, "top_…" for a wallet top-up, "dom_…" for a domain',
		)
		.description(
			"Show one checkout order: what it charges, what it is for, and whether it can still be paid. Exits 13 (CHECKOUT_PENDING) while the order is payable so an agent can tell a resumable checkout from a settled one without parsing the payload; terminal orders exit 0.",
		)
		.action(async (orderId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching checkout order...");
				const order = await client.payment.getCheckoutOrder.query({ orderId });
				succeedSpinner();

				const code = exitCodeForCheckoutOrder(order);

				if (isJsonMode()) {
					outputData(order);
					if (code !== ExitCode.SUCCESS) exit(code);
					return;
				}

				quietOutput(String(order?.status ?? ""));

				log("");
				log(colors.bold(`Checkout ${orderId}`));
				log(`  Kind:        ${order?.kind || orderIdKind(orderId)}`);
				log(`  Description: ${order?.description || "-"}`);
				log(
					`  Amount:      ${colors.bold(formatSarAmount(order?.grossAmountHalalas))}${order?.currency && order.currency !== "SAR" ? ` ${order.currency}` : ""}`,
				);
				log(`  Status:      ${order?.status || "-"}`);
				log(`  Phase:       ${order?.phase || "-"}`);
				if (order?.planKey) log(`  Plan:        ${order.planKey}`);
				if (order?.actionKind) log(`  Action:      ${order.actionKind}`);
				if (order?.recurring) {
					log(
						`  ${colors.dim("This checkout tokenizes the card for recurring renewals.")}`,
					);
				}
				log("");
				if (order?.canPay) {
					log(
						`This order can still be paid. Resume it with ${colors.dim(`tarout billing wait ${orderId}`)}, or abandon it with ${colors.dim(`tarout billing cancel-checkout ${orderId}`)}.`,
					);
					log("");
				}
				if (code !== ExitCode.SUCCESS) exit(code);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("cancel-checkout")
		.argument("<orderId>", 'Subscription checkout order ID ("sub_…")')
		.option(
			"--reason <text>",
			"Why it was abandoned, recorded on the checkout (max 200 characters)",
		)
		.description(
			"Abandon a pending subscription checkout so it stops blocking a retry. This only marks the unpaid order expired; it never refunds and never contacts the payment provider, and it does nothing to an order that was already paid, expired or cancelled (that is reported, not an error). Org owner only, and it acts on the active project.",
		)
		.action(async (orderId: string, options: { reason?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				assertSubscriptionCheckoutOrderId(orderId);
				const client = getApiClient();
				const _spinner = startSpinner("Cancelling checkout...");
				const result = await client.subscription.cancelCheckout.mutate({
					orderId,
					...(options.reason ? { reason: options.reason } : {}),
				});
				succeedSpinner(
					result?.cancelled
						? "Pending checkout abandoned."
						: "Nothing to abandon.",
				);

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(result?.cancelled ? "cancelled" : "not_pending");

				log("");
				if (result?.cancelled) {
					log(
						colors.success(
							`Checkout ${orderId} is abandoned. No money was taken and nothing was refunded — the order was never paid.`,
						),
					);
				} else {
					log(
						`No pending checkout matched ${orderId} on this project, so nothing changed. It was already paid, expired or cancelled — check ${colors.dim(`tarout billing order ${orderId}`)}.`,
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("period:preview")
		.argument("[period]", "Target billing interval: monthly or yearly")
		.option(
			"--period <period>",
			"Target billing interval (alias for the positional argument; useful for agent invocations)",
		)
		.description(
			"Quote what switching the active project's billing interval costs today. The quote comes from the same charge computation `period:set` uses, so the amount shown here is the amount charged, and this refuses on exactly the same three conditions: already on that interval, a plan change already staged for the end of the term, or the subscription set to cancel at term end. Org owner only.",
		)
		.action(async (periodArg: string | undefined, options: { period?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const target = await resolveBillingPeriodTarget(
					periodArg ?? options.period,
				);
				const client = getApiClient();
				const _spinner = startSpinner("Quoting interval switch...");
				const quote = await client.subscription.previewBillingPeriodChange.query(
					billingPeriodChangeArg(target),
				);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(quote);
					return;
				}

				quietOutput(String(quote?.chargeTodayHalalas ?? 0));

				// `resolveCheckoutAmountDisplay` renders the VAT parenthetical from the
				// server's own rate (empty while Tarout is not VAT-registered) instead
				// of a hardcoded 15%.
				const { amountHalalas: dueHalalas, vatNote } =
					resolveCheckoutAmountDisplay(
						quote?.tax,
						typeof quote?.chargeTodayHalalas === "number"
							? quote.chargeTodayHalalas
							: undefined,
					);

				log("");
				log(colors.bold("Billing Interval Switch"));
				log(
					`  From:            ${quote?.currentPeriod || "-"} → ${colors.cyan(quote?.targetPeriod || target)}`,
				);
				log(
					`  Current period:  ${formatSarAmount(quote?.currentPeriodTotalHalalas)}`,
				);
				log(
					`  Target period:   ${formatSarAmount(quote?.targetPeriodTotalHalalas)}`,
				);
				log(`  Unused credit:   ${formatSarAmount(quote?.creditHalalas)}`);
				log(
					`  Charged today:   ${colors.bold(formatSarAmount(dueHalalas))}${vatNote ? ` ${vatNote}` : ""}`,
				);
				log(
					`  Applies:         ${quote?.appliesImmediately ? "immediately" : `at the end of the current term (${formatDate(quote?.effectiveAt)})`}`,
				);
				if (quote?.newTermEnd) {
					log(`  New term ends:   ${formatDate(quote.newTermEnd)}`);
				}
				log("");
				log(`Apply it: ${colors.dim(`tarout billing period:set ${target}`)}`);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("period:set")
		.argument("[period]", "Target billing interval: monthly or yearly")
		.option(
			"--period <period>",
			"Target billing interval (alias for the positional argument; useful for agent invocations)",
		)
		.option(
			"--wait",
			"Wait/poll until the hosted checkout is confirmed (this is the default)",
		)
		.option(
			"--no-wait",
			"Return as soon as the hosted checkout opens, without polling for confirmation (default: wait until paid)",
		)
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.option("--no-open", "Do not auto-open the payment URL in the browser")
		.description(
			"Switch the active project between monthly and yearly billing. Monthly to yearly applies now and opens a hosted checkout for the yearly total minus a credit for the unused remainder — the same amount `period:preview` quotes. Yearly to monthly is only staged: it is applied at the end of the paid term, there is no refund, and `billing plan:cancel-pending` undoes it. Org owner only.",
		)
		.action(
			async (
				periodArg: string | undefined,
				options: {
					period?: string;
					wait?: boolean;
					timeout: number;
					open?: boolean;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const target = await resolveBillingPeriodTarget(
						periodArg ?? options.period,
					);
					const client = getApiClient();

					// Quote first so the confirm names the real amount, and so an
					// agent-driven run can decide whether a browser hand-off is coming.
					const _quoteSpinner = startSpinner("Quoting interval switch...");
					// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC result.
					let quote: any;
					try {
						quote = await client.subscription.previewBillingPeriodChange.query(
							billingPeriodChangeArg(target),
						);
						succeedSpinner();
					} catch {
						// The preview and the mutation refuse on identical conditions, so
						// a failed quote means the mutation will report the same thing
						// with a better message. Carry on and let it speak.
						failSpinner();
						quote = null;
					}

					const chargeHalalas: number | undefined =
						typeof quote?.chargeTodayHalalas === "number"
							? quote.chargeTodayHalalas
							: undefined;

					if (!shouldSkipConfirmation()) {
						log("");
						log(
							`Switching billing interval to ${colors.cyan(target)}${chargeHalalas !== undefined ? `, charged today: ${colors.bold(formatSarAmount(chargeHalalas))}` : ""}.`,
						);
						if (quote && !quote.appliesImmediately) {
							log(
								"This is staged for the end of the paid term — no charge now, and no refund for the remainder.",
							);
						}
						log("");
						// Parity with `billing upgrade`: a positive charge ends on the
						// hosted Moyasar page, which is the real consent surface, so a
						// non-TTY agent run skips the local y/n rather than halting.
						if (shouldAutoConfirmPaidCheckout(chargeHalalas)) {
							log(
								"Opening the secure payment page in your browser to complete the switch...",
							);
						} else {
							const confirmed = await confirm(
								`Switch to ${target} billing?`,
								false,
								{
									field: "confirm_billing_period",
									flag: "--yes",
									context: {
										targetPeriod: target,
										chargeTodayHalalas: chargeHalalas,
										appliesImmediately: quote?.appliesImmediately,
									},
								},
							);
							if (!confirmed) {
								log("Cancelled.");
								return;
							}
						}
					}

					const _spinner = startSpinner("Changing billing interval...");
					const raw = await client.subscription.changeBillingPeriod.mutate(
						billingPeriodChangeArg(target),
					);
					succeedSpinner("Billing interval change processed.");

					// Ride the shared classify-and-poll engine: `scheduled` has no order
					// and classifies as deferred, `checkout` goes through the ordinary
					// hosted-checkout + `billing wait` path.
					const result = await finalizeBillingMutation(
						client,
						billingPeriodMutationShape(raw),
						{
							kind: "plan",
							target: `${target} billing`,
							wait: options.wait,
							timeoutMs: options.timeout * 1000,
							openBrowser: paymentBrowserOpener({
								noOpen: options.open === false,
							}),
							onCheckoutOpened: ({ orderId, paymentUrl }) => {
								if (isJsonMode()) {
									outputJsonLine({
										type: "event",
										event: "checkout_started",
										orderId,
										paymentUrl,
									});
								} else {
									log("");
									log("Open this URL to complete payment:");
									log(`  ${colors.cyan(paymentUrl)}`);
									log(`Order ID: ${colors.dim(orderId)}`);
									log(`Polling for confirmation (up to ${options.timeout}s)...`);
								}
							},
						},
					);
					reportBillingResult(result, `Billing interval: ${target}`);
					if (raw?.status === "scheduled" && !isJsonMode()) {
						log(
							`Undo before it applies: ${colors.dim("tarout billing plan:cancel-pending")}`,
						);
						log("");
					}
				} catch (err) {
					stopSpinner();
					handleError(err);
				}
			},
		);

	billing
		.command("retry-renewal")
		.description(
			"Charge an already-owed renewal against the card on file, right now, outside the dunning schedule. This is the supported recovery path for a PAST_DUE or PAUSED subscription and it refuses on any other status. It cannot double-charge (the charge runs under a Postgres advisory lock with a deterministic provider order id) and it cannot choose its own amount — the period total is recomputed server-side from the plan and the locked add-on prices. Because it charges a saved card with no payment page in between, it ALWAYS requires explicit confirmation: pass --yes under --json or --non-interactive. Org owner only, and it acts on the active project.",
		)
		.addHelpText(
			"after",
			"\nExit codes: 0 charged, 1 declined / nothing charged / no card on file. A manual retry does not advance the dunning ladder, so retrying is safe.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const gate = renewalConsentGate();
				if (gate === "refuse") {
					// Deliberately NOT `shouldAutoConfirmPaidCheckout`: that helper
					// delegates consent to the hosted payment page, and this charge has
					// no page. Nothing downstream will ask the human, so refuse here.
					outputError(
						"NEEDS_CONFIRMATION",
						"`billing retry-renewal` charges the saved card immediately and there is no payment page to confirm it on, so it will not run unattended without explicit consent. Re-run with --yes once a human has agreed to the charge.",
						{
							nextCommand: "tarout billing retry-renewal --yes",
							field: "confirm_retry_renewal",
							flag: "--yes",
						},
					);
					exit(ExitCode.NEEDS_INPUT);
					return;
				}
				if (gate === "confirm") {
					log("");
					log(
						colors.warn(
							"This charges the card on file for the overdue period immediately. The amount is recomputed server-side from your plan and add-ons; this command cannot change it.",
						),
					);
					log("");
					const confirmed = await confirm(
						"Charge the card on file for the overdue renewal now?",
						false,
						{ field: "confirm_retry_renewal", flag: "--yes" },
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Retrying the renewal charge...");
				const result = (await client.subscription.retryRenewal.mutate()) as
					| RetryRenewalResult
					| null;
				succeedSpinner();

				const addCardUrl = addCardDashboardUrl();
				const report = describeRetryRenewal(result, addCardUrl);

				if (report.code === null) {
					if (isJsonMode()) {
						outputData({ ...(result ?? {}), hint: report.message });
						return;
					}
					quietOutput(String(result?.status ?? "charged"));
					log("");
					log(colors.success(report.message));
					log(
						`Confirm with ${colors.dim("tarout billing invoices -n 1")} or ${colors.dim("tarout billing standing")}.`,
					);
					log("");
					return;
				}

				outputError(report.code, report.message, {
					status: result?.status ?? "unknown",
					reason: result?.reason ?? null,
					...(report.code === "NO_PAYMENT_METHOD" ? { addCardUrl } : {}),
				});
				if (!isJsonMode() && report.code === "NO_PAYMENT_METHOD") {
					box("No card on file", [
						`Add a card: ${colors.cyan(addCardUrl)}`,
						`Then re-run: ${colors.dim("tarout billing retry-renewal --yes")}`,
					]);
				}
				exit(report.exitCode);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Ops recovery: shared → dedicated app migration ───────────────────────
	// Flow: migrate:list → migrate:start → migrate:status (copying →
	// ready_to_cutover) → migrate:cutover or migrate:rollback. The cutover is
	// normally AUTOMATIC from a queue worker once the copies are healthy; the
	// manual commands are the retry/fallback.

	billing
		.command("migrate:list")
		.option(
			"--count",
			"Only fetch the count, not the per-app verdicts (the cheap pre-flight read)",
		)
		.description(
			"List the active project's shared-pool apps that can be moved onto its dedicated host, each with a per-app eligibility verdict, so an incompatibility surfaces before the batch starts instead of failing mid-flight. Apps already pinned to a dedicated server or already mid-migration are excluded. Org owner only.",
		)
		.action(async (options: { count?: boolean }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching movable apps...");
				if (options.count) {
					const counted =
						await client.subscription.getMigratableSharedAppsCount.query();
					succeedSpinner();
					if (isJsonMode()) {
						outputData(counted);
						return;
					}
					quietOutput(String(counted?.count ?? 0));
					log("");
					log(`${counted?.count ?? 0} app(s) can be moved.`);
					log("");
					return;
				}

				const data = await client.subscription.getMigratableSharedApps.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC result.
				const apps: any[] = Array.isArray(data?.apps) ? data.apps : [];
				quietOutput(String(apps.length));

				if (!apps.length) {
					log("");
					log("No shared-pool apps on this project can be moved right now.");
					log("");
					return;
				}

				log("");
				log(colors.bold("Movable Shared Apps"));
				table(
					["APP", "ID", "ELIGIBLE", "REASON"],
					apps.map((app: any) => [
						app.name || "-",
						colors.dim(String(app.applicationId || "").slice(0, 12)),
						app.eligible ? colors.success("yes") : colors.error("no"),
						app.reasonCode || colors.dim("-"),
					]),
				);
				log("");
				log(`Start the move: ${colors.dim("tarout billing migrate:start")}`);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("migrate:start")
		.option(
			"--app <id>",
			"Move only this application ID (repeatable; omit to move every eligible shared app)",
			collectApplicationId,
			[] as string[],
		)
		.description(
			"Queue the blue/green copy of the project's shared-pool apps onto its dedicated host. This only stages the apps — it copies them and leaves them at `COPIED`; traffic is not moved until a cutover. No money changes hands, and the platform re-checks host capacity, the host's migration claim and per-app eligibility itself, so a repeat call is safe. Requires an ACTIVE dedicated host. Org owner only.",
		)
		.action(async (options: { app: string[] }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const applicationIds =
					Array.isArray(options.app) && options.app.length > 0
						? options.app
						: undefined;

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						applicationIds
							? `Start copying ${applicationIds.length} app(s) onto the dedicated host?`
							: "Start copying every eligible shared app onto the dedicated host?",
						false,
						{
							field: "confirm_migrate_start",
							flag: "--yes",
							context: { applicationIds: applicationIds ?? "all_eligible" },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Queueing the move...");
				const result =
					await client.subscription.migrateSharedAppsToDedicated.mutate(
						applicationIds ? { applicationIds } : undefined,
					);
				succeedSpinner("Move queued.");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(String(result?.queued ?? 0));

				log("");
				if (!result?.queued) {
					log(
						`Nothing was queued${result?.skippedIneligible ? ` (${result.skippedIneligible} app(s) skipped as ineligible)` : ""}. Check ${colors.dim("tarout billing migrate:list")}.`,
					);
					log("");
					return;
				}
				log(colors.success(`${result.queued} app(s) are being copied.`));
				if (result.skippedIneligible) {
					log(
						colors.warn(
							`${result.skippedIneligible} app(s) were skipped as ineligible and stay on the shared pool.`,
						),
					);
				}
				log(
					`Watch progress: ${colors.dim("tarout billing migrate:status")} — the cutover then happens automatically once every copy is healthy.`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("migrate:status")
		.description(
			"Show the in-flight shared-to-dedicated move for the active project: stage, per-app state and progress toward a cutover. Safe to poll. A `ready_to_cutover` can legitimately be months old — copied rows are never aged out server-side because a cutover is their only exit — so an old one is reported as old, not as stale.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching migration status...");
				const migration = (await client.subscription.getActiveMigration.query()) as
					| ActiveMigrationResponse
					| null;
				succeedSpinner();

				const summary = summarizeMigration(migration);

				if (isJsonMode()) {
					outputData({ ...migration, summary });
					return;
				}

				quietOutput(summary.stage ?? "none");

				log("");
				log(colors.bold("Shared → Dedicated Migration"));
				log(`  ${summary.headline}`);
				if (summary.note) log(`  ${colors.dim(summary.note)}`);
				if (!summary.active) {
					log("");
					return;
				}
				log(`  Mode:     ${migration?.mode || "-"}`);
				log(`  Stage:    ${summary.stage || "-"}`);
				log(
					`  Host:     ${migration?.host?.name || "-"}${migration?.host?.status ? ` (${migration.host.status})` : ""}`,
				);
				if (summary.ageDays !== null) {
					log(`  Age:      ${summary.ageDays} day(s)`);
				}

				// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC result.
				const apps: any[] = Array.isArray((migration as any)?.apps)
					? (migration as any).apps
					: [];
				if (apps.length) {
					log("");
					table(
						["APP", "STATE", "READY", "ERROR"],
						apps.map((app: any) => [
							app.name || "-",
							app.state || "-",
							app.ready ? colors.success("yes") : colors.dim("no"),
							app.errorMessage || colors.dim("-"),
						]),
					);
				}
				if (summary.nextCommand) {
					log(`Next: ${colors.dim(summary.nextCommand)}`);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("migrate:cutover")
		.description(
			"Flip traffic (DNS and ownership) onto the dedicated host for every app that is copied AND reported healthy there, finishing the move. This is the RETRY path: the normal cutover is automatic from a queue worker once the copies come up, and this is what you run when that did not happen. Apps that are still unhealthy stay copied and are left behind rather than blocking the rest; the platform refuses the whole call if none are healthy yet. Org owner only.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						"Flip live traffic onto the dedicated host now?",
						false,
						{ field: "confirm_migrate_cutover", flag: "--yes" },
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Cutting over...");
				const result =
					await client.subscription.completeSharedToDedicatedCutover.mutate();
				succeedSpinner("Cutover processed.");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(String(result?.cutover ?? 0));

				log("");
				if (result?.nothingToDo) {
					log(
						`Nothing is staged for cutover on this project. Check ${colors.dim("tarout billing migrate:status")}.`,
					);
					log("");
					return;
				}
				log(
					colors.success(
						`${result?.cutover ?? 0} app(s) are now serving from the dedicated host.`,
					),
				);
				if (result?.failed) {
					log(colors.error(`  ${result.failed} app(s) failed to cut over.`));
				}
				if (result?.skipped) {
					log(colors.warn(`  ${result.skipped} app(s) were skipped.`));
				}
				if (result?.notReady) {
					log(
						colors.warn(
							`  ${result.notReady} app(s) were still starting and stay copied — re-run this once they are healthy.`,
						),
					);
				}
				if (result?.failed || result?.notReady) {
					log(
						`Give up on the move instead: ${colors.dim("tarout billing migrate:rollback")}`,
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	billing
		.command("migrate:rollback")
		.description(
			"Abandon a stuck or partial shared-to-dedicated move: every app goes back to its shared-pool host with DNS and plan restored, and the dedicated host keeps its migration claim so a fixed batch can be retried. Valid any time before a fully clean cutover finalizes; the platform refuses when there is no in-flight move. Org owner only.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						"Move every app back to the shared pool and abandon this migration?",
						false,
						{ field: "confirm_migrate_rollback", flag: "--yes" },
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Rolling back...");
				const result =
					await client.subscription.rollbackSharedToDedicatedCutover.mutate();
				succeedSpinner("Rollback processed.");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(String(result?.rolledBack ?? 0));

				log("");
				log(
					colors.success(
						`${result?.rolledBack ?? 0} app(s) are back on the shared pool.`,
					),
				);
				if (result?.failed) {
					log(
						colors.error(
							`  ${result.failed} app(s) could not be rolled back — contact support before retrying the move.`,
						),
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});
}

/**
 * Resolve the target billing interval for `period:preview` / `period:set`.
 * The procedures have no default, so when neither the positional argument nor
 * `--period` names one we ask: an interactive run gets a picker, and a
 * `--json` / `--non-interactive` run gets a `needs_input` event plus exit 6
 * instead of a guessed interval.
 */
async function resolveBillingPeriodTarget(
	raw: string | undefined,
): Promise<BillingPeriodTarget> {
	if (raw !== undefined && String(raw).trim() !== "") {
		return parseBillingPeriodTarget(raw);
	}
	const picked = await select<BillingPeriodTarget>(
		"Switch billing to:",
		BILLING_PERIOD_TARGETS.map((period) => ({
			name:
				period === "yearly"
					? "yearly (10× monthly, 2 months free; charged today)"
					: "monthly (staged for the end of the paid term, no refund)",
			value: period,
		})),
		{
			field: "target_period",
			flag: "--period",
			context: { available: [...BILLING_PERIOD_TARGETS] },
		},
	);
	return parseBillingPeriodTarget(picked);
}

/**
 * Commander `--app <id>` accumulator for `billing migrate:start`. Repeated
 * flags push onto the array; the platform caps an explicit selection at 100
 * ids and refuses the whole batch if any of them is ineligible.
 */
function collectApplicationId(value: string, previous: string[]): string[] {
	const id = String(value).trim();
	if (!id) {
		throw new InvalidArgumentError(
			"Invalid --app value. Expected an application ID.",
		);
	}
	return [...previous, id];
}

/**
 * Commander `--addon <key[:qty]>` accumulator. Repeated flags push onto the
 * array; the optional `:qty` suffix is parsed as a positive integer
 * (defaults to 1). Used by `tarout billing upgrade` to forward bundled
 * addons into the same Moyasar checkout as the plan change.
 *
 * Throws `InvalidArgumentError` so Commander surfaces a clean
 * `INVALID_ARGUMENTS` failure (exit 2) instead of leaking a Node stack
 * trace — required for the agent JSON contract.
 */
function collectAddon(
	value: string,
	previous: Array<{ addonKey: string; quantity: number }>,
): Array<{ addonKey: string; quantity: number }> {
	const [rawKey, rawQty] = value.split(":");
	const addonKey = (rawKey || "").trim();
	if (!addonKey) {
		throw new InvalidArgumentError(
			`Invalid --addon value "${value}". Expected key[:qty] (e.g. db.standard:2).`,
		);
	}
	const quantity = rawQty === undefined ? 1 : Number.parseInt(rawQty, 10);
	if (!Number.isFinite(quantity) || quantity <= 0) {
		throw new InvalidArgumentError(
			`Invalid --addon quantity in "${value}". Expected a positive integer.`,
		);
	}
	return [...previous, { addonKey, quantity }];
}

/**
 * Parse a free-text prompt answer into a non-negative integer, falling back to
 * `fallback` for blank/invalid input. Used by the interactive upgrade estimator.
 */
function parsePositiveInt(raw: string, fallback: number): number {
	const n = Number.parseInt(String(raw).trim(), 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Commander argParser for `--billing-period`. Fails fast on unknown values
 * via `InvalidArgumentError` so the CLI exits before the auth check —
 * an agent doesn't have to be authenticated to discover a malformed flag.
 */
function parseBillingPeriod(raw: string): "monthly" | "yearly" {
	const v = raw.toLowerCase();
	if (v === "monthly" || v === "yearly") return v;
	throw new InvalidArgumentError(
		`Invalid --billing-period "${raw}". Expected "monthly" or "yearly".`,
	);
}

function formatSubStatus(status: string): string {
	const map: Record<string, string> = {
		active: colors.success("active"),
		trialing: colors.info("trialing"),
		past_due: colors.warn("past due"),
		cancelled: colors.warn("cancelled"),
		none: colors.dim("none"),
	};
	return map[status] || status;
}

function formatDate(date: Date | string): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
