import { describe, expect, it } from "vitest";
import {
	type Catalog,
	nextPlanForCurrent,
	nextPlanForRequested,
	resolveEntitlementRemedy,
	upgradeTargetPlan,
} from "../src/lib/entitlement-remedy";

/**
 * Minimal catalog mirroring the real `subscription.getCatalog` shape: plans
 * carry `grants` keyed by entitlement, addons carry `grants` for the resource
 * slots they unlock. The resolver maps a failed entitlement key to the cheapest
 * concrete remedy command an agent can run.
 */
const catalog: Catalog = {
	plans: [
		{ key: "free", name: "Free", priceHalalas: 0, grants: [{ entitlementKey: "app.free.slots", quantity: 1 }] },
		{
			key: "shared",
			name: "Starter",
			priceHalalas: 1900,
			quantityAware: false,
			minQuantity: 1,
			maxQuantity: 1,
			grants: [{ entitlementKey: "app.shared.slots", quantity: 5 }],
		},
		{
			key: "dedicated_small",
			name: "Pro Small",
			priceHalalas: 59900,
			grants: [
				{ entitlementKey: "host.small.slots", quantity: 1 },
				{ entitlementKey: "app.dedicated.slots", quantity: 10 },
			],
		},
	],
	addons: [
		{ key: "db.standard", name: "Standard database", priceHalalas: 4900, grants: [{ entitlementKey: "db.standard.slots", quantity: 1 }] },
		{ key: "storage.standard", name: "Standard storage", priceHalalas: 1500, grants: [{ entitlementKey: "storage.standard.slots", quantity: 1 }] },
	],
};

describe("nextPlanForRequested", () => {
	it("suggests shared for free/undefined and escalates dedicated tiers", () => {
		expect(nextPlanForRequested(undefined)).toBe("shared");
		expect(nextPlanForRequested("free")).toBe("shared");
		expect(nextPlanForRequested("shared")).toBe("shared");
		expect(nextPlanForRequested("dedicated")).toBe("dedicated_small");
		expect(nextPlanForRequested("dedicated_medium")).toBe("dedicated_medium");
	});
});

describe("nextPlanForCurrent", () => {
	it("climbs the ladder from the project's CURRENT plan (free→shared→dedicated)", () => {
		expect(nextPlanForCurrent(undefined)).toBe("shared");
		expect(nextPlanForCurrent("free")).toBe("shared");
		// The key fix: a shared project upgrading goes to dedicated, not stays shared.
		expect(nextPlanForCurrent("shared")).toBe("dedicated_small");
		expect(nextPlanForCurrent("dedicated_small")).toBe("dedicated_medium");
		expect(nextPlanForCurrent("dedicated_medium")).toBe("dedicated_large");
		expect(nextPlanForCurrent("dedicated_large")).toBe("dedicated_large");
	});
});

describe("upgradeTargetPlan", () => {
	it("prefers the current-plan ladder over the requested-plan heuristic", () => {
		expect(
			upgradeTargetPlan({ currentPlanKey: "shared", requestedPlan: "shared" }),
		).toBe("dedicated_small");
	});

	it("falls back to the requested-plan heuristic when no current plan is known", () => {
		expect(upgradeTargetPlan({ requestedPlan: "free" })).toBe("shared");
		expect(upgradeTargetPlan({})).toBe("shared");
	});
});

describe("resolveEntitlementRemedy", () => {
	it("app.free.slots → upgrade to a paid plan (shared)", () => {
		const r = resolveEntitlementRemedy("app.free.slots", catalog);
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("shared");
		expect(r.command).toContain("billing upgrade shared");
	});

	it("app.shared.slots → report the flat five-app cap and upgrade to Pro", () => {
		const r = resolveEntitlementRemedy("app.shared.slots", catalog, {
			currentPlanKey: "shared",
		});
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("dedicated_small");
		expect(r.command).toBe(
			"tarout billing upgrade dedicated_small --wait",
		);
		expect(r.command).not.toContain("plan:quantity");
		expect(r.hint).toMatch(/five|5/i);
	});

	it("app.dedicated.slots / host.* → dedicated plan upgrade", () => {
		expect(resolveEntitlementRemedy("app.dedicated.slots", catalog).targetKey).toBe(
			"dedicated_small",
		);
		const host = resolveEntitlementRemedy("host.small.slots", catalog);
		expect(host.kind).toBe("plan");
		expect(host.targetKey).toBe("dedicated_small");
	});

	it("db.*.slots → addon purchase (catalog-matched)", () => {
		const r = resolveEntitlementRemedy("db.standard.slots", catalog);
		expect(r.kind).toBe("addon");
		expect(r.targetKey).toBe("db.standard");
		expect(r.command).toContain("addon:buy db.standard");
	});

	it("storage.*.slots → addon purchase", () => {
		const r = resolveEntitlementRemedy("storage.standard.slots", catalog);
		expect(r.kind).toBe("addon");
		expect(r.targetKey).toBe("storage.standard");
	});

	it("db.free.slots → plan upgrade, never a (non-existent) free-db addon", () => {
		const r = resolveEntitlementRemedy("db.free.slots", catalog);
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("shared");
		expect(r.command).toContain("billing upgrade shared");
		expect(r.command).not.toContain("addon:buy");
		expect(r.hint).toMatch(/single database for this project/i);
	});

	it("storage.free.slots → plan upgrade, never a (non-existent) free-storage addon", () => {
		const r = resolveEntitlementRemedy("storage.free.slots", catalog);
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("shared");
		expect(r.command).not.toContain("addon:buy");
		expect(r.hint).toMatch(/single storage bucket for this project/i);
	});

	it("falls back to a plan upgrade when no failed key (e.g. no active subscription)", () => {
		const r = resolveEntitlementRemedy(undefined, catalog, {
			requestedPlan: "free",
		});
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("shared");
	});

	it("strips '.slots' for addon keys when the catalog is unavailable", () => {
		const r = resolveEntitlementRemedy("db.standard.slots", null);
		expect(r.kind).toBe("addon");
		expect(r.targetKey).toBe("db.standard");
	});

	it("plan-upgrade gate on a SHARED plan → dedicated (not back to shared)", () => {
		// db.free.slots normally upgrades free→shared; on a shared plan the ladder
		// must climb to dedicated instead.
		const r = resolveEntitlementRemedy("db.free.slots", catalog, {
			currentPlanKey: "shared",
		});
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("dedicated_small");
	});

	it("dedicated host gate escalates from the project's current dedicated tier", () => {
		const r = resolveEntitlementRemedy("app.dedicated.slots", catalog, {
			currentPlanKey: "dedicated_small",
		});
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("dedicated_medium");
	});

	it("a free project's app.free.slots still upgrades to shared", () => {
		const r = resolveEntitlementRemedy("app.free.slots", catalog, {
			currentPlanKey: "free",
		});
		expect(r.kind).toBe("plan");
		expect(r.targetKey).toBe("shared");
	});
});
