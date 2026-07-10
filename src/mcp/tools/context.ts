/**
 * Curated MCP tools for identity / context: context_status, context_switch,
 * link_app, unlink_app. Handlers route through withAuth() and never touch
 * stdout / process.exit / CLI prompt helpers.
 *
 * `link_app` writes .tarout/project.json in the given directory so future
 * deploy/env tools can infer the target when no `app` argument is passed.
 * `context_switch` performs a partial update: it only mutates the org /
 * project / environment fields the caller supplied.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	getProjectConfig,
	isProjectLinked,
	removeProjectConfig,
	setProjectConfig,
} from "../../lib/config.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

const path = z.string().optional().describe("Directory (defaults to cwd).");

export function registerContextTools(server: McpServer): void {
	server.registerTool(
		"context_status",
		{
			title: "Current org / project / env + link info",
			description:
				"Returns the whoami identity, the active organization / project / environment, and whether the given directory is linked to an app via .tarout/project.json.",
			inputSchema: { path },
			annotations: { readOnlyHint: true },
		},
		async ({ path: dir }) =>
			withAuth(async (client) => {
				const cwd = dir ?? process.cwd();
				const [user, project, environment] = await Promise.all([
					client.user.get.query(),
					// getActive endpoints throw when nothing is set — treat as null so
					// status can still report identity + link info.
					client.project.getActive.query().catch(() => null),
					client.environment.getActive.query().catch(() => null),
				]);
				const link = isProjectLinked(cwd)
					? { linked: true, ...getProjectConfig(cwd) }
					: { linked: false };
				return { user, project, environment, link, cwd };
			}),
	);

	server.registerTool(
		"context_switch",
		{
			title: "Switch active organization / project / environment",
			description:
				"Any subset of the three can be provided (id, slug, or name). Only the fields you supply are changed.",
			inputSchema: {
				organization: z.string().optional(),
				project: z.string().optional(),
				environment: z.string().optional(),
			},
		},
		async ({ organization, project, environment }) =>
			withAuth(async (client) => {
				const changes: Record<string, unknown> = {};
				if (organization) {
					const orgs = (await client.organization.all.query()) as Array<{
						organizationId: string;
						name: string;
					}>;
					const match = orgs.find(
						(o) =>
							o.organizationId === organization || o.name === organization,
					);
					if (!match) throw new Error(`Unknown organization: ${organization}`);
					await client.organization.setActive.mutate({
						organizationId: match.organizationId,
					});
					changes.organization = match;
				}
				if (project) {
					const projs = (await client.project.all.query()) as Array<{
						id: string;
						slug?: string;
						name?: string;
					}>;
					const match = projs.find(
						(p) =>
							p.id === project || p.slug === project || p.name === project,
					);
					if (!match) throw new Error(`Unknown project: ${project}`);
					await client.project.setActive.mutate({ projectId: match.id });
					changes.project = match;
				}
				if (environment) {
					await client.environment.setActive.mutate({
						environmentId: environment,
					});
					changes.environment = { id: environment };
				}
				return changes;
			}),
	);

	server.registerTool(
		"link_app",
		{
			title: "Link a directory to an app",
			description:
				"Writes .tarout/project.json in the given directory so future deploy / env tools can infer the target when no `app` argument is passed.",
			inputSchema: { app: z.string(), path },
		},
		async ({ app: appRef, path: dir }) =>
			withAuth(async (client) => {
				const cwd = dir ?? process.cwd();
				const { applicationId, name } = await resolveAppRef(client, appRef);
				// resolveAppRef only surfaces { applicationId, name }; re-query to pick
				// up organizationId, which ProjectConfig requires.
				const apps = (await client.application.allByOrganization.query()) as Array<{
					applicationId: string;
					name: string;
					organizationId?: string;
				}>;
				const full = apps.find((a) => a.applicationId === applicationId);
				setProjectConfig(
					{
						applicationId,
						name,
						organizationId: full?.organizationId ?? "",
						linkedAt: new Date().toISOString(),
					},
					cwd,
				);
				return { linked: true, applicationId, name, cwd };
			}),
	);

	server.registerTool(
		"unlink_app",
		{
			title: "Remove a directory's link",
			description:
				"Deletes .tarout/project.json in the given directory. Only untracks the local link — does not touch the remote app.",
			inputSchema: { path },
		},
		async ({ path: dir }) =>
			withAuth(async () => {
				const cwd = dir ?? process.cwd();
				removeProjectConfig(cwd);
				return { unlinked: true, cwd };
			}),
	);
}
