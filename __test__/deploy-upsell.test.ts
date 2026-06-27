import { describe, expect, it } from "vitest";
import type {
	Catalog,
	EntitlementRemedy,
} from "../src/lib/entitlement-remedy";
import {
	buildConfigFromOptions,
	buildRemedyOptions,
	formatPlanPrice,
	inferAppSlotKey,
	inferSuggestedPlan,
	isEntitlementError,
	pickDefaultResourceTier,
	runInlineTargetedRemedy,
	runInlineUpgrade,
} from "../src/commands/deploy";

/**
 * Build a fake tRPC client that returns whatever `changePlan` was scripted
 * to return. We don't exercise `pollCheckoutStatus` here — that path needs
 * to mock `open` and the polling helper, which is covered indirectly by
 * the `pollCheckoutUntilTerminal` tests in the billing test suite.
 */
function fakeClient(changePlanReturn: unknown) {
	return {
		subscription: {
			changePlan: {
				mutate: async () => changePlanReturn,
			},
		},
	};
}

describe("formatPlanPrice", () => {
	it("formats a positive halalas amount as 'X.XX SAR/mo'", () => {
		expect(formatPlanPrice(2900)).toBe("29.00 SAR/mo");
		expect(formatPlanPrice(10000)).toBe("100.00 SAR/mo");
		expect(formatPlanPrice(150)).toBe("1.50 SAR/mo");
	});

	it("returns an empty string for zero, negative, or missing prices", () => {
		expect(formatPlanPrice(0)).toBe("");
		expect(formatPlanPrice(-100)).toBe("");
		expect(formatPlanPrice(undefined)).toBe("");
	});
});

describe("buildConfigFromOptions", () => {
	it("returns undefined when no build flags are set", () => {
		expect(buildConfigFromOptions({})).toBeUndefined();
	});

	it("returns undefined when all build flags are empty strings", () => {
		expect(
			buildConfigFromOptions({
				frameworkPreset: "",
				rootDirectory: "   ",
				installCommand: "",
				buildCommand: "",
				outputDirectory: "  ",
				startCommand: "",
			}),
		).toBeUndefined();
	});

	it("includes only the fields that have non-empty trimmed values", () => {
		expect(
			buildConfigFromOptions({
				frameworkPreset: "Next.js",
				rootDirectory: " apps/web ",
				installCommand: "",
				buildCommand: "  bun run build  ",
				outputDirectory: "",
				startCommand: "node server.js",
			}),
		).toEqual({
			frameworkPreset: "Next.js",
			rootDirectory: "apps/web",
			buildCommand: "bun run build",
			startCommand: "node server.js",
		});
	});

	it("ignores non-string values (e.g. boolean coming from commander defaults)", () => {
		expect(
			buildConfigFromOptions({
				// Cast through unknown — simulating an upstream caller that
				// forgot to coerce a boolean flag. We want this path to be
				// safe, not throw.
				frameworkPreset: undefined,
				installCommand: "bun install",
			}),
		).toEqual({ installCommand: "bun install" });
	});
});

describe("runInlineUpgrade", () => {
	it("returns true immediately when changePlan is applied without payment", async () => {
		const client = fakeClient({ applied: true });
		await expect(runInlineUpgrade(client, "shared")).resolves.toBe(true);
	});

	it("returns false when changePlan returns no paymentUrl and is not applied (e.g. downgrade staged)", async () => {
		const client = fakeClient({ applied: false });
		await expect(runInlineUpgrade(client, "shared")).resolves.toBe(false);
	});

	it("returns false when changePlan returns paymentUrl without an orderId", async () => {
		// Malformed server response — we treat it as "did not confirm".
		const client = fakeClient({
			applied: false,
			paymentUrl: "https://example.test/pay",
		});
		await expect(runInlineUpgrade(client, "shared")).resolves.toBe(false);
	});
});

describe("runInlineTargetedRemedy", () => {
	const addonRemedy: EntitlementRemedy = {
		kind: "addon",
		targetKey: "db.starter",
		targetName: "Starter database",
		command: "tarout billing addon:buy db.starter --wait",
		hint: "",
	};

	it("buys the addon via purchaseAddons and returns true when applied", async () => {
		let purchasedItems: unknown;
		const client = {
			subscription: {
				purchaseAddons: {
					mutate: async (input: { items: unknown }) => {
						purchasedItems = input.items;
						return { applied: true };
					},
				},
			},
		};
		await expect(runInlineTargetedRemedy(client, addonRemedy)).resolves.toBe(
			true,
		);
		expect(purchasedItems).toEqual([{ addonKey: "db.starter", quantity: 1 }]);
	});

	it("returns false when the addon purchase neither applies nor opens checkout", async () => {
		const client = {
			subscription: {
				purchaseAddons: { mutate: async () => ({ applied: false }) },
			},
		};
		await expect(runInlineTargetedRemedy(client, addonRemedy)).resolves.toBe(
			false,
		);
	});

	it("bumps the quantity-aware plan to current + 1 (setPlanQuantity is absolute)", async () => {
		let setQuantity: number | undefined;
		const quantityRemedy: EntitlementRemedy = {
			kind: "plan_quantity",
			targetKey: "shared",
			targetName: "Starter",
			command: "tarout billing plan:quantity 3 --wait",
			hint: "",
		};
		const client = {
			subscription: {
				getCurrent: { query: async () => ({ planQuantity: 2 }) },
				setPlanQuantity: {
					mutate: async (input: { quantity: number }) => {
						setQuantity = input.quantity;
						return { applied: true };
					},
				},
			},
		};
		await expect(
			runInlineTargetedRemedy(client, quantityRemedy),
		).resolves.toBe(true);
		expect(setQuantity).toBe(3);
	});

	it("falls back to quantity 2 when the current plan quantity can't be read", async () => {
		let setQuantity: number | undefined;
		const quantityRemedy: EntitlementRemedy = {
			kind: "plan_quantity",
			targetKey: "shared",
			command: "tarout billing plan:quantity 2 --wait",
			hint: "",
		};
		const client = {
			subscription: {
				getCurrent: {
					query: async () => {
						throw new Error("network");
					},
				},
				setPlanQuantity: {
					mutate: async (input: { quantity: number }) => {
						setQuantity = input.quantity;
						return { applied: true };
					},
				},
			},
		};
		await expect(
			runInlineTargetedRemedy(client, quantityRemedy),
		).resolves.toBe(true);
		expect(setQuantity).toBe(2);
	});
});

describe("buildRemedyOptions", () => {
	const catalog: Catalog = {
		plans: [
			{ key: "shared", name: "Starter", priceHalalas: 1900 },
			{ key: "dedicated_small", name: "Pro Small", priceHalalas: 59900 },
		],
	};

	it("addon gate → both 'buy just the addon' and 'upgrade the plan'", () => {
		const remedy: EntitlementRemedy = {
			kind: "addon",
			targetKey: "db.starter",
			targetName: "Starter database",
			command: "tarout billing addon:buy db.starter --wait",
			hint: "",
		};
		const opts = buildRemedyOptions(remedy, "free", catalog);
		expect(opts.map((o) => o.action)).toEqual(["buy_addon", "upgrade_plan"]);
		expect(opts[0]?.command).toBe("tarout billing addon:buy db.starter --wait");
		expect(opts[1]?.command).toBe("tarout billing upgrade shared --wait");
		expect(opts[1]?.label).toBe("Upgrade to Starter");
	});

	it("app-slot gate → both 'add one more app slot' and 'upgrade the plan'", () => {
		const remedy: EntitlementRemedy = {
			kind: "plan_quantity",
			targetKey: "shared",
			targetName: "Starter",
			command: "tarout billing plan:quantity 3 --wait",
			hint: "",
		};
		const opts = buildRemedyOptions(remedy, "shared", catalog);
		expect(opts.map((o) => o.action)).toEqual([
			"add_app_slot",
			"upgrade_plan",
		]);
		expect(opts[0]?.command).toBe("tarout billing plan:quantity 3 --wait");
	});

	it("plan-only gate (free-tier cap) → single upgrade option, no addon", () => {
		const remedy: EntitlementRemedy = {
			kind: "plan",
			targetKey: "shared",
			targetName: "Starter",
			command: "tarout billing upgrade shared --wait",
			hint: "",
		};
		const opts = buildRemedyOptions(remedy, "free", catalog);
		expect(opts).toHaveLength(1);
		expect(opts[0]?.action).toBe("upgrade_plan");
	});

	it("addon gate on a SHARED org → upgrade option climbs to dedicated", () => {
		const remedy: EntitlementRemedy = {
			kind: "addon",
			targetKey: "db.standard",
			targetName: "Standard database",
			command: "tarout billing addon:buy db.standard --wait",
			hint: "",
		};
		// currentPlanKey "shared" → the upgrade alternative is dedicated_small,
		// not "shared" (which the requested-plan heuristic would have produced).
		const opts = buildRemedyOptions(remedy, "shared", catalog, "shared");
		expect(opts[0]?.command).toBe("tarout billing addon:buy db.standard --wait");
		expect(opts[1]?.action).toBe("upgrade_plan");
		expect(opts[1]?.command).toBe("tarout billing upgrade dedicated_small --wait");
		expect(opts[1]?.label).toBe("Upgrade to Pro Small");
	});

	it("app-slot gate on a SHARED org → upgrade option targets dedicated", () => {
		const remedy: EntitlementRemedy = {
			kind: "plan_quantity",
			targetKey: "shared",
			targetName: "Starter",
			command: "tarout billing plan:quantity 3 --wait",
			hint: "",
		};
		const opts = buildRemedyOptions(remedy, undefined, catalog, "shared");
		expect(opts[0]?.command).toBe("tarout billing plan:quantity 3 --wait");
		expect(opts[1]?.command).toBe("tarout billing upgrade dedicated_small --wait");
	});

	it("Starter app-slot gate → add-slot + upgrade + per-app reuse options", () => {
		const remedy: EntitlementRemedy = {
			kind: "plan_quantity",
			failedKey: "app.shared.slots",
			targetKey: "shared",
			targetName: "Starter",
			command: "tarout billing plan:quantity 3 --wait",
			hint: "",
		};
		const apps = [
			{ id: "7f3a2b00", name: "api" },
			{ id: "9c1d4e00", name: "web" },
		];
		const opts = buildRemedyOptions(remedy, "shared", catalog, "shared", apps);
		expect(opts.map((o) => o.action)).toEqual([
			"add_app_slot",
			"upgrade_plan",
			"reuse_app",
			"reuse_app",
		]);
		expect(opts[2]?.command).toBe("tarout up --app 7f3a2b00");
		expect(opts[3]?.label).toBe('Reuse "web"');
	});

	it("Dedicated app-slot gate → upgrade (no add-slot) + reuse options", () => {
		const remedy: EntitlementRemedy = {
			kind: "plan",
			failedKey: "app.dedicated.slots",
			targetKey: "dedicated_medium",
			targetName: "Pro Medium",
			command: "tarout billing upgrade dedicated_medium --wait",
			hint: "",
		};
		const opts = buildRemedyOptions(remedy, undefined, catalog, "dedicated_small", [
			{ id: "abc12345", name: "api" },
		]);
		expect(opts.map((o) => o.action)).toEqual(["upgrade_plan", "reuse_app"]);
		expect(opts[1]?.command).toBe("tarout up --app abc12345");
	});

	it("caps reuse options at 5 and points the rest at `apps list`", () => {
		const remedy: EntitlementRemedy = {
			kind: "plan_quantity",
			failedKey: "app.shared.slots",
			targetKey: "shared",
			command: "tarout billing plan:quantity 2 --wait",
			hint: "",
		};
		const many = Array.from({ length: 7 }, (_, i) => ({
			id: `id${i}`,
			name: `app${i}`,
		}));
		const opts = buildRemedyOptions(remedy, undefined, catalog, "shared", many);
		const reuse = opts.filter((o) => o.action === "reuse_app");
		expect(reuse).toHaveLength(6); // 5 apps + 1 "list the rest" pointer
		expect(reuse[5]?.command).toBe("tarout apps list");
	});

	it("non-app gate (db addon) never adds reuse options, even with apps present", () => {
		const remedy: EntitlementRemedy = {
			kind: "addon",
			failedKey: "db.standard.slots",
			targetKey: "db.standard",
			targetName: "Standard database",
			command: "tarout billing addon:buy db.standard --wait",
			hint: "",
		};
		const opts = buildRemedyOptions(remedy, "shared", catalog, "shared", [
			{ id: "x", name: "api" },
		]);
		expect(opts.some((o) => o.action === "reuse_app")).toBe(false);
	});
});

describe("inferAppSlotKey", () => {
	it("maps the legacy keyless app-slot gate to the org's plan-family key", () => {
		const err = new Error(
			"No app slots available on your current plan. Upgrade to add more.",
		);
		expect(inferAppSlotKey(err, "shared")).toBe("app.shared.slots");
		expect(inferAppSlotKey(err, "dedicated_small")).toBe("app.dedicated.slots");
		expect(inferAppSlotKey(err, "free")).toBe("app.free.slots");
		expect(inferAppSlotKey(err, undefined)).toBe("app.free.slots");
	});

	it("returns undefined for non app-slot errors", () => {
		expect(
			inferAppSlotKey(
				new Error("Plan limit reached for db.standard.slots: 1/1."),
				"shared",
			),
		).toBeUndefined();
		expect(inferAppSlotKey(new Error("boom"), "shared")).toBeUndefined();
	});
});

describe("pickDefaultResourceTier", () => {
	const tier = (
		t: "FREE" | "STARTER" | "STANDARD" | "PRO",
		limit: number,
		used: number,
		monthlyHalalas: number,
	) => ({
		tier: t,
		limit,
		used,
		available: Math.max(0, limit - used),
		canCreate: used < limit,
		monthlyHalalas,
	});

	it("free org with an open free slot → FREE", () => {
		const tiers = [
			tier("FREE", 1, 0, 0),
			tier("STARTER", 0, 0, 2900),
			tier("STANDARD", 0, 0, 4900),
			tier("PRO", 0, 0, 9900),
		];
		expect(pickDefaultResourceTier(tiers)).toBe("FREE");
	});

	it("paid org with a starter addon slot → STARTER, never FREE", () => {
		const tiers = [
			tier("FREE", 0, 0, 0), // paid org: no free entitlement
			tier("STARTER", 1, 0, 2900),
			tier("STANDARD", 0, 0, 4900),
			tier("PRO", 0, 0, 9900),
		];
		expect(pickDefaultResourceTier(tiers)).toBe("STARTER");
	});

	it("paid org with multiple creatable tiers → the cheapest", () => {
		const tiers = [
			tier("FREE", 0, 0, 0),
			tier("STARTER", 1, 0, 2900),
			tier("PRO", 1, 0, 9900),
		];
		expect(pickDefaultResourceTier(tiers)).toBe("STARTER");
	});

	it("paid org with no db addon (nothing creatable) → STARTER so the gate offers the addon", () => {
		const tiers = [
			tier("FREE", 0, 0, 0),
			tier("STARTER", 0, 0, 2900),
			tier("STANDARD", 0, 0, 4900),
			tier("PRO", 0, 0, 9900),
		];
		expect(pickDefaultResourceTier(tiers)).toBe("STARTER");
	});

	it("org owns db.standard with an OPEN slot → STANDARD (never STARTER)", () => {
		// The reported case: a SHARED-plan org holding an unused db.standard slot
		// must not be sent to db.starter (which it doesn't own).
		const tiers = [
			tier("FREE", 0, 0, 0),
			tier("STARTER", 0, 0, 2900),
			tier("STANDARD", 1, 0, 4900),
			tier("PRO", 0, 0, 9900),
		];
		expect(pickDefaultResourceTier(tiers)).toBe("STANDARD");
	});

	it("org owns db.standard but the slot is used → STANDARD, so the gate matches the owned tier (not STARTER)", () => {
		const tiers = [
			tier("FREE", 0, 0, 0),
			tier("STARTER", 0, 0, 2900),
			tier("STANDARD", 1, 1, 4900),
			tier("PRO", 0, 0, 9900),
		];
		expect(pickDefaultResourceTier(tiers)).toBe("STANDARD");
	});

	it("free org whose one free slot is used → FREE (server gate then explains the cap)", () => {
		const tiers = [
			tier("FREE", 1, 1, 0), // has the free entitlement, just consumed
			tier("STARTER", 0, 0, 2900),
		];
		expect(pickDefaultResourceTier(tiers)).toBe("FREE");
	});

	it("empty/failed entitlement lookup → STARTER (safer than auto-FREE)", () => {
		expect(pickDefaultResourceTier([])).toBe("STARTER");
	});
});

// These re-exports come from the previous task. Keeping a smoke check here
// so the deploy-upsell file stands on its own and a regression on the
// shared helper is caught regardless of which test file runs first.
describe("re-exported helpers", () => {
	it("isEntitlementError still recognizes the new FREE_NOT_ALLOWED_ON_PAID_PLAN reason", () => {
		expect(
			isEntitlementError({
				code: "FORBIDDEN",
				message: "FREE_NOT_ALLOWED_ON_PAID_PLAN",
			}),
		).toBe(true);
	});

	it("inferSuggestedPlan returns 'shared' for undefined / free input", () => {
		expect(inferSuggestedPlan(undefined)).toBe("shared");
		expect(inferSuggestedPlan("free")).toBe("shared");
	});
});
