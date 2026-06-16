/**
 * The single billing-change engine the whole CLI funnels through — plan
 * upgrades, addon purchases, and plan-quantity bumps. Previously each surface
 * (`tarout billing upgrade`, the deploy free-tier upsell, the entitlement-gate
 * prompt, `addon:add`/`addon:buy`) re-implemented `changePlan → branch → poll`
 * with subtle divergence; that divergence was the source of the "bugs in
 * different deployment flows". One engine = one behavior everywhere.
 *
 * It never calls `process.exit` and never opens a browser itself (the caller
 * injects `openBrowser` only in interactive mode), so it is fully unit-testable
 * with a scripted fake client.
 *
 * Payment reality: StreamPay exposes no off-session "charge stored token" API,
 * so any positive charge returns a hosted-checkout `paymentUrl` a human must
 * complete. Only net-zero changes (free, downgrade, proration → 0) apply
 * instantly. The engine classifies both paths into one typed result.
 */

import { ExitCode } from "../utils/exit-codes.js";
import {
	box,
	colors,
	isJsonMode,
	outputData,
	outputError,
	outputJsonLine,
} from "./output.js";

/**
 * Agent-facing guidance attached to every NEEDS_UPGRADE envelope. If the
 * agent's OWN permission layer blocks the billing command (e.g. a coding-agent
 * harness that gates paid-looking commands), the CLI can't print anything —
 * it never runs. So we surface the fix one step earlier, on the upgrade-needed
 * result the agent DOES receive, and tell it to have the user allowlist billing
 * once. Running an upgrade is non-destructive: it only opens the hosted payment
 * page; the user still completes payment in the browser.
 */
export const AGENT_BILLING_PERMISSION_HINT =
	'If your agent\'s permission system blocks this billing command, ask the user to allowlist Tarout billing once so you can run it directly (Claude Code: add "Bash(tarout billing:*)" to .claude/settings.json). Running an upgrade only opens the hosted payment page — the user still completes payment in the browser.';

export type BillingChangeKind = "plan" | "addon" | "plan_quantity";

export type BillingChangeStatus =
	| "applied" // net-zero change applied immediately, no payment
	| "deferred" // staged for the end of the current billing period
	| "payment_required" // hosted checkout opened; not polled (no --wait)
	| "paid" // polled to PAID
	| "pending_timeout" // polled until timeout, still PENDING (resumable)
	| "failed"
	| "expired";

export interface BillingChangeResult {
	status: BillingChangeStatus;
	kind: BillingChangeKind;
	/** Plan key, addon key, or the quantity-aware plan key. */
	target: string;
	orderId?: string;
	paymentUrl?: string;
	amountHalalas?: number;
	effectiveAt?: string | Date;
	failureReason?: string | null;
}

export interface PerformBillingChangeInput {
	kind: BillingChangeKind;
	planKey?: string;
	addonKey?: string;
	quantity?: number;
	billingPeriod?: "monthly" | "yearly";
	/** Bundled addons for a plan change, or the cart for an addon purchase. */
	addons?: Array<{ addonKey: string; quantity: number }>;
	/** Poll the hosted checkout until terminal instead of returning early. */
	wait?: boolean;
	timeoutMs?: number;
	/** Injected in interactive mode only; omitted in JSON/agent mode. */
	openBrowser?: (url: string) => Promise<void>;
	/** Called once a hosted checkout exists, before polling begins (UX hook). */
	onCheckoutOpened?: (info: { orderId: string; paymentUrl: string }) => void;
}

/** Post-mutation classification shared by every billing surface. */
export interface FinalizeContext {
	kind: BillingChangeKind;
	target: string;
	wait?: boolean;
	timeoutMs?: number;
	openBrowser?: (url: string) => Promise<void>;
	onCheckoutOpened?: (info: { orderId: string; paymentUrl: string }) => void;
}

/**
 * Map a per-tier storage *slot* addon key to its tier for
 * `storage.purchaseStorageSlot`. Returns null for anything else — including the
 * metered per-GB `storage.gb` capacity addon, which is a real `purchaseAddons`
 * line, not a bucket-slot purchase.
 *
 * Storage bucket slots (`storage.{starter,standard,pro}.slots`) are gated and
 * sold differently from db/app: the generic `purchaseAddons` path runs
 * `assertResourceAddonsMatchPlan`, which rejects `storage.standard` on a shared
 * plan (it only allows `storage.gb`). The dashboard buys bucket slots through
 * the dedicated `purchaseStorageSlot` mutation instead, so the CLI mirrors that
 * here — same logic, same server endpoint.
 */
export function storageSlotTierForAddonKey(
	addonKey: string,
): "STARTER" | "STANDARD" | "PRO" | null {
	switch (addonKey) {
		case "storage.starter":
			return "STARTER";
		case "storage.standard":
			return "STANDARD";
		case "storage.pro":
			return "PRO";
		default:
			return null;
	}
}

function resolveTarget(input: PerformBillingChangeInput): string {
	if (input.kind === "plan") return input.planKey ?? "";
	if (input.kind === "addon") {
		return input.addonKey ?? input.addons?.[0]?.addonKey ?? "";
	}
	return input.planKey ?? "shared";
}

function chargeFromResult(result: {
	proratedChargeHalalas?: number;
	proratedCharge?: number;
}): number | undefined {
	if (typeof result?.proratedChargeHalalas === "number") {
		return result.proratedChargeHalalas;
	}
	if (typeof result?.proratedCharge === "number") return result.proratedCharge;
	return undefined;
}

export async function performBillingChange(
	// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
	client: any,
	input: PerformBillingChangeInput,
): Promise<BillingChangeResult> {
	const kind = input.kind;
	const target = resolveTarget(input);

	// biome-ignore lint/suspicious/noExplicitAny: server result shapes vary per mutation.
	let result: any;
	if (kind === "plan") {
		result = await client.subscription.changePlan.mutate({
			planKey: input.planKey,
			planQuantity: input.quantity,
			billingPeriod: input.billingPeriod,
			addons: input.addons,
		});
	} else if (kind === "addon") {
		// Per-tier storage bucket slots go through the dedicated
		// `storage.purchaseStorageSlot` mutation (same path the dashboard uses),
		// not `purchaseAddons` — which would reject `storage.standard`/`storage.pro`
		// via `assertResourceAddonsMatchPlan`. Only the single-addon form is routed
		// this way; a multi-line `addons` cart stays on `purchaseAddons`.
		const storageTier =
			!input.addons && input.addonKey
				? storageSlotTierForAddonKey(input.addonKey)
				: null;
		if (storageTier) {
			result = await client.storage.purchaseStorageSlot.mutate({
				tier: storageTier,
				quantity: input.quantity ?? 1,
			});
		} else {
			const items =
				input.addons ??
				(input.addonKey
					? [{ addonKey: input.addonKey, quantity: input.quantity ?? 1 }]
					: []);
			// Server contract: `purchaseAddons` takes `{ items }` (see
			// validations/subscription.ts `purchaseAddonsInput`). `changePlan` is the
			// one that takes `addons` — they are not interchangeable.
			result = await client.subscription.purchaseAddons.mutate({ items });
		}
	} else {
		result = await client.subscription.setPlanQuantity.mutate({
			quantity: input.quantity,
		});
	}

	return finalizeBillingMutation(client, result, {
		kind,
		target,
		wait: input.wait,
		timeoutMs: input.timeoutMs,
		openBrowser: input.openBrowser,
		onCheckoutOpened: input.onCheckoutOpened,
	});
}

/**
 * Classify the result of *any* subscription-mutating tRPC call (changePlan,
 * purchaseAddons, setPlanQuantity, addAddon, updateAddonQuantity, confirmCheckout)
 * into the unified {@link BillingChangeResult}, optionally polling to terminal.
 * Exposed so surfaces that call a mutation not covered by `performBillingChange`
 * (e.g. `addon:add` → addAddon) get identical branching.
 */
export async function finalizeBillingMutation(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	// biome-ignore lint/suspicious/noExplicitAny: server result shapes vary per mutation.
	result: any,
	ctx: FinalizeContext,
): Promise<BillingChangeResult> {
	const { kind, target } = ctx;
	const amountHalalas = chargeFromResult(result ?? {});

	if (result?.applied) {
		return {
			status: "applied",
			kind,
			target,
			amountHalalas,
			effectiveAt: result?.effectiveAt,
		};
	}

	if (!result?.paymentUrl || !result?.orderId) {
		return {
			status: "deferred",
			kind,
			target,
			amountHalalas,
			effectiveAt: result?.effectiveAt,
		};
	}

	const orderId: string = result.orderId;
	const paymentUrl: string = result.paymentUrl;

	// Surface the checkout URL before opening, but only when we're about to
	// poll — `onCheckoutOpened` carries wait-specific copy ("Polling for
	// confirmation…") in some callers.
	if (ctx.wait) ctx.onCheckoutOpened?.({ orderId, paymentUrl });

	// Auto-open the hosted checkout whenever a browser opener is injected
	// (interactive / non-JSON agent), for BOTH the --wait and no-wait paths:
	// surfacing the payment page is the whole point of a positive-charge result.
	// JSON/agent callers inject no opener and read `paymentUrl` from the
	// envelope instead. Failures are swallowed — the URL is always in the box.
	if (ctx.openBrowser) {
		try {
			await ctx.openBrowser(paymentUrl);
		} catch {
			// Headless / no display — the paymentUrl is surfaced in the envelope.
		}
	}

	if (!ctx.wait) {
		return {
			status: "payment_required",
			kind,
			target,
			orderId,
			paymentUrl,
			amountHalalas,
		};
	}

	const final = await pollCheckoutUntilTerminal(client, orderId, {
		timeoutMs: ctx.timeoutMs ?? 600_000,
		intervalMs: 4_000,
	});

	const status: BillingChangeStatus =
		final.status === "PAID"
			? "paid"
			: final.status === "FAILED"
				? "failed"
				: final.status === "EXPIRED"
					? "expired"
					: "pending_timeout";

	return {
		status,
		kind,
		target,
		orderId,
		paymentUrl,
		amountHalalas,
		failureReason: final.failureReason,
	};
}

/** The resumable command an agent should run for a non-terminal checkout. */
export function nextCommandFor(result: BillingChangeResult): string | undefined {
	if (
		(result.status === "payment_required" ||
			result.status === "pending_timeout") &&
		result.orderId
	) {
		return `tarout billing wait ${result.orderId} --timeout 600`;
	}
	return undefined;
}

/** Maps a result to the process exit code, distinguishing resumable from hard. */
export function exitCodeForBillingResult(result: BillingChangeResult): number {
	switch (result.status) {
		case "pending_timeout":
			return ExitCode.CHECKOUT_PENDING;
		case "failed":
		case "expired":
			return ExitCode.GENERAL_ERROR;
		default:
			return ExitCode.SUCCESS;
	}
}

function formatHalalas(halalas: number | undefined): string | undefined {
	if (typeof halalas !== "number") return undefined;
	return `${(halalas / 100).toFixed(2)} SAR`;
}

/**
 * Emit the single, documented agent envelope for a billing result and print
 * the human-friendly box. Returns the exit code the caller should apply.
 *
 * Agent envelope (one JSON line):
 *   { success, data: { status, kind, target, orderId?, paymentUrl?,
 *                      amountHalalas?, nextCommand? , hint } }   // success-ish
 *   { success:false, error: { code, message, details } }        // failed/expired/pending
 */
export function emitBillingResult(
	result: BillingChangeResult,
	opts?: { label?: string },
): number {
	const label = opts?.label ?? result.target;
	const nextCommand = nextCommandFor(result);
	const amount = formatHalalas(result.amountHalalas);
	const envelope = {
		status: result.status,
		kind: result.kind,
		target: result.target,
		...(result.orderId ? { orderId: result.orderId } : {}),
		...(result.paymentUrl ? { paymentUrl: result.paymentUrl } : {}),
		...(typeof result.amountHalalas === "number"
			? { amountHalalas: result.amountHalalas }
			: {}),
		...(nextCommand ? { nextCommand } : {}),
	};

	switch (result.status) {
		case "applied":
			outputData({ ...envelope, hint: "Applied immediately. Retry your last action." });
			box("Plan changed", [
				`${label}: ${colors.success("applied immediately")}`,
				amount ? `Charged: ${amount}` : "",
			].filter(Boolean));
			return ExitCode.SUCCESS;

		case "paid":
			outputData({ ...envelope, hint: "Payment confirmed. Retry your last action." });
			box("Payment confirmed", [
				`${label}: ${colors.success("subscription is active")}`,
				"Retry your last action.",
			]);
			return ExitCode.SUCCESS;

		case "deferred":
			outputData({
				...envelope,
				hint: "Change staged for the end of the current billing period.",
			});
			box("Plan change staged", [
				`${label}: will apply at the end of the current billing period.`,
			]);
			return ExitCode.SUCCESS;

		case "payment_required":
			outputData({
				...envelope,
				hint: `Open paymentUrl to complete checkout, then run \`${nextCommand}\` — or re-run without --no-wait (waiting is the default).`,
			});
			box("Payment required", [
				`${label}`,
				`Open: ${colors.cyan(result.paymentUrl ?? "")}`,
				`Order ID: ${colors.dim(result.orderId ?? "")}`,
				`Then: ${colors.dim(nextCommand ?? "")}`,
			]);
			return ExitCode.SUCCESS;

		case "pending_timeout":
			outputError(
				"CHECKOUT_PENDING",
				"Hosted checkout is still pending after the timeout — resume polling or finish payment in the browser.",
				{ ...envelope },
			);
			box("Still waiting", [
				`Order ID: ${colors.dim(result.orderId ?? "")}`,
				`Run: ${colors.dim(nextCommand ?? "")}`,
			]);
			return ExitCode.CHECKOUT_PENDING;

		default: {
			// failed | expired
			const code =
				result.status === "expired" ? "CHECKOUT_EXPIRED" : "CHECKOUT_FAILED";
			outputError(
				code,
				result.failureReason ?? `Checkout ${result.status}.`,
				{ ...envelope },
			);
			box("Payment failed", [
				`Order ID: ${colors.dim(result.orderId ?? "")}`,
				`Reason: ${result.failureReason ?? result.status}`,
			]);
			return ExitCode.GENERAL_ERROR;
		}
	}
}

/**
 * Poll `subscription.pollCheckoutStatus` every `intervalMs` until the checkout
 * reaches a terminal status (PAID/FAILED/EXPIRED) or `timeoutMs` elapses. Emits
 * one JSON event line per status change when --json is on, so an external agent
 * sees progress without buffering.
 *
 * Lives here (not in `commands/billing.ts`) so the engine can reuse it without a
 * circular import; `commands/billing.ts` re-exports it for back-compat.
 */
export async function pollCheckoutUntilTerminal(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	orderId: string,
	opts: { timeoutMs: number; intervalMs: number },
): Promise<{
	status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
	paidAt: Date | null;
	failedAt: Date | null;
	failureReason: string | null;
}> {
	const deadline = Date.now() + opts.timeoutMs;
	let lastStatus = "";
	while (Date.now() < deadline) {
		const r = await client.subscription.pollCheckoutStatus.query({ orderId });
		if (r.status !== lastStatus) {
			if (isJsonMode()) {
				outputJsonLine({
					type: "event",
					event: "checkout_status",
					orderId,
					status: r.status,
				});
			}
			lastStatus = r.status;
		}
		if (r.status !== "PENDING") {
			return {
				status: r.status,
				paidAt: r.paidAt,
				failedAt: r.failedAt,
				failureReason: r.failureReason,
			};
		}
		await new Promise((res) => setTimeout(res, opts.intervalMs));
	}
	// Timeout — return last seen status (PENDING).
	const r = await client.subscription.pollCheckoutStatus.query({ orderId });
	return {
		status: r.status,
		paidAt: r.paidAt,
		failedAt: r.failedAt,
		failureReason: r.failureReason,
	};
}
