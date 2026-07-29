/**
 * Curated MCP tools for database management. Each tool takes a
 * `type: "postgres" | "mysql"` param (except db_list, which fans out to both
 * engines) so agents pick the engine explicitly instead of the tool
 * disambiguating by lookup. resolveDbRef() accepts a name OR id (`postgresId` /
 * `mysqlId`) using the same list-then-match approach as resolveAppRef().
 *
 * Tools (grouped by annotation):
 *  READ (readOnlyHint):
 *   - db_list ............ postgres.allByOrganization + mysql.allByOrganization
 *   - db_info ............ postgres.one / mysql.one
 *   - db_credentials ..... postgres.one (external pooler fields; postgres-only)
 *   - db_tables .......... postgres.listTables (postgres-only)
 *   - db_preview ......... postgres.previewTable (postgres-only)
 *   - db_analytics ....... postgres.getAnalytics (postgres-only)
 *   - db_stats ........... postgres.sharedStats / mysql.sharedStats
 *   - db_backups ......... backup.listByDatabase (schedules)
 *   - db_backup_download . backup.getBackupDownloadUrl (signed URL — read-only)
 *  CONTROL (mutating, not destructive — no hint):
 *   - db_create .......... postgres.create / mysql.create
 *   - db_sql ............. postgres.executeSql (postgres-only)
 *   - db_import .......... postgres.executeSql from `sql` or a local `file` (postgres-only)
 *   - db_restart ......... postgres/mysql.changeStatus → "running"
 *   - db_stop ............ postgres/mysql.changeStatus → "stopped"
 *   - db_reactivate ...... postgres/mysql.reactivate
 *   - db_update .......... postgres/mysql.update (name / description)
 *   - db_attach .......... postgres/mysql.attachToApplication
 *   - db_detach .......... postgres/mysql.detachFromApplication
 *   - db_external_access . postgres.updateExternalAccess (postgres-only; load-merge)
 *   - db_backup_now ...... backup.manualBackupPostgres / manualBackupMySql
 *  DESTRUCTIVE (destructiveHint):
 *   - db_delete .......... postgres.remove / mysql.remove
 *   - db_restore ......... backup.restoreBackupWithLogs — see note below
 *
 * Postgres-only tools (db_sql / db_import / db_tables / db_preview /
 * db_analytics / db_external_access) reject MySQL with INVALID_ARGUMENTS BEFORE withAuth so
 * callers see the argument problem instead of an auth error when
 * unauthenticated. All of them share postgresOnlyRejection().
 *
 * db_credentials is intentionally external-only. MCP clients run outside the
 * platform network, so private provider routes are neither useful nor safe to
 * expose. PostgreSQL uses the explicit external pooler fields; engines without
 * an external endpoint return a precondition error.
 *
 * db_external_access shares lib/db-external-access.ts with the CLI command:
 * the server REPLACES the stored allowlist/public/ssl with whatever the call
 * sends, so the helper loads the current row first and preserves every field
 * the caller didn't override.
 *
 * db_backup_now takes a backup SCHEDULE id (from db_backups), not a database
 * ref — matching backup.manualBackup* whose input is `{ backupId }`.
 *
 * db_restore is present with the full apiRestoreBackup input shape and a
 * destructiveHint, but the platform exposes restore ONLY as a streaming tRPC
 * subscription (backup.restoreBackupWithLogs). The httpBatchLink transport used
 * here (and by the CLI) cannot drive a subscription, so — exactly like
 * `tarout backups restore` — the tool refuses with clear guidance instead of
 * firing a doomed request. Swap in a mutation-based restore endpoint if one is
 * added platform-side.
 */
import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCurrentProfile } from "../../lib/config.js";
import { updateExternalAccessMerged } from "../../lib/db-external-access.js";
import { NotFoundError } from "../../lib/errors.js";
import { generateSlug } from "../../utils/slug.js";
import { errorResult, type TrpcClient, withAuth } from "../runtime.js";

const dbType = z.enum(["postgres", "mysql"]).describe("Database engine.");
const dbRef = z.string().describe("Database name or id.");

// Default images per engine, matching commands/db.ts. postgres.create /
// mysql.create both require `dockerImage`.
const DEFAULT_DOCKER_IMAGE = {
	postgres: "postgres:17",
	mysql: "mysql:8",
} as const;

/**
 * Resolves a name-or-id reference by listing all databases of the given
 * engine and matching. Mirrors resolveAppRef() but routes to
 * `postgres.allByOrganization` / `mysql.allByOrganization`.
 *
 * Returns the matched `{id, name}` plus the engine's `router` (tRPC
 * sub-router) and `idKey` ("postgresId" / "mysqlId") so handlers don't
 * re-derive the engine ternaries on every call.
 *
 * Throws `NotFoundError` when no match is found — this maps to `NOT_FOUND`
 * in the tool envelope via `toEnvelope()`.
 */
async function resolveDbRef(
	client: TrpcClient,
	ref: string,
	type: "postgres" | "mysql",
): Promise<{
	id: string;
	name: string;
	router: TrpcClient;
	idKey: "postgresId" | "mysqlId";
}> {
	const router = type === "postgres" ? client.postgres : client.mysql;
	const idKey = type === "postgres" ? "postgresId" : "mysqlId";
	const list = (await router.allByOrganization.query()) as Array<
		Record<string, unknown>
	>;
	const match = list.find((d) => d[idKey] === ref || d.name === ref);
	if (!match) {
		throw new NotFoundError(
			type === "postgres" ? "Postgres database" : "MySQL database",
			ref,
		);
	}
	return {
		id: match[idKey] as string,
		name: match.name as string,
		router,
		idKey,
	};
}

/**
 * Pre-auth rejection for postgres-only tools: a MySQL request is turned away
 * with INVALID_ARGUMENTS BEFORE withAuth so the caller sees the argument
 * problem instead of an auth error when unauthenticated.
 */
function postgresOnlyRejection(tool: string) {
	return errorResult({
		error: `${tool} is postgres-only; use \`call\` for mysql-specific ops.`,
		code: "INVALID_ARGUMENTS",
	});
}

export function registerDbTools(server: McpServer): void {
	server.registerTool(
		"db_list",
		{
			title: "List Postgres + MySQL databases in the organization",
			description: "Wraps postgres.allByOrganization + mysql.allByOrganization.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const [pg, my] = await Promise.all([
					client.postgres.allByOrganization.query(),
					client.mysql.allByOrganization.query(),
				]);
				return { postgres: pg, mysql: my };
			}),
	);

	server.registerTool(
		"db_create",
		{
			title: "Create a database",
			description:
				"Creates a Postgres or MySQL database with the given plan. Uses postgres.create / mysql.create.",
			inputSchema: {
				type: dbType,
				name: z.string().min(1),
				plan: z.enum(["STARTER", "STANDARD", "PRO"]),
				description: z.string().optional(),
			},
		},
		async ({ type, name, plan, description }) => {
			// postgres.create / mysql.create require `appName` (slug),
			// `dockerImage`, and `organizationId`; the tRPC input schema does not
			// inject them. Mirror the CLI command.
			const profile = getCurrentProfile();
			if (!profile) {
				return errorResult({
					error: "No CLI profile — cannot create a database without one.",
					code: "AUTH_ERROR",
					remediation:
						"Run `tarout login` on the machine running this MCP server.",
				});
			}
			return withAuth(async (client) => {
				const router = type === "postgres" ? client.postgres : client.mysql;
				const created = (await router.create.mutate({
					name,
					appName: generateSlug(name),
					dockerImage: DEFAULT_DOCKER_IMAGE[type],
					organizationId: profile.organizationId,
					description,
					plan,
				})) as unknown;
				return { type, created };
			});
		},
	);

	server.registerTool(
		"db_info",
		{
			title: "Details for one database",
			description: "postgres.one / mysql.one.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, router, idKey } = await resolveDbRef(client, db, type);
				const info = (await router.one.query({ [idKey]: id })) as unknown;
				return { type, db: info };
			}),
	);

	server.registerTool(
		"db_credentials",
		{
			title: "External connection credentials for a database",
			description:
				"Returns an externally reachable connection object (host / port / user / password / database). Private infrastructure addresses are never returned.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) => {
			// MySQL has no external pooler endpoint — reject BEFORE withAuth so an
			// unauthenticated caller still sees the real problem.
			if (type !== "postgres") {
				return errorResult({
					error: "External database credentials are unavailable for MySQL.",
					code: "PRECONDITION_FAILED",
					remediation:
						"Use PostgreSQL for an externally reachable database, or manage this database in the Tarout dashboard.",
				});
			}
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				const info = (await client.postgres.one.query({
					postgresId: id,
				})) as Record<string, unknown>;

				if (
					info.externalAccessEnabled !== true ||
					typeof info.externalPoolerHost !== "string" ||
					info.externalPoolerHost.length === 0
				) {
					// toEnvelope honors top-level `code` + `remediation` on thrown
					// errors, so this surfaces as a PRECONDITION_FAILED envelope.
					throw Object.assign(
						new Error("External database access is disabled or unavailable."),
						{
							code: "PRECONDITION_FAILED",
							remediation:
								"Enable public database access in the Tarout dashboard, then retry this tool.",
						},
					);
				}

				return {
					type,
					host: info.externalPoolerHost,
					port: info.externalPoolerPort ?? 5432,
					database: info.databaseName ?? info.database ?? null,
					user: info.databaseUser ?? info.user ?? null,
					password: info.databasePassword ?? info.password ?? null,
				};
			});
		},
	);

	server.registerTool(
		"db_sql",
		{
			title: "Run a SQL statement (Postgres only)",
			description:
				"Wraps postgres.executeSql. MySQL is not supported by the platform — use `call` if you need mysql-specific ops.",
			inputSchema: { type: dbType, db: dbRef, sql: z.string() },
		},
		async ({ type, db, sql }) => {
			if (type !== "postgres") return postgresOnlyRejection("db_sql");
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				const result = (await client.postgres.executeSql.mutate({
					postgresId: id,
					sql,
				})) as unknown;
				return result;
			});
		},
	);

	server.registerTool(
		"db_import",
		{
			title: "Import/restore a Postgres database from SQL (Postgres only)",
			description:
				"Runs a SQL dump against a Postgres database via postgres.executeSql — the 'upload/restore a database' path. Provide the SQL inline as `sql`, OR a local `file` path the MCP server reads from disk. MySQL is not supported — use `call` for mysql-specific ops.",
			inputSchema: {
				type: dbType,
				db: dbRef,
				sql: z
					.string()
					.optional()
					.describe("SQL to run. Provide this OR `file`."),
				file: z
					.string()
					.optional()
					.describe(
						"Path to a local .sql file the MCP server reads. Provide this OR `sql`.",
					),
			},
		},
		async ({ type, db, sql, file }) => {
			if (type !== "postgres") return postgresOnlyRejection("db_import");
			if ((sql && file) || (!sql && !file)) {
				return errorResult({
					error: "Provide exactly one of `sql` or `file`.",
					code: "INVALID_ARGUMENTS",
				});
			}
			let sqlText = sql ?? "";
			if (file) {
				try {
					sqlText = readFileSync(file, "utf8");
				} catch (readErr) {
					return errorResult({
						error: `Could not read SQL file "${file}": ${
							readErr instanceof Error ? readErr.message : String(readErr)
						}`,
						code: "INVALID_ARGUMENTS",
					});
				}
			}
			if (!sqlText.trim()) {
				return errorResult({
					error: file ? `SQL file "${file}" is empty.` : "`sql` is empty.",
					code: "INVALID_ARGUMENTS",
				});
			}
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				const result = (await client.postgres.executeSql.mutate({
					postgresId: id,
					sql: sqlText,
				})) as unknown;
				return result;
			});
		},
	);

	server.registerTool(
		"db_delete",
		{
			title: "Delete a database (irreversible)",
			description: "postgres.remove / mysql.remove.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { destructiveHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, name, router, idKey } = await resolveDbRef(
					client,
					db,
					type,
				);
				const result = (await router.remove.mutate({
					[idKey]: id,
				})) as unknown;
				return { type, deleted: true, id, name, result };
			}),
	);

	// ── READ / DATA (readOnlyHint) ─────────────────────────────────────────────

	server.registerTool(
		"db_tables",
		{
			title: "List tables in a Postgres database",
			description:
				"Wraps postgres.listTables. Postgres-only — use `call` for mysql-specific ops.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) => {
			if (type !== "postgres") return postgresOnlyRejection("db_tables");
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				const tables = (await client.postgres.listTables.query({
					postgresId: id,
				})) as unknown;
				return { type, tables };
			});
		},
	);

	server.registerTool(
		"db_preview",
		{
			title: "Preview rows from a Postgres table",
			description:
				"Wraps postgres.previewTable. Postgres-only. Reads rows only (SELECT).",
			inputSchema: {
				type: dbType,
				db: dbRef,
				table: z.string().describe("Table name."),
				schema: z.string().default("public").describe("Schema name."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.default(50)
					.describe("Max rows to return (1-100)."),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ type, db, table, schema, limit }) => {
			if (type !== "postgres") return postgresOnlyRejection("db_preview");
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				const result = (await client.postgres.previewTable.mutate({
					postgresId: id,
					schema,
					table,
					limit,
				})) as unknown;
				return result;
			});
		},
	);

	server.registerTool(
		"db_analytics",
		{
			title: "Analytics and metrics for a Postgres database",
			description:
				"Wraps postgres.getAnalytics (size, table/row/connection counts, cache hit rate). Postgres-only.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) => {
			if (type !== "postgres") return postgresOnlyRejection("db_analytics");
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				const analytics = (await client.postgres.getAnalytics.query({
					postgresId: id,
				})) as unknown;
				return { type, analytics };
			});
		},
	);

	server.registerTool(
		"db_stats",
		{
			title: "Shared-pool statistics for a database",
			description: "postgres.sharedStats / mysql.sharedStats.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, router, idKey } = await resolveDbRef(client, db, type);
				const stats = (await router.sharedStats.query({
					[idKey]: id,
				})) as unknown;
				return { type, stats };
			}),
	);

	server.registerTool(
		"db_backups",
		{
			title: "List backup schedules for a database",
			description: "backup.listByDatabase (backup schedule configs).",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, idKey } = await resolveDbRef(client, db, type);
				const backups = (await client.backup.listByDatabase.query({
					[idKey]: id,
				})) as unknown;
				return { type, backups };
			}),
	);

	server.registerTool(
		"db_backup_download",
		{
			title: "Signed download URL for a backup file",
			description:
				"backup.getBackupDownloadUrl — returns a short-lived signed URL. Reads only.",
			inputSchema: {
				type: dbType,
				db: dbRef,
				destinationId: z.string().describe("Backup destination id."),
				backupFile: z
					.string()
					.describe("Backup file path within the destination."),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ type, db, destinationId, backupFile }) =>
			withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, type);
				const result = (await client.backup.getBackupDownloadUrl.mutate({
					backupFile,
					databaseId: id,
					databaseType: type,
					destinationId,
				})) as unknown;
				return result;
			}),
	);

	// ── CONTROL (mutating, not destructive) ────────────────────────────────────

	server.registerTool(
		"db_restart",
		{
			title: "Restart a database",
			description:
				'postgres/mysql.changeStatus with applicationStatus "running".',
			inputSchema: { type: dbType, db: dbRef },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, name, router, idKey } = await resolveDbRef(
					client,
					db,
					type,
				);
				const result = (await router.changeStatus.mutate({
					[idKey]: id,
					applicationStatus: "running",
				})) as unknown;
				return { type, id, name, restarted: true, result };
			}),
	);

	server.registerTool(
		"db_stop",
		{
			title: "Stop a database",
			description:
				'postgres/mysql.changeStatus with applicationStatus "stopped".',
			inputSchema: { type: dbType, db: dbRef },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, name, router, idKey } = await resolveDbRef(
					client,
					db,
					type,
				);
				const result = (await router.changeStatus.mutate({
					[idKey]: id,
					applicationStatus: "stopped",
				})) as unknown;
				return { type, id, name, stopped: true, result };
			}),
	);

	server.registerTool(
		"db_reactivate",
		{
			title: "Reactivate a suspended (free) database",
			description: "postgres/mysql.reactivate.",
			inputSchema: { type: dbType, db: dbRef },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, name, router, idKey } = await resolveDbRef(
					client,
					db,
					type,
				);
				const result = (await router.reactivate.mutate({
					[idKey]: id,
				})) as unknown;
				return { type, id, name, reactivated: true, result };
			}),
	);

	server.registerTool(
		"db_update",
		{
			title: "Update a database's name / description",
			description: "postgres/mysql.update.",
			inputSchema: {
				type: dbType,
				db: dbRef,
				name: z.string().min(1).optional().describe("New display name."),
				description: z.string().optional().describe("New description."),
			},
		},
		async ({ type, db, name, description }) =>
			withAuth(async (client) => {
				const { id, router, idKey } = await resolveDbRef(client, db, type);
				const result = (await router.update.mutate({
					[idKey]: id,
					name,
					description,
				})) as unknown;
				return { type, id, updated: true, result };
			}),
	);

	server.registerTool(
		"db_attach",
		{
			title: "Attach a database to an application",
			description:
				"postgres/mysql.attachToApplication. `applicationId` is the app id (not a name).",
			inputSchema: {
				type: dbType,
				db: dbRef,
				applicationId: z.string().describe("Application id to attach."),
			},
		},
		async ({ type, db, applicationId }) =>
			withAuth(async (client) => {
				const { id, router, idKey } = await resolveDbRef(client, db, type);
				const result = (await router.attachToApplication.mutate({
					[idKey]: id,
					applicationId,
				})) as unknown;
				return { type, id, applicationId, attached: true, result };
			}),
	);

	server.registerTool(
		"db_detach",
		{
			title: "Detach a database from an application",
			description:
				"postgres/mysql.detachFromApplication. `applicationId` is the app id (not a name).",
			inputSchema: {
				type: dbType,
				db: dbRef,
				applicationId: z.string().describe("Application id to detach."),
			},
		},
		async ({ type, db, applicationId }) =>
			withAuth(async (client) => {
				const { id, router, idKey } = await resolveDbRef(client, db, type);
				const result = (await router.detachFromApplication.mutate({
					[idKey]: id,
					applicationId,
				})) as unknown;
				return { type, id, applicationId, detached: true, result };
			}),
	);

	server.registerTool(
		"db_external_access",
		{
			title: "Configure external access for a Postgres database",
			description:
				"postgres.updateExternalAccess. Postgres-only. The server REPLACES the stored config, so this loads the current row and preserves any field left unset.",
			inputSchema: {
				type: dbType,
				db: dbRef,
				enabled: z
					.boolean()
					.optional()
					.describe("Enable/disable external access."),
				allowedCidrs: z
					.array(z.string())
					.optional()
					.describe("Allowlist — REPLACES the current list."),
				public: z
					.boolean()
					.optional()
					.describe("Allow the whole internet (0.0.0.0/0)."),
				requireSsl: z.boolean().optional().describe("Require SSL/TLS."),
			},
		},
		async ({ type, db, enabled, allowedCidrs, public: isPublic, requireSsl }) => {
			if (type !== "postgres") return postgresOnlyRejection("db_external_access");
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				// Load-merge semantics (the server replaces omitted fields) live in
				// the shared helper, also used by `tarout db external-access`.
				const { result } = await updateExternalAccessMerged(client, id, {
					enabled,
					allowedCidrs,
					public: isPublic,
					requireSsl,
				});
				return { type, id, externalAccess: result };
			});
		},
	);

	server.registerTool(
		"db_backup_now",
		{
			title: "Trigger an immediate backup for a schedule",
			description:
				"backup.manualBackupPostgres / manualBackupMySql. `backupId` is a backup SCHEDULE id — get it from db_backups.",
			inputSchema: {
				type: dbType,
				backupId: z
					.string()
					.describe("Backup schedule id (from db_backups)."),
			},
		},
		async ({ type, backupId }) =>
			withAuth(async (client) => {
				const result =
					type === "postgres"
						? await client.backup.manualBackupPostgres.mutate({ backupId })
						: await client.backup.manualBackupMySql.mutate({ backupId });
				return { type, backupId, triggered: result };
			}),
	);

	// ── DESTRUCTIVE (destructiveHint) ──────────────────────────────────────────

	server.registerTool(
		"db_restore",
		{
			title: "Restore a database from a backup (overwrites data)",
			description:
				"Restore maps to backup.restoreBackupWithLogs, which the platform exposes ONLY as a streaming tRPC subscription. The batch-only MCP transport cannot drive it, so — like `tarout backups restore` — this refuses with guidance instead of firing a doomed request. Restore from the Tarout dashboard.",
			inputSchema: {
				type: dbType,
				db: dbRef,
				databaseName: z
					.string()
					.min(1)
					.describe("Target database name to restore into."),
				backupFile: z.string().min(1).describe("Backup file to restore from."),
				destinationId: z
					.string()
					.optional()
					.describe("Backup destination id (required for S3 restores)."),
			},
			annotations: { destructiveHint: true },
		},
		async () =>
			errorResult({
				error:
					"Backup restore isn't available over MCP — the platform exposes it only as a streaming subscription (backup.restoreBackupWithLogs) that the batch transport can't drive.",
				code: "PRECONDITION_FAILED",
				remediation: "Restore from the Tarout dashboard.",
			}),
	);
}
