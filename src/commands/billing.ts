import { type Command, InvalidArgumentError } from "commander";
import { getApiClient } from "../lib/api.js";
import {
	type BillingChangeResult,
	emitBillingResult,
	finalizeBillingMutation,
	performBillingChange,
	pollCheckoutUntilTerminal,
	storageSlotTierForAddonKey,
} from "../lib/billing-upgrade.js";
import {
	paymentBrowserOpener,
	shouldAutoConfirmPaidCheckout,
} from "../lib/browser.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	buildPlanAddonCart,
	isPaidFamily,
	planFamily,
} from "../lib/plan-cart.js";
import {
	box,
	colors,
	isJsonMode,
	isNonInteractiveMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
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
function reportBillingResult(
	result: BillingChangeResult,
	label: string,
): void {
	const code = emitBillingResult(result, { label });
	if (code !== ExitCode.SUCCESS) exit(code);
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

				log("");
				log(colors.bold("Current Subscription"));
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
				let addons:
					| Array<{ addonKey: string; quantity: number }>
					| undefined =
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
					// Quantity-aware Starter: number of app slots → plan quantity.
					if (planQuantity === undefined && planFamily(targetPlan) === "SHARED") {
						const apps = parsePositiveInt(
							await input("How many apps (app slots)?", "1"),
							1,
						);
						planQuantity = Math.max(1, apps);
					}

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
					if (amountDueHalalas !== undefined) {
						log(
							`Amount due now: ${colors.bold(`${(amountDueHalalas / 100).toFixed(2)} SAR`)} ${colors.dim("(incl. 15% VAT for SA orgs at checkout)")}`,
						);
					}
					if (typeof preview?.newPeriodTotalHalalas === "number") {
						log(
							`New recurring total: ${(preview.newPeriodTotalHalalas / 100).toFixed(2)} SAR`,
						);
					}
					log("");

					// Agent path: a paid upgrade goes through StreamPay hosted
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
				if (typeof p?.totalProratedHalalas === "number") {
					log(
						`  Amount Due: ${colors.bold(`${(p.totalProratedHalalas / 100).toFixed(2)} SAR`)} ${colors.dim("(incl. 15% VAT for SA orgs at checkout)")}`,
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
					// StreamPay hosted checkout, which is the real consent surface. In
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

	// Confirm checkout
	billing
		.command("checkout:confirm")
		.argument("<session-id>", "Checkout session ID")
		.description("Confirm a pending checkout session")
		.action(async (sessionId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Confirming checkout...");
				const result = await client.subscription.confirmCheckout.mutate({
					sessionId,
				} as any);
				succeedSpinner("Checkout confirmed!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	// Get checkout session
	billing
		.command("checkout:get")
		.argument("<session-id>", "Checkout session ID")
		.description("Get details of a checkout session")
		.action(async (sessionId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching checkout...");
				const data = await client.payment.getCheckout.query({
					sessionId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) outputData(data);
				else {
					const d = data as any;
					log("");
					log(colors.bold("Checkout Session"));
					log(`  ID:     ${d.sessionId || sessionId}`);
					log(`  Status: ${d.status || "-"}`);
					log(
						`  Amount: ${d.amount !== undefined ? `${(d.amount / 100).toFixed(2)} SAR` : "-"}`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Submit card payment
	billing
		.command("checkout:pay")
		.argument("<session-id>", "Checkout session ID")
		.description("Submit card payment for a checkout session")
		.option("--card-number <n>", "Card number")
		.option("--exp-month <m>", "Expiry month")
		.option("--exp-year <y>", "Expiry year")
		.option("--cvv <cvv>", "CVV")
		.option("--name <name>", "Cardholder name")
		.action(async (sessionId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Processing payment...");
				const result = await client.payment.submitCardPayment.mutate({
					sessionId,
					cardNumber: options.cardNumber,
					expMonth: options.expMonth,
					expYear: options.expYear,
					cvv: options.cvv,
					cardholderName: options.name,
				} as any);
				succeedSpinner("Payment submitted!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	// Billing analytics — usage breakdown
	billing
		.command("usage")
		.description("Show resource usage breakdown")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching usage...");
				const data = await client.billing.getUsageBreakdown.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold("Usage Breakdown"));
				log(`  Apps:      ${d.apps ?? "-"}`);
				log(`  Databases: ${d.databases ?? "-"}`);
				log(`  Storage:   ${d.storage ?? "-"}`);
				log(`  Domains:   ${d.domains ?? "-"}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Detailed resource usage
	billing
		.command("resources")
		.description("Show detailed resource usage and costs")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching resource usage...");
				const data = await client.billing.getDetailedResourceUsage.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data)
					? data
					: (data as any)?.resources || [];
				if (!list.length) {
					log("\nNo active resources.\n");
					return;
				}
				log("");
				table(
					["TYPE", "NAME", "COST (SAR)"],
					list.map((r: any) => [
						r.type || "-",
						r.name || "-",
						r.cost !== undefined ? (r.cost / 100).toFixed(2) : "-",
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
		.option("--days <n>", "Number of days", "30")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching cost trend...");
				const data = await client.billing.getDailyCostTrend.query({
					days: Number.parseInt(options.days || "30"),
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data) ? data : (data as any)?.trend || [];
				if (!list.length) {
					log("\nNo cost data found.\n");
					return;
				}
				log("");
				log(colors.bold("Daily Cost Trend"));
				table(
					["DATE", "COST (SAR)"],
					list.map((d: any) => [
						d.date || "-",
						d.cost !== undefined ? (d.cost / 100).toFixed(2) : "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Resource estimate
	billing
		.command("estimate")
		.description("Estimate cost for a resource type")
		.option("--type <type>", "Resource type (app, database, storage, domain)")
		.option("--plan <plan>", "Plan key")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Calculating estimate...");
				const data = await client.billing.getResourceEstimate.query({
					resourceType: options.type,
					planKey: options.plan,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold("Resource Estimate"));
				log(
					`  Monthly: ${d.monthly !== undefined ? `${(d.monthly / 100).toFixed(2)} SAR` : "-"}`,
				);
				log(
					`  Hourly:  ${d.hourly !== undefined ? `${(d.hourly / 100).toFixed(4)} SAR` : "-"}`,
				);
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
}

/**
 * Commander `--addon <key[:qty]>` accumulator. Repeated flags push onto the
 * array; the optional `:qty` suffix is parsed as a positive integer
 * (defaults to 1). Used by `tarout billing upgrade` to forward bundled
 * addons into the same StreamPay checkout as the plan change.
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
		cancelled: colors.error("cancelled"),
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
