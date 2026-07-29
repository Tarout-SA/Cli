/**
 * Escape-hatch MCP tools: `call`, `list_procedures`, `describe_procedure`.
 *
 * Covers every long-tail tRPC procedure not surfaced as a curated tool.
 * `describe_procedure` fetches JSON Schemas from the hosted /api/mcp endpoint
 * and caches the result for the lifetime of the process.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getApiClient } from "../../lib/api.js";
import { getApiUrl } from "../../lib/config.js";
import {
	fetchManifestFresh,
	loadManifest,
	type ManifestEntry,
} from "../../lib/surface-manifest.js";
import { withAuth } from "../runtime.js";

// Discovery tools reach the hosted control plane; a hung host must surface a
// clean MCP error instead of blocking the call forever. Every network await
// below is bounded by this budget.
const DISCOVERY_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				Object.assign(
					new Error(`${label} timed out after ${DISCOVERY_TIMEOUT_MS}ms.`),
					{ data: { code: "TIMEOUT" } },
				),
			);
		}, DISCOVERY_TIMEOUT_MS);
	});
	return Promise.race([promise, timeout]).finally(() =>
		clearTimeout(timer),
	) as Promise<T>;
}

async function resolveEntry(procedure: string): Promise<ManifestEntry | undefined> {
	const client = getApiClient();
	const apiUrl = getApiUrl();
	let manifest = await withTimeout(
		loadManifest(client, apiUrl),
		"Manifest load",
	);
	let entry = manifest.find((m) => m.path === procedure);
	if (!entry) {
		// Cache MISS — refetch to guard against stale cache never seeing a new
		// procedure. If it's still absent, it's genuinely unknown.
		manifest = await withTimeout(
			fetchManifestFresh(client, apiUrl),
			"Manifest refetch",
		);
		entry = manifest.find((m) => m.path === procedure);
	}
	return entry;
}

export function registerCallTools(server: McpServer): void {
	server.registerTool(
		"call",
		{
			title: "Call a raw platform procedure",
			description:
				"Dispatches any exposed tRPC procedure (dot-path). Use list_procedures / describe_procedure to discover shapes. Prefer curated tools when they exist.",
			inputSchema: {
				procedure: z
					.string()
					.describe("Procedure dot-path, e.g. `application.allByOrganization`."),
				input: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("JSON input for the procedure. Default: empty object."),
			},
		},
		async ({ procedure, input }) =>
			withAuth(async (client) => {
				const entry = await resolveEntry(procedure);
				if (!entry) {
					// toEnvelope honors top-level `code` + `remediation` on thrown
					// errors, so this surfaces as a stable NOT_FOUND envelope.
					throw Object.assign(new Error(`Unknown procedure: ${procedure}`), {
						code: "NOT_FOUND",
						remediation: "Run list_procedures to see the current surface.",
					});
				}
				// Walk every dot segment so a nested-router path dispatches to the
				// leaf procedure. The tRPC proxy answers ANY property path, so the
				// manifest lookup above is the real existence gate.
				const node = procedure
					.split(".")
					// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy walk.
					.reduce<any>((acc, segment) => acc?.[segment], client);
				return entry.type === "mutation"
					? await node.mutate(input ?? {})
					: await node.query(input ?? {});
			}, procedure),
	);

	server.registerTool(
		"list_procedures",
		{
			title: "List all callable platform procedures",
			description:
				"Returns the full manifest (name + query/mutation). Optional `filter` matches procedures whose path contains the substring.",
			inputSchema: {
				filter: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ filter }) =>
			await withAuth(async (client) => {
				const manifest = await withTimeout(
					fetchManifestFresh(client, getApiUrl()),
					"Manifest fetch",
				);
				const matched = manifest.filter(
					(m) => !filter || m.path.includes(filter),
				);
				return { count: matched.length, procedures: matched };
			}),
	);

	server.registerTool(
		"describe_procedure",
		{
			title: "Describe a procedure's input schema",
			description:
				"Returns the JSON Schema the hosted MCP endpoint advertises for a given procedure. Useful before calling `call`.",
			inputSchema: {
				procedure: z.string(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ procedure }) =>
			await withAuth(async () => {
				const cached = await describeCache();
				const key = procedure.replace(/\./g, "__");
				const found = cached.get(key);
				if (!found) {
					throw Object.assign(new Error(`Unknown procedure: ${procedure}`), {
						code: "NOT_FOUND",
						remediation: "Run list_procedures to see the current surface.",
					});
				}
				return found;
			}, procedure),
	);
}

// Module-local cache of the hosted `/api/mcp` tools/list response. Fetched
// on first use and reused for the process lifetime — the hosted endpoint's
// tool surface only changes on server redeploys.
// biome-ignore lint/suspicious/noExplicitAny: MCP tool objects are untyped here.
let describeCachePromise: Promise<Map<string, any>> | undefined;

// biome-ignore lint/suspicious/noExplicitAny: MCP tool objects are untyped here.
async function describeCache(): Promise<Map<string, any>> {
	if (describeCachePromise) return describeCachePromise;
	describeCachePromise = (async () => {
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StreamableHTTPClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/streamableHttp.js"
		);
		const { getToken } = await import("../../lib/config.js");
		const token = getToken() ?? "";
		const client = new Client(
			{ name: "tarout-mcp-describe", version: "0" },
			{ capabilities: {} },
		);
		const transport = new StreamableHTTPClientTransport(
			new URL(`${getApiUrl()}/api/mcp`),
			{ requestInit: { headers: token ? { "x-api-key": token } : {} } },
		);
		await withTimeout(client.connect(transport), "MCP connect");
		const list = await withTimeout(client.listTools(), "MCP tools/list");
		await client.close();
		// biome-ignore lint/suspicious/noExplicitAny: MCP tool objects are untyped here.
		const map = new Map<string, any>();
		for (const tool of list.tools) map.set(tool.name, tool);
		return map;
	})().catch((err) => {
		// Reset on failure so a transient network error doesn't poison the cache.
		describeCachePromise = undefined;
		throw err;
	});
	return describeCachePromise;
}
