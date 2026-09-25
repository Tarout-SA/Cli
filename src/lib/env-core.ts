/**
 * @fileoverview Shared dotenv parse/serialize helpers and an application
 * reference resolver. Extracted from `commands/env.ts` so the local MCP
 * server's `env_*` tools can reuse the same behavior.
 * @module lib/env-core
 */

import { InvalidArgumentError, NotFoundError } from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/**
 * Parses a dotenv-formatted string into a plain object.
 *
 * Supports:
 * - `KEY=value` pairs
 * - Double-quoted values (`KEY="hello world"`) — quotes stripped
 * - Single-quoted values (`KEY='raw\nstring'`) — quotes stripped, escapes NOT interpreted
 * - `#` line comments and inline ` #` trailing comments outside quoted values
 * - Blank lines
 *
 * Values are NOT re-interpolated (no `${VAR}` expansion).
 */
export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (!key) continue;
		let value = line.slice(eq + 1);
		// Preserve leading/trailing whitespace inside quotes; trim only when unquoted.
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				out[key] = value.slice(1, -1);
				continue;
			}
		}
		value = value.trim();
		const hash = value.indexOf(" #");
		if (hash !== -1) value = value.slice(0, hash).trim();
		out[key] = value;
	}
	return out;
}

/**
 * Serializes a key/value map to a dotenv-formatted string.
 *
 * - Keys are emitted in sorted order (deterministic output).
 * - Values are quoted with double quotes when they contain whitespace,
 *   `=`, `"`, or a backslash.
 * - Double quotes inside a quoted value are escaped as `\"`.
 * - Output always ends with a trailing newline.
 */
export function serializeDotenv(vars: Record<string, string>): string {
	const keys = Object.keys(vars).sort();
	return `${keys
		.map((k) => {
			const v = vars[k] ?? "";
			const needsQuote = /[\s="\\]/.test(v);
			if (!needsQuote) return `${k}=${v}`;
			const escaped = v.replace(/"/g, '\\"');
			return `${k}="${escaped}"`;
		})
		.join("\n")}\n`;
}

/** Shortest id prefix accepted, so a short typo cannot select an app. */
const MIN_ID_PREFIX = 4;

function candidates(apps: Array<{ applicationId: string; name: string }>) {
	return apps.map((a) => `${a.name} (${a.applicationId})`).join(", ");
}

/**
 * Resolves an application reference (id, name, slug or unique id prefix)
 * against the caller's organization to a `{ applicationId, name }` tuple.
 *
 * Order: exact id, exact name, exact slug (`appName`), then a unique id
 * prefix of at least 4 characters (the CLI prints 8-character prefixes).
 * Application ids are nanoids with no fixed shape, so an exact id is tried
 * first whatever it looks like.
 *
 * Throws `InvalidArgumentError` when a name or prefix matches more than one
 * app (listing the ids, so a destructive tool never guesses), and
 * `NotFoundError` when nothing matches.
 */
export async function resolveAppRef(
	client: TrpcClient,
	ref: string,
): Promise<{ applicationId: string; name: string }> {
	const apps = (await client.application.allByOrganization.query()) as Array<{
		applicationId: string;
		name: string;
		appName?: string | null;
	}>;
	const wanted = String(ref ?? "").trim();
	const pick = (a: { applicationId: string; name: string }) => ({
		applicationId: a.applicationId,
		name: a.name,
	});

	const byId = apps.find((a) => a.applicationId === wanted);
	if (byId) return pick(byId);

	const byName = apps.filter((a) => a.name === wanted);
	if (byName.length === 1) return pick(byName[0]);
	if (byName.length > 1) {
		throw new InvalidArgumentError(
			`"${ref}" matches ${byName.length} applications by name: ${candidates(byName)}. Pass the application id instead.`,
		);
	}

	const bySlug = apps.find((a) => a.appName && a.appName === wanted);
	if (bySlug) return pick(bySlug);

	if (wanted.length >= MIN_ID_PREFIX) {
		const byPrefix = apps.filter((a) => a.applicationId.startsWith(wanted));
		if (byPrefix.length === 1) return pick(byPrefix[0]);
		if (byPrefix.length > 1) {
			throw new InvalidArgumentError(
				`"${ref}" is a prefix of ${byPrefix.length} application ids: ${candidates(byPrefix)}. Pass more characters or the full id.`,
			);
		}
	}
	throw new NotFoundError("Application", ref);
}
