/**
 * Curated MCP tools for database management: db_list, db_create, db_info,
 * db_credentials, db_sql, db_delete. Each tool takes a `type: "postgres" |
 * "mysql"` param (except db_list which fans out to both engines) so agents
 * pick the engine explicitly instead of the tool disambiguating by lookup.
 *
 * Dispatch:
 * - db_list: parallel postgres + mysql allByOrganization queries
 * - db_create / db_info / db_credentials / db_delete: route by `type` to the
 *   matching router; resolveDbRef() accepts name OR id (`postgresId` /
 *   `mysqlId`) using the same list-then-match approach as resolveAppRef()
 * - db_sql: postgres-only wrapper over postgres.executeSql. MySQL requests
 *   are rejected with INVALID_ARGUMENTS BEFORE hitting withAuth so callers
 *   see the argument problem instead of an auth error when unauthenticated.
 *
 * db_credentials is intentionally external-only. MCP clients run outside the
 * platform network, so private provider routes are neither useful nor safe to
 * expose. PostgreSQL uses the explicit external pooler fields; engines without
 * an external endpoint return a precondition error.
 *
 * Annotations:
 * - readOnlyHint on db_list / db_info / db_credentials
 * - destructiveHint on db_delete
 * - db_create / db_sql are mutating but not destructive (no hint)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCurrentProfile } from "../../lib/config.js";
import { NotFoundError } from "../../lib/errors.js";
import { errorResult, type TrpcClient, withAuth } from "../runtime.js";

const dbType = z.enum(["postgres", "mysql"]).describe("Database engine.");
const dbRef = z.string().describe("Database name or id.");

// Default images per engine, matching commands/db.ts. postgres.create /
// mysql.create both require `dockerImage`.
const DEFAULT_DOCKER_IMAGE = {
	postgres: "postgres:17",
	mysql: "mysql:8",
} as const;

// URL-safe slug, mirroring generateSlug() in commands/db.ts. The platform
// create schemas require an `appName` slug alongside the display `name`.
function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);
}

/**
 * Resolves a name-or-id reference to the database's `{id, name}` pair by
 * listing all databases of the given engine and matching. Mirrors
 * resolveAppRef() but routes to `postgres.allByOrganization` /
 * `mysql.allByOrganization` and picks the correct id field.
 *
 * Throws `NotFoundError` when no match is found — this maps to `NOT_FOUND`
 * in the tool envelope via `toEnvelope()`.
 */
async function resolveDbRef(
	client: TrpcClient,
	ref: string,
	type: "postgres" | "mysql",
): Promise<{ id: string; name: string }> {
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
	return { id: match[idKey] as string, name: match.name as string };
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
				const { id } = await resolveDbRef(client, db, type);
				const router = type === "postgres" ? client.postgres : client.mysql;
				const idKey = type === "postgres" ? "postgresId" : "mysqlId";
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
			let unavailable:
				| { error: string; remediation: string }
				| undefined;
			const result = await withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, type);
				const router = type === "postgres" ? client.postgres : client.mysql;
				const idKey = type === "postgres" ? "postgresId" : "mysqlId";
				const info = (await router.one.query({
					[idKey]: id,
				})) as Record<string, unknown>;

				if (type !== "postgres") {
					unavailable = {
						error: "External database credentials are unavailable for MySQL.",
						remediation:
							"Use PostgreSQL for an externally reachable database, or manage this database in the Tarout dashboard.",
					};
					return null;
				}

				if (
					info.externalAccessEnabled !== true ||
					typeof info.externalPoolerHost !== "string" ||
					info.externalPoolerHost.length === 0
				) {
					unavailable = {
						error: "External database access is disabled or unavailable.",
						remediation:
							"Enable public database access in the Tarout dashboard, then retry this tool.",
					};
					return null;
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

			if (!result.isError && unavailable) {
				return errorResult({
					error: unavailable.error,
					code: "PRECONDITION_FAILED",
					remediation: unavailable.remediation,
				});
			}
			return result;
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
			if (type !== "postgres") {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									error:
										"db_sql is postgres-only; use `call` for mysql-specific ops.",
									code: "INVALID_ARGUMENTS",
								},
								null,
								2,
							),
						},
					],
					isError: true,
				};
			}
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
		"db_delete",
		{
			title: "Delete a database (irreversible)",
			description: "postgres.remove / mysql.remove.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { destructiveHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, name } = await resolveDbRef(client, db, type);
				const router = type === "postgres" ? client.postgres : client.mysql;
				const idKey = type === "postgres" ? "postgresId" : "mysqlId";
				const result = (await router.remove.mutate({
					[idKey]: id,
				})) as unknown;
				return { type, deleted: true, id, name, result };
			}),
	);
}
