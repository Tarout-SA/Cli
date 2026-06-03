import { type Command, InvalidArgumentError } from "commander";
import open from "open";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, select } from "../utils/prompts.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

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
			"-w, --wait",
			"After hosted-checkout opens, poll status until the payment is confirmed",
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
				const addons:
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

				// Preview the change
				const _previewSpinner = startSpinner("Calculating change...");
				let preview: any;
				try {
					preview = await client.subscription.previewPlanChange.query({
						planKey: targetPlan,
						planQuantity: options.quantity,
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
					if (options.quantity) log(`Quantity: ${options.quantity}`);
					if (billingPeriod) log(`Billing period: ${billingPeriod}`);
					if (addons && addons.length > 0) {
						log(
							`Addons: ${addons
								.map((a) => `${a.addonKey}×${a.quantity}`)
								.join(", ")}`,
						);
					}
					if (preview?.amountDue !== undefined) {
						log(
							`Amount due now: ${colors.bold(`${(preview.amountDue / 100).toFixed(2)} SAR`)}`,
						);
					}
					log("");

					const confirmed = await confirm(
						`Switch to plan "${targetPlan}"?`,
						false,
						{
							field: "confirm_upgrade",
							flag: "--yes",
							context: {
								plan: targetPlan,
								quantity: options.quantity,
								billingPeriod,
								addons,
								amountDueHalalas: preview?.amountDue,
							},
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _changeSpinner = startSpinner("Changing plan...");

				const result = await client.subscription.changePlan.mutate({
					planKey: targetPlan,
					planQuantity: options.quantity,
					billingPeriod,
					addons,
				});

				succeedSpinner("Plan changed!");

				// Three outcomes:
				//  (a) applied: true  — free upgrade or stored payment method;
				//      entitlements are already updated, nothing more to do.
				//  (b) applied: false + paymentUrl/orderId — user must finish
				//      checkout in the browser. If --wait, we open and poll.
				//  (c) applied: false + no paymentUrl — downgrade staged for
				//      period rollover; nothing to wait on.
				if (result?.applied) {
					if (isJsonMode()) {
						outputData({ ...result, status: "applied" });
					} else {
						box("Plan Changed", [
							`Plan: ${colors.cyan(targetPlan)}`,
							colors.success("Applied immediately"),
						]);
					}
					return;
				}

				if (!result?.paymentUrl || !result?.orderId) {
					if (isJsonMode()) {
						outputData({ ...result, status: "deferred" });
					} else {
						box("Plan Change Staged", [
							`Plan: ${colors.cyan(targetPlan)}`,
							"Will apply at the end of the current billing period.",
						]);
					}
					return;
				}

				const orderId: string = result.orderId;
				const paymentUrl: string = result.paymentUrl;

				if (!options.wait) {
					if (isJsonMode()) {
						outputData({
							...result,
							status: "payment_required",
							hint: "Re-run with --wait to poll until checkout completes, or call `tarout billing confirm <orderId>` after the browser flow.",
						});
					} else {
						box("Payment Required", [
							`Plan: ${colors.cyan(targetPlan)}`,
							`Open: ${colors.cyan(paymentUrl)}`,
							`Order ID: ${colors.dim(orderId)}`,
							`Then: ${colors.dim(`tarout billing confirm ${orderId.slice(0, 8)}`)} or rerun upgrade with --wait`,
						]);
					}
					return;
				}

				// --wait path: open the browser, poll the order until it
				// resolves. The success/failure URLs the platform set on the
				// checkout fire confirmCheckout/markCheckoutFailed when the
				// user lands on them, which flips status. Mock mode (set on
				// the server) returns the success URL immediately as the
				// "payment URL"; opening it flips status too.
				if (options.open !== false) {
					try {
						await open(paymentUrl);
					} catch {
						// Headless / no-display — surface the URL via stdout
						// below and rely on the user to open it manually.
					}
				}
				if (isJsonMode()) {
					outputJsonLine({
						type: "event",
						event: "checkout_started",
						orderId,
						paymentUrl,
					});
				} else {
					log("");
					log(`Open this URL to complete payment:`);
					log(`  ${colors.cyan(paymentUrl)}`);
					log(`Order ID: ${colors.dim(orderId)}`);
					log(`Polling for confirmation (up to ${options.timeout}s)...`);
				}

				const final = await pollCheckoutUntilTerminal(client, orderId, {
					timeoutMs: options.timeout * 1000,
					intervalMs: 4000,
				});

				if (final.status === "PAID") {
					if (isJsonMode()) {
						outputData({
							applied: true,
							orderId,
							status: "paid",
							paidAt: final.paidAt,
						});
					} else {
						box("Payment Confirmed", [
							`Plan: ${colors.cyan(targetPlan)}`,
							colors.success("Subscription is active. Retry your last action."),
						]);
					}
					return;
				}

				if (final.status === "FAILED" || final.status === "EXPIRED") {
					outputError(
						final.status === "EXPIRED"
							? "CHECKOUT_EXPIRED"
							: "CHECKOUT_FAILED",
						final.failureReason ?? `Checkout ${final.status.toLowerCase()}`,
						{ orderId, status: final.status, failedAt: final.failedAt },
					);
					if (!isJsonMode()) {
						box("Payment Failed", [
							`Order ID: ${colors.dim(orderId)}`,
							`Reason: ${final.failureReason ?? final.status}`,
						]);
					}
					exit(ExitCode.GENERAL_ERROR);
					return;
				}

				// timeout still PENDING
				outputError(
					"CHECKOUT_TIMEOUT",
					`Checkout still PENDING after ${options.timeout}s; the agent should keep polling or surface the URL.`,
					{ orderId, status: final.status, paymentUrl },
				);
				if (!isJsonMode()) {
					box("Still Waiting", [
						`Order ID: ${colors.dim(orderId)}`,
						`Run: ${colors.dim(`tarout billing wait ${orderId.slice(0, 8)} --timeout 600`)}`,
					]);
				}
				exit(ExitCode.GENERAL_ERROR);
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
				if (isJsonMode()) {
					outputData(result);
				} else {
					box("Confirmed", [
						`Order ID: ${colors.dim(orderId)}`,
						colors.success("Subscription is active."),
					]);
				}
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
				if (final.status === "PAID") {
					if (isJsonMode()) {
						outputData({ orderId, status: "paid", paidAt: final.paidAt });
					} else {
						box("Confirmed", [
							`Order ID: ${colors.dim(orderId)}`,
							colors.success("Payment confirmed."),
						]);
					}
					return;
				}
				if (final.status === "PENDING") {
					outputError("CHECKOUT_TIMEOUT", "Still pending after timeout", {
						orderId,
					});
					exit(ExitCode.GENERAL_ERROR);
					return;
				}
				outputError(
					final.status === "EXPIRED"
						? "CHECKOUT_EXPIRED"
						: "CHECKOUT_FAILED",
					final.failureReason ?? `Checkout ${final.status.toLowerCase()}`,
					{ orderId, status: final.status },
				);
				exit(ExitCode.GENERAL_ERROR);
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
		.description("Purchase an addon slot")
		.action(async (addonKey, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const quantity = options.quantity || 1;

				if (!shouldSkipConfirmation()) {
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
							context: { addonKey, quantity },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Adding addon...");

				const result = await client.subscription.addAddon.mutate({
					addonKey,
					quantity,
				});

				succeedSpinner("Addon added!");

				if (isJsonMode()) {
					outputData(result);
				} else {
					box("Addon Added", [
						`Addon: ${colors.cyan(addonKey)}`,
						`Quantity: ${quantity}`,
						result?.paymentUrl
							? `Payment: ${colors.cyan(result.paymentUrl)}`
							: colors.success("Applied immediately"),
					]);
				}
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

	// Set plan quantity
	billing
		.command("plan:quantity")
		.argument("<quantity>", "New plan quantity", Number.parseInt)
		.description("Set quantity for a multi-slot plan")
		.action(async (quantity) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Updating plan quantity...");
				const result = await client.subscription.setPlanQuantity.mutate({
					quantity,
				} as any);
				succeedSpinner("Plan quantity updated!");
				if (isJsonMode()) outputData(result);
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
					addons: [{ addonKey, quantity: options.quantity || 1 }],
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(preview);
					return;
				}
				const p = preview as any;
				log("");
				log(colors.bold("Addon Purchase Preview"));
				log(`  Addon:      ${colors.cyan(addonKey)}`);
				log(`  Quantity:   ${options.quantity || 1}`);
				if (p.amountDue !== undefined) {
					log(
						`  Amount Due: ${colors.bold(`${(p.amountDue / 100).toFixed(2)} SAR`)}`,
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Purchase addons
	billing
		.command("addon:buy")
		.argument("<addon>", "Addon key")
		.option("-q, --quantity <n>", "Quantity", Number.parseInt)
		.description("Purchase addon slots")
		.action(async (addonKey, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const quantity = options.quantity || 1;
				if (!shouldSkipConfirmation()) {
					log(`\nPurchase ${quantity}× ${colors.cyan(addonKey)}?`);
					const confirmed = await confirm("Proceed?", false, {
						field: "confirm_addon_buy",
						flag: "--yes",
						context: { addonKey, quantity },
					});
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Purchasing addon...");
				const result = await client.subscription.purchaseAddons.mutate({
					addons: [{ addonKey, quantity }],
				} as any);
				succeedSpinner("Addon purchased!");
				if (isJsonMode()) outputData(result);
				else if ((result as any)?.paymentUrl) {
					log(
						`\nPayment required: ${colors.cyan((result as any).paymentUrl)}\n`,
					);
				}
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
 * Poll `subscription.pollCheckoutStatus` every `intervalMs` until the
 * checkout reaches a terminal status (PAID/FAILED/EXPIRED) or `timeoutMs`
 * elapses. Emits one JSON event line per status read when --json is on,
 * so an external agent can show progress without buffering.
 */
export async function pollCheckoutUntilTerminal(
	client: any,
	orderId: string,
	opts: { timeoutMs: number; intervalMs: number },
): Promise<{
	status: "PENDING" | "PAID" | "FAILED" | "EXPIRED";
	paidAt: Date | null;
	failedAt: Date | null;
	failureReason: string | null;
}> {
	const deadline = Date.now() + opts.timeoutMs;
	let lastStatus = "";
	while (Date.now() < deadline) {
		const r = await client.subscription.pollCheckoutStatus.query({ orderId });
		if (r.status !== lastStatus) {
			if (isJsonMode()) {
				outputJsonLine({
					type: "event",
					event: "checkout_status",
					orderId,
					status: r.status,
				});
			}
			lastStatus = r.status;
		}
		if (r.status !== "PENDING") {
			return {
				status: r.status,
				paidAt: r.paidAt,
				failedAt: r.failedAt,
				failureReason: r.failureReason,
			};
		}
		await new Promise((res) => setTimeout(res, opts.intervalMs));
	}
	// Timeout — return last seen status (PENDING).
	const r = await client.subscription.pollCheckoutStatus.query({ orderId });
	return {
		status: r.status,
		paidAt: r.paidAt,
		failedAt: r.failedAt,
		failureReason: r.failureReason,
	};
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
