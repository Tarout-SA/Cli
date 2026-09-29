/**
 * Curated MCP tools for application management: app_list, app_info, app_create,
 * app_logs, app_restart, app_stop, app_delete, app_exec, app_explain_build. All
 * handlers route through withAuth() and resolve the target application via
 * resolveAppRef() so agents can address apps by name OR id (app_exec and
 * app_explain_build fall back to the app linked in the credential directory
 * when `app` is omitted).
 *
 * `app_list` returns a trimmed shape (id / name / status / plan / url /
 * lastDeployment); agents should call `app_info` for the full application
 * object. `status` is the router's `applicationStatus` and `url` is its
 * `liveUrl` (custom domain, else the platform subdomain) as an https URL, or
 * null when the app has never been deployed.
 *
 * Annotations:
 * - readOnlyHint on app_list / app_info / app_logs / app_explain_build (it
 *   builds, deploys and changes nothing)
 * - destructiveHint on app_stop / app_delete / app_exec (arbitrary shell in the
 *   live container; operator-tier keys get NEEDS_APPROVAL for it)
 * - app_restart / app_create are mutating but non-destructive (no hint)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toAppNameSlug } from "../../lib/app-name.js";
import {
	DEFAULT_EXPLAIN_WAIT_SECONDS,
	EXPLAIN_RATE_LIMIT_MESSAGE,
	EXPLAIN_SOURCE_NOTE,
	explainBuild,
	explainRateLimitDetails,
	MAX_EXPLAIN_WAIT_SECONDS,
} from "../../lib/build-explain.js";
import { getCurrentProfile, getProjectConfig } from "../../lib/config.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { getCredentialResolutionDir } from "../../lib/project-auth.js";
import { formatAppUrl } from "../../utils/url.js";
import { errorResult, type ToolText, withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");

/**
 * Added to app_exec's NEEDS_APPROVAL envelope. The platform replays an approved
 * call without keeping its return value, and a non-zero exit is a normal
 * result there, so "executed" is not "exited 0".
 */
export const APP_EXEC_AFTER_APPROVAL_NOTE =
	'Once a human approves it, the platform runs the command, but its output and exit code are not returned to you: approvals_get reports only "executed" or "failed". "executed" means the command ran, not that it exited 0; "failed" means it could not run (for example, no running container). If you need the output, ask the user to run the command in the dashboard console (Application > Console).';

/** Adds the exec note to a NEEDS_APPROVAL envelope; any other result as is. */
function withExecApprovalNote(result: ToolText): ToolText {
	if (!result.isError) return result;
	const text = result.content[0]?.text;
	try {
		const env = JSON.parse(text ?? "") as {
			code?: string;
			details?: Record<string, unknown>;
		};
		if (env.code !== "NEEDS_APPROVAL") return result;
		env.details = {
			...(env.details ?? {}),
			afterApproval: APP_EXEC_AFTER_APPROVAL_NOTE,
		};
		return {
			...result,
			content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
		};
	} catch {
		return result;
	}
}

/**
 * app_explain_build's TOO_MANY_REQUESTS carries the server's text, which names
 * a procedure the tool already polls for the agent; say what to do instead.
 */
function withExplainRateLimitNote(result: ToolText): ToolText {
	if (!result.isError) return result;
	const text = result.content[0]?.text;
	try {
		const env = JSON.parse(text ?? "") as {
			error?: string;
			code?: string;
			remediation?: string;
			details?: Record<string, unknown>;
		};
		if (env.code !== "TOO_MANY_REQUESTS") return result;
		env.error = EXPLAIN_RATE_LIMIT_MESSAGE;
		env.remediation =
			"Wait about a minute before calling app_explain_build again. Retrying sooner is refused the same way.";
		env.details = { ...(env.details ?? {}), ...explainRateLimitDetails() };
		return {
			...result,
			content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
		};
	} catch {
		return result;
	}
}

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

	server.registerTool(
		"app_exec",
		{
			title: "Run one shell command inside an application's running container",
			description:
				"Wraps application.exec. Runs `command` with sh inside the app's running container and returns exitCode, stdout, stderr, truncated, timedOut and durationMs once it finishes. It is not streamed, and the platform keeps the first 4,000 and last 8,000 characters of each stream. A non-zero exitCode is a normal result, not a tool error; timedOut=true means no exit code came back. `app` defaults to the app linked in the MCP server's project directory. Owners and admins only. An operator-tier key gets NEEDS_APPROVAL, and after a human approves, the command runs but its output is NOT returned (approvals_get shows only executed or failed, and executed does not mean exit 0). PRECONDITION_FAILED means the app has no running container. Credential-looking lines (KEY=secret, known token formats) in the output are redacted from this result. There is no interactive shell; that is the dashboard console.",
			inputSchema: {
				app: z
					.string()
					.optional()
					.describe(
						"Application name or id. Defaults to the app linked in the MCP server's project directory.",
					),
				command: z
					.string()
					.min(1)
					.max(4000)
					.describe(
						'Shell line run with sh inside the container, e.g. "npm run migrate && echo ok". At most 4000 characters.',
					),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(300)
					.optional()
					.describe("Seconds to wait for the command, 1 to 300 (default 60)."),
			},
			annotations: { destructiveHint: true },
		},
		async ({ app: appRef, command, timeoutSeconds }) => {
			const linked = appRef
				? null
				: getProjectConfig(getCredentialResolutionDir());
			if (!appRef && !linked?.applicationId) {
				return errorResult({
					error: "No `app` was given and no app is linked in this directory.",
					code: "INVALID_ARGUMENTS",
					remediation:
						"Pass `app` (name or id), or link the directory to an app first with the `link_app` tool.",
				});
			}
			const result = await withAuth(async (client) => {
				const target = appRef
					? await resolveAppRef(client, appRef)
					: {
							applicationId: linked?.applicationId as string,
							name: linked?.name ?? "",
						};
				const ran = (await client.application.exec.mutate({
					applicationId: target.applicationId,
					command,
					...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
				})) as Record<string, unknown>;
				return {
					applicationId: target.applicationId,
					name: target.name,
					command,
					...ran,
					ok: ran.exitCode === 0 && ran.timedOut !== true,
				};
			});
			return withExecApprovalNote(result);
		},
	);

	server.registerTool(
		"app_explain_build",
		{
			title: "Explain what a deploy would build, without deploying",
			description: `Wraps application.explainBuild, polling application.explainBuildResult while the answer is pending. ${EXPLAIN_SOURCE_NOTE} Returns applicationId, name, status (ok | failed | pending), detectedKind, buildType, summary, plan (providers, packages with versions, steps with their commands, startCommand, port, and buildEnv: the NAMES of build-time variables, never values; null when the deploy would stop before planning), warnings, errors and source (type, repository, branch, commitSha). status failed is a normal result, not a tool error: errors say what would stop the deploy. status pending (with stillPending=true) means the inspection outlived waitSeconds; call again to pick up the same inspection. \`app\` defaults to the app linked in the MCP server's project directory. Limited to 10 calls a minute per user (TOO_MANY_REQUESTS). A server without the procedure answers NOT_FOUND.`,
			inputSchema: {
				app: z
					.string()
					.optional()
					.describe(
						"Application name or id. Defaults to the app linked in the MCP server's project directory.",
					),
				waitSeconds: z
					.number()
					.int()
					.min(0)
					.max(MAX_EXPLAIN_WAIT_SECONDS)
					.optional()
					.describe(
						`Seconds to keep polling a slow inspection, 0 to ${MAX_EXPLAIN_WAIT_SECONDS} (default ${DEFAULT_EXPLAIN_WAIT_SECONDS}). 0 returns a pending answer at once.`,
					),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, waitSeconds }) => {
			const linked = appRef
				? null
				: getProjectConfig(getCredentialResolutionDir());
			if (!appRef && !linked?.applicationId) {
				return errorResult({
					error: "No `app` was given and no app is linked in this directory.",
					code: "INVALID_ARGUMENTS",
					remediation:
						"Pass `app` (name or id), or link the directory to an app first with the `link_app` tool.",
				});
			}
			const result = await withAuth(async (client) => {
				const target = appRef
					? await resolveAppRef(client, appRef)
					: {
							applicationId: linked?.applicationId as string,
							name: linked?.name ?? "",
						};
				const outcome = await explainBuild(client, target.applicationId, {
					waitMs: (waitSeconds ?? DEFAULT_EXPLAIN_WAIT_SECONDS) * 1000,
				});
				return {
					applicationId: target.applicationId,
					name: target.name,
					...outcome.result,
					...(outcome.timedOut ? { stillPending: true } : {}),
				};
			});
			return withExplainRateLimitNote(result);
		},
	);
}
