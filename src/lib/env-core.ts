/**
 * @fileoverview Shared dotenv parse/serialize helpers and an application
 * reference resolver. Extracted from `commands/env.ts` so the local MCP
 * server's `env_*` tools can reuse the same behavior.
 * @module lib/env-core
 */

import { NotFoundError } from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/**
 * Parses a dotenv-formatted string into a plain object.
 *
 * Supports:
 * - `KEY=value` pairs
 * - Double-quoted values (`KEY="hello world"`) — quotes stripped and the
 *   standard dotenv escapes (`\n`, `\r`, `\"`, `\\`) interpreted
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
			if (first === '"' && last === '"') {
				out[key] = value
					.slice(1, -1)
					.replace(/\\([nr"\\])/g, (_m, c: string) =>
						c === "n" ? "\n" : c === "r" ? "\r" : c,
					);
				continue;
			}
			if (first === "'" && last === "'") {
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
 * - Backslashes, double quotes and newlines inside a quoted value are escaped
 *   (`\\`, `\"`, `\n`, `\r`) so a multiline value stays ONE physical line —
 *   an unescaped newline would split the value across lines that no
 *   line-based dotenv parser (including parseDotenv above) can round-trip.
 * - Output always ends with a trailing newline.
 */
export function serializeDotenv(vars: Record<string, string>): string {
	const keys = Object.keys(vars).sort();
	return `${keys
		.map((k) => {
			const v = vars[k] ?? "";
			const needsQuote = /[\s="\\]/.test(v);
			if (!needsQuote) return `${k}=${v}`;
			const escaped = v
				.replace(/\\/g, "\\\\")
				.replace(/"/g, '\\"')
				.replace(/\n/g, "\\n")
				.replace(/\r/g, "\\r");
			return `${k}="${escaped}"`;
		})
		.join("\n")}\n`;
}

const ID_SHAPE = /^(app_|[0-9a-f]{8}-)/i;

/**
 * Resolves an application reference (id, name, or slug) against the caller's
 * organization to a `{ applicationId, name }` tuple.
 *
 * Recognized id shapes: `app_*` prefix or a UUID-looking `xxxxxxxx-` head.
 * Falls back to an exact name match, then to the CLI's relaxed matching
 * (commands/jobs.ts findApp): case-insensitive display name and the generated
 * `appName` slug — e.g. creating "My App" yields slug "my-app", which agents
 * naturally reuse as the ref.
 *
 * Throws `NotFoundError` when no application matches.
 */
export async function resolveAppRef(
	client: TrpcClient,
	ref: string,
): Promise<{ applicationId: string; name: string }> {
	const apps = (await client.application.allByOrganization.query()) as Array<{
		applicationId: string;
		name: string;
		appName?: string;
	}>;
	if (ID_SHAPE.test(ref)) {
		const byId = apps.find((a) => a.applicationId === ref);
		if (byId) return { applicationId: byId.applicationId, name: byId.name };
	}
	const byName = apps.find((a) => a.name === ref);
	if (byName) return { applicationId: byName.applicationId, name: byName.name };
	const lower = ref.toLowerCase();
	const relaxed = apps.find(
		(a) =>
			a.name.toLowerCase() === lower || a.appName?.toLowerCase() === lower,
	);
	if (relaxed) {
		return { applicationId: relaxed.applicationId, name: relaxed.name };
	}
	throw new NotFoundError("Application", ref);
}
