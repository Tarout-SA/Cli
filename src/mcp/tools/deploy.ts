/**
 * Curated MCP tools for the deploy pipeline.
 *
 * This module currently exposes the two read-only inspection tools:
 * - `deployment_status`: latest deployment for an app OR a specific deployment.
 * - `deployment_logs`: build + runtime logs for a specific deployment.
 *
 * The mutating `deploy` tool is intentionally added in a later task; keeping
 * the read-only tools separate lets them ship early and get exercised by
 * agents while the deploy surface is finalized.
 *
 * Handler policy (from src/mcp/runtime.ts): no process.exit, no CLI output
 * helpers. `withAuth` handles auth checks + error → envelope mapping.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAppRef } from "../../lib/env-core.js";
import { errorResult, withAuth } from "../runtime.js";

export function registerDeployTools(server: McpServer): void {
	server.registerTool(
		"deployment_status",
		{
			title: "Current deployment status of an app or a specific deployment",
			description:
				"Provide `deploymentId` for a specific deployment, or `app` (name/id) for the app's latest. `deploymentId` wins if both are provided.",
			inputSchema: {
				app: z.string().optional(),
				deploymentId: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, deploymentId }) => {
			if (!deploymentId && !appRef) {
				return errorResult({
					error: "Provide either `deploymentId` or `app`.",
					code: "INVALID_ARGUMENTS",
				});
			}
			return withAuth(async (client) => {
				if (deploymentId) {
					const one = (await client.deployment.one.query({
						deploymentId,
					})) as unknown;
					return one;
				}
				// appRef is defined here because the pre-check above rejected the
				// case where both are missing.
				const { applicationId, name } = await resolveAppRef(
					client,
					appRef as string,
				);
				const status = (await client.application.getDeploymentStatus.query({
					applicationId,
				})) as Record<string, unknown>;
				return { app: { applicationId, name }, ...status };
			});
		},
	);

	server.registerTool(
		"deployment_logs",
		{
			title: "Build + runtime logs for a deployment",
			description:
				"Wraps deployment.getDeploymentLogs. Pass `offset` to paginate through longer log streams.",
			inputSchema: {
				deploymentId: z.string(),
				offset: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(2000).optional().default(500),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ deploymentId, offset, limit }) =>
			withAuth(async (client) => {
				const logs = (await client.deployment.getDeploymentLogs.query({
					deploymentId,
					offset,
					limit,
				})) as unknown;
				return logs;
			}),
	);
}
