/**
 * @fileoverview The environment a LOCAL process gets for a Tarout app. Shared by
 * `tarout run`, `tarout dev` and `tarout build`, so all three inject the same
 * variables.
 *
 * `envVariable.list` returns a managed database's private route (DATABASE_URL,
 * PGHOST, ...) as a placeholder sentence, because that route only resolves
 * inside the platform. Injected as-is, a local process got a DATABASE_URL that
 * failed with a baffling parse error. So placeholders are dropped, and
 * `application.connections` supplies the externally reachable values instead.
 * A database it cannot connect (external access off, unsupported engine) is
 * reported with the platform's hint and its keys are left unset.
 * @module lib/app-env
 */

import { isMissingProcedureError } from "./errors.js";
import { warn } from "./output.js";
import { envVarsToObject } from "./process.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/**
 * The sentence the platform returns in place of a managed database route.
 * Copied verbatim from cloud `src/server/services/database-customer-details.ts`
 * (`MANAGED_DATABASE_ENV_PLACEHOLDER`).
 */
export const MANAGED_DB_ENV_PLACEHOLDER =
	"[managed database route hidden; use the external database endpoint]";

function normalizeValue(value: string): string {
	return value
		.trim()
		.replace(/^(["'])([\s\S]*)\1$/, "$2")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
}

const NORMALIZED_PLACEHOLDER = normalizeValue(MANAGED_DB_ENV_PLACEHOLDER);

/** The same bracketed notice with other trailing wording, so a copy edit on the platform does not reopen the bug. */
const PLACEHOLDER_SHAPE = /^\[managed database route hidden\b[^\]]*\]$/;

/**
 * True when a stored value is the platform's managed-database placeholder
 * rather than a real value. Tolerates surrounding whitespace or quotes, case,
 * and a reworded tail; a value that merely CONTAINS the words is not matched.
 */
export function isManagedDbEnvPlaceholder(
	value: string | null | undefined,
): boolean {
	if (typeof value !== "string") return false;
	const normalized = normalizeValue(value);
	return (
		normalized === NORMALIZED_PLACEHOLDER || PLACEHOLDER_SHAPE.test(normalized)
	);
}

/** A database `application.connections` could not provide local values for. */
export interface UnavailableConnection {
	databaseId: string;
	name: string;
	engine: "postgres" | "mysql";
	keys: string[];
	reason: "external_access_disabled" | "engine_unsupported";
	hint: string;
}

export interface AppEnv {
	/** What to inject: stored values minus placeholders, then the connections. */
	env: Record<string, string>;
	/** Databases whose keys were left unset, each with the platform's hint. */
	unavailable: UnavailableConnection[];
	/** Keys whose stored value was the placeholder, so they were not injected. */
	hiddenKeys: string[];
	/** False when the server predates `application.connections`. */
	connectionsSupported: boolean;
}

interface ConnectionsResponse {
	env?: Record<string, unknown> | null;
	unavailable?: UnavailableConnection[] | null;
}

/**
 * Resolves the app's local environment. Values are never logged here or by the
 * callers. An error from either procedure propagates, except a server that has
 * no `application.connections` yet, which yields `connectionsSupported: false`
 * and no database keys.
 */
export async function resolveAppEnv(
	client: TrpcClient,
	applicationId: string,
): Promise<AppEnv> {
	const variables = await client.envVariable.list.query({
		applicationId,
		includeValues: true,
	});

	const env: Record<string, string> = {};
	const hiddenKeys: string[] = [];
	for (const [key, value] of Object.entries(envVarsToObject(variables ?? []))) {
		if (isManagedDbEnvPlaceholder(value)) {
			hiddenKeys.push(key);
		} else {
			env[key] = value;
		}
	}

	let connections: ConnectionsResponse | null = null;
	try {
		connections = (await client.application.connections.query({
			applicationId,
		})) as ConnectionsResponse;
	} catch (err) {
		if (!isMissingProcedureError(err)) throw err;
	}
	if (!connections) {
		return { env, unavailable: [], hiddenKeys, connectionsSupported: false };
	}

	const unavailable = Array.isArray(connections.unavailable)
		? connections.unavailable
		: [];
	for (const entry of unavailable) {
		for (const key of entry.keys ?? []) delete env[key];
	}
	for (const [key, value] of Object.entries(connections.env ?? {})) {
		if (typeof value === "string" && !isManagedDbEnvPlaceholder(value)) {
			env[key] = value;
		}
	}
	return { env, unavailable, hiddenKeys, connectionsSupported: true };
}

/**
 * Prints (to stderr, human mode only) why database keys were left unset: one
 * line per unavailable database carrying the platform's hint, or a single line
 * when the server cannot provide connections at all.
 */
export function reportAppEnvNotices(result: AppEnv): void {
	for (const entry of result.unavailable) {
		const keys = entry.keys?.length ? ` Left unset: ${entry.keys.join(", ")}.` : "";
		warn(`Database "${entry.name}" is not connected locally. ${entry.hint}${keys}`);
	}
	if (!result.connectionsSupported) {
		const keys = result.hiddenKeys.length
			? ` Left unset: ${result.hiddenKeys.join(", ")}.`
			: "";
		warn(
			`This Tarout server cannot provide database connections for local runs yet (no application.connections), so no managed database variables were injected.${keys}`,
		);
	}
}

/**
 * The unavailable databases for a `--json` result (names, keys and hints, never
 * values), or nothing when every database was connected.
 */
export function unavailableEnvField(
	result: AppEnv,
): { unavailableEnv?: UnavailableConnection[] } {
	return result.unavailable.length > 0
		? { unavailableEnv: result.unavailable }
		: {};
}
