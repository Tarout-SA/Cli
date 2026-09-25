/**
 * @fileoverview Rules for Tarout managed databases that both the `tarout db` /
 * `tarout backups` commands and the MCP db tools apply, so the two surfaces
 * refuse the same requests with the same words. Each rule mirrors a check the
 * platform makes (cloud/src/server/api/routers/postgres.ts, mysql.ts,
 * backup.ts and services/postgres-console.ts); running it here explains the
 * problem before a request is sent instead of surfacing an opaque server error.
 * @module lib/managed-db
 */

/**
 * `postgres.changeStatus` only writes a status column: it never stops or
 * starts anything, FREE databases are refused outright, and a paid database
 * would be shown as "stopped" while it keeps running. So neither the CLI nor
 * MCP calls it.
 */
export const MANAGED_DB_LIFECYCLE_MESSAGE =
	"Managed databases run on shared hosts and cannot be stopped, started or restarted. A database stays online for as long as it exists; to stop paying for one, delete it with `tarout db delete <db>`. A free database that was deactivated for inactivity comes back with `tarout db reactivate <db>`.";

/** `mysql.create` always throws PRECONDITION_FAILED on the platform. */
export const MYSQL_CREATE_UNAVAILABLE_MESSAGE =
	"MySQL databases are not available on Tarout. Only PostgreSQL databases can be created.";

/**
 * `postgres.updateExternalAccess` refuses `enabled && !requireSsl`, and the
 * pooler never accepts a plaintext connection.
 */
export const EXTERNAL_ACCESS_TLS_MESSAGE =
	"External access always requires TLS, so it cannot be enabled without it. Connect with sslmode=require (the connection string from `tarout db info` already sets it).";

/** `postgres.updateExternalAccess` takes at most 20 allowlist entries. */
export const EXTERNAL_ACCESS_MAX_CIDRS = 20;

/** The pooler port. External clients never reach a backend on 5432. */
export const EXTERNAL_POOLER_DEFAULT_PORT = 6432;

/** `postgres.executeSql` accepts at most this many characters per call. */
export const CONSOLE_SQL_MAX_CHARS = 10_000;

// Mirrors BLOCKED_SQL_RE in the platform's services/postgres-console.ts. The
// server refuses any SQL it matches; keep the two identical so this never
// refuses something the server would run.
const BLOCKED_SQL_RE =
	/\b(alter\s+(role|user)|create\s+(database|role|user)|drop\s+(database|role|user)|grant\b|revoke\b)\b/i;

// `COPY ... FROM stdin` expects its rows to be streamed over the client
// connection after the statement. The console runs plain queries with no
// input stream, so the rows can never arrive. pg_dump writes table data this
// way unless told to use INSERT statements.
const COPY_FROM_STDIN_RE = /\bcopy\b[^;]*?\bfrom\s+stdin\b/i;

const PSQL_FALLBACK =
	"load the file with psql over external access instead, for example `tarout db connect <db> < dump.sql`";

/**
 * Why the platform's SQL console would refuse (or fail on) this SQL, or null
 * when it can be sent. Callers send `sql.trim()`: the platform trims before it
 * executes, and trimming keeps blank lines from counting against the cap.
 */
export function consoleSqlProblem(sql: string): string | null {
	const trimmed = sql.trim();
	const problems: string[] = [];
	if (trimmed.length > CONSOLE_SQL_MAX_CHARS) {
		problems.push(
			`This SQL is ${trimmed.length.toLocaleString("en-US")} characters, and the Tarout SQL console accepts at most ${CONSOLE_SQL_MAX_CHARS.toLocaleString("en-US")} per call. Split it into smaller files, or ${PSQL_FALLBACK}.`,
		);
	}
	if (COPY_FROM_STDIN_RE.test(trimmed)) {
		problems.push(
			`This SQL uses COPY ... FROM stdin, which the SQL console cannot feed rows to. Re-export with \`pg_dump --inserts\` (or --column-inserts), or ${PSQL_FALLBACK}.`,
		);
	}
	if (BLOCKED_SQL_RE.test(trimmed)) {
		problems.push(
			"The SQL console blocks GRANT, REVOKE and role or database-level statements (CREATE/ALTER/DROP ROLE or USER, CREATE/DROP DATABASE). Remove them, for example by re-exporting with `pg_dump --no-owner --no-privileges`.",
		);
	}
	return problems.length > 0 ? problems.join(" ") : null;
}

/** Human-readable byte size (1024-based), e.g. `5.0 MB`. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.max(
		0,
		Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
	);
	return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
