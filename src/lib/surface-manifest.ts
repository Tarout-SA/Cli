/**
 * Cached fetch of the platform's surface manifest (list of exposed tRPC
 * procedures). Shared by `tarout call` and by the local MCP server's
 * discovery + escape-hatch tools. TTL is 5 min; a cache MISS for a requested
 * path triggers a fresh refetch upstream (never a false "unknown procedure").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export interface ManifestEntry {
	path: string;
	type: "query" | "mutation" | "subscription";
	router: string;
}

const MANIFEST_TTL_MS = 5 * 60 * 1000;

export function manifestCachePath(): string {
	return join(homedir(), ".tarout", "surface-manifest-cache.json");
}

export async function fetchManifestFresh(
	client: TrpcClient,
	apiUrl: string,
): Promise<ManifestEntry[]> {
	const manifest = (await client.settings.getSurfaceManifest.query()) as ManifestEntry[];
	try {
		const dir = join(homedir(), ".tarout");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		let cache: Record<string, { at: number; manifest: ManifestEntry[] }> = {};
		try {
			cache = JSON.parse(readFileSync(manifestCachePath(), "utf8"));
		} catch {
			// no/invalid cache — start fresh
		}
		cache[apiUrl] = { at: Date.now(), manifest };
		writeFileSync(manifestCachePath(), JSON.stringify(cache), { mode: 0o600 });
	} catch {
		// caching is best-effort
	}
	return manifest;
}

export async function loadManifest(
	client: TrpcClient,
	apiUrl: string,
): Promise<ManifestEntry[]> {
	try {
		const cache = JSON.parse(readFileSync(manifestCachePath(), "utf8")) as Record<
			string,
			{ at: number; manifest: ManifestEntry[] }
		>;
		const entry = cache[apiUrl];
		if (
			entry &&
			Date.now() - entry.at < MANIFEST_TTL_MS &&
			Array.isArray(entry.manifest)
		) {
			return entry.manifest;
		}
	} catch {
		// cache miss/corruption
	}
	return fetchManifestFresh(client, apiUrl);
}
