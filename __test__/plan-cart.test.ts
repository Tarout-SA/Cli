import { describe, expect, it } from "vitest";
import {
	buildPlanAddonCart,
	dbAddonKeyForPlanFamily,
	isPaidFamily,
	planFamily,
	purchasableDbAddonKeys,
	resourceAddonKeysForPlan,
} from "../src/lib/plan-cart";

describe("planFamily / isPaidFamily", () => {
	it("classifies known plan keys", () => {
		expect(planFamily("free")).toBe("FREE");
		expect(planFamily("shared")).toBe("SHARED");
		expect(planFamily("dedicated_medium")).toBe("DEDICATED");
		expect(planFamily("nope")).toBeNull();
		expect(planFamily(undefined)).toBeNull();
		// bundle_* plans were removed from the catalog — no longer a known family.
		expect(planFamily("bundle_starter")).toBeNull();
	});

	it("treats only SHARED/DEDICATED as paid families", () => {
		expect(isPaidFamily("shared")).toBe(true);
		expect(isPaidFamily("dedicated_large")).toBe(true);
		expect(isPaidFamily("free")).toBe(false);
		expect(isPaidFamily("nope")).toBe(false);
	});
});

describe("resourceAddonKeysForPlan", () => {
	it("maps SHARED → db.starter + storage.gb (matches the dashboard estimator)", () => {
		expect(resourceAddonKeysForPlan("shared")).toEqual({
			dbAddonKey: "db.starter",
			storageAddonKey: "storage.gb",
		});
	});

	it("maps DEDICATED → db.pro + storage.gb", () => {
		expect(resourceAddonKeysForPlan("dedicated_small")).toEqual({
			dbAddonKey: "db.pro",
			storageAddonKey: "storage.gb",
		});
	});

	it("grants nothing for free/unknown", () => {
		expect(resourceAddonKeysForPlan("free")).toEqual({
			dbAddonKey: null,
			storageAddonKey: null,
		});
	});
});

describe("dbAddonKeyForPlanFamily", () => {
	it("defaults a plan family to the CHEAPEST standalone managed db addon", () => {
		// The server accepts any db tier standalone on a paid plan, so the default
		// is the cheapest tier — "just add a database" must never over-charge.
		expect(dbAddonKeyForPlanFamily("shared")).toBe("db.starter");
		expect(dbAddonKeyForPlanFamily("dedicated_small")).toBe("db.pro");
		expect(dbAddonKeyForPlanFamily("dedicated_large")).toBe("db.pro");
	});

	it("returns null for free/unknown (no managed db addon to buy)", () => {
		expect(dbAddonKeyForPlanFamily("free")).toBeNull();
		expect(dbAddonKeyForPlanFamily(undefined)).toBeNull();
		expect(dbAddonKeyForPlanFamily("nope")).toBeNull();
	});
});

describe("purchasableDbAddonKeys", () => {
	it("lists every db tier (cheapest first) for paid families, none for free", () => {
		expect(purchasableDbAddonKeys("shared")).toEqual([
			"db.starter",
			"db.standard",
			"db.pro",
		]);
		expect(purchasableDbAddonKeys("dedicated_small")).toEqual([
			"db.starter",
			"db.standard",
			"db.pro",
		]);
		expect(purchasableDbAddonKeys("free")).toEqual([]);
		expect(purchasableDbAddonKeys(undefined)).toEqual([]);
	});
});

describe("buildPlanAddonCart", () => {
	it("bundles DB + storage for Starter", () => {
		expect(buildPlanAddonCart("shared", { databases: 2, storageGb: 5 })).toEqual([
			{ addonKey: "db.starter", quantity: 2 },
			{ addonKey: "storage.gb", quantity: 5 },
		]);
	});

	it("uses db.pro for the dedicated family", () => {
		expect(
			buildPlanAddonCart("dedicated_medium", { databases: 1, storageGb: 10 }),
		).toEqual([
			{ addonKey: "db.pro", quantity: 1 },
			{ addonKey: "storage.gb", quantity: 10 },
		]);
	});

	it("drops zero-quantity lines (app-only / no-DB / no-storage are all valid)", () => {
		expect(buildPlanAddonCart("shared", { databases: 0, storageGb: 0 })).toEqual(
			[],
		);
		expect(buildPlanAddonCart("shared", { databases: 0, storageGb: 5 })).toEqual([
			{ addonKey: "storage.gb", quantity: 5 },
		]);
		expect(buildPlanAddonCart("shared", { databases: 1, storageGb: 0 })).toEqual([
			{ addonKey: "db.starter", quantity: 1 },
		]);
	});

	it("returns an empty cart for non-paid plans", () => {
		expect(buildPlanAddonCart("free", { databases: 1, storageGb: 5 })).toEqual(
			[],
		);
	});

	it("floors and clamps negative/fractional input", () => {
		expect(
			buildPlanAddonCart("shared", { databases: 2.9, storageGb: -3 }),
		).toEqual([{ addonKey: "db.starter", quantity: 2 }]);
	});
});
