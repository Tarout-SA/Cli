import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabasePlan } from "../src/commands/deploy";
import { setGlobalOptions } from "../src/lib/output";

/**
 * `ensureDatabasePlan` defaults a new database to the project's subscribed tier. In
 * an INTERACTIVE session it auto-buys the plan-matched managed db add-on when
 * there's no open slot; in JSON / non-interactive / --yes (agent) mode it must
 * NOT charge — it hands off a `needsConsent` signal so the caller surfaces
 * NEEDS_UPGRADE instead of silently billing a second time. These tests drive it
 * with a scripted fake tRPC client — no DB, no payment gateway.
 *
 * Vitest sets `TAROUT_NO_BROWSER=1` globally, so the auto-buy path's injected
 * `paymentBrowserOpener()` is always `undefined`. A fail-closed `open` mock in
 * the Vitest setup also catches any browser-launch path that bypasses the helper.
 */

type Tier = {
	tier: string;
	canCreate: boolean;
	limit: number;
	available: number;
	monthlyHalalas: number;
};

function tier(
	t: string,
	limit: number,
	used: number,
	monthlyHalalas: number,
): Tier {
	return {
		tier: t,
		limit,
		available: Math.max(0, limit - used),
		canCreate: used < limit,
		monthlyHalalas,
	};
}

function fakeClient(opts: {
	planKey?: string | null;
	tiers?: Tier[];
	purchaseAddons?: unknown;
	pollStatus?: {
		status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
		failureReason?: string | null;
	};
	onPurchase?: (input: unknown) => void;
	onTiers?: () => void;
}) {
	return {
		subscription: {
			getCurrent: {
				query: async () => ({ planKey: opts.planKey ?? "free" }),
			},
			purchaseAddons: {
				mutate: async (input: unknown) => {
					opts.onPurchase?.(input);
					return opts.purchaseAddons ?? { applied: true };
				},
			},
			pollCheckoutStatus: {
				query: async () => ({
					orderId: "o",
					status: opts.pollStatus?.status ?? "PENDING",
					paidAt: null,
					failedAt: null,
					failureReason: opts.pollStatus?.failureReason ?? null,
				}),
			},
		},
		postgres: {
			getEntitlements: {
				query: async () => {
					opts.onTiers?.();
					return { tiers: opts.tiers ?? [] };
				},
			},
		},
	};
}

beforeEach(() => {
	// Interactive session by default. Vitest's TAROUT_NO_BROWSER guard prevents
	// auto-buy from launching a real browser on every host OS.
	setGlobalOptions({ json: false, nonInteractive: false });
});

afterEach(() => {
	setGlobalOptions({ json: false, nonInteractive: false });
});

describe("ensureDatabasePlan", () => {
	it("interactive Starter project with no open DB slot → auto-buys the CHEAPEST tier (db.starter), resolves STARTER", async () => {
		let purchased: unknown;
		const client = fakeClient({
			planKey: "shared",
			tiers: [
				tier("FREE", 0, 0, 0),
				tier("STARTER", 0, 0, 2900),
				tier("STANDARD", 0, 0, 4900),
				tier("PRO", 0, 0, 9900),
			],
			purchaseAddons: { applied: true },
			onPurchase: (i) => {
				purchased = i;
			},
		});
		const r = await ensureDatabasePlan(client, undefined);
		expect(r).toEqual({ ok: true, plan: "STARTER" });
		// db.starter (29) — the cheapest tier; the server accepts any db tier on
		// Shared, so "just add a database" defaults to the cheapest.
		expect(purchased).toEqual({
			items: [{ addonKey: "db.starter", quantity: 1 }],
		});
	});

	it("agent/non-interactive Starter project with no open DB slot → hands off, NO purchase", async () => {
		// Regression: `tarout up --json --non-interactive` must not silently fire a
		// second paid checkout for the db add-on after the user just paid for the
		// plan. It hands off `needsConsent` so the caller can ask the user first.
		setGlobalOptions({ json: true, nonInteractive: true });
		let purchaseCalled = false;
		const client = fakeClient({
			planKey: "shared",
			tiers: [
				tier("FREE", 0, 0, 0),
				tier("STARTER", 0, 0, 2900),
				tier("STANDARD", 0, 0, 4900),
				tier("PRO", 0, 0, 9900),
			],
			onPurchase: () => {
				purchaseCalled = true;
			},
		});
		const r = await ensureDatabasePlan(client, undefined);
		expect(purchaseCalled).toBe(false);
		expect(r.ok).toBe(false);
		if (r.ok || !("needsConsent" in r)) {
			throw new Error("expected a needsConsent handoff, got: " + JSON.stringify(r));
		}
		expect(r.needsConsent).toBe(true);
		// Cheapest tier is the default hand-off; the NEEDS_UPGRADE envelope the
		// caller emits lists all tiers so the user can pick a bigger one.
		expect(r.addonKey).toBe("db.starter");
		expect(r.tier).toBe("STARTER");
	});

	it("Dedicated project with a bundled db.standard slot → STANDARD, NO purchase", async () => {
		let purchaseCalled = false;
		const client = fakeClient({
			planKey: "dedicated_small",
			tiers: [
				tier("FREE", 0, 0, 0),
				tier("STARTER", 0, 0, 2900),
				tier("STANDARD", 5, 0, 4900), // bundled with the dedicated plan
				tier("PRO", 0, 0, 9900),
			],
			onPurchase: () => {
				purchaseCalled = true;
			},
		});
		const r = await ensureDatabasePlan(client, undefined);
		expect(r).toEqual({ ok: true, plan: "STANDARD" });
		expect(purchaseCalled).toBe(false); // never buys db.pro when db.standard is free
	});

	it("Dedicated project with bundled db.standard exhausted → auto-buys db.pro, resolves PRO", async () => {
		let purchased: unknown;
		const client = fakeClient({
			planKey: "dedicated_small",
			tiers: [tier("STANDARD", 5, 5, 4900), tier("PRO", 0, 0, 9900)],
			purchaseAddons: { applied: true },
			onPurchase: (i) => {
				purchased = i;
			},
		});
		const r = await ensureDatabasePlan(client, undefined);
		expect(r).toEqual({ ok: true, plan: "PRO" });
		expect(purchased).toEqual({ items: [{ addonKey: "db.pro", quantity: 1 }] });
	});

	it("free project with an open free DB slot → FREE, no purchase", async () => {
		let purchaseCalled = false;
		const client = fakeClient({
			planKey: "free",
			tiers: [tier("FREE", 1, 0, 0), tier("STARTER", 0, 0, 2900)],
			onPurchase: () => {
				purchaseCalled = true;
			},
		});
		const r = await ensureDatabasePlan(client, undefined);
		expect(r).toEqual({ ok: true, plan: "FREE" });
		expect(purchaseCalled).toBe(false);
	});

	it("explicit non-free tier wins — no tier lookup, no purchase", async () => {
		let tiersCalled = false;
		let purchaseCalled = false;
		const client = fakeClient({
			planKey: "shared",
			onTiers: () => {
				tiersCalled = true;
			},
			onPurchase: () => {
				purchaseCalled = true;
			},
		});
		const r = await ensureDatabasePlan(client, "PRO");
		expect(r).toEqual({ ok: true, plan: "PRO" });
		expect(tiersCalled).toBe(false);
		expect(purchaseCalled).toBe(false);
	});

	it("explicit FREE on a paid project is dropped → resolves the project's real tier", async () => {
		const client = fakeClient({
			planKey: "shared",
			tiers: [tier("FREE", 0, 0, 0), tier("STANDARD", 1, 0, 4900)],
		});
		const r = await ensureDatabasePlan(client, "FREE");
		expect(r).toEqual({ ok: true, plan: "STANDARD" });
	});

	it("paid project whose auto-buy checkout does not complete → ok:false with the result", async () => {
		const client = fakeClient({
			planKey: "shared",
			tiers: [tier("STANDARD", 0, 0, 4900)],
			purchaseAddons: {
				applied: false,
				paymentUrl: "https://pay.test/x",
				orderId: "o",
			},
			pollStatus: { status: "FAILED", failureReason: "card declined" },
		});
		const r = await ensureDatabasePlan(client, undefined);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.result.status).toBe("failed");
			expect(r.result.kind).toBe("addon");
		}
	});
});
