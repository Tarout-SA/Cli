import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	postgres: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([
				{
					postgresId: "pg_1",
					name: "prod",
					plan: "STARTER",
				},
			]),
		},
		one: {
			query: vi.fn().mockResolvedValue({
				postgresId: "pg_1",
				name: "prod",
				host: "pg.internal",
				externalHost: "pg.external",
				port: 5432,
				databaseName: "prod_db",
				databaseUser: "prod_owner",
				databasePassword: "s3cret",
			}),
		},
		create: {
			mutate: vi
				.fn()
				.mockResolvedValue({ postgresId: "pg_2", name: "analytics" }),
		},
		remove: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		executeSql: {
			mutate: vi.fn().mockResolvedValue({ rows: [{ n: 1 }] }),
		},
	},
	mysql: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([
				{
					mysqlId: "my_1",
					name: "reports",
					plan: "STARTER",
				},
			]),
		},
		one: {
			query: vi.fn().mockResolvedValue({
				mysqlId: "my_1",
				name: "reports",
				host: "my.internal",
				port: 3306,
				databaseName: "reports_db",
				databaseUser: "reports_owner",
				databasePassword: "my-pass",
			}),
		},
		create: {
			mutate: vi.fn().mockResolvedValue({ mysqlId: "my_2", name: "cache" }),
		},
		remove: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDbTools } from "../../src/mcp/tools/db";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerDbTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// SDK 1.29.x stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

beforeEach(() => {
	for (const engine of [fakeClient.postgres, fakeClient.mysql]) {
		engine.allByOrganization.query.mockClear();
		engine.one.query.mockClear();
		engine.create.mutate.mockClear();
		engine.remove.mutate.mockClear();
	}
	fakeClient.postgres.executeSql.mutate.mockClear();
});

describe("db tools", () => {
	it("db_list returns both engines", async () => {
		const r = await invoke("db_list", {});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			postgres: unknown[];
			mysql: unknown[];
		};
		expect(body.postgres).toHaveLength(1);
		expect(body.mysql).toHaveLength(1);
	});

	it("db_create routes to postgres.create when type=postgres", async () => {
		const r = await invoke("db_create", {
			type: "postgres",
			name: "analytics",
			plan: "STARTER",
			description: "warehouse",
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.postgres.create.mutate).toHaveBeenCalledWith({
			name: "analytics",
			plan: "STARTER",
			description: "warehouse",
		});
		expect(fakeClient.mysql.create.mutate).not.toHaveBeenCalled();
	});

	it("db_create routes to mysql.create when type=mysql", async () => {
		const r = await invoke("db_create", {
			type: "mysql",
			name: "cache",
			plan: "STANDARD",
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.mysql.create.mutate).toHaveBeenCalledWith({
			name: "cache",
			plan: "STANDARD",
			description: undefined,
		});
	});

	it("db_info resolves postgres by name and calls postgres.one", async () => {
		const r = await invoke("db_info", { type: "postgres", db: "prod" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.postgres.one.query).toHaveBeenCalledWith({
			postgresId: "pg_1",
		});
	});

	it("db_info resolves mysql by name and calls mysql.one", async () => {
		const r = await invoke("db_info", { type: "mysql", db: "reports" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.mysql.one.query).toHaveBeenCalledWith({ mysqlId: "my_1" });
	});

	it("db_credentials returns the credential fields for postgres", async () => {
		const r = await invoke("db_credentials", {
			type: "postgres",
			db: "prod",
		});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			type: string;
			host: string;
			port: number;
			database: string;
			user: string;
			password: string;
		};
		expect(body.type).toBe("postgres");
		expect(body.host).toBe("pg.internal");
		expect(body.port).toBe(5432);
		expect(body.database).toBe("prod_db");
		expect(body.user).toBe("prod_owner");
		expect(body.password).toBe("s3cret");
	});

	it("db_credentials returns the credential fields for mysql", async () => {
		const r = await invoke("db_credentials", {
			type: "mysql",
			db: "reports",
		});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			type: string;
			host: string;
			port: number;
			database: string;
			user: string;
			password: string;
		};
		expect(body.type).toBe("mysql");
		expect(body.host).toBe("my.internal");
		expect(body.port).toBe(3306);
		expect(body.database).toBe("reports_db");
		expect(body.user).toBe("reports_owner");
		expect(body.password).toBe("my-pass");
	});

	it("db_sql calls postgres.executeSql for a postgres db", async () => {
		const r = await invoke("db_sql", {
			db: "prod",
			type: "postgres",
			sql: "SELECT 1",
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.postgres.executeSql.mutate).toHaveBeenCalledWith({
			postgresId: "pg_1",
			sql: "SELECT 1",
		});
		const body = JSON.parse(r.content[0].text) as { rows: unknown[] };
		expect(body.rows).toEqual([{ n: 1 }]);
	});

	it("db_sql rejects mysql with INVALID_ARGUMENTS", async () => {
		const r = await invoke("db_sql", {
			db: "any",
			type: "mysql",
			sql: "SELECT 1",
		});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("INVALID_ARGUMENTS");
		// Must reject BEFORE reaching withAuth / the tRPC client.
		expect(fakeClient.mysql.allByOrganization.query).not.toHaveBeenCalled();
	});

	it("db_delete calls postgres.remove", async () => {
		const r = await invoke("db_delete", { type: "postgres", db: "prod" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.postgres.remove.mutate).toHaveBeenCalledWith({
			postgresId: "pg_1",
		});
		const body = JSON.parse(r.content[0].text) as {
			deleted: boolean;
			id: string;
			name: string;
			type: string;
		};
		expect(body.deleted).toBe(true);
		expect(body.type).toBe("postgres");
		expect(body.id).toBe("pg_1");
		expect(body.name).toBe("prod");
	});

	it("db_delete calls mysql.remove", async () => {
		const r = await invoke("db_delete", { type: "mysql", db: "reports" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.mysql.remove.mutate).toHaveBeenCalledWith({
			mysqlId: "my_1",
		});
	});

	it("db_info returns NOT_FOUND envelope when the db cannot be resolved", async () => {
		const r = await invoke("db_info", {
			type: "postgres",
			db: "does-not-exist",
		});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
	});
});
