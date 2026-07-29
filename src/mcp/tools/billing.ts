/**
 * Curated MCP tools for billing: billing_status, billing_upgrade.
 *
 * billing_upgrade delegates to performBillingChange (lib/billing-upgrade.ts),
 * which is already exit-free and non-interactive. It always runs with
 * wait=false: over MCP there is no mid-call channel to hand the hosted
 * checkout URL to a human, so blocking on the checkout would just burn the
 * timeout and only then reveal the URL. A payment-bearing change returns
 * `status: "payment_required"` + `paymentUrl` immediately instead.
 *
 * Annotations:
 * - readOnlyHint on billing_status
 * - billing_upgrade mutates but isn't destructive (no hint) — a charge is
 *   consented to on the hosted checkout page, and a plan DOWNGRADE (which
 *   never reaches a checkout) is gated behind `confirmDowngrade: true`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	classifyPlanDirection,
	planKeyOf,
} from "../../commands/billing.js";
import { performBillingChange } from "../../lib/billing-upgrade.js";
import { errorResult, withAuth } from "../runtime.js";

export function registerBillingTools(server: McpServer): void {
	server.registerTool(
		"billing_status",
		{
			title: "Current subscription + usage summary",
			description:
				"Returns subscription.getCurrent + billing.getUsageBreakdown in one call.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const [subscription, usage] = await Promise.all([
					client.subscription.getCurrent.query(),
					client.billing.getUsageBreakdown.query({}).catch(() => null),
				]);
				return { subscription, usage };
			}),
	);

	server.registerTool(
		"billing_upgrade",
		{
			title: "Change plan / add addon / adjust quantity",
			description:
				"Provide `plan` (optionally with `planQuantity`), or `addon` (optionally with `quantity`), or `planQuantity` alone. A change that needs payment returns `status: \"payment_required\"` with a `paymentUrl` the user must open; confirm afterwards with `billing_status`. A plan downgrade requires `confirmDowngrade: true`.",
			inputSchema: {
				plan: z.string().optional(),
				addon: z.string().optional(),
				quantity: z.number().int().positive().optional(),
				planQuantity: z.number().int().positive().optional(),
				billingPeriod: z.enum(["monthly", "yearly"]).optional(),
				confirmDowngrade: z.boolean().optional().default(false),
			},
		},
		async ({
			plan,
			addon,
			quantity,
			planQuantity,
			billingPeriod,
			confirmDowngrade,
		}) => {
			if (plan !== undefined && addon !== undefined) {
				return errorResult({
					error: "Provide `plan` or `addon`, not both.",
					code: "INVALID_ARGUMENTS",
				});
			}
			if (
				plan === undefined &&
				addon === undefined &&
				planQuantity === undefined
			) {
				return errorResult({
					error: "Provide one of `plan`, `addon`, or `planQuantity`.",
					code: "INVALID_ARGUMENTS",
				});
			}
			if (quantity !== undefined && addon === undefined) {
				return errorResult({
					error:
						"`quantity` sets the addon unit count and requires `addon`; for plan seats use `planQuantity`.",
					code: "INVALID_ARGUMENTS",
				});
			}
			if (addon !== undefined && planQuantity !== undefined) {
				return errorResult({
					error: "`planQuantity` applies to plans; with `addon` use `quantity`.",
					code: "INVALID_ARGUMENTS",
				});
			}
			return withAuth(async (client) => {
				if (plan) {
					// Downgrades never reach the hosted checkout (they defer to the
					// period rollover with no charge), so the checkout page can't act
					// as the consent surface — mirror the CLI's explicit confirm.
					const [current, catalog] = await Promise.all([
						client.subscription.getCurrent.query().catch(() => null),
						client.subscription.getCatalog.query().catch(() => null),
					]);
					const currentKey = (current as { planKey?: string } | null)?.planKey;
					const plans =
						(catalog as { plans?: unknown[] } | null)?.plans ?? [];
					if (currentKey && plans.length > 0) {
						const known = plans.some(
							(p) => planKeyOf(p).toLowerCase() === plan.toLowerCase(),
						);
						// classifyPlanDirection throws on an unknown target; let the
						// server produce the authoritative error in that case.
						const direction = known
							? classifyPlanDirection(plans, currentKey, plan)
							: undefined;
						if (direction === "same") {
							return { status: "no_change", plan, hint: `Already on plan "${plan}".` };
						}
						if (direction === "downgrade" && !confirmDowngrade) {
							throw Object.assign(
								new Error(
									`Downgrading from "${currentKey}" to "${plan}" takes effect at the end of the current billing period; the remainder is not refunded.`,
								),
								{
									code: "NEEDS_INPUT",
									remediation:
										"Confirm with the user, then re-call `billing_upgrade` with `confirmDowngrade: true`.",
								},
							);
						}
					}
				}
				// biome-ignore lint/suspicious/noExplicitAny: PerformBillingChangeInput is a discriminated union we build dynamically.
				const input: any = {
					kind: plan ? "plan" : addon ? "addon" : "plan_quantity",
					wait: false,
				};
				if (plan) {
					input.planKey = plan;
					input.billingPeriod = billingPeriod;
					// PerformBillingChangeInput carries the plan-quantity under
					// `quantity`; the engine forwards it as `planQuantity` to
					// subscription.changePlan / setPlanQuantity.
					if (planQuantity !== undefined) input.quantity = planQuantity;
				} else if (addon) {
					input.addonKey = addon;
					input.quantity = quantity ?? 1;
				} else {
					input.quantity = planQuantity;
				}
				const result = await performBillingChange(client, input);
				if (result.status === "payment_required") {
					return {
						...result,
						hint: "Have the user open `paymentUrl` to complete payment, then call `billing_status` to confirm the change.",
					};
				}
				return result;
			});
		},
	);
}
