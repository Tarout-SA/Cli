import { describe, expect, it } from "vitest";
import {
	type BillingChangeResult,
	exitCodeForBillingResult,
	finalizeBillingMutation,
	nextCommandFor,
	performBillingChange,
	storageSlotTierForAddonKey,
} from "../src/lib/billing-upgrade";
import { ExitCode } from "../src/utils/exit-codes";

/**
 * Scripted fake tRPC client. Each mutation/query returns the value it was
 * configured with. `pollCheckoutStatus` returns a fixed status so the engine's
 * --wait path resolves without real timers.
 */
function fakeClient(opts: {
	changePlan?: unknown;
	purchaseAddons?: unknown;
	setPlanQuantity?: unknown;
	pollStatus?: {
		status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
		failureReason?: string | null;
	};
}) {
	return {
		subscription: {
			changePlan: { mutate: async () => opts.changePlan },
			purchaseAddons: { mutate: async () => opts.purchaseAddons },
			setPlanQuantity: { mutate: async () => opts.setPlanQuantity },
			pollCheckoutStatus: {
				query: async () => ({
					orderId: "ord_1",
					status: opts.pollStatus?.status ?? "PENDING",
					paidAt: null,
					failedAt: null,
					failureReason: opts.pollStatus?.failureReason ?? null,
				}),
			},
		},
	};
}

describe("performBillingChange — plan", () => {
	it("applied immediately for a net-zero change", async () => {
		const c = fakeClient({
			changePlan: { applied: true, proratedChargeHalalas: 0 },
		});
		const r = await performBillingChange(c, { kind: "plan", planKey: "shared" });
		expect(r.status).toBe("applied");
		expect(r.target).toBe("shared");
		expect(r.amountHalalas).toBe(0);
	});

	it("deferred when not applied and no payment URL", async () => {
		const c = fakeClient({ changePlan: { applied: false } });
		const r = await performBillingChange(c, {
			kind: "plan",
			planKey: "free",
		});
		expect(r.status).toBe("deferred");
	});

	it("payment_required when a checkout URL is returned and --wait is off", async () => {
		const c = fakeClient({
			changePlan: {
				applied: false,
				paymentUrl: "https://pay.test/x",
				orderId: "ord_1",
				proratedChargeHalalas: 1900,
			},
		});
		const r = await performBillingChange(c, {
			kind: "plan",
			planKey: "shared",
		});
		expect(r.status).toBe("payment_required");
		expect(r.orderId).toBe("ord_1");
		expect(r.paymentUrl).toBe("https://pay.test/x");
		expect(r.amountHalalas).toBe(1900);
	});

	it("opens the hosted checkout in the browser even without --wait", async () => {
		const c = fakeClient({
			changePlan: {
				applied: false,
				paymentUrl: "https://pay.test/x",
				orderId: "ord_1",
				proratedChargeHalalas: 1900,
			},
		});
		const opened: string[] = [];
		const r = await performBillingChange(c, {
			kind: "plan",
			planKey: "shared",
			openBrowser: async (url: string) => {
				opened.push(url);
			},
		});
		expect(r.status).toBe("payment_required");
		expect(opened).toEqual(["https://pay.test/x"]);
	});

	it("a failed browser open does not reject the no-wait path", async () => {
		const c = fakeClient({
			changePlan: {
				applied: false,
				paymentUrl: "https://pay.test/x",
				orderId: "ord_1",
				proratedChargeHalalas: 1900,
			},
		});
		const r = await performBillingChange(c, {
			kind: "plan",
			planKey: "shared",
			openBrowser: async () => {
				throw new Error("no display");
			},
		});
		expect(r.status).toBe("payment_required");
		expect(r.paymentUrl).toBe("https://pay.test/x");
	});

	it("paid when --wait polls to PAID", async () => {
		const c = fakeClient({
			changePlan: { applied: false, paymentUrl: "u", orderId: "ord_1" },
			pollStatus: { status: "PAID" },
		});
		const r = await performBillingChange(c, {
			kind: "plan",
			planKey: "shared",
			wait: true,
		});
		expect(r.status).toBe("paid");
	});

	it("failed when --wait polls to FAILED", async () => {
		const c = fakeClient({
			changePlan: { applied: false, paymentUrl: "u", orderId: "ord_1" },
			pollStatus: { status: "FAILED", failureReason: "card declined" },
		});
		const r = await performBillingChange(c, {
			kind: "plan",
			planKey: "shared",
			wait: true,
		});
		expect(r.status).toBe("failed");
		expect(r.failureReason).toBe("card declined");
	});

	it("pending_timeout when --wait times out still PENDING", async () => {
		const c = fakeClient({
			changePlan: { applied: false, paymentUrl: "u", orderId: "ord_1" },
			pollStatus: { status: "PENDING" },
		});
		const r = await performBillingChange(c, {
			kind: "plan",
			planKey: "shared",
			wait: true,
			timeoutMs: 0,
		});
		expect(r.status).toBe("pending_timeout");
	});
});

describe("performBillingChange — addon & plan_quantity", () => {
	it("addon purchase returns payment_required with the addon as target", async () => {
		const c = fakeClient({
			purchaseAddons: {
				applied: false,
				paymentUrl: "u",
				orderId: "ord_2",
			},
		});
		const r = await performBillingChange(c, {
			kind: "addon",
			addonKey: "db.standard",
			quantity: 1,
		});
		expect(r.status).toBe("payment_required");
		expect(r.kind).toBe("addon");
		expect(r.target).toBe("db.standard");
	});

	it("sends addons to purchaseAddons as `items` (server contract), not `addons`", async () => {
		let captured: unknown;
		const client = {
			subscription: {
				purchaseAddons: {
					mutate: async (input: unknown) => {
						captured = input;
						return { applied: true, proratedChargeHalalas: 0 };
					},
				},
			},
		};
		const cart = [{ addonKey: "db.starter", quantity: 2 }];
		await performBillingChange(client, { kind: "addon", addons: cart });
		expect(captured).toEqual({ items: cart });
		expect(captured).not.toHaveProperty("addons");
	});

	it("plan_quantity applies immediately and reads proratedCharge", async () => {
		const c = fakeClient({
			setPlanQuantity: { applied: true, proratedCharge: 500 },
		});
		const r = await performBillingChange(c, {
			kind: "plan_quantity",
			planKey: "shared",
			quantity: 3,
		});
		expect(r.status).toBe("applied");
		expect(r.amountHalalas).toBe(500);
	});

	it("routes a per-tier storage slot addon through storage.purchaseStorageSlot (not purchaseAddons)", async () => {
		let storageInput: unknown;
		let purchaseAddonsCalled = false;
		const client = {
			subscription: {
				purchaseAddons: {
					mutate: async () => {
						purchaseAddonsCalled = true;
						return { applied: true };
					},
				},
			},
			storage: {
				purchaseStorageSlot: {
					mutate: async (input: unknown) => {
						storageInput = input;
						return { applied: true, proratedChargeHalalas: 1500 };
					},
				},
			},
		};
		const r = await performBillingChange(client, {
			kind: "addon",
			addonKey: "storage.standard",
			quantity: 1,
		});
		expect(purchaseAddonsCalled).toBe(false);
		expect(storageInput).toEqual({ tier: "STANDARD", quantity: 1 });
		expect(r.status).toBe("applied");
		expect(r.kind).toBe("addon");
		expect(r.target).toBe("storage.standard");
		expect(r.amountHalalas).toBe(1500);
	});

	it("keeps db addons on purchaseAddons (only storage slots reroute)", async () => {
		let purchaseAddonsInput: unknown;
		const client = {
			subscription: {
				purchaseAddons: {
					mutate: async (input: unknown) => {
						purchaseAddonsInput = input;
						return { applied: true };
					},
				},
			},
		};
		await performBillingChange(client, {
			kind: "addon",
			addonKey: "db.standard",
			quantity: 1,
		});
		expect(purchaseAddonsInput).toEqual({
			items: [{ addonKey: "db.standard", quantity: 1 }],
		});
	});
});

describe("storageSlotTierForAddonKey", () => {
	it("maps per-tier storage slot addons to their tier", () => {
		expect(storageSlotTierForAddonKey("storage.starter")).toBe("STARTER");
		expect(storageSlotTierForAddonKey("storage.standard")).toBe("STANDARD");
		expect(storageSlotTierForAddonKey("storage.pro")).toBe("PRO");
	});

	it("returns null for the metered per-GB addon and non-storage keys", () => {
		// `storage.gb` is a real purchaseAddons line (per-GB capacity), not a slot.
		expect(storageSlotTierForAddonKey("storage.gb")).toBeNull();
		expect(storageSlotTierForAddonKey("db.standard")).toBeNull();
		expect(storageSlotTierForAddonKey("storage.free")).toBeNull();
	});
});

describe("nextCommandFor / exitCodeForBillingResult", () => {
	const base: BillingChangeResult = {
		status: "payment_required",
		kind: "plan",
		target: "shared",
		orderId: "ord_9",
	};

	it("suggests `billing wait` for payment_required and pending_timeout", () => {
		expect(nextCommandFor(base)).toContain("billing wait ord_9");
		expect(nextCommandFor({ ...base, status: "pending_timeout" })).toContain(
			"billing wait ord_9",
		);
	});

	it("has no next command for terminal states", () => {
		expect(nextCommandFor({ ...base, status: "paid" })).toBeUndefined();
		expect(nextCommandFor({ ...base, status: "applied" })).toBeUndefined();
	});

	it("maps statuses to exit codes (resumable vs hard failure)", () => {
		expect(exitCodeForBillingResult({ ...base, status: "applied" })).toBe(
			ExitCode.SUCCESS,
		);
		expect(exitCodeForBillingResult({ ...base, status: "payment_required" })).toBe(
			ExitCode.SUCCESS,
		);
		expect(exitCodeForBillingResult({ ...base, status: "pending_timeout" })).toBe(
			ExitCode.CHECKOUT_PENDING,
		);
		expect(exitCodeForBillingResult({ ...base, status: "failed" })).toBe(
			ExitCode.GENERAL_ERROR,
		);
		expect(exitCodeForBillingResult({ ...base, status: "expired" })).toBe(
			ExitCode.GENERAL_ERROR,
		);
	});
});

describe("finalizeBillingMutation — database kind", () => {
	it("classifies an applied (net-zero) db change", async () => {
		const r = await finalizeBillingMutation(
			{} as never,
			{ applied: true, proratedChargeHalalas: 0 },
			{ kind: "database", target: "STANDARD" },
		);
		expect(r.status).toBe("applied");
		expect(r.kind).toBe("database");
		expect(r.target).toBe("STANDARD");
	});

	it("classifies a db upgrade that returns a hosted checkout", async () => {
		const r = await finalizeBillingMutation(
			{} as never,
			{ applied: false, paymentUrl: "https://pay.test/x", orderId: "ord_9", proratedChargeHalalas: 2000 },
			{ kind: "database", target: "PRO" },
		);
		expect(r.status).toBe("payment_required");
		expect(r.kind).toBe("database");
		expect(r.target).toBe("PRO");
	});
});
