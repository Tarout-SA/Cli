/**
 * Maps a failed entitlement key (from a server-side `assertEntitlement`
 * FORBIDDEN error) to the *concrete* billing action that unblocks it — so an
 * agent is told the exact next command instead of guessing.
 *
 * The key insight the old `inferSuggestedPlan` got wrong: not every gate is
 * resolved by a plan switch.
 *   - `app.shared.slots`        → bump the quantity-aware Starter plan
 *   - `app.dedicated.slots`/host → upgrade to a (bigger) dedicated plan
 *   - `db.*` / `storage.*` slots → buy a resource addon
 *   - `app.free.slots` / none    → upgrade Free → a paid plan
 *
 * Resolution is catalog-driven where possible (find the plan/addon whose
 * `grants` include the failed key), with deterministic prefix fallbacks so it
 * still produces a sensible command when the catalog can't be fetched.
 *
 * Plan-upgrade targets follow the org's CURRENT plan family — free → shared,
 * shared → dedicated_small, dedicated_small → _medium → _large — so the
 * "upgrade the plan" path always moves *up* a tier. (`requestedPlan`, the plan
 * the user asked to deploy as, is only a fallback when the current plan is
 * unknown.)
 */

import { planFamily } from "./plan-cart.js";

export type RemedyKind = "plan" | "addon" | "plan_quantity";

export interface CatalogGrant {
	entitlementKey: string;
	quantity: number;
}

export interface CatalogPlan {
	key?: string;
	planKey?: string;
	name?: string;
	priceHalalas?: number;
	quantityAware?: boolean;
	minQuantity?: number;
	maxQuantity?: number;
	sortOrder?: number;
	grants?: CatalogGrant[];
}

export interface CatalogAddon {
	key?: string;
	addonKey?: string;
	name?: string;
	priceHalalas?: number;
	grants?: CatalogGrant[];
}

export interface Catalog {
	plans?: CatalogPlan[];
	addons?: CatalogAddon[];
}

export interface EntitlementRemedy {
	kind: RemedyKind;
	/** The entitlement key that was exhausted, if known. */
	failedKey?: string;
	/** Plan key, addon key, or the quantity-aware plan key for a quantity bump. */
	targetKey: string;
	targetName?: string;
	priceHalalas?: number;
	/** The exact CLI command an agent should run to resolve the gate. */
	command: string;
	hint: string;
}

const planKeyOf = (p: CatalogPlan): string => p.planKey ?? p.key ?? "";
const addonKeyOf = (a: CatalogAddon): string => a.addonKey ?? a.key ?? "";

/**
 * Best-effort next paid tier. Mirrors the historical `inferSuggestedPlan`
 * behavior so existing callers/tests keep the same suggestions.
 */
export function nextPlanForRequested(requested?: string): string {
	const r = (requested ?? "free").trim().toLowerCase();
	if (!r || r === "free") return "shared";
	if (r === "shared") return "shared";
	if (r === "dedicated" || r === "dedicated_small") return "dedicated_small";
	if (r === "dedicated_medium") return "dedicated_medium";
	if (r === "dedicated_large") return "dedicated_large";
	return r;
}

/**
 * The next tier *up* from the org's CURRENT plan — this is the "upgrade the
 * plan" ladder the user asked for:
 *   free / none    → shared (Starter)
 *   shared family  → dedicated_small (Pro Small)
 *   dedicated_small → dedicated_medium
 *   dedicated_medium → dedicated_large
 *   dedicated_large → dedicated_large (already the top tier)
 * Unlike {@link nextPlanForRequested} (which never escalates shared → dedicated)
 * this always moves up so the upgrade option is a real change.
 */
export function nextPlanForCurrent(currentPlanKey?: string): string {
	const family = planFamily(currentPlanKey);
	if (family === "SHARED") return "dedicated_small";
	if (family === "DEDICATED") {
		const k = (currentPlanKey ?? "").trim().toLowerCase();
		if (k === "dedicated_large") return "dedicated_large";
		if (k === "dedicated_medium") return "dedicated_large";
		// bare "dedicated" or "dedicated_small"
		return "dedicated_medium";
	}
	// FREE / unknown → first paid tier.
	return "shared";
}

/**
 * The plan key the "upgrade the plan" option should target. Prefer the
 * current-plan ladder when the caller knows the org's plan; otherwise fall back
 * to the requested-plan heuristic (keeps behavior stable for callers/tests that
 * don't pass `currentPlanKey`).
 */
export function upgradeTargetPlan(opts?: {
	currentPlanKey?: string;
	requestedPlan?: string;
}): string {
	if (opts?.currentPlanKey) return nextPlanForCurrent(opts.currentPlanKey);
	return nextPlanForRequested(opts?.requestedPlan);
}

export function resolveEntitlementRemedy(
	failedKey: string | undefined,
	catalog: Catalog | null,
	opts?: {
		requestedPlan?: string;
		currentPlanKey?: string;
		currentSharedQuantity?: number;
	},
): EntitlementRemedy {
	const plans = catalog?.plans ?? [];
	const addons = catalog?.addons ?? [];

	// app.shared.slots → quantity bump on the quantity-aware Starter plan.
	if (failedKey?.startsWith("app.shared")) {
		const sharedPlan = plans.find((p) => p.quantityAware);
		const targetKey = sharedPlan ? planKeyOf(sharedPlan) : "shared";
		const next = (opts?.currentSharedQuantity ?? 1) + 1;
		return {
			kind: "plan_quantity",
			failedKey,
			targetKey,
			targetName: sharedPlan?.name,
			priceHalalas: sharedPlan?.priceHalalas,
			command: `tarout billing plan:quantity ${next} --wait`,
			hint: `Your ${sharedPlan?.name ?? "Starter"} plan is quantity-aware — add an app slot by raising the plan quantity to ${next}.`,
		};
	}

	// app.dedicated.slots / host.* → (bigger) dedicated plan.
	if (
		failedKey?.startsWith("app.dedicated") ||
		failedKey?.startsWith("host.")
	) {
		const requested = opts?.requestedPlan;
		// On a dedicated plan already → escalate to the next dedicated tier.
		// Otherwise honor an explicit dedicated request, else the smallest Pro.
		const target =
			planFamily(opts?.currentPlanKey) === "DEDICATED"
				? nextPlanForCurrent(opts?.currentPlanKey)
				: requested && requested.toLowerCase().startsWith("dedicated")
					? nextPlanForRequested(requested)
					: "dedicated_small";
		const plan = plans.find((p) => planKeyOf(p) === target);
		return {
			kind: "plan",
			failedKey,
			targetKey: target,
			targetName: plan?.name,
			priceHalalas: plan?.priceHalalas,
			command: `tarout billing upgrade ${target} --wait`,
			hint: `A dedicated host slot is required — upgrade to ${plan?.name ?? target}.`,
		};
	}

	// Free-tier resource slots (`db.free.slots`, `storage.free.slots`) are
	// capped by the free plan's single grant — NO addon grants them, so the
	// generic `db.`/`storage.` branch below would wrongly suggest a dead-end
	// `addon:buy db.free`. The only ways to get another are to free the existing
	// one or move to a paid plan (which unlocks the paid resource addons).
	if (failedKey === "db.free.slots" || failedKey === "storage.free.slots") {
		const target = upgradeTargetPlan(opts);
		const plan = plans.find((p) => planKeyOf(p) === target);
		const resource =
			failedKey === "db.free.slots" ? "database" : "storage bucket";
		return {
			kind: "plan",
			failedKey,
			targetKey: target,
			targetName: plan?.name,
			priceHalalas: plan?.priceHalalas,
			command: `tarout billing upgrade ${target} --wait`,
			hint: `The free plan includes a single ${resource} for the whole org — delete the existing free ${resource}, or upgrade to ${plan?.name ?? target} to add more.`,
		};
	}

	// db.* / storage.* / domain.* / email_service.* → resource addon.
	if (
		failedKey?.startsWith("db.") ||
		failedKey?.startsWith("storage.") ||
		failedKey?.startsWith("domain") ||
		failedKey?.startsWith("email")
	) {
		const matched =
			addons.find((a) =>
				a.grants?.some((g) => g.entitlementKey === failedKey),
			) ??
			addons.find((a) => addonKeyOf(a) === failedKey.replace(/\.slots$/, ""));
		const targetKey = matched
			? addonKeyOf(matched)
			: failedKey.replace(/\.slots$/, "");
		return {
			kind: "addon",
			failedKey,
			targetKey,
			targetName: matched?.name,
			priceHalalas: matched?.priceHalalas,
			command: `tarout billing addon:buy ${targetKey} --wait`,
			hint: `Add a ${matched?.name ?? targetKey} slot with an addon purchase.`,
		};
	}

	// app.free.slots, "no active subscription", or unmatched → plan upgrade.
	const target = upgradeTargetPlan(opts);
	const plan = plans.find((p) => planKeyOf(p) === target);
	return {
		kind: "plan",
		failedKey,
		targetKey: target,
		targetName: plan?.name,
		priceHalalas: plan?.priceHalalas,
		command: `tarout billing upgrade ${target} --wait`,
		hint: `Upgrade to a paid plan (${plan?.name ?? target}) to continue.`,
	};
}
