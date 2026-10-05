/**
 * Curated MCP tool: referral_status - the user's referral code, link, funnel
 * and compute-credit earnings, plus recent per-payment credit history.
 * Read-only; minting the code on first call is idempotent.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withAuth } from "../runtime.js";

export function registerReferralTools(server: McpServer): void {
	server.registerTool(
		"referral_status",
		{
			title: "Referral code, link and earnings",
			description:
				"Returns referral.getMyCode + referral.getPartnerSummary (clicks, sign-ups, paying customers, credit pending/available in halalas, program terms) and the most recent credits from referral.listCredits. Credit is compute-only (no cash value).",
			inputSchema: {
				historyLimit: z.number().int().min(0).max(200).optional().default(20),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ historyLimit }) =>
			withAuth(async (client) => {
				const [code, summary, history] = await Promise.all([
					client.referral.getMyCode.query(),
					client.referral.getPartnerSummary.query(),
					historyLimit > 0
						? client.referral.listCredits.query({ limit: historyLimit })
						: Promise.resolve([]),
				]);
				return { ...code, summary, history };
			}),
	);
}
