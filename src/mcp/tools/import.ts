/**
 * Curated MCP tools for moving a project to Tarout:
 *   import_project - plan (default) or run an import from Vercel or Render
 *   import_status  - copy progress + report, optionally deploy when ready
 *
 * The source token is NEVER a tool argument: it is read from the MCP server's
 * environment (VERCEL_TOKEN / RENDER_API_KEY, or the variable named by
 * `tokenEnv`), so it never enters the chat transcript.
 */
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	buildSourceInput,
	DEFAULT_TOKEN_ENV,
	detectImportProvider,
	IMPORT_PROVIDERS,
	type ImportProvider,
	readDatabaseUrls,
	readSourceToken,
	waitForImport,
} from "../../lib/platform-import.js";
import { withAuth } from "../runtime.js";

const MAX_WAIT_SECONDS = 600;

export function registerImportTools(server: McpServer): void {
	server.registerTool(
		"import_project",
		{
			title: "Move a project from Vercel or Render",
			description: `Recreates a Vercel project or Render services on Tarout: apps, environment variables (values copied server-side, never returned), the Postgres database with its data, scheduled jobs, and a DNS plan for the domains. Reads vercel.json / .vercel/project.json / render.yaml from \`path\`. With execute=false (default) it only returns the plan (platformImport.plan) - show it to the user before running with execute=true (platformImport.start, then platformImport.status/finish). The source token comes from the MCP server environment (${DEFAULT_TOKEN_ENV.vercel} or ${DEFAULT_TOKEN_ENV.render}); ask the user to set it there, never to paste it in chat.`,
			inputSchema: {
				path: z.string().optional().describe("Repo directory (defaults to cwd)."),
				from: z.enum(IMPORT_PROVIDERS).optional().describe("Source platform; detected from the repo when omitted."),
				project: z.string().optional().describe("Vercel project name or prj_ id."),
				teamId: z.string().optional().describe("Vercel team id for a team project."),
				services: z.array(z.string()).optional().describe("Render service names to read."),
				only: z.array(z.string()).optional().describe("Plan service keys to import (default all)."),
				databaseMode: z.enum(["copy", "empty", "keep"]).optional().default("copy"),
				databasePlan: z.enum(["STARTER", "STANDARD", "PRO"]).optional().default("STARTER"),
				deploy: z.boolean().optional().default(true),
				tokenEnv: z.string().optional().describe("Name of the env var holding the source token."),
				databaseUrlEnv: z
					.array(z.string())
					.optional()
					.describe("<database key>=<ENV_VAR> pairs: read a source database URL from the environment."),
				execute: z.boolean().optional().default(false).describe("false = plan only; true = create and import."),
				waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional().default(120),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
		},
		async (args) => {
			const dir = resolve(args.path ?? process.cwd());
			return withAuth(
				async (client) => {
					const provider = (args.from ?? detectImportProvider(dir)) as ImportProvider | null;
					if (!provider) {
						throw new Error("Could not tell which platform this repo is on. Pass from: vercel or render.");
					}
					const token = readSourceToken(provider, args.tokenEnv);
					const source = buildSourceInput({
						provider,
						cwd: dir,
						token,
						project: args.project,
						teamId: args.teamId,
						services: args.services,
					});
					const planned = await client.platformImport.plan.mutate(source);
					const sourceAuth = token
						? "token found in the environment"
						: `no token: set ${args.tokenEnv || DEFAULT_TOKEN_ENV[provider]} in the MCP server environment to copy variables and data`;
					if (!args.execute) {
						return { mode: "plan", sourceAuth, ...planned };
					}
					const result = await client.platformImport.start.mutate({
						...source,
						selection: {
							...(args.only?.length ? { services: args.only } : {}),
							databaseMode: args.databaseMode,
							databasePlan: args.databasePlan,
							deploy: args.deploy,
							...(args.databaseUrlEnv?.length
								? { databaseUrls: readDatabaseUrls(args.databaseUrlEnv) }
								: {}),
						},
					});
					const { status, timedOut } = await waitForImport(client, result.runId, {
						deploy: args.deploy,
						timeoutMs: args.waitSeconds * 1000,
					});
					return {
						mode: "import",
						sourceAuth,
						runId: result.runId,
						apps: result.apps,
						state: status.state,
						copies: status.copies,
						report: status.report,
						...(timedOut || status.state === "copying"
							? { next: `Call import_status with runId ${result.runId} until state is "finished".` }
							: {}),
					};
				},
				"platformImport.plan",
				{ cwd: dir },
			);
		},
	);

	server.registerTool(
		"import_status",
		{
			title: "Import progress and report",
			description:
				"Returns platformImport.status for a run started by import_project: database copy progress, what moved, what did not and how to fix it, and the DNS step per domain. With deploy=true it calls platformImport.finish once the copy has ended.",
			inputSchema: {
				runId: z.string().uuid(),
				deploy: z.boolean().optional().default(false),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		},
		async ({ runId, deploy }) =>
			withAuth(async (client) => {
				let status = await client.platformImport.status.query({ runId });
				if (deploy && status.state === "ready") {
					await client.platformImport.finish.mutate({ runId });
					status = await client.platformImport.status.query({ runId });
				}
				return status;
			}, "platformImport.status"),
	);
}
