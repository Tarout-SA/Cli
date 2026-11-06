/**
 * Contracts for the headless billing ops-recovery surface: `billing standing`,
 * `billing retry-renewal`, the monthly/yearly interval switch, the
 * shared→dedicated app migration, and `wallet cancel`.
 *
 * The real incident these exist for: a renewal failed three times on
 * insufficient funds and had to be recovered with hand-written SQL, because
 * there was no CLI path. `retryRenewal` is that path — and because it charges a
 * saved card server-side with no hosted payment page in between, the consent
 * gate below is load-bearing, not cosmetic.
 *
 * Pure helpers only; no network client is constructed and no procedure is
 * called.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// `addCardDashboardUrl()` derives its link from the active profile's API URL.
// Pin it so the assertion does not depend on whoever is logged in locally.
vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	getApiUrl: () => "https://api.test",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
}));

import { Command } from "commander";
import {
	type ActiveMigrationResponse,
	addCardDashboardUrl,
	assertSubscriptionCheckoutOrderId,
	billingPeriodChangeArg,
	billingPeriodMutationShape,
	describeRetryRenewal,
	exitCodeForCheckoutOrder,
	exitCodeForStanding,
	formatSarAmount,
	orderIdKind,
	parseBillingPeriodTarget,
	registerBillingCommands,
	renewalConsentGate,
	summarizeMigration,
} from "../src/commands/billing";
import {
	assertWalletTopupOrderId,
	formatRunwayLevel,
	registerWalletCommands,
	WALLET_CANCEL_HELP_WARNING,
	WALLET_CANCEL_NOT_A_REFUND,
} from "../src/commands/wallet";
import { setGlobalOptions } from "../src/lib/output";
import { ExitCode } from "../src/utils/exit-codes";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: true,
	yes: false,
	nonInteractive: false,
};

afterEach(() => {
	setGlobalOptions(RESET);
});

function subcommand(
	register: (program: Command) => void,
	group: string,
	name: string,
) {
	const program = new Command();
	program.exitOverride();
	register(program);
	const parent = program.commands.find((c) => c.name() === group);
	return parent?.commands.find((c) => c.name() === name);
}

const billingSub = (name: string) =>
	subcommand(registerBillingCommands, "billing", name);
const walletSub = (name: string) =>
	subcommand(registerWalletCommands, "wallet", name);

// ── Billing period target ───────────────────────────────────────────────────

describe("parseBillingPeriodTarget", () => {
	it("accepts both intervals the procedure declares", () => {
		expect(parseBillingPeriodTarget("monthly")).toBe("monthly");
		expect(parseBillingPeriodTarget("yearly")).toBe("yearly");
	});

	it("normalises case and surrounding whitespace", () => {
		expect(parseBillingPeriodTarget("  Yearly ")).toBe("yearly");
		expect(parseBillingPeriodTarget("MONTHLY")).toBe("monthly");
	});

	it("rejects an unknown interval instead of guessing one", () => {
		expect(() => parseBillingPeriodTarget("annual")).toThrow(
			/Invalid billing period "annual"/,
		);
		expect(() => parseBillingPeriodTarget("quarterly")).toThrow(
			/monthly or yearly/,
		);
	});

	it("rejects a missing or blank interval (the input has no default)", () => {
		expect(() => parseBillingPeriodTarget(undefined)).toThrow(
			/no default, so the target interval must be named explicitly/,
		);
		expect(() => parseBillingPeriodTarget("   ")).toThrow(
			/Invalid billing period/,
		);
	});

	it("exits 2 (INVALID_ARGUMENTS) through the CLI error class", () => {
		try {
			parseBillingPeriodTarget("yeerly");
			expect.unreachable("should have thrown");
		} catch (err) {
			expect((err as { code?: number }).code).toBe(ExitCode.INVALID_ARGUMENTS);
		}
	});
});

describe("billingPeriodChangeArg", () => {
	it("sends exactly { targetPeriod } to both period procedures", () => {
		expect(billingPeriodChangeArg("yearly")).toEqual({
			targetPeriod: "yearly",
		});
		expect(billingPeriodChangeArg("Monthly")).toEqual({
			targetPeriod: "monthly",
		});
	});

	it("validates before building, so a bad value never reaches the server", () => {
		expect(() => billingPeriodChangeArg("weekly")).toThrow(
			/Invalid billing period/,
		);
	});
});

// ── changeBillingPeriod → billing engine adapter ────────────────────────────

describe("billingPeriodMutationShape", () => {
	it("maps yearly→monthly (scheduled) onto a no-charge, no-order result", () => {
		const shaped = billingPeriodMutationShape({
			status: "scheduled",
			effectiveAt: "2027-01-01T00:00:00.000Z",
			chargeTodayHalalas: 0,
			paymentUrl: null,
			publicPaymentUrl: null,
			orderId: null,
		});
		expect(shaped.applied).toBe(false);
		expect(shaped.proratedChargeHalalas).toBe(0);
		expect(shaped.orderId).toBeUndefined();
		expect(shaped.paymentUrl).toBeUndefined();
		expect(shaped.publicPaymentUrl).toBeUndefined();
		expect(shaped.effectiveAt).toBe("2027-01-01T00:00:00.000Z");
	});

	it("maps monthly→yearly (checkout) onto the hosted-checkout shape", () => {
		const shaped = billingPeriodMutationShape({
			status: "checkout",
			chargeTodayHalalas: 22000,
			paymentUrl: "https://tarout.sa/dashboard/billing/checkout/pay?o=sub_9",
			publicPaymentUrl: "https://tarout.sa/pay/sub_9",
			orderId: "sub_9",
		});
		expect(shaped.applied).toBe(false);
		// The previewed amount IS the charged amount: it is carried through under
		// the key the billing engine reads, never recomputed here.
		expect(shaped.proratedChargeHalalas).toBe(22000);
		expect(shaped.orderId).toBe("sub_9");
		expect(shaped.publicPaymentUrl).toBe("https://tarout.sa/pay/sub_9");
	});

	it("maps an instant apply onto applied:true", () => {
		expect(
			billingPeriodMutationShape({ status: "applied", chargeTodayHalalas: 0 })
				.applied,
		).toBe(true);
	});

	it("defaults a missing charge to zero rather than undefined", () => {
		expect(billingPeriodMutationShape(null).proratedChargeHalalas).toBe(0);
		expect(billingPeriodMutationShape({}).applied).toBe(false);
	});
});

// ── billing standing → exit code ────────────────────────────────────────────

describe("exitCodeForStanding", () => {
	it("exits non-zero on a danger severity so CI can gate on it", () => {
		expect(
			exitCodeForStanding({ kind: "paused", severity: "danger", daysLeft: 0 }),
		).toBe(ExitCode.GENERAL_ERROR);
		expect(
			exitCodeForStanding({ kind: "canceled", severity: "danger", daysLeft: 0 }),
		).toBe(ExitCode.GENERAL_ERROR);
	});

	it("exits 0 on a warning (PAST_DUE still inside its grace window)", () => {
		expect(
			exitCodeForStanding({ kind: "past_due", severity: "warning", daysLeft: 4 }),
		).toBe(ExitCode.SUCCESS);
	});

	it("exits 0 when standing is healthy (the procedure returns null)", () => {
		expect(exitCodeForStanding(null)).toBe(ExitCode.SUCCESS);
		expect(exitCodeForStanding(undefined)).toBe(ExitCode.SUCCESS);
	});
});

// ── retry-renewal consent gate ──────────────────────────────────────────────

describe("renewalConsentGate", () => {
	it("refuses to run unattended under --json without --yes", () => {
		setGlobalOptions({ ...RESET, json: true });
		expect(renewalConsentGate()).toBe("refuse");
	});

	it("refuses to run unattended under --non-interactive without --yes", () => {
		setGlobalOptions({ ...RESET, nonInteractive: true });
		expect(renewalConsentGate()).toBe("refuse");
	});

	it("accepts --yes as the explicit consent, in either agent mode", () => {
		setGlobalOptions({ ...RESET, json: true, yes: true });
		expect(renewalConsentGate()).toBe("skip");
		setGlobalOptions({ ...RESET, nonInteractive: true, yes: true });
		expect(renewalConsentGate()).toBe("skip");
	});

	it("asks on an interactive TTY run", () => {
		setGlobalOptions(RESET);
		expect(renewalConsentGate()).toBe("confirm");
	});
});

// ── retry-renewal outcome mapping ───────────────────────────────────────────

describe("describeRetryRenewal", () => {
	const url = "https://api.test/dashboard/billing/add-card";

	it("treats a charge as success", () => {
		const report = describeRetryRenewal({ status: "charged" }, url);
		expect(report.code).toBeNull();
		expect(report.exitCode).toBe(ExitCode.SUCCESS);
		expect(report.message).toMatch(/charged to the card on file/);
	});

	it("explains a fully discounted cycle without claiming a charge", () => {
		const report = describeRetryRenewal(
			{ status: "charged", reason: "promo_free_cycle" },
			url,
		);
		expect(report.exitCode).toBe(ExitCode.SUCCESS);
		expect(report.message).toMatch(/without a charge/);
	});

	it("maps no_card to an error pointing at the dashboard card page", () => {
		const report = describeRetryRenewal({ status: "no_card" }, url);
		expect(report.code).toBe("NO_PAYMENT_METHOD");
		expect(report.exitCode).toBe(ExitCode.GENERAL_ERROR);
		expect(report.message).toContain(url);
		// The CLI must not imply it can fix this itself.
		expect(report.message).toMatch(/cannot add or read a card/);
	});

	it("maps a decline to a non-zero charge failure, carrying the reason", () => {
		const report = describeRetryRenewal(
			{ status: "failed", reason: "insufficient_funds" },
			url,
		);
		expect(report.code).toBe("RENEWAL_CHARGE_FAILED");
		expect(report.exitCode).toBe(ExitCode.GENERAL_ERROR);
		expect(report.message).toContain("insufficient_funds");
		expect(report.message).toMatch(/does not advance the dunning ladder/);
	});

	it("maps skipped to non-zero: no money moved, so it is not a recovery", () => {
		const report = describeRetryRenewal(
			{ status: "skipped", reason: "not_due" },
			url,
		);
		expect(report.code).toBe("RENEWAL_NOT_CHARGED");
		expect(report.exitCode).toBe(ExitCode.GENERAL_ERROR);
		expect(report.message).toContain("not_due");
	});

	it("refuses to call an unknown status a success", () => {
		const report = describeRetryRenewal({ status: "weird" }, url);
		expect(report.code).toBe("RENEWAL_UNKNOWN_STATUS");
		expect(report.exitCode).toBe(ExitCode.GENERAL_ERROR);
		expect(describeRetryRenewal(null, url).exitCode).toBe(
			ExitCode.GENERAL_ERROR,
		);
	});
});

describe("addCardDashboardUrl", () => {
	it("points at the dashboard page on the active API host", () => {
		expect(addCardDashboardUrl()).toBe(
			"https://api.test/dashboard/billing/add-card",
		);
	});
});

// ── shared → dedicated migration summary ────────────────────────────────────

const NOW = new Date("2026-11-05T12:00:00.000Z");

function migration(
	over: Partial<ActiveMigrationResponse> = {},
): ActiveMigrationResponse {
	return {
		active: true,
		mode: "shared-to-dedicated",
		stage: "copying",
		startedAt: "2026-11-05T11:00:00.000Z",
		canCutover: false,
		progressPct: 33,
		host: { name: "pro-host-1", status: "ACTIVE" },
		counts: { copied: 0, failed: 0, provisioning: 3, ready: 0, total: 3 },
		...over,
	};
}

describe("summarizeMigration", () => {
	it("reports no migration without inventing a stage", () => {
		const summary = summarizeMigration({ active: false }, NOW);
		expect(summary.active).toBe(false);
		expect(summary.stage).toBeNull();
		expect(summary.nextCommand).toBeUndefined();
		expect(summary.headline).toMatch(/No shared-to-dedicated app migration/);
		expect(summarizeMigration(null, NOW).active).toBe(false);
	});

	it("names the automatic cutover while copying", () => {
		const summary = summarizeMigration(migration(), NOW);
		expect(summary.stage).toBe("copying");
		expect(summary.headline).toContain("pro-host-1");
		expect(summary.headline).toContain("33%");
		expect(summary.note).toMatch(/cuts over automatically/);
		expect(summary.nextCommand).toBe("tarout billing migrate:status");
	});

	it("offers the cutover once an app is healthy on the new host", () => {
		const summary = summarizeMigration(
			migration({
				stage: "ready_to_cutover",
				canCutover: true,
				progressPct: 100,
				counts: { copied: 3, failed: 0, provisioning: 0, ready: 3, total: 3 },
			}),
			NOW,
		);
		expect(summary.nextCommand).toBe("tarout billing migrate:cutover");
		expect(summary.headline).toMatch(/waiting for the traffic cutover/);
	});

	it("withholds the cutover while nothing is healthy yet", () => {
		const summary = summarizeMigration(
			migration({
				stage: "ready_to_cutover",
				canCutover: false,
				counts: { copied: 2, failed: 0, provisioning: 0, ready: 0, total: 2 },
			}),
			NOW,
		);
		expect(summary.nextCommand).toBe("tarout billing migrate:status");
		expect(summary.headline).toMatch(/cutover would be refused/);
	});

	it("reports a months-old ready_to_cutover as real, not stale", () => {
		// COPIED rows are never aged out server-side — their only exit is a
		// cutover — so a poller legitimately sees one of these.
		const summary = summarizeMigration(
			migration({
				stage: "ready_to_cutover",
				canCutover: true,
				startedAt: "2026-06-30T00:00:00.000Z",
				counts: { copied: 1, failed: 0, provisioning: 0, ready: 1, total: 1 },
			}),
			NOW,
		);
		expect(summary.ageDays).toBe(128);
		expect(summary.note).toMatch(/never aged out/);
		expect(summary.note).toMatch(/still actionable/);
		expect(summary.nextCommand).toBe("tarout billing migrate:cutover");
	});

	it("routes an all-failed migration to the rollback", () => {
		const summary = summarizeMigration(
			migration({
				stage: "failed",
				counts: { copied: 0, failed: 2, provisioning: 0, ready: 0, total: 2 },
			}),
			NOW,
		);
		expect(summary.nextCommand).toBe("tarout billing migrate:rollback");
		expect(summary.headline).toContain("2 app(s)");
	});

	it("survives a payload with no counts or startedAt", () => {
		const summary = summarizeMigration({ active: true }, NOW);
		expect(summary.active).toBe(true);
		expect(summary.ageDays).toBeNull();
		expect(summary.stage).toBe("copying");
	});
});

// ── order ids ───────────────────────────────────────────────────────────────

describe("orderIdKind", () => {
	it("classifies each checkout prefix the platform mints", () => {
		expect(orderIdKind("sub_abc")).toBe("subscription");
		expect(orderIdKind("top_abc")).toBe("wallet");
		expect(orderIdKind("dom_abc")).toBe("domain");
		expect(orderIdKind("whatever")).toBe("unknown");
	});
});

describe("assertSubscriptionCheckoutOrderId", () => {
	it("allows a subscription order and anything unrecognised", () => {
		expect(() => assertSubscriptionCheckoutOrderId("sub_1")).not.toThrow();
		expect(() => assertSubscriptionCheckoutOrderId("legacy-1")).not.toThrow();
	});

	it("redirects a wallet order to the wallet command", () => {
		// `cancelCheckout` matches subscription checkouts only; a wallet id would
		// come back `cancelled: false`, which reads as "already settled".
		expect(() => assertSubscriptionCheckoutOrderId("top_7")).toThrow(
			/tarout wallet cancel top_7/,
		);
	});

	it("rejects a domain order", () => {
		expect(() => assertSubscriptionCheckoutOrderId("dom_7")).toThrow(
			/not a subscription checkout/,
		);
	});
});

describe("exitCodeForCheckoutOrder", () => {
	it("exits CHECKOUT_PENDING on a resumable hosted checkout", () => {
		expect(
			exitCodeForCheckoutOrder({ canPay: true }),
		).toBe(ExitCode.CHECKOUT_PENDING);
	});

	it("exits 0 for a settled or unreadable order", () => {
		expect(exitCodeForCheckoutOrder({ canPay: false })).toBe(ExitCode.SUCCESS);
		expect(exitCodeForCheckoutOrder(null)).toBe(ExitCode.SUCCESS);
	});
});

// ── amount formatting ───────────────────────────────────────────────────────

describe("formatSarAmount", () => {
	it("renders integer halalas as SAR", () => {
		expect(formatSarAmount(22000)).toBe("220.00 SAR");
		expect(formatSarAmount(0)).toBe("0.00 SAR");
		expect(formatSarAmount(-1250)).toBe("-12.50 SAR");
	});

	it("renders a missing amount as a dash rather than NaN", () => {
		expect(formatSarAmount(undefined)).toBe("-");
		expect(formatSarAmount(null)).toBe("-");
		expect(formatSarAmount(Number.NaN)).toBe("-");
	});
});

// ── wallet ──────────────────────────────────────────────────────────────────

describe("assertWalletTopupOrderId", () => {
	it("allows a top-up order", () => {
		expect(() => assertWalletTopupOrderId("top_1")).not.toThrow();
	});

	it("rejects anything else, because the procedure silently ignores it", () => {
		// markWalletTopupFailed returns early for a non-`top_` id and the mutation
		// still answers { success: true } — a success report for a no-op.
		expect(() => assertWalletTopupOrderId("sub_1")).toThrow(
			/tarout billing cancel-checkout sub_1/,
		);
		expect(() => assertWalletTopupOrderId("1234")).toThrow(
			/report success without cancelling anything/,
		);
	});
});

describe("wallet cancel wording", () => {
	it("says loudly that it is not a refund", () => {
		expect(WALLET_CANCEL_NOT_A_REFUND).toMatch(/NOT a refund/);
		expect(WALLET_CANCEL_NOT_A_REFUND).toMatch(
			/does not contact the payment provider/,
		);
		expect(WALLET_CANCEL_NOT_A_REFUND).toMatch(/never paid/);
	});

	it("tells a customer who already paid what to do instead", () => {
		expect(WALLET_CANCEL_HELP_WARNING).toContain(WALLET_CANCEL_NOT_A_REFUND);
		expect(WALLET_CANCEL_HELP_WARNING).toMatch(/support ticket/);
	});

	it("repeats the warning in --help and in the description", () => {
		const cancel = walletSub("cancel");
		expect(cancel, "wallet cancel should exist").toBeTruthy();
		expect(cancel?.description()).toMatch(/NOT a refund/);
		// Commander hard-wraps help text, so compare on collapsed whitespace.
		const help = (cancel?.helpInformation() ?? "").replace(/\s+/g, " ");
		expect(help).toMatch(/NOT a refund/);
		expect(help).toMatch(/does not reverse a completed payment/);
	});
});

describe("formatRunwayLevel", () => {
	it("passes the server's own vocabulary through", () => {
		setGlobalOptions({ ...RESET, noColor: true });
		expect(formatRunwayLevel("ok")).toBe("ok");
		expect(formatRunwayLevel("low")).toBe("low");
		expect(formatRunwayLevel("empty")).toBe("empty");
		expect(formatRunwayLevel(undefined)).toBe("-");
	});
});

// ── registration ────────────────────────────────────────────────────────────

describe("ops-recovery command registration", () => {
	for (const name of [
		"summary",
		"standing",
		"discount",
		"order",
		"cancel-checkout",
		"period:preview",
		"period:set",
		"retry-renewal",
		"migrate:list",
		"migrate:start",
		"migrate:status",
		"migrate:cutover",
		"migrate:rollback",
	]) {
		it(`registers \`billing ${name}\``, () => {
			const cmd = billingSub(name);
			expect(cmd, `billing ${name} should exist`).toBeTruthy();
			// Descriptions are read by agents as well as operators.
			expect((cmd?.description() ?? "").length).toBeGreaterThan(80);
		});
	}

	for (const name of ["status", "cancel"]) {
		it(`registers \`wallet ${name}\``, () => {
			const cmd = walletSub(name);
			expect(cmd, `wallet ${name} should exist`).toBeTruthy();
			expect((cmd?.description() ?? "").length).toBeGreaterThan(80);
		});
	}

	it("`period:set` reuses the shared checkout-polling flags", () => {
		const longs = billingSub("period:set")?.options.map((o) => o.long) ?? [];
		expect(longs).toContain("--wait");
		expect(longs).toContain("--no-wait");
		expect(longs).toContain("--timeout");
		expect(longs).toContain("--no-open");
	});

	it("both period commands accept the interval positionally or by flag", () => {
		for (const name of ["period:preview", "period:set"]) {
			const cmd = billingSub(name);
			expect(cmd?.options.map((o) => o.long)).toContain("--period");
			expect(cmd?.usage()).toMatch(/\[period\]/);
		}
	});

	it("`retry-renewal` takes no flags that could change the amount", () => {
		const cmd = billingSub("retry-renewal");
		// The amount is recomputed server-side; there must be no --amount here.
		expect(cmd?.options.map((o) => o.long)).not.toContain("--amount");
		expect(cmd?.description()).toMatch(/--yes/);
		expect(cmd?.description()).toMatch(/PAST_DUE/);
	});

	it("`migrate:start` takes a repeatable --app selection", () => {
		expect(billingSub("migrate:start")?.options.map((o) => o.long)).toContain(
			"--app",
		);
	});
});
