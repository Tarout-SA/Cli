/**
 * Curated MCP tools for application management: app_list, app_info, app_create,
 * app_logs, app_restart, app_stop, app_delete. All handlers route through
 * withAuth() and resolve the target application via resolveAppRef() so agents
 * can address apps by name OR id.
 *
 * `app_list` returns a trimmed shape (id / name / status / plan / url) —
 * agents should call `app_info` for the full application object. The `url`
 * field falls back through `deployedUrl → url → null`; when the server
 * payload uses a different field name this is null and the caller can
 * fetch the full object.
 *
 * Annotations:
 * - readOnlyHint on app_list / app_info / app_logs
 * - destructiveHint on app_stop / app_delete
 * - app_restart / app_create are mutating but non-destructive (no hint)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toAppNameSlug } from "../../lib/app-name.js";
import { getCurrentProfile } from "../../lib/config.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { errorResult, withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");

export function registerAppsTools(server: McpServer): void {
	server.registerTool(
		"app_list",
		{
			title: "List applications in the active organization",
			description: "Wraps application.allByOrganization; returns trimmed fields.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const all = (await client.application.allByOrganization.query()) as Array<
					Record<string, unknown>
				>;
				return {
					count: all.length,
					apps: all.map((a) => ({
						id: a.applicationId,
						name: a.name,
						status: a.status,
						plan: a.plan,
						url: a.deployedUrl ?? a.url ?? null,
					})),
				};
			}),
	);

	server.registerTool(
		"app_info",
		{
			title: "Full details for one application",
			description: "Resolves the app by name or id then calls application.one.",
			inputSchema: { app },
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const one = (await client.application.one.query({ applicationId })) as unknown;
				return { app: one };
			}),
	);

	server.registerTool(
		"app_create",
		{
			title: "Create a new application",
			description:
				"Creates an app in the active organization. Prefer the `deploy` tool for a full deploy-from-local-directory flow.",
			inputSchema: {
				name: z.string().min(1),
				description: z.string().optional(),
				plan: z.enum(["FREE", "SHARED", "DEDICATED"]).optional(),
			},
		},
		async ({ name, description, plan }) => {
			// application.create requires `appName` (slug) + `organizationId`; the
			// tRPC input schema does not inject them. Derive the slug the same way
			// the CLI command does and take the org from the active profile.
			const profile = getCurrentProfile();
			if (!profile) {
				return errorResult({
					error: "No CLI profile — cannot create an app without one.",
					code: "AUTH_ERROR",
					remediation:
						"Run `tarout login` on the machine running this MCP server.",
				});
			}
			return withAuth(async (client) => {
				const created = (await client.application.create.mutate({
					name,
					appName: toAppNameSlug(name),
					description,
					organizationId: profile.organizationId,
					plan,
				})) as unknown;
				return { created };
			});
		},
	);

	server.registerTool(
		"app_logs",
		{
			title: "Tail runtime logs for an application",
			description: "Wraps application.getApplicationLogs.",
			inputSchema: {
				app,
				lines: z.number().int().positive().max(1000).optional().default(200),
				level: z.enum(["debug", "info", "warn", "error"]).optional(),
				timeRange: z.enum(["5m", "15m", "1h", "24h"]).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, lines, level, timeRange }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const logs = (await client.application.getApplicationLogs.query({
					applicationId,
					lines,
					level,
					timeRange,
				})) as unknown;
				return logs;
			}),
	);

	server.registerTool(
		"app_restart",
		{
			title: "Restart an application",
			description: "Wraps application.restart.",
			inputSchema: { app },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const result = (await client.application.restart.mutate({ applicationId })) as unknown;
				return { restarted: true, result };
			}),
	);

	server.registerTool(
		"app_stop",
		{
			title: "Stop an application",
			description: "Wraps application.stop.",
			inputSchema: { app },
			annotations: { destructiveHint: true },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const result = (await client.application.stop.mutate({ applicationId })) as unknown;
				return { stopped: true, result };
			}),
	);

	server.registerTool(
		"app_delete",
		{
			title: "Delete an application (irreversible)",
			description: "Wraps application.delete.",
			inputSchema: { app },
			annotations: { destructiveHint: true },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const result = (await client.application.delete.mutate({ applicationId })) as unknown;
				return { deleted: true, applicationId, name, result };
			}),
	);
}
