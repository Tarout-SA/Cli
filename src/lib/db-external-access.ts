/**
 * @fileoverview Shared load-merge-update for `postgres.updateExternalAccess`.
 * The server REPLACES the stored allowlist/public/ssl with whatever the call
 * sends (an omitted field is wiped to its default), so every caller — the CLI
 * `db external-access` command and the MCP `db_external_access` tool — must
 * load the current row and preserve each field the caller didn't explicitly
 * change, matching the dashboard, which edits the loaded values in place.
 * @module lib/db-external-access
 */

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export interface ExternalAccessOverrides {
	enabled?: boolean;
	allowedCidrs?: string[];
	public?: boolean;
	requireSsl?: boolean;
}

export interface ExternalAccessSettings {
	enabled: boolean;
	allowedCidrs: string[];
	public: boolean;
	requireSsl: boolean;
}

/**
 * Loads the database's current external-access config, overlays the caller's
 * overrides (an `undefined` override keeps the stored value), and sends the
 * full replacement payload. Returns both the effective settings and the raw
 * mutation result.
 */
export async function updateExternalAccessMerged(
	client: TrpcClient,
	postgresId: string,
	overrides: ExternalAccessOverrides,
): Promise<{ settings: ExternalAccessSettings; result: unknown }> {
	const current = (await client.postgres.one.query({
		postgresId,
	})) as Record<string, unknown>;
	const settings: ExternalAccessSettings = {
		enabled:
			overrides.enabled ?? (current.externalAccessEnabled as boolean) ?? false,
		allowedCidrs:
			overrides.allowedCidrs ??
			(current.externalAllowedCidrs as string[]) ??
			[],
		public:
			overrides.public ?? (current.externalPublicAccess as boolean) ?? false,
		requireSsl:
			overrides.requireSsl ?? (current.externalSslRequired as boolean) ?? false,
	};
	const result = (await client.postgres.updateExternalAccess.mutate({
		postgresId,
		...settings,
	})) as unknown;
	return { settings, result };
}
