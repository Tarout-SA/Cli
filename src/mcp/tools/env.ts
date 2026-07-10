/**
 * Curated MCP tools for environment-variable management: env_list, env_set,
 * env_unset, env_pull, env_push. All handlers route through withAuth() and
 * resolve the target application via resolveAppRef() so agents can address
 * apps by name OR id. FS-touching tools (env_pull / env_push) default their
 * working path to process.cwd() and always end up at <path>/<file>.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseDotenv, resolveAppRef, serializeDotenv } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");
const path = z.string().optional().describe("Directory (defaults to cwd).");

export function registerEnvTools(server: McpServer): void {
	server.registerTool(
		"env_list",
		{
			title: "List environment variables of an app",
			description:
				"Returns keys (and values when reveal=true) for the selected environment. Wraps envVariable.list.",
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
				"Removes the given keys from the app's environment. Re-uploads the current environment minus the removed keys via envVariable.import with merge=false — destructive: any drift between list and import is overwritten.",
			inputSchema: {
				app,
				keys: z.array(z.string()).min(1),
				restart: z.boolean().optional().default(false),
			},
			annotations: { destructiveHint: true },
		},
		async ({ app: appRef, keys, restart }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const existing = (await client.envVariable.list.query({
					applicationId,
					includeValues: true,
				})) as Array<{ key: string; value?: string }>;
				const keep = existing
					.filter((v) => !keys.includes(v.key))
					.reduce<Record<string, string>>((acc, v) => {
						acc[v.key] = v.value ?? "";
						return acc;
					}, {});
				const content = serializeDotenv(keep);
				const result = (await client.envVariable.import.mutate({
					applicationId,
					content,
					format: "dotenv",
					merge: false,
					restart: restart ?? false,
				})) as unknown;
				return { app: { applicationId, name }, removed: keys, result };
			}),
	);

	server.registerTool(
		"env_pull",
		{
			title: "Write the app's environment to a local .env file",
			description:
				"Downloads variables via envVariable.export (dotenv format) and writes them to <path>/<file>. The file is created with mode 0600 because dotenv payloads may contain secrets.",
			inputSchema: {
				app,
				path,
				file: z.string().optional().default(".env"),
				maskSecrets: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, path: dir, file, maskSecrets }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const text = (await client.envVariable.export.query({
					applicationId,
					format: "dotenv",
					maskSecrets: maskSecrets ?? false,
				})) as string;
				const target = resolve(dir ?? process.cwd(), file ?? ".env");
				writeFileSync(target, text, { mode: 0o600 });
				return { app: { applicationId, name }, wrote: target, bytes: text.length };
			}),
	);

	server.registerTool(
		"env_push",
		{
			title: "Push a local .env file to the app",
			description:
				"Reads <path>/<file> as dotenv and uploads via envVariable.import (merge default true).",
			inputSchema: {
				app,
				path,
				file: z.string().optional().default(".env"),
				merge: z.boolean().optional().default(true),
				restart: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, path: dir, file, merge, restart }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const source = resolve(dir ?? process.cwd(), file ?? ".env");
				const raw = readFileSync(source, "utf8");
				const content = serializeDotenv(parseDotenv(raw));
				const result = (await client.envVariable.import.mutate({
					applicationId,
					content,
					format: "dotenv",
					merge: merge ?? true,
					restart: restart ?? false,
				})) as unknown;
				return { app: { applicationId, name }, source, result };
			}),
	);
}
