/**
 * Curated MCP tools for agent approval requests: approvals_list,
 * approvals_get. They wrap the platform's `approvals` router through
 * lib/approvals.
 *
 * When this server's API key calls a destructive procedure on an
 * operator-tier key, the call comes back as NEEDS_APPROVAL with an approval
 * id: it is parked until a human approves or denies it in the dashboard.
 * `approvals_get` is the poll target for that id. There is deliberately no
 * approve or deny tool: the platform refuses both to API keys, because an
 * agent must never approve its own request.
 *
 * Annotations: readOnlyHint on both.
 *
 * Note: the result sanitizer redacts any key containing "apiKey", so
 * `apiKeyId` reads as redacted here; `keyName` on list rows names the key.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	APPROVAL_STATUSES,
	DEFAULT_APPROVALS_LIMIT,
	getApproval,
	listApprovals,
	MAX_APPROVALS_LIMIT,
} from "../../lib/approvals.js";
import { withAuth } from "../runtime.js";

const STATUS_MEANINGS =
	'"pending" = waiting for a human; "approved" = approved and running now; "executed" = approved and performed; "failed" = approved but errored when it ran (see resultSummary); "denied" = a human refused it; "expired" = nobody decided within 24 hours.';

export function registerApprovalsTools(server: McpServer): void {
	server.registerTool(
		"approvals_list",
		{
			title: "List approval requests for agent actions",
			description: `Wraps approvals.list for the active organization: pending requests first, then recent decided ones, each with the requesting key's name. \`status\` filters the most recent requests the platform returns. ${STATUS_MEANINGS} A human approves or denies requests in the Tarout dashboard under Agent; this server cannot approve anything.`,
			inputSchema: {
				status: z
					.enum(APPROVAL_STATUSES)
					.optional()
					.describe("Only requests in this status."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_APPROVALS_LIMIT)
					.optional()
					.describe(`How many to return (default ${DEFAULT_APPROVALS_LIMIT}).`),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ status, limit }) =>
			withAuth(async (client) => {
				const approvals = await listApprovals(client, { status, limit });
				return { count: approvals.length, approvals };
			}),
	);

	server.registerTool(
		"approvals_get",
		{
			title: "One approval request by id (the NEEDS_APPROVAL poll target)",
			description: `Wraps approvals.get. Pass the approval id from a NEEDS_APPROVAL error (details.approvalId). Poll it every few seconds until the status is terminal: executed, failed, denied or expired. ${STATUS_MEANINGS} Do not retry the parked action while it is pending, and do not try to approve it yourself: only a human can, in the dashboard.`,
			inputSchema: {
				id: z
					.string()
					.min(1)
					.describe("Approval id (details.approvalId of the NEEDS_APPROVAL error)."),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ id }) =>
			withAuth(async (client) => {
				const approval = await getApproval(client, id);
				return { approval };
			}),
	);
}
