import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getApiUrl, isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, table } from "../lib/output.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

interface ManifestEntry {
	path: string;
	type: "query" | "mutation" | "subscription";
	router: string;
}

// Cache the surface manifest per API URL with a short TTL so an agent firing many
// `tarout call`s in a session doesn't refetch it every time. The cache is a pure
// optimization: a cache MISS for a requested procedure triggers a live refetch
// (see below), so a newly-added procedure is never wrongly reported as unknown.
const MANIFEST_TTL_MS = 5 * 60 * 1000;

function manifestCachePath(): string {
	return join(homedir(), ".tarout", "surface-manifest-cache.json");
}

async function fetchManifestFresh(
	client: any,
	apiUrl: string,
): Promise<ManifestEntry[]> {
	const manifest =
		(await client.settings.getSurfaceManifest.query()) as ManifestEntry[];
	try {
		const dir = join(homedir(), ".tarout");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		let cache: Record<string, { at: number; manifest: ManifestEntry[] }> = {};
		try {
			cache = JSON.parse(readFileSync(manifestCachePath(), "utf8"));
		} catch {
			// no/invalid cache file — start fresh
		}
		cache[apiUrl] = { at: Date.now(), manifest };
		writeFileSync(manifestCachePath(), JSON.stringify(cache), { mode: 0o600 });
	} catch {
		// caching is best-effort; never let it break the call
	}
	return manifest;
}

async function loadManifest(
	client: any,
	apiUrl: string,
): Promise<ManifestEntry[]> {
	try {
		const cache = JSON.parse(
			readFileSync(manifestCachePath(), "utf8"),
		) as Record<string, { at: number; manifest: ManifestEntry[] }>;
		const entry = cache[apiUrl];
		if (
			entry &&
			Date.now() - entry.at < MANIFEST_TTL_MS &&
			Array.isArray(entry.manifest)
		) {
			return entry.manifest;
		}
	} catch {
		// cache miss/corruption — fall through to a live fetch
	}
	return fetchManifestFresh(client, apiUrl);
}

/**
 * Generic escape hatch: call ANY exposed platform procedure directly, the same
 * way the REST and MCP surfaces do. Gives the CLI 100% coverage of the control
 * surface without a bespoke command per procedure. The curated commands remain
 * for ergonomics; `tarout call` covers everything else.
 *
 *   tarout call --list [filter]
 *   tarout call application.create --input '{"name":"my-app", ...}'
 *   tarout call deployment.all --input '{"applicationId":"..."}' --json
 */
export function registerCallCommand(program: Command) {
	program
		.command("call [procedure]")
		.description(
			"Call any platform API procedure directly (e.g. application.create). Use --list to discover.",
		)
		.option("-i, --input <json>", "JSON input for the procedure", "{}")
		.option("--input-file <path>", "Read JSON input from a file")
		.option(
			"-l, --list [filter]",
			"List callable procedures (optionally filtered by substring)",
		)
		.action(async (procedure: string | undefined, opts) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				// ── Discovery mode ──────────────────────────────────────────────
				if (opts.list !== undefined || !procedure) {
					startSpinner("Loading control surface...");
					// Always fetch fresh for discovery so the listing is never stale.
					const manifest = await fetchManifestFresh(client, getApiUrl());
					succeedSpinner();

					const filter = typeof opts.list === "string" ? opts.list : undefined;
					const matched = manifest.filter(
						(m) => !filter || m.path.includes(filter),
					);

					if (isJsonMode()) {
						outputData(matched);
						return;
					}

					if (!procedure && opts.list === undefined) {
						log(
							colors.dim(
								"No procedure given. Available procedures (call one with `tarout call <procedure> --input '{...}'`):",
							),
						);
						log("");
					}
					table(
						["Procedure", "Type"],
						matched.map((m) => [m.path, m.type]),
					);
					log("");
					log(colors.dim(`${matched.length} procedures`));
					return;
				}

				// ── Resolve the procedure's call type from the manifest ─────────
				const apiUrl = getApiUrl();
				let manifest = await loadManifest(client, apiUrl);
				let entry = manifest.find((m) => m.path === procedure);
				if (!entry) {
					// Not in the (possibly cached) manifest — refetch live before
					// declaring it unknown, so a just-added procedure still works.
					manifest = await fetchManifestFresh(client, apiUrl);
					entry = manifest.find((m) => m.path === procedure);
				}
				if (!entry) {
					throw new Error(
						`Unknown or non-exposed procedure: "${procedure}". Run \`tarout call --list\` to see what's available.`,
					);
				}

				// ── Parse input ─────────────────────────────────────────────────
				let input: unknown = {};
				const rawInput: string = opts.inputFile
					? readFileSync(opts.inputFile, "utf8")
					: opts.input;
				if (rawInput && rawInput.trim()) {
					try {
						input = JSON.parse(rawInput);
					} catch {
						throw new Error(
							`--input must be valid JSON. Received: ${rawInput}`,
						);
					}
				}

				// ── Dispatch via the untyped tRPC proxy ─────────────────────────
				const [routerKey, procKey] = procedure.split(".");
				const node = (client as Record<string, any>)[routerKey ?? ""]?.[
					procKey ?? ""
				];
				if (!node) {
					throw new Error(`Procedure path not found on client: ${procedure}`);
				}

				startSpinner(`Calling ${procedure}...`);
				const result =
					entry.type === "mutation"
						? await node.mutate(input)
						: await node.query(input);
				succeedSpinner();
				// outputData only prints under --json; in human mode it would be a
				// silent no-op (the call looks like it did nothing). Print the result.
				if (isJsonMode()) {
					outputData(result);
				} else {
					log(
						typeof result === "string"
							? result
							: JSON.stringify(result, null, 2),
					);
				}
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
