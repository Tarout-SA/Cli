/**
 * Curated MCP tools for application management: app_list, app_info, app_create,
 * app_logs, app_restart, app_stop, app_delete. All handlers route through
 * withAuth() and resolve the target application via resolveAppRef() so agents
 * can address apps by name OR id.
 *
 * `app_list` returns a trimmed shape (id / name / status / plan / url /
 * lastDeployment); agents should call `app_info` for the full application
 * object. `status` is the router's `applicationStatus` and `url` is its
 * `liveUrl` (custom domain, else the platform subdomain) as an https URL, or
 * null when the app has never been deployed.
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
import { formatAppUrl } from "../../utils/url.js";
import { errorResult, withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");

export function registerAppsTools(server: McpServer): void {
	server.registerTool(
		"app_list",
		{
			title: "List applications in the active organization",
			description:
				"Wraps application.allByOrganization; returns id, name, status (applicationStatus), plan, url (live URL or null when never deployed) and lastDeployment.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const all =
					(await client.application.allByOrganization.query()) as Array<
						Record<string, unknown>
					>;
				return {
					count: all.length,
					apps: all.map((a) => ({
						id: a.applicationId,
						name: a.name,
						status: a.applicationStatus ?? null,
						plan: a.plan ?? null,
						url: formatAppUrl(
							typeof a.liveUrl === "string" ? a.liveUrl : null,
						),
						lastDeployment: a.lastDeployment ?? null,
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
				const one = (await client.application.one.query({
					applicationId,
				})) as unknown;
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
				lines: z.number().int().min(10).max(5000).optional().default(500),
				level: z
					.enum(["ALL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE", "UNKNOWN"])
					.optional()
					.default("ALL"),
				timeRange: z
					.enum(["1h", "6h", "24h", "7d", "all"])
					.optional()
					.default("all"),
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
				const result = (await client.application.restart.mutate({
					applicationId,
				})) as unknown;
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
				const result = (await client.application.stop.mutate({
					applicationId,
				})) as unknown;
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
				const result = (await client.application.delete.mutate({
					applicationId,
				})) as unknown;
				return { deleted: true, applicationId, name, result };
			}),
	);
}
