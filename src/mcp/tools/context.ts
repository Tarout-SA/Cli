/**
 * Curated MCP tools for identity / context: context_status, context_switch,
 * link_app, unlink_app, agent_manifest, agent_events, agent_sessions. Handlers
 * route through withAuth() and never touch stdout / process.exit / CLI prompt
 * helpers.
 *
 * `agent_manifest` maps a whole project in one read (the same data as
 * `tarout agent manifest --json`), so an agent can orient itself without
 * listing every resource type.
 *
 * `agent_events` and `agent_sessions` are the reads behind `tarout agent
 * events` and `tarout agent sessions`. `agent_sessions` exists because
 * `user.listApiKeys` is already on the platform's MCP surface (reachable through
 * `call`); it returns no key material, and there is deliberately no revoke or
 * pause tool: the platform refuses those to API keys, and a human does them in
 * the dashboard. Note: the result sanitizer redacts any field named like
 * "apiKey", so `apiKeyId` on event rows reads as redacted; `keyName` names the
 * key.
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
import {
	getCurrentProfile,
	updateProfile,
	getProjectConfig,
	isProjectLinked,
	removeProjectConfig,
	setProjectConfig,
} from "../../lib/config.js";
import {
	DEFAULT_EVENTS_LIMIT,
	fetchAgentEvents,
	parseSinceDuration,
} from "../../lib/agent-events.js";
import { fetchAgentManifest } from "../../lib/agent-manifest.js";
import { listAgentSessions } from "../../lib/agent-sessions.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { rememberRequestProjectId } from "../../lib/api.js";
import { AuthError } from "../../lib/errors.js";
import {
	type ProjectSummary,
	verifyProjectCredentialScope,
} from "../../lib/project-context.js";
import { withAuth } from "../runtime.js";

const path = z.string().optional().describe("Directory (defaults to cwd).");

/** A tool result is read by a model, so it stays well under the CLI's 500. */
const MAX_EVENTS_TOOL_LIMIT = 100;

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
		async ({ path: dir }) => {
			const cwd = dir ?? process.cwd();
			return withAuth(
				async (client) => {
					const [user, project] = await Promise.all([
						client.user.get.query(),
						// getActive throws when nothing is set — treat as null so status can
						// still report identity + link info.
						client.project.getActive
							.query()
							.catch(() => null),
					]);
					const link = isProjectLinked(cwd)
						? { linked: true, ...getProjectConfig(cwd) }
						: { linked: false };
					return { user, project, link, cwd };
				},
				undefined,
				{ cwd },
			);
		},
	);

	server.registerTool(
		"context_switch",
		{
			title: "Switch active organization / project",
			description:
				"Select a project by id, slug, or name for the directory's credential. Organization changes require a new API key; selecting the current organization is a no-op.",
			inputSchema: {
				path,
				organization: z.string().optional(),
				project: z.string().optional(),
			},
		},
		async ({ organization, project, path: dir }) =>
			withAuth(
				async (client) => {
					const changes: Record<string, unknown> = {};
					if (organization) {
						const orgs = (await client.organization.all.query()) as Array<{
							id: string;
							slug?: string;
							name: string;
						}>;
						const match = orgs.find(
							(o) =>
								o.id === organization ||
								o.slug === organization ||
								o.name === organization,
						);
						if (
							!match ||
							(orgs.length !== 1 &&
								match.id !== getCurrentProfile()?.organizationId)
						) {
							throw new AuthError(
								`Unknown organization or different credential scope: ${organization}. Run \`tarout login\` with an API key for that organization.`,
							);
						}
						changes.organization = match;
					}
					if (project) {
						const projs =
							(await client.project.all.query()) as ProjectSummary[];
						const match = projs.find(
							(p) =>
								p.projectId === project ||
								p.slug === project ||
								p.name === project,
						);
						if (!match) throw new Error(`Unknown project: ${project}`);
						await verifyProjectCredentialScope(client, match);
						updateProfile({
							projectId: match.projectId,
							projectName: match.name,
							projectSlug: match.slug,
						});
						rememberRequestProjectId(match.projectId);
						changes.project = match;
					}
					return changes;
				},
				undefined,
				{ cwd: dir ?? process.cwd() },
			),
	);

	server.registerTool(
		"link_app",
		{
			title: "Link a directory to an app",
			description:
				"Writes .tarout/project.json in the given directory so future deploy / env tools can infer the target when no `app` argument is passed.",
			inputSchema: { app: z.string(), path },
		},
		async ({ app: appRef, path: dir }) => {
			const cwd = dir ?? process.cwd();
			return withAuth(
				async (client) => {
					const { applicationId, name } = await resolveAppRef(client, appRef);
					// resolveAppRef only surfaces { applicationId, name }; re-query to pick
					// up organizationId, which ProjectConfig requires.
					const apps =
						(await client.application.allByOrganization.query()) as Array<{
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
				},
				undefined,
				{ cwd },
			);
		},
	);

	server.registerTool(
		"agent_manifest",
		{
			title: "Project manifest: apps, databases, buckets, domains",
			description:
				"One read that maps a project: every app with its status, URL, source, custom domains, linked database ids, env var NAMES (never values) and scheduled job count, plus the project's databases (engine, plan, external access, linked apps), storage buckets and domains. Defaults to the active project. Call it first to orient instead of listing each resource type.",
			inputSchema: {
				projectId: z
					.string()
					.optional()
					.describe("Project id. Defaults to the session's active project."),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ projectId }) =>
			withAuth(
				(client) => fetchAgentManifest(client, projectId),
				"project.manifest",
			),
	);

	server.registerTool(
		"agent_events",
		{
			title: "Agent activity timeline",
			description: `What agents changed in this organization through the tarout CLI and MCP (the dashboard's Agent page feed): one row per mutation or guardrail refusal, reads are not recorded. Each row has the time (at), the key or OAuth client that acted (keyName), the procedure, the surface (cli or mcp), status ok or error, and errorCode / errorMessage. Rows come oldest first, newest last. \`since\` is a duration such as 15m, 2h or 7d. Returns the ${DEFAULT_EVENTS_LIMIT} most recent by default, or up to ${MAX_EVENTS_TOOL_LIMIT} with \`since\`.`,
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_EVENTS_TOOL_LIMIT)
					.optional()
					.describe(
						`How many recent events (default ${DEFAULT_EVENTS_LIMIT}, or ${MAX_EVENTS_TOOL_LIMIT} with since).`,
					),
				since: z
					.string()
					.optional()
					.describe(
						"Only events newer than this duration: 90s, 15m, 2h, 7d or 1h30m.",
					),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ limit, since }) =>
			withAuth(async (client) => {
				const sinceMs =
					since === undefined ? undefined : parseSinceDuration(since, "since");
				const events = await fetchAgentEvents(client, {
					limit: limit ?? (sinceMs !== undefined ? MAX_EVENTS_TOOL_LIMIT : undefined),
					sinceMs,
				});
				return { count: events.length, events };
			}, "dashboard.getAgentActivity"),
	);

	server.registerTool(
		"agent_sessions",
		{
			title: "Agent credentials: OAuth connections and API keys",
			description:
				"Lists this account's agent credentials in the active organization, grouped as oauthConnections (hosted MCP connector authorizations: client name, tier, status, created, last used, expires) and keys (API keys: name, prefix, tier, status, last used). Never returns key material. status is active, paused (agent access switched off) or expired. This server cannot revoke or pause anything: a human does that in the dashboard at dashboardUrl.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth((client) => listAgentSessions(client), "user.listApiKeys"),
	);

	server.registerTool(
		"unlink_app",
		{
			title: "Remove a directory's link",
			description:
				"Deletes .tarout/project.json in the given directory. Only untracks the local link — does not touch the remote app.",
			inputSchema: { path },
		},
		async ({ path: dir }) => {
			const cwd = dir ?? process.cwd();
			return withAuth(
				async () => {
					removeProjectConfig(cwd);
					return { unlinked: true, cwd };
				},
				undefined,
				{ cwd },
			);
		},
	);
}
