/**
 * @fileoverview The organization's agent credentials, shared by
 * `tarout agent sessions` and the stdio MCP `agent_sessions` tool. Wraps the
 * platform's `user.listApiKeys`.
 *
 * Two kinds of row come back from that one procedure:
 * - OAuth connections: the hosted MCP connector mints an operator-tier API key
 *   per authorization, named `<client> (OAuth)` with prefix `mcp`
 *   (cloud `oauth-server.ts`, `mintOauthAccessToken`). Access tokens live 30
 *   days, so expired rows are normal.
 * - API keys: dashboard, onboarding and `tarout login` keys (`agent`, `cli`, or
 *   a custom prefix).
 *
 * The procedure returns the CALLING user's keys in the active organization, not
 * every member's. It never returns the key itself, but it does return `start`,
 * the key's first characters: that field is dropped here so no caller can
 * print it. Revoking or pausing a credential is a human action in the
 * dashboard (Agent > Keys); the platform refuses those mutations to API keys,
 * so nothing here offers them.
 * @module lib/agent-sessions
 */

import { agentDashboardUrl } from "./approvals.js";
import { CliError, isMissingProcedureError } from "./errors.js";
import { ExitCode } from "../utils/exit-codes.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/** The prefix the platform gives OAuth-minted access keys. */
export const OAUTH_KEY_PREFIX = "mcp";

const OAUTH_NAME_SUFFIX = / \(OAuth\)$/;

export type AgentSessionKind = "oauth" | "api_key";
export type AgentSessionStatus = "active" | "paused" | "expired";

export interface AgentSession {
	id: string;
	kind: AgentSessionKind;
	/** OAuth rows: the client name without the ` (OAuth)` suffix. */
	name: string;
	prefix: string | null;
	/** `read_only`, `operator` or `full`. */
	tier: string;
	/** null = every area; a list restricts the credential. */
	areas: string[] | null;
	enabled: boolean;
	status: AgentSessionStatus;
	projectId: string | null;
	requestCount: number | null;
	createdAt: string | null;
	lastUsedAt: string | null;
	expiresAt: string | null;
}

/**
 * Grouped result. The group names deliberately avoid "apiKey" and "token": the
 * MCP result sanitizer redacts any field whose name contains them, which would
 * blank the whole list.
 */
export interface AgentSessionList {
	oauthConnections: AgentSession[];
	keys: AgentSession[];
	/** Where a human revokes or pauses any of these. */
	dashboardUrl: string;
}

interface RawApiKeyRow {
	id?: unknown;
	name?: unknown;
	prefix?: unknown;
	enabled?: unknown;
	requestCount?: unknown;
	lastRequest?: unknown;
	expiresAt?: unknown;
	createdAt?: unknown;
	scope?: { projectId?: unknown } | null;
	tier?: unknown;
	areas?: unknown;
}

function isoOrNull(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	const date = value instanceof Date ? value : new Date(String(value));
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * One platform row, reduced to what is safe to show. Built field by field
 * (never spread) so `start`, `permissions` or anything the server adds later
 * cannot leak through.
 */
export function toAgentSession(
	row: RawApiKeyRow,
	now: number = Date.now(),
): AgentSession {
	const prefix = stringOrNull(row.prefix);
	const kind: AgentSessionKind =
		prefix === OAUTH_KEY_PREFIX ? "oauth" : "api_key";
	const rawName = stringOrNull(row.name) ?? "";
	const name =
		(kind === "oauth" ? rawName.replace(OAUTH_NAME_SUFFIX, "") : rawName) ||
		"(unnamed)";
	const enabled = row.enabled !== false;
	const expiresAt = isoOrNull(row.expiresAt);
	const expired = expiresAt !== null && new Date(expiresAt).getTime() <= now;
	return {
		id: String(row.id ?? ""),
		kind,
		name,
		prefix,
		tier: stringOrNull(row.tier) ?? "full",
		areas: Array.isArray(row.areas)
			? row.areas.filter((area): area is string => typeof area === "string")
			: null,
		enabled,
		status: expired ? "expired" : enabled ? "active" : "paused",
		projectId: stringOrNull(row.scope?.projectId),
		requestCount:
			typeof row.requestCount === "number" ? row.requestCount : null,
		createdAt: isoOrNull(row.createdAt),
		lastUsedAt: isoOrNull(row.lastRequest),
		expiresAt,
	};
}

/**
 * An older server without the procedure, as a readable NOT_FOUND. Refusals
 * (FORBIDDEN) pass through untouched: the CLI command and the MCP runtime each
 * explain them in their own envelope.
 */
function missingProcedureError(err: unknown): CliError | undefined {
	if (!isMissingProcedureError(err)) return undefined;
	return new CliError(
		"This Tarout server cannot list agent sessions (user.listApiKeys is missing). Review agent access in the dashboard instead.",
		ExitCode.NOT_FOUND,
		undefined,
		{
			procedure: "user.listApiKeys",
			reason: "procedure_unavailable",
			dashboardUrl: agentDashboardUrl(),
		},
	);
}

/** Every agent credential of the calling user in the active organization. */
export async function listAgentSessions(
	client: TrpcClient,
	options: { now?: number } = {},
): Promise<AgentSessionList> {
	let rows: unknown;
	try {
		rows = await client.user.listApiKeys.query();
	} catch (err) {
		throw missingProcedureError(err) ?? err;
	}
	const now = options.now ?? Date.now();
	const sessions = (Array.isArray(rows) ? rows : []).map((row) =>
		toAgentSession((row ?? {}) as RawApiKeyRow, now),
	);
	return {
		oauthConnections: sessions.filter((session) => session.kind === "oauth"),
		keys: sessions.filter((session) => session.kind === "api_key"),
		dashboardUrl: agentDashboardUrl(),
	};
}
