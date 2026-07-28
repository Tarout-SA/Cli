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
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

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
		.argument("<invoice-id>", "Invoice ID")
		.description("Pay an outstanding invoice now (org owner only)")
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
						? "Invoice already paid."
						: "Payment queued.",
				);
				if (isJsonMode()) outputData(res);
			} catch (err) {
				handleError(err);
			}
		});
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
