import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
	getCurrentProfile: () => ({ organizationId: "org_1" }),
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
				port: 5432,
				externalAccessEnabled: true,
				externalPoolerHost: "pg.external",
				externalPoolerPort: 6432,
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
		changeStatus: { mutate: vi.fn().mockResolvedValue({}) },
		updateExternalAccess: {
			mutate: vi.fn().mockResolvedValue({ enabled: true }),
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
				externalAccessSupported: false,
				databaseName: "reports_db",
				databaseUser: "reports_owner",
				databasePassword: "my-pass",
			}),
		},
		create: {
			mutate: vi.fn().mockResolvedValue({ mysqlId: "my_2", name: "cache" }),
		},
		remove: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		changeStatus: { mutate: vi.fn().mockResolvedValue({}) },
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
		engine.changeStatus.mutate.mockClear();
	}
	fakeClient.postgres.executeSql.mutate.mockClear();
	fakeClient.postgres.updateExternalAccess.mutate.mockClear();
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
		// Regression: postgres.create requires appName (slug), dockerImage, and
		// organizationId in addition to name/plan — the old payload sent none.
		expect(fakeClient.postgres.create.mutate).toHaveBeenCalledWith({
			name: "analytics",
			appName: "analytics",
			dockerImage: "postgres:17",
			organizationId: "org_1",
			description: "warehouse",
			plan: "STARTER",
		});
		expect(fakeClient.mysql.create.mutate).not.toHaveBeenCalled();
	});

	it("db_create refuses type=mysql without calling the API (MySQL creation is disabled on the platform)", async () => {
		const r = await invoke("db_create", {
			type: "mysql",
			name: "cache",
			plan: "STANDARD",
		});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			error: string;
		};
		expect(body.code).toBe("PRECONDITION_FAILED");
		expect(body.error).toContain("Only PostgreSQL");
		expect(fakeClient.mysql.create.mutate).not.toHaveBeenCalled();
		expect(fakeClient.postgres.create.mutate).not.toHaveBeenCalled();
	});

	it("db_create accepts the FREE plan", async () => {
		// invoke() calls the handler directly, which skips the tool's own input
		// schema; that schema is what refused FREE, so check it explicitly.
		const server = new McpServer(
			{ name: "t", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerDbTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool fields are private-ish.
		const schema = (server as any)._registeredTools.db_create.inputSchema;
		for (const plan of ["FREE", "STARTER", "STANDARD", "PRO"]) {
			expect(
				schema.safeParse({ type: "postgres", name: "scratch", plan }).success,
				plan,
			).toBe(true);
		}

		const r = await invoke("db_create", {
			type: "postgres",
			name: "scratch",
			plan: "FREE",
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.postgres.create.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ plan: "FREE", name: "scratch" }),
		);
	});

	it("db_create does not advertise MySQL creation", async () => {
		const server = new McpServer(
			{ name: "t", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerDbTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool fields are private-ish.
		const reg = (server as any)._registeredTools.db_create;
		expect(`${reg.title} ${reg.description}`).not.toMatch(/mysql\.create/i);
		expect(`${reg.title}`).not.toMatch(/mysql/i);
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

	it("db_credentials returns only the external Postgres endpoint", async () => {
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
		expect(body.host).toBe("pg.external");
		expect(body.port).toBe(6432);
		expect(body.database).toBe("prod_db");
		expect(body.user).toBe("prod_owner");
		expect(body.password).toBe("s3cret");
		expect(r.content[0].text).not.toContain("pg.internal");
	});

	it("db_credentials rejects MySQL when no external endpoint is supported", async () => {
		const r = await invoke("db_credentials", {
			type: "mysql",
			db: "reports",
		});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			remediation?: string;
		};
		expect(body.code).toBe("PRECONDITION_FAILED");
		expect(body.remediation).toMatch(/dashboard/i);
		expect(r.content[0].text).not.toContain("my.internal");
		expect(r.content[0].text).not.toContain("my-pass");
	});

	it("db_credentials never falls back to an internal Postgres route", async () => {
		fakeClient.postgres.one.query.mockResolvedValueOnce({
			postgresId: "pg_1",
			name: "prod",
			host: "pg.internal",
			port: 5432,
			externalAccessEnabled: false,
			externalPoolerHost: null,
			externalPoolerPort: null,
			databaseName: "prod_db",
			databaseUser: "prod_owner",
			databasePassword: "s3cret",
		});

		const r = await invoke("db_credentials", {
			type: "postgres",
			db: "prod",
		});

		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("PRECONDITION_FAILED");
		expect(r.content[0].text).not.toContain("pg.internal");
		expect(r.content[0].text).not.toContain("s3cret");
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

describe("db tools: platform contract fixes", () => {
	it("db_credentials falls back to the pooler port 6432 and returns the platform connection string", async () => {
		fakeClient.postgres.one.query.mockResolvedValueOnce({
			postgresId: "pg_1",
			name: "prod",
			externalAccessEnabled: true,
			externalPoolerHost: "pg.external",
			externalPoolerPort: null,
			externalConnectionString:
				"postgresql://prod_owner:s3cret@pg.external:6432/prod_db?sslmode=require",
			databaseName: "prod_db",
			databaseUser: "prod_owner",
			databasePassword: "s3cret",
		});

		const r = await invoke("db_credentials", { type: "postgres", db: "prod" });

		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			port: number;
			connectionString: string;
			sslmode: string;
		};
		expect(body.port).toBe(6432);
		expect(body.sslmode).toBe("require");
		expect(body.connectionString).toContain("sslmode=require");
	});

	it("db_credentials points at db_external_access, not a dashboard toggle, when access is off", async () => {
		fakeClient.postgres.one.query.mockResolvedValueOnce({
			postgresId: "pg_1",
			name: "prod",
			externalAccessEnabled: false,
			externalPoolerHost: null,
			externalPoolerPort: null,
			databaseName: "prod_db",
			databaseUser: "prod_owner",
			databasePassword: "s3cret",
		});

		const r = await invoke("db_credentials", { type: "postgres", db: "prod" });

		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { remediation: string };
		expect(body.remediation).toContain("db_external_access");
		expect(body.remediation).toContain("tarout db external-access");
		expect(body.remediation).not.toMatch(/dashboard/i);
	});

	it("db_external_access always sends requireSsl: true when enabling, even on a legacy row", async () => {
		fakeClient.postgres.one.query.mockResolvedValueOnce({
			postgresId: "pg_1",
			externalAccessEnabled: false,
			externalAllowedCidrs: [],
			externalPublicAccess: false,
			externalSslRequired: false,
		});

		const r = await invoke("db_external_access", {
			type: "postgres",
			db: "prod",
			enabled: true,
			public: true,
		});

		expect(r.isError).toBeUndefined();
		expect(fakeClient.postgres.updateExternalAccess.mutate).toHaveBeenCalledWith({
			postgresId: "pg_1",
			enabled: true,
			allowedCidrs: [],
			public: true,
			requireSsl: true,
		});
	});

	it("db_external_access refuses requireSsl: false while enabling", async () => {
		const r = await invoke("db_external_access", {
			type: "postgres",
			db: "prod",
			enabled: true,
			public: true,
			requireSsl: false,
		});

		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string; error: string };
		expect(body.code).toBe("INVALID_ARGUMENTS");
		expect(body.error).toContain("External access always requires TLS");
		expect(fakeClient.postgres.updateExternalAccess.mutate).not.toHaveBeenCalled();
	});

	for (const tool of ["db_restart", "db_stop"]) {
		it(`${tool} refuses without calling changeStatus`, async () => {
			const r = await invoke(tool, { type: "postgres", db: "prod" });

			expect(r.isError).toBe(true);
			const body = JSON.parse(r.content[0].text) as { code: string; error: string };
			expect(body.code).toBe("PRECONDITION_FAILED");
			expect(body.error).toContain("cannot be stopped, started or restarted");
			expect(fakeClient.postgres.changeStatus.mutate).not.toHaveBeenCalled();
			expect(fakeClient.postgres.allByOrganization.query).not.toHaveBeenCalled();
		});
	}

	it("db_restore points at the dashboard Backups tab", async () => {
		const r = await invoke("db_restore", {
			type: "postgres",
			db: "prod",
			databaseName: "prod_db",
			backupFile: "x.dump",
		});

		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { remediation: string };
		expect(body.remediation).toContain("Backups tab");
	});

	it("db_import refuses SQL over the 10,000-character console cap", async () => {
		const r = await invoke("db_import", {
			type: "postgres",
			db: "prod",
			sql: "INSERT INTO t VALUES (1);\n".repeat(500),
		});

		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string; error: string };
		expect(body.code).toBe("INVALID_ARGUMENTS");
		expect(body.error).toContain("10,000");
		expect(fakeClient.postgres.executeSql.mutate).not.toHaveBeenCalled();
	});

	it("db_import refuses COPY ... FROM stdin", async () => {
		const r = await invoke("db_import", {
			type: "postgres",
			db: "prod",
			sql: "COPY public.users (id) FROM stdin;\n1\n\\.\n",
		});

		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { error: string };
		expect(body.error).toContain("FROM stdin");
		expect(fakeClient.postgres.executeSql.mutate).not.toHaveBeenCalled();
	});
});
