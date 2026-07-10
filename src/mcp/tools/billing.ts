/**
 * Curated MCP tools for billing: billing_status, billing_upgrade.
 *
 * billing_upgrade delegates to performBillingChange (lib/billing-upgrade.ts),
 * which is already exit-free and non-interactive — hosted-checkout polling is
 * driven by the `wait`/`timeoutMs` inputs and returns a typed classification.
 *
 * Annotations:
 * - readOnlyHint on billing_status
 * - billing_upgrade mutates but isn't destructive (no hint) — payment happens
 *   in the hosted checkout the user completes in a browser.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { performBillingChange } from "../../lib/billing-upgrade.js";
import { withAuth } from "../runtime.js";

export function registerBillingTools(server: McpServer): void {
	server.registerTool(
		"billing_status",
		{
			title: "Current subscription + usage summary",
			description:
				"Returns subscription.getCurrent + subscription.getUsage in one call.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const [subscription, usage] = await Promise.all([
					client.subscription.getCurrent.query(),
					client.subscription.getUsage.query().catch(() => null),
				]);
				return { subscription, usage };
			}),
	);

	server.registerTool(
		"billing_upgrade",
		{
			title: "Upgrade / add addon / adjust quantity",
			description:
				"Delegates to performBillingChange. Provide exactly one of {plan}, {addon}, {planQuantity}. When wait=true, polls hosted checkout to a terminal status.",
			inputSchema: {
				plan: z.string().optional(),
				addon: z.string().optional(),
				quantity: z.number().int().positive().optional(),
				planQuantity: z.number().int().positive().optional(),
				billingPeriod: z.enum(["MONTHLY", "YEARLY"]).optional(),
				wait: z.boolean().optional().default(true),
				timeoutSeconds: z
					.number()
					.int()
					.positive()
					.max(3600)
					.optional()
					.default(600),
			},
		},
		async ({
			plan,
			addon,
			quantity,
			planQuantity,
			billingPeriod,
			wait,
			timeoutSeconds,
		}) =>
			withAuth(async (client) => {
				const kind = plan ? "plan" : addon ? "addon" : "plan_quantity";
				// biome-ignore lint/suspicious/noExplicitAny: PerformBillingChangeInput is a discriminated union we build dynamically.
				const input: any = {
					kind,
					wait,
					timeoutMs: timeoutSeconds * 1000,
				};
				if (plan) {
					input.planKey = plan;
					input.billingPeriod = billingPeriod;
				}
				if (addon) {
					input.addonKey = addon;
					input.quantity = quantity ?? 1;
				}
				if (planQuantity !== undefined) {
					input.planQuantity = planQuantity;
				}
				const result = await performBillingChange(client, input);
				return result;
			}),
	);
}
