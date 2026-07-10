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
	buildConfigFromOptions,
	createAppFromCurrentDirectory,
	extractEntitlementKeyFromError,
	inspectCurrentProject,
	isEntitlementError,
	uploadCurrentDirectorySource,
} from "../../commands/deploy.js";
import { getProjectConfig, setProjectConfig } from "../../lib/config.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { resolveEntitlementRemedy } from "../../lib/entitlement-remedy.js";
import { errorResult, okResult, withAuth } from "../runtime.js";

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
			// Zod defaults only apply when the schema is parsed; direct handler
			// invocations (and MCP SDK versions that don't pre-parse) can bypass
			// them, so mirror them here.
			const doWait = wait ?? true;
			const timeoutS = timeoutSeconds ?? 600;
			const doCreate = createIfMissing ?? true;
			try {
				const { isLoggedIn } = await import("../../lib/config.js");
				if (!isLoggedIn()) {
					return errorResult({
						error: "Not authenticated.",
						code: "AUTH_ERROR",
						remediation:
							"Run `tarout login` on the machine running this MCP server, or set TAROUT_TOKEN.",
					});
				}
				const { getApiClient } = await import("../../lib/api.js");
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
					const apps = (await client.application.allByOrganization.query()) as Array<{
						applicationId: string;
						name: string;
					}>;
					const match = apps.find(
						(a) => a.name === name || a.applicationId === name,
					);
					if (match) {
						applicationId = match.applicationId;
						appName = match.name;
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
						// The plan-snippet shape (options + inspection) is broader than
						// the current helper signatures — the helpers are treated as
						// opaque here so the tool can evolve without churning the MCP
						// surface. `as any` matches the intent while keeping the
						// concrete call type-safe (both helpers are mocked in tests).
						// biome-ignore lint/suspicious/noExplicitAny: helper API shape may drift; treat as opaque.
						const options = (buildConfigFromOptions as any)(
							{
								name: name ?? undefined,
								yes: true,
								nonInteractive: true,
								json: true,
								plan,
							},
							inspection,
						);
						// biome-ignore lint/suspicious/noExplicitAny: see comment above; helper signature may include a Profile arg upstream.
						const created = (await (createAppFromCurrentDirectory as any)(
							client,
							options,
							inspection,
						)) as {
							applicationId: string;
							name: string;
							organizationId?: string;
						};
						applicationId = created.applicationId;
						appName = created.name;
						setProjectConfig(
							{
								applicationId,
								name: appName,
								organizationId: created.organizationId ?? "",
								linkedAt: new Date().toISOString(),
							},
							cwd,
						);
					} catch (err) {
						if (isEntitlementError(err)) {
							const catalog = (await client.subscription.getCatalog
								.query()
								.catch(() => ({ plans: [], addons: [] }))) as {
								plans: Array<{ planKey: string }>;
								addons: Array<{ addonKey: string }>;
							};
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
				await uploadCurrentDirectorySource(client, applicationId, appName ?? "app");

				// 4) Trigger deploy.
				const started = (await client.application.deployToCloud.mutate({
					applicationId,
				})) as { deploymentId: string };
				const deploymentId = started.deploymentId;

				// 5) wait=false: return the id.
				if (!doWait) {
					return okResult({ status: "started", deploymentId, applicationId });
				}

				// 6) Poll with progress notifications.
				const deadline = Date.now() + timeoutS * 1000;
				let last: Record<string, unknown> | undefined;
				let progressToken = 0;
				while (Date.now() < deadline) {
					last = (await client.deployment.one.query({ deploymentId })) as Record<
						string,
						unknown
					>;
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
						const logs = (await client.deployment.getDeploymentLogs
							.query({ deploymentId, limit: 200 })
							.catch(() => ({ logs: [] }))) as {
							logs?: Array<Record<string, unknown>>;
						};
						return okResult({
							status: "done",
							deploymentId,
							appUrl: (last as { url?: string }).url,
							logsTail: (logs.logs ?? []).slice(-80),
						});
					}
					if (status === "error" || status === "failed") {
						return errorResult({
							error: "Deployment failed.",
							code: "DEPLOYMENT_FAILED",
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
				const { toEnvelope } = await import("../runtime.js");
				return errorResult(toEnvelope(err));
			}
		},
	);
}
