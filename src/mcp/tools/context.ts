/**
 * Curated MCP tools for identity / context: context_status, context_switch,
 * link_app, unlink_app. Handlers route through withAuth() and never touch
 * stdout / process.exit / CLI prompt helpers.
 *
 * `link_app` writes .tarout/project.json in the given directory so future
 * deploy/env tools can infer the target when no `app` argument is passed.
 * `context_switch` performs a partial update: it only mutates the org /
 * project fields the caller supplied.
 *
 * There is deliberately no "environment" dimension here: the platform has no
 * environment model and no `environment` router, so any such call fails at
 * runtime. Don't re-add it without a server-side router to back it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyProjectCredentialScope } from "../../commands/projects.js";
import {
	getCurrentProfile,
	getProjectConfig,
	isProjectLinked,
	removeProjectConfig,
	setProjectConfig,
	updateProfile,
} from "../../lib/config.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { NotFoundError } from "../../lib/errors.js";
import { withAuth } from "../runtime.js";

const path = z.string().optional().describe("Directory (defaults to cwd).");

export function registerContextTools(server: McpServer): void {
	server.registerTool(
		"context_status",
		{
			title: "Current org / project + link info",
			description:
				"Returns the whoami identity, the active organization / project, and whether the given directory is linked to an app via .tarout/project.json.",
			inputSchema: { path },
			annotations: { readOnlyHint: true },
		},
		async ({ path: dir }) =>
			withAuth(async (client) => {
				const cwd = dir ?? process.cwd();
				const [user, project] = await Promise.all([
					client.user.get.query(),
					// getActive throws when nothing is set — treat as null so status can
					// still report identity + link info.
					client.project.getActive.query().catch(() => null),
				]);
				const link = isProjectLinked(cwd)
					? { linked: true, ...getProjectConfig(cwd) }
					: { linked: false };
				// The local profile drives create tools (app_create, db_create,
				// deploy send profile.organizationId) — report it alongside the
				// server view so any divergence is observable.
				const profile = getCurrentProfile();
				const localProfile = profile
					? {
							organizationId: profile.organizationId,
							organizationName: profile.organizationName,
							projectId: profile.projectId,
							projectName: profile.projectName,
						}
					: null;
				return { user, project, profile: localProfile, link, cwd };
			}),
	);

	server.registerTool(
		"context_switch",
		{
			title: "Switch active organization / project",
			description:
				"Either or both can be provided (id, slug, or name). Only the fields you supply are changed.",
			inputSchema: {
				organization: z.string().optional(),
				project: z.string().optional(),
			},
		},
		async ({ organization, project }) =>
			withAuth(async (client) => {
				const changes: Record<string, unknown> = {};
				if (organization) {
					// organization.all rows carry `id` (see commands/orgs.ts findOrg).
					const orgs = (await client.organization.all.query()) as Array<{
						id: string;
						name: string;
					}>;
					const lower = organization.toLowerCase();
					const match = orgs.find(
						(o) =>
							o.id === organization ||
							o.id.startsWith(organization) ||
							o.name.toLowerCase() === lower,
					);
					if (!match) throw new NotFoundError("Organization", organization);
					await client.organization.setActive.mutate({
						organizationId: match.id,
					});
					// Keep the LOCAL profile coherent: create tools (app_create,
					// db_create, deploy) send getCurrentProfile().organizationId, so a
					// server-only switch would silently create resources in the old
					// org. Projects are org-scoped — clear the stale selection.
					updateProfile({
						organizationId: match.id,
						organizationName: match.name,
						projectId: undefined,
						projectName: undefined,
						projectSlug: undefined,
					});
					changes.organization = { organizationId: match.id, name: match.name };
				}
				if (project) {
					// project.all rows carry `projectId` (see commands/projects.ts).
					const projs = (await client.project.all.query()) as Array<{
						projectId: string;
						slug?: string;
						name?: string;
					}>;
					const lower = project.toLowerCase();
					const match = projs.find(
						(p) =>
							p.projectId === project ||
							p.slug === project ||
							(p.name ?? "").toLowerCase() === lower,
					);
					if (!match) throw new NotFoundError("Project", project);
					// Project-scoped API keys cannot be moved by mutating session
					// state — verify the credential covers the target (throws
					// AuthError otherwise), then update the local profile, exactly
					// like `tarout projects use`.
					await verifyProjectCredentialScope(client, {
						projectId: match.projectId,
						name: match.name ?? match.projectId,
						slug: match.slug ?? "",
					});
					updateProfile({
						projectId: match.projectId,
						projectName: match.name,
						projectSlug: match.slug,
					});
					changes.project = match;
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
				// resolveAppRef only surfaces { applicationId, name }; one direct
				// record fetch (not a second full-list query) picks up
				// organizationId, falling back to the profile's org rather than
				// persisting an empty string.
				const full = (await client.application.one
					.query({ applicationId })
					.catch(() => null)) as { organizationId?: string } | null;
				const organizationId =
					full?.organizationId ?? getCurrentProfile()?.organizationId ?? "";
				setProjectConfig(
					{
						applicationId,
						name,
						organizationId,
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
