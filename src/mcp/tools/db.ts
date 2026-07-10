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
 * Credentials field naming differs across engines (host vs externalHost,
 * databaseName vs database, etc.) — db_credentials uses `??` fallback so
 * whichever field the server populates surfaces to the caller.
 *
 * Annotations:
 * - readOnlyHint on db_list / db_info / db_credentials
 * - destructiveHint on db_delete
 * - db_create / db_sql are mutating but not destructive (no hint)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotFoundError } from "../../lib/errors.js";
import { type TrpcClient, withAuth } from "../runtime.js";

const dbType = z.enum(["postgres", "mysql"]).describe("Database engine.");
const dbRef = z.string().describe("Database name or id.");

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
		async ({ type, name, plan, description }) =>
			withAuth(async (client) => {
				const router = type === "postgres" ? client.postgres : client.mysql;
				const created = (await router.create.mutate({
					name,
					plan,
					description,
				})) as unknown;
				return { type, created };
			}),
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
			title: "Connection credentials for a database",
			description:
				"Returns the connection object (host / port / user / password / database). Uses postgres.one / mysql.one which include credentials for owner roles.",
			inputSchema: { type: dbType, db: dbRef },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, type);
				const router = type === "postgres" ? client.postgres : client.mysql;
				const idKey = type === "postgres" ? "postgresId" : "mysqlId";
				const info = (await router.one.query({
					[idKey]: id,
				})) as Record<string, unknown>;
				return {
					type,
					host: info.host ?? info.externalHost ?? null,
					port: info.port ?? info.externalPort ?? null,
					database: info.databaseName ?? info.database ?? null,
					user: info.databaseUser ?? info.user ?? null,
					password: info.databasePassword ?? info.password ?? null,
				};
			}),
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
