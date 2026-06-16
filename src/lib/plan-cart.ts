/**
 * Builds the bundled-addon cart for a plan change, mirroring the dashboard
 * plan-card estimator: choosing a paid plan and some databases / storage GB
 * turns into `changePlan({ planKey, addons })` where `addons` is the resource
 * cart. Self-contained in the CLI package (no cross-package imports).
 *
 * Addon keys per paid family (matching the dashboard estimator):
 *   - SHARED ("Starter")  → `db.starter` + `storage.gb`
 *   - DEDICATED ("Pro")   → `db.pro`     + `storage.gb`
 *   - FREE / unknown      → none
 */

export type PlanFamily = "FREE" | "SHARED" | "DEDICATED" | null;

/** Mirror of the server-side plan-family classification (`@/lib/plan-families`). */
export function planFamily(planKey?: string | null): PlanFamily {
	if (!planKey) return null;
	if (planKey === "free") return "FREE";
	if (
		planKey === "shared" ||
		planKey.startsWith("shared_") ||
		planKey.startsWith("bundle_")
	) {
		return "SHARED";
	}
	if (planKey === "dedicated" || planKey.startsWith("dedicated_")) {
		return "DEDICATED";
	}
	return null;
}

/** Any plan that is not FREE and is a recognized paid family. */
export function isPaidFamily(planKey?: string | null): boolean {
	const family = planFamily(planKey);
	return family === "SHARED" || family === "DEDICATED";
}

/**
 * The standalone *managed* database addon a plan family can purchase on top of
 * its subscription — mirrors the server's `getResourceAddonPolicyForPlan`
 * (`src/lib/subscription-resource-addons.ts`): SHARED buys `db.standard`,
 * DEDICATED buys `db.pro`; FREE/unknown can't buy a managed db addon.
 *
 * Distinct from {@link resourceAddonKeysForPlan} (the `db.starter` ESTIMATOR key
 * used to bundle databases into a plan-onboarding checkout) — this is the key
 * that passes the server's `assertResourceAddonsMatchPlan` for a standalone buy.
 */
export function dbAddonKeyForPlanFamily(
	planKey?: string | null,
): string | null {
	switch (planFamily(planKey)) {
		case "SHARED":
			return "db.standard";
		case "DEDICATED":
			return "db.pro";
		default:
			return null;
	}
}

export interface PlanResourceAddonKeys {
	dbAddonKey: string | null;
	storageAddonKey: string | null;
}

export function resourceAddonKeysForPlan(
	planKey?: string | null,
): PlanResourceAddonKeys {
	switch (planFamily(planKey)) {
		case "SHARED":
			return { dbAddonKey: "db.starter", storageAddonKey: "storage.gb" };
		case "DEDICATED":
			return { dbAddonKey: "db.pro", storageAddonKey: "storage.gb" };
		default:
			return { dbAddonKey: null, storageAddonKey: null };
	}
}

export interface PlanCartResources {
	/** Number of databases (→ `dbAddonKey` quantity). */
	databases?: number;
	/** Total object-storage GB (→ `storage.gb` quantity). */
	storageGb?: number;
}

export interface PlanAddonCartItem {
	addonKey: string;
	quantity: number;
}

/**
 * Translate desired resource counts into the bundled-addon cart. Zero-quantity
 * lines are dropped (the backend rejects an addon with quantity 0), so "app
 * only", "app + storage, no DB", and "app + DB, no storage" are all valid.
 */
export function buildPlanAddonCart(
	planKey: string | null | undefined,
	resources: PlanCartResources,
): PlanAddonCartItem[] {
	const { dbAddonKey, storageAddonKey } = resourceAddonKeysForPlan(planKey);
	const databases = Math.max(0, Math.floor(resources.databases ?? 0));
	const storageGb = Math.max(0, Math.floor(resources.storageGb ?? 0));

	const cart: PlanAddonCartItem[] = [];
	if (dbAddonKey && databases > 0) {
		cart.push({ addonKey: dbAddonKey, quantity: databases });
	}
	if (storageAddonKey && storageGb > 0) {
		cart.push({ addonKey: storageAddonKey, quantity: storageGb });
	}
	return cart;
}
