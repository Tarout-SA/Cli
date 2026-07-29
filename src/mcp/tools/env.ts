/**
 * Curated MCP tools for environment-variable management: env_list, env_set,
 * env_unset, env_pull, env_push. All handlers route through withAuth() and
 * resolve the target application via resolveAppRef() so agents can address
 * apps by name OR id. FS-touching tools (env_pull / env_push) default their
 * working path to process.cwd() and always end up at <path>/<file>.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAppRef, serializeDotenv } from "../../lib/env-core.js";
import { errorResult, withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");
const path = z.string().optional().describe("Directory (defaults to cwd).");

export function registerEnvTools(server: McpServer): void {
	server.registerTool(
		"env_list",
		{
			title: "List environment variables of an app",
			description:
				"Returns keys (and values when reveal=true) for the selected environment. NOTE: values whose key looks credential-bearing (passwords, tokens, keys, connection strings) are replaced with a redaction placeholder in MCP responses — use env_pull to write the real values to a local file. Wraps envVariable.list.",
			inputSchema: {
				app,
				reveal: z.boolean().optional().default(false),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, reveal }) =>
			withAuth(async (client) => {
				// Defensive default: when a caller invokes the raw handler (in tests, or
				// via a non-parsing MCP client) zod's .default() has not yet applied.
				const includeValues = reveal ?? false;
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const vars = (await client.envVariable.list.query({
					applicationId,
					includeValues,
				})) as Array<{ key: string; value?: string }>;
				return {
					app: { applicationId, name },
					keys: vars.map((v) => v.key),
					vars: includeValues
						? Object.fromEntries(vars.map((v) => [v.key, v.value ?? ""]))
						: undefined,
					// The result sanitizer masks credential-looking values AFTER this
					// handler returns; without this note the reveal contract silently
					// breaks and agents copy the placeholder into config files.
					note: includeValues
						? "Values that look credential-bearing appear as a redaction placeholder; use env_pull to write real values to a local file."
						: undefined,
				};
			}),
	);

	server.registerTool(
		"env_set",
		{
			title: "Set environment variables on an app",
			description:
				"Merges (upsert) the given key/values into the app's environment. Wraps envVariable.import with merge=true.",
			inputSchema: {
				app,
				vars: z
					.record(z.string(), z.string())
					.describe("Object of KEY → value pairs to upsert."),
				restart: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, vars, restart }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const content = serializeDotenv(vars);
				const result = (await client.envVariable.import.mutate({
					applicationId,
					content,
					format: "dotenv",
					merge: true,
					restart: restart ?? false,
				})) as unknown;
				return { app: { applicationId, name }, result };
			}),
	);

	server.registerTool(
		"env_unset",
		{
			title: "Remove environment variables from an app",
			description:
				"Removes the given keys from the app's environment (envVariable.delete for a single key, envVariable.bulkDelete for many). Deleting ALWAYS triggers an application restart so the removed values stop being live in the running container — important for secret rotation. The `restarted` field reports whether that restart was actually issued (single-key deletes restart atomically; the bulk path issues a best-effort application.restart afterward). Any `restart` argument sent by older clients is ignored — deletion restarts unconditionally when the platform supports it.",
			inputSchema: {
				app,
				keys: z.array(z.string()).min(1),
			},
			annotations: { destructiveHint: true },
		},
		async ({ app: appRef, keys }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				// The old merge=false re-import path is always rejected by the
				// platform (apiImportEnvVariables.superRefine). Delete keys directly:
				// single via envVariable.delete, many via envVariable.bulkDelete.
				let result: unknown;
				let restarted: boolean;
				if (keys.length === 1) {
					// Platform apiDeleteEnvVariable requires restart:true (a healthy
					// replacement workload must be confirmed) — it is a Zod literal, so
					// this path always redeploys the app.
					result = (await client.envVariable.delete.mutate({
						applicationId,
						key: keys[0],
						restart: true,
					})) as unknown;
					restarted = true;
				} else {
					result = (await client.envVariable.bulkDelete.mutate({
						applicationId,
						keys,
					})) as unknown;
					// bulkDelete does NOT redeploy — the deleted values stay live in the
					// running container until the next deploy. Issue a best-effort
					// application.restart so multi-key deletes match single-key semantics
					// (deleted secrets actually leave the running container). Deletion has
					// already succeeded; a restart failure only downgrades `restarted`.
					restarted = false;
					try {
						await client.application.restart.mutate({ applicationId });
						restarted = true;
					} catch {
						// best-effort — report restarted:false so the caller knows the
						// removed values may remain live until the app's next deploy.
					}
				}
				return { app: { applicationId, name }, removed: keys, restarted, result };
			}),
	);

	server.registerTool(
		"env_pull",
		{
			title: "Write the app's environment to a local .env file",
			description:
				"Downloads variables via envVariable.export (dotenv format) and writes them to <path>/<file> with mode 0600 (dotenv payloads may contain secrets). Refuses to replace an existing file unless overwrite=true.",
			inputSchema: {
				app,
				path,
				file: z.string().optional().default(".env"),
				maskSecrets: z.boolean().optional().default(false),
				overwrite: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, path: dir, file, maskSecrets, overwrite }) => {
			const target = resolve(dir ?? process.cwd(), file ?? ".env");
			// The CLI's `env pull` confirms before clobbering an existing file;
			// over MCP that consent is the explicit overwrite flag.
			if (existsSync(target) && !overwrite) {
				return errorResult({
					error: `${target} already exists.`,
					code: "PRECONDITION_FAILED",
					remediation: "Pass overwrite:true to replace it.",
				});
			}
			return withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const result = (await client.envVariable.export.query({
					applicationId,
					format: "dotenv",
					maskSecrets: maskSecrets ?? false,
				})) as { content: string };
				const text = result.content;
				writeFileSync(target, text, { mode: 0o600 });
				// writeFileSync's mode only applies when the file is CREATED —
				// tighten an existing file too, so pulled secrets never sit in a
				// world-readable .env.
				chmodSync(target, 0o600);
				return { app: { applicationId, name }, wrote: target, bytes: text.length };
			});
		},
	);

	server.registerTool(
		"env_push",
		{
			title: "Push a local .env file to the app",
			description:
				"Reads <path>/<file> and uploads it via envVariable.import with merge/upsert semantics — existing keys are updated and absent ones are left alone. Remove keys with env_unset.",
			inputSchema: {
				app,
				path,
				file: z.string().optional().default(".env"),
				restart: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, path: dir, file, restart }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const source = resolve(dir ?? process.cwd(), file ?? ".env");
				// Upload the RAW file like `tarout env push` does — a local
				// parse/re-serialize round-trip can only lose information the
				// platform's own parser handles.
				const content = readFileSync(source, "utf8");
				const result = (await client.envVariable.import.mutate({
					applicationId,
					content,
					format: "dotenv",
					// Always upsert. The CLI's `--replace` (merge=false) DELETES every
					// key absent from the file and the platform only accepts it
					// alongside restart=true (apiImportEnvVariables.superRefine), so
					// it is deliberately not reachable from an agent-driven tool.
					merge: true,
					restart: restart ?? false,
				})) as unknown;
				return { app: { applicationId, name }, source, result };
			}),
	);
}
