/**
 * Curated MCP tools for the deploy pipeline.
 *
 * This module exposes three tools:
 * - `deployment_status`: latest deployment for an app OR a specific deployment.
 * - `deployment_logs`: build + runtime logs for a specific deployment.
 * - `deploy`: flagship pipeline. Inspects the current directory, resolves or
 *   creates an app, uploads a source archive (or, for an app that deploys
 *   from a connected Git repository, deploys that repository instead), and
 *   (when `wait=true`) polls until terminal. A timeout returns
 *   DEPLOYMENT_TIMEOUT with `stillRunning: true`.
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
	type AppGitSourceDetail,
	createAppFromCurrentDirectory,
	extractEntitlementKeyFromError,
	inspectCurrentProject,
	isEntitlementError,
	shouldRefuseUploadOverGitSource,
	uploadCurrentDirectorySource,
} from "../../commands/deploy.js";
import { getProjectConfig } from "../../lib/config.js";
// `deploy` archives the WHOLE target directory (createSourceArchive) and the
// archive excludes only cover build artifacts + .env, so a steered agent could
// point deploy at e.g. ~/.ssh or the home dir and ship keys/tokens to the
// platform. The check now lives in lib/deploy-safety so `tarout up` /
// `tarout deploy` enforce the SAME rule — it living only here is why those
// paths were unguarded.
import { unsafeDeployDirectory } from "../../lib/deploy-safety.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { resolveEntitlementRemedy } from "../../lib/entitlement-remedy.js";
import { formatAppUrl } from "../../utils/url.js";
import { errorResult, okResult, withAuth } from "../runtime.js";

/** How many trailing build-log lines a finished `deploy` returns. */
const LOGS_TAIL_LINES = 80;

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
		"deployment_retry",
		{
			title: "Retry a failed deployment without rebuilding",
			description:
				"Re-runs only the deploy step of a FAILED deployment, reusing the image it already built. Use this when a deployment failed AFTER its build succeeded (image pull failed, registry auth stale, target host unavailable) — it skips source resolution, preflight and the build entirely. If the deployment failed during the build, there is no image to reuse; fix the code and call `deploy` instead.",
			inputSchema: {
				app: z.string().describe("Application name or id"),
				deploymentId: z
					.string()
					.optional()
					.describe(
						"Failed deployment to retry. Defaults to the most recent failure.",
					),
			},
		},
		async ({ app: appRef, deploymentId }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);

				let target = deploymentId;
				if (!target) {
					const deployments = (await client.deployment.all.query({
						applicationId,
					})) as Array<{ deploymentId: string; status: string }>;
					// The server rejects a target that isn't actually failed, so a
					// wrong guess here fails loudly rather than redeploying something
					// unintended.
					target = deployments.find((d) => d.status === "error")?.deploymentId;
					if (!target) {
						throw new Error(
							`No failed deployment found for ${name}. Nothing to retry.`,
						);
					}
				}

				const result = (await client.deployment.retry.mutate({
					applicationId,
					deploymentId: target,
				})) as Record<string, unknown>;

				return {
					app: { applicationId, name },
					retryOf: target,
					reusedImage: true,
					...result,
				};
			}),
	);

	server.registerTool(
		"deploy",
		{
			title: "Deploy the current directory to an app",
			description:
				"Inspects the given directory, resolves an app (by linked config, `name`, or new), uploads a source archive, triggers a deploy, and (when wait=true) polls until done. An existing app that deploys from a connected Git repository is deployed from that repository instead (push your changes first); pass replaceGitSource=true to upload this directory and disconnect the repository. On timeout returns DEPLOYMENT_TIMEOUT with details.stillRunning=true.",
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
				replaceGitSource: z
					.boolean()
					.optional()
					.default(false)
					.describe(
						"Upload this directory even when the app deploys from a connected Git repository. This replaces the repository source and stops push-to-deploy.",
					),
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: tRPC client and helper options intentionally untyped here.
		async (
			{
				path: dir,
				name,
				wait,
				timeoutSeconds,
				createIfMissing,
				plan,
				replaceGitSource,
			},
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
			// This tool builds its own client rather than going through withAuth, so
			// it has to point credential resolution at the directory being deployed
			// itself — otherwise an MCP server started outside the project would
			// miss its .tarout/auth.json.
			const { resetProjectAuthCache } = await import(
				"../../lib/project-auth.js"
			);
			const { withInvocationContext } = await import(
				"../../lib/invocation-context.js"
			);
			return withInvocationContext(cwd, async () => {
				resetProjectAuthCache();
				try {
					const { isLoggedIn } = await import("../../lib/config.js");
					if (!isLoggedIn()) {
						return errorResult({
							error: "Not authenticated.",
							code: "AUTH_ERROR",
							remediation:
								"Run `tarout login --token <api-key>` from the project directory on the machine running this MCP server, then restart it from that directory so it picks up ./.tarout/auth.json.",
						});
					}
					const { getApiClient } = await import("../../lib/api.js");
					const client = getApiClient();

					// 1) Inspect the project.
					inspectCurrentProject(cwd);

					// 2) Resolve target: linked > name > create.
					let applicationId: string | undefined;
					let appName: string | undefined;
					// True when this run REUSES an existing app. Only a reused app
					// can already deploy on push; one created below has no source.
					let reused = false;
					const linked = getProjectConfig(cwd);
					if (linked) {
						applicationId = linked.applicationId;
						appName = linked.name;
						reused = true;
					} else if (name) {
						const apps =
							(await client.application.allByOrganization.query()) as Array<{
								applicationId: string;
								name: string;
							}>;
						const match = apps.find(
							(a) => a.name === name || a.applicationId === name,
						);
						if (match) {
							applicationId = match.applicationId;
							appName = match.name;
							reused = true;
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
							const { getCurrentProfile } = await import("../../lib/config.js");
							const profile = getCurrentProfile();
							if (!profile) {
								return errorResult({
									error: "No CLI profile — cannot create an app without one.",
									code: "AUTH_ERROR",
									remediation:
										"Run `tarout login` on the machine running this MCP server.",
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
							)) as {
								applicationId: string;
								name: string;
								organizationId?: string;
							};
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

					// 3) Upload source archive, unless the app deploys from a
					// connected Git repository. completeDropUpload clears every
					// source field, so uploading over a repo silently stopped
					// push-to-deploy. Same rule as `tarout up`
					// (shouldRefuseUploadOverGitSource); the app list carries no
					// repository fields, so read the app's real source first.
					const sourceDetail: AppGitSourceDetail =
						reused && !replaceGitSource
							? ((await client.application.one.query({
									applicationId,
								})) as AppGitSourceDetail)
							: {};
					const deployFromGit = shouldRefuseUploadOverGitSource({
						explicitSource: Boolean(replaceGitSource),
						reused,
						app: sourceDetail,
					});
					const sourceInfo = deployFromGit
						? {
								source: "git" as const,
								note: `${appName ?? "This app"} deploys from its connected ${sourceDetail.sourceType ?? "Git"} repository, so this deployed the repository's branch, not ${cwd}. Push local changes first. To replace the repository with an upload of this directory (stops push-to-deploy), call deploy again with replaceGitSource=true.`,
							}
						: { source: "upload" as const };
					if (!deployFromGit) {
						await uploadCurrentDirectorySource(
							client,
							applicationId,
							appName ?? "app",
							cwd,
						);
					}

					// 4) Trigger deploy.
					const started = (await client.application.deployToCloud.mutate({
						applicationId,
					})) as { deploymentId: string };
					const deploymentId = started.deploymentId;

					// 5) wait=false: return the id.
					if (!doWait) {
						return okResult({
							status: "started",
							deploymentId,
							applicationId,
							...sourceInfo,
						});
					}

					// 6) Poll with progress notifications.
					const deadline = Date.now() + timeoutS * 1000;
					let last: Record<string, unknown> | undefined;
					let progressToken = 0;
					while (Date.now() < deadline) {
						last = (await client.deployment.one.query({
							deploymentId,
						})) as Record<string, unknown>;
						const status = String(last.status ?? "").toLowerCase();
						const progress = extra?.sendNotification;
						if (typeof progress === "function") {
							progressToken += 1;
							void progress({
								method: "notifications/progress",
								params: {
									progressToken,
									message: `deployment ${deploymentId}: ${status}`,
								},
							});
						}
						if (status === "done" || status === "success") {
							// deployment.one has no URL; the app's public URL comes
							// from getDeploymentStatus (appSubdomain once placed).
							const appStatus = (await client.application.getDeploymentStatus
								.query({ applicationId })
								.catch(() => null)) as { publicUrl?: string | null } | null;
							return okResult({
								status: "done",
								deploymentId,
								appUrl: formatAppUrl(appStatus?.publicUrl ?? null),
								logsTail: await tailDeploymentLogs(client, deploymentId),
								...sourceInfo,
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
					// Running out of the wait window is not success. An okResult here
					// meant an agent that checked only `ok` treated an unfinished — and
					// possibly failing — deployment as shipped, which is the same class
					// of false-positive as reporting a deploy healthy without checking
					// that it serves. The CLI's own wait path returns DEPLOYMENT_TIMEOUT
					// for this; match it, and keep `stillRunning` so the agent can tell
					// "not finished yet" from "broken" and resume rather than redeploy.
					return errorResult({
						error: `Deployment still running after ${timeoutS}s. It has not failed — the server is still working on it.`,
						code: "DEPLOYMENT_TIMEOUT",
						details: {
							deploymentId,
							stillRunning: true,
							status: String(last?.status ?? "unknown"),
							phase: last?.phase ?? null,
							hint: "Poll `deployment_status` / `deployment_logs` to follow it to completion.",
						},
					});
				} catch (err) {
					const { toEnvelope } = await import("../runtime.js");
					return errorResult(toEnvelope(err));
				}
			});
		},
	);
}

/**
 * The last LOGS_TAIL_LINES lines of a deployment's build log.
 * deployment.getDeploymentLogs pages from the START (`offset`, `limit`) and
 * returns `{ lines, totalLines, hasMore }`, so read the count, then the tail.
 * Never throws: logs are a convenience on an already-successful result.
 */
// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
async function tailDeploymentLogs(client: any, deploymentId: string) {
	type LogPage = { lines?: unknown[]; totalLines?: number };
	try {
		const head = (await client.deployment.getDeploymentLogs.query({
			deploymentId,
			offset: 0,
			limit: LOGS_TAIL_LINES,
		})) as LogPage;
		const total = head?.totalLines ?? 0;
		if (total <= LOGS_TAIL_LINES) return head?.lines ?? [];
		const tail = (await client.deployment.getDeploymentLogs.query({
			deploymentId,
			offset: total - LOGS_TAIL_LINES,
			limit: LOGS_TAIL_LINES,
		})) as LogPage;
		return tail?.lines ?? [];
	} catch {
		return [];
	}
}
