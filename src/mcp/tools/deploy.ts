/**
 * Curated MCP tools for the deploy pipeline.
 *
 * This module exposes three tools:
 * - `deployment_status`: latest deployment for an app OR a specific deployment.
 * - `deployment_logs`: build + runtime logs for a specific deployment.
 * - `deploy`: flagship pipeline — inspects the current directory, resolves or
 *   creates an app, uploads a source archive, triggers a cloud deploy, and
 *   (when `wait=true`) polls until terminal. Timeouts are an outcome
 *   (`{status: "in_progress", deploymentId}`), NOT an error.
 *
 * Handler policy (from src/mcp/runtime.ts): no process.exit, no CLI output
 * helpers. `withAuth` handles auth checks + error → envelope mapping for the
 * two read-only tools; the `deploy` handler manages its own control flow so it
 * can surface entitlement remedies + timeout outcomes without collapsing them
 * into a plain error envelope.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createAppFromCurrentDirectory,
	extractEntitlementKeyFromError,
	inspectCurrentProject,
	isEntitlementError,
	uploadCurrentDirectorySource,
} from "../../commands/deploy.js";
import { getApiClient } from "../../lib/api.js";
import {
	getCurrentProfile,
	getProjectConfig,
	isLoggedIn,
} from "../../lib/config.js";
// `deploy` archives the WHOLE target directory (createSourceArchive) and the
// archive excludes only cover build artifacts + .env, so a steered agent could
// point deploy at e.g. ~/.ssh or the home dir and ship keys/tokens to the
// platform. The check now lives in lib/deploy-safety so `tarout up` /
// `tarout deploy` enforce the SAME rule — it living only here is why those
// paths were unguarded.
import { unsafeDeployDirectory } from "../../lib/deploy-safety.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { resolveEntitlementRemedy } from "../../lib/entitlement-remedy.js";
import { NotFoundError } from "../../lib/errors.js";
import { formatAppUrl } from "../../utils/url.js";
import { errorResult, okResult, toEnvelope, withAuth } from "../runtime.js";

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

	server.registerTool(
		"deploy",
		{
			title: "Deploy the current directory to an app",
			description:
				"Inspects the given directory, resolves an app (by linked config, `name`, or new), uploads a source archive, triggers a deploy, and (when wait=true) polls until done. On timeout returns { status: 'in_progress', deploymentId }.",
			inputSchema: {
				path: z.string().optional(),
				name: z.string().optional(),
				wait: z.boolean().optional().default(true),
				timeoutSeconds: z
					.number()
					.int()
					.positive()
					.max(3600)
					.optional()
					.default(600),
				createIfMissing: z.boolean().optional().default(true),
				plan: z.enum(["FREE", "SHARED", "DEDICATED"]).optional(),
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: tRPC client and helper options intentionally untyped here.
		async (
			{ path: dir, name, wait, timeoutSeconds, createIfMissing, plan },
			extra: any,
		) => {
			const cwd = dir ?? process.cwd();
			// Confine deploy to a real project directory: refuse home/root/secret
			// dirs so a prompt-injected agent can't archive+upload e.g. ~/.ssh.
			const unsafe = unsafeDeployDirectory(cwd);
			if (unsafe) {
				return errorResult({ error: unsafe, code: "INVALID_ARGUMENTS" });
			}
			// Zod defaults only apply when the schema is parsed; direct handler
			// invocations (and MCP SDK versions that don't pre-parse) can bypass
			// them, so mirror them here.
			const doWait = wait ?? true;
			const timeoutS = timeoutSeconds ?? 600;
			const doCreate = createIfMissing ?? true;
			try {
				if (!isLoggedIn()) {
					return errorResult({
						error: "Not authenticated.",
						code: "AUTH_ERROR",
						remediation:
							"Run `tarout login` on the machine running this MCP server, or set TAROUT_TOKEN.",
					});
				}
				const client = getApiClient();

				// 1) Inspect the project.
				const inspection = inspectCurrentProject(cwd);

				// 2) Resolve target: linked > name > create.
				let applicationId: string | undefined;
				let appName: string | undefined;
				const linked = getProjectConfig(cwd);
				if (linked) {
					applicationId = linked.applicationId;
					appName = linked.name;
				} else if (name) {
					// Shared resolver (same ID-shape + name semantics as every other
					// app-addressing tool); a miss falls through to createIfMissing.
					try {
						const resolved = await resolveAppRef(client, name);
						applicationId = resolved.applicationId;
						appName = resolved.name;
					} catch (err) {
						if (!(err instanceof NotFoundError)) throw err;
					}
				}
				if (!applicationId) {
					if (!doCreate) {
						return errorResult({
							error: `No linked or matching app for ${cwd}. Pass createIfMissing=true to create one.`,
							code: "NOT_FOUND",
						});
					}
					try {
						const profile = getCurrentProfile();
						if (!profile) {
							return errorResult({
								error: "No CLI profile — cannot create an app without one.",
								code: "AUTH_ERROR",
								remediation: "Run `tarout login` on the machine running this MCP server.",
							});
						}
						// biome-ignore lint/suspicious/noExplicitAny: DeployOptions is untyped at the tool boundary.
						const options: any = {
							name: name ?? undefined,
							yes: true,
							nonInteractive: true,
							json: true,
						};
						if (plan) options.plan = plan;
						const created = (await createAppFromCurrentDirectory(
							client,
							profile,
							options,
							cwd,
						)) as { applicationId: string; name: string; organizationId?: string };
						applicationId = created.applicationId;
						appName = created.name;
					} catch (err) {
						if (isEntitlementError(err)) {
							// biome-ignore lint/suspicious/noExplicitAny: catalog shape narrows via optional chaining.
							const catalog: any = await client.subscription.getCatalog
								.query()
								.catch(() => ({ plans: [], addons: [] }));
							const failedKey = extractEntitlementKeyFromError(err);
							const remedy = failedKey
								? resolveEntitlementRemedy(failedKey, catalog, {})
								: null;
							return errorResult({
								error: err instanceof Error ? err.message : String(err),
								code: "PERMISSION_DENIED",
								remediation:
									"Upgrade or add an addon: call `billing_upgrade` with the remedy below.",
								details: { remedy, entitlementKey: failedKey },
							});
						}
						throw err;
					}
				}

				// 3) Upload source archive.
				await uploadCurrentDirectorySource(
					client,
					applicationId,
					appName ?? "app",
					cwd,
				);

				// 4) Trigger deploy.
				const started = (await client.application.deployToCloud.mutate({
					applicationId,
				})) as { deploymentId: string };
				const deploymentId = started.deploymentId;

				// 5) wait=false: return the id.
				if (!doWait) {
					return okResult({ status: "started", deploymentId, applicationId });
				}

				// 6) Poll with progress notifications. Per the MCP spec a progress
				// notification may only echo the token the CLIENT sent in the
				// request's _meta (and must carry a numeric `progress`); when no
				// token was provided, send nothing.
				const deadline = Date.now() + timeoutS * 1000;
				let last: Record<string, unknown> | undefined;
				const clientProgressToken = extra?._meta?.progressToken;
				let pollCount = 0;
				while (Date.now() < deadline) {
					if (extra?.signal?.aborted) {
						return okResult({
							status: "in_progress",
							deploymentId,
							hint: "Client cancelled the request; the deployment continues server-side. Poll `deployment_status`.",
						});
					}
					last = (await client.deployment.one.query({ deploymentId })) as Record<
						string,
						unknown
					>;
					const status = String(last.status ?? "").toLowerCase();
					pollCount += 1;
					if (
						typeof extra?.sendNotification === "function" &&
						clientProgressToken !== undefined
					) {
						void extra
							.sendNotification({
								method: "notifications/progress",
								params: {
									progressToken: clientProgressToken,
									progress: pollCount,
									message: `deployment ${deploymentId}: ${status}`,
								},
							})
							.catch(() => {
								// A failed notification must never break the poll.
							});
					}
					if (status === "done" || status === "success") {
						const logs = (await client.deployment.getDeploymentLogs
							.query({ deploymentId, limit: 200 })
							.catch(() => ({ lines: [] }))) as {
							lines?: Array<Record<string, unknown>>;
						};
						// The deployment record carries no URL — derive it from the
						// application record the way the CLI does.
						const app = (await client.application.one
							.query({ applicationId })
							.catch(() => null)) as {
							appSubdomain?: string | null;
							domain?: Array<{ host?: string | null }> | null;
						} | null;
						const appUrl =
							formatAppUrl(app?.appSubdomain) ??
							formatAppUrl(app?.domain?.[0]?.host) ??
							undefined;
						return okResult({
							status: "done",
							deploymentId,
							appUrl,
							logsTail: (logs.lines ?? []).slice(-80),
						});
					}
					if (status === "error" || status === "failed") {
						return errorResult({
							error: "Deployment failed.",
							code: "DEPLOYMENT_FAILED",
							details: { deploymentId, snapshot: last },
						});
					}
					if (status === "cancelled") {
						return errorResult({
							error: "Deployment cancelled.",
							code: "DEPLOYMENT_CANCELLED",
							details: { deploymentId, snapshot: last },
						});
					}
					await new Promise((r) => setTimeout(r, 3000));
				}
				return okResult({
					status: "in_progress",
					deploymentId,
					hint: "Poll `deployment_status` / `deployment_logs`.",
				});
			} catch (err) {
				return errorResult(toEnvelope(err));
			}
		},
	);
}
