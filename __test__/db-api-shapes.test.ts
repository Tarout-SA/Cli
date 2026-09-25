import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout db` read field names the platform does not send and sent inputs the
 * platform refuses. These specs drive each command against the real
 * `postgres.*` / `mysql.*` / `backup.*` response shapes (cloud/src/server/api/
 * routers/postgres.ts, mysql.ts, backup.ts) and pin both what the CLI sends and
 * what it prints.
 */

const h = vi.hoisted(() => ({
	client: {} as any,
	input: vi.fn(),
	confirm: vi.fn(),
	select: vi.fn(),
}));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1", projectName: undefined }),
	getApiUrl: () => "https://api.test",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

vi.mock("../src/utils/prompts.js", () => ({
	input: h.input,
	confirm: h.confirm,
	select: h.select,
}));

import { Command } from "commander";
import { registerDbCommands } from "../src/commands/db";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
const ANSI = /\x1b\[[0-9;]*m/g;

let stdout: string[];
let stderr: string[];
let exitCodes: number[];

beforeEach(() => {
	stdout = [];
	stderr = [];
	exitCodes = [];
	h.input.mockReset();
	h.confirm.mockReset();
	h.select.mockReset();
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	// handleError ends in process.exit; record the code and unwind instead.
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	h.client = {} as any;
});

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerDbCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

function helpFor(path: string[]): string {
	const program = new Command();
	registerDbCommands(program);
	let cmd: Command | undefined = program;
	for (const name of path) {
		cmd = cmd?.commands.find((c) => c.name() === name);
	}
	if (!cmd) throw new Error(`no command ${path.join(" ")}`);
	return cmd.helpInformation();
}

const PG = {
	postgresId: "pg_0123456789abcdefghij",
	name: "main",
	applicationStatus: "done",
	createdAt: "2026-09-01T00:00:00.000Z",
	plan: "STARTER",
};

const MY = {
	mysqlId: "my_0123456789abcdefghij",
	name: "legacy",
	applicationStatus: "done",
	createdAt: "2026-08-01T00:00:00.000Z",
	plan: "STARTER",
};

/** A client whose engine lists hold one postgres row (and optionally mysql). */
function clientWith(
	postgres: Record<string, unknown> = {},
	mysql: Record<string, unknown> = {},
	rest: Record<string, unknown> = {},
) {
	return {
		postgres: { allByOrganization: { query: async () => [PG] }, ...postgres },
		mysql: { allByOrganization: { query: async () => [] }, ...mysql },
		...rest,
	};
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

describe("db analytics", () => {
	it("prints the real postgres.getAnalytics fields", async () => {
		const query = vi.fn(async () => ({
			databaseSize: "12 MB",
			tableCount: 4,
			connectionCount: 2,
			rowCount: 1234,
			cacheHitRate: 99.5,
			tables: [{ name: "users", rowCount: 1000, size: "8192 kB" }],
		}));
		h.client = clientWith({ getAnalytics: { query } });

		await run(["db", "analytics", "main"]);

		expect(query).toHaveBeenCalledWith({ postgresId: PG.postgresId });
		const text = out();
		expect(text).toMatch(/Size:\s+12 MB/);
		expect(text).toMatch(/Tables:\s+4/);
		expect(text).toMatch(/Rows \(approx\.\):\s+1,234/);
		expect(text).toMatch(/Connections:\s+2/);
		expect(text).toMatch(/Cache hit rate:\s+99\.5%/);
		expect(text).toMatch(/users\s+1,000\s+8192 kB/);
		expect(exitCodes).toEqual([]);
	});

	it("explains that analytics are unavailable when the platform returns null", async () => {
		h.client = clientWith({ getAnalytics: { query: async () => null } });

		await run(["db", "analytics", "main"]);

		expect(out()).toContain(
			"Analytics are not available for this database right now",
		);
		expect(exitCodes).toEqual([]);
	});
});

describe("db stats", () => {
	it("prints the real postgres.sharedStats fields", async () => {
		const query = vi.fn(async () => ({
			activeConnections: 3,
			maxConnections: 20,
			storageUsedBytes: 5 * 1024 * 1024,
			storageLimitBytes: 1024 ** 3,
			storageGb: 1,
			plan: "STARTER",
			isReadOnly: false,
			readOnlyReason: null,
		}));
		h.client = clientWith({ sharedStats: { query } });

		await run(["db", "stats", "main"]);

		expect(query).toHaveBeenCalledWith({ postgresId: PG.postgresId });
		const text = out();
		expect(text).toMatch(/Plan:\s+STARTER/);
		expect(text).toMatch(/Connections:\s+3 \/ 20/);
		expect(text).toMatch(/Storage:\s+5\.0 MB \/ 1\.0 GB/);
		expect(text).toMatch(/Read-only:\s+no/);
	});

	it("reads mysql.sharedStats for a mysql row and shows the read-only reason", async () => {
		const query = vi.fn(async () => ({
			activeConnections: 0,
			maxConnections: 10,
			storageUsedBytes: 2 * 1024 * 1024,
			storageLimitBytes: 2 * 1024 * 1024,
			storageGb: 0,
			plan: "FREE",
			isReadOnly: true,
			readOnlyReason: "storage_exceeded",
		}));
		h.client = clientWith(
			{},
			{ allByOrganization: { query: async () => [MY] }, sharedStats: { query } },
		);

		await run(["db", "stats", "legacy"]);

		expect(query).toHaveBeenCalledWith({ mysqlId: MY.mysqlId });
		expect(out()).toMatch(/Read-only:\s+yes \(storage_exceeded\)/);
	});

	it("explains that stats are unavailable when the platform returns null", async () => {
		h.client = clientWith({ sharedStats: { query: async () => null } });

		await run(["db", "stats", "main"]);

		expect(out()).toContain("Stats are not available for this database right now");
		expect(exitCodes).toEqual([]);
	});
});

describe("db tables", () => {
	it("reads estimatedRows and prints '-' when the planner has no estimate", async () => {
		h.client = clientWith({
			listTables: {
				query: async () => [
					{ schema: "public", name: "users", estimatedRows: 1500, totalBytes: 16384 },
					{ schema: "public", name: "fresh", estimatedRows: -1, totalBytes: 8192 },
					{ schema: "public", name: "empty", estimatedRows: 0, totalBytes: 0 },
				],
			},
		});

		await run(["db", "tables", "main"]);

		const text = out();
		expect(text).toMatch(/users\s+1,500\s+16\.0 KB/);
		expect(text).toMatch(/fresh\s+-\s+8\.0 KB/);
		expect(text).toMatch(/empty\s+0\s+0 B/);
	});
});

describe("db external-access", () => {
	const current = {
		postgresId: PG.postgresId,
		externalAccessEnabled: false,
		externalAllowedCidrs: [],
		externalPublicAccess: false,
		// Rows created before the always-on rollout carry false here; the
		// platform refuses enabled && !requireSsl, so this must never leak
		// into the request.
		externalSslRequired: false,
	};

	it("always sends requireSsl: true when enabling", async () => {
		const mutate = vi.fn(async () => ({ enabled: true }));
		h.client = clientWith({
			one: { query: async () => current },
			updateExternalAccess: { mutate },
		});

		await run(["db", "external-access", "main", "--enable", "--public"]);

		expect(mutate).toHaveBeenCalledWith({
			postgresId: PG.postgresId,
			enabled: true,
			allowedCidrs: [],
			public: true,
			requireSsl: true,
		});
	});

	it("refuses --allow-insecure without calling the API", async () => {
		const mutate = vi.fn();
		const one = vi.fn(async () => current);
		h.client = clientWith({
			one: { query: one },
			updateExternalAccess: { mutate },
		});

		await run(["db", "external-access", "main", "--enable", "--allow-insecure"]);

		expect(exitCodes[0]).toBe(2);
		expect(mutate).not.toHaveBeenCalled();
		expect(err()).toContain("External access always requires TLS");
	});

	it("refuses --allow-insecure on an already-enabled database", async () => {
		const mutate = vi.fn();
		h.client = clientWith({
			one: {
				query: async () => ({
					...current,
					externalAccessEnabled: true,
					externalPublicAccess: true,
				}),
			},
			updateExternalAccess: { mutate },
		});

		await run(["db", "external-access", "main", "--allow-insecure"]);

		expect(exitCodes[0]).toBe(2);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("rejects more than 20 CIDRs before sending", async () => {
		const mutate = vi.fn();
		h.client = clientWith({
			one: { query: async () => current },
			updateExternalAccess: { mutate },
		});
		const cidrs = Array.from({ length: 21 }, (_, i) => `10.0.${i}.0/24`).join(",");

		await run(["db", "external-access", "main", "--enable", "--cidrs", cidrs]);

		expect(exitCodes[0]).toBe(2);
		expect(mutate).not.toHaveBeenCalled();
		expect(err()).toContain("20");
	});
});

describe("db restart / db stop", () => {
	for (const verb of ["restart", "stop"]) {
		it(`${verb} explains managed databases cannot be ${verb === "stop" ? "stopped" : "restarted"} and exits non-zero without calling the API`, async () => {
			const list = vi.fn(async () => [PG]);
			const changeStatus = vi.fn();
			h.client = {
				postgres: {
					allByOrganization: { query: list },
					changeStatus: { mutate: changeStatus },
				},
				mysql: {
					allByOrganization: { query: list },
					changeStatus: { mutate: changeStatus },
				},
			};

			await run(["db", verb, "main"]);

			expect(exitCodes[0]).toBe(1);
			expect(list).not.toHaveBeenCalled();
			expect(changeStatus).not.toHaveBeenCalled();
			expect(err()).toContain("shared hosts");
			expect(err()).toContain("cannot be stopped, started or restarted");
		});
	}
});

describe("full ids in tables", () => {
	it("db list prints the full database id", async () => {
		h.client = clientWith();

		await run(["db", "list"]);

		expect(out()).toContain(PG.postgresId);
	});

	it("db backups prints the full backup schedule id", async () => {
		const listByDatabase = vi.fn(async () => [
			{ backupId: "bk_0123456789abcdefghijk", schedule: "0 2 * * *", enabled: true },
		]);
		h.client = clientWith({}, {}, { backup: { listByDatabase: { query: listByDatabase } } });

		await run(["db", "backups", "main"]);

		expect(listByDatabase).toHaveBeenCalledWith({ postgresId: PG.postgresId });
		expect(out()).toContain("bk_0123456789abcdefghijk");
	});
});

describe("db create", () => {
	it("refuses --type mysql without calling the API", async () => {
		const pgCreate = vi.fn();
		const myCreate = vi.fn();
		h.client = clientWith({ create: { mutate: pgCreate } }, { create: { mutate: myCreate } });

		await run(["db", "create", "cache", "--type", "mysql"]);

		expect(exitCodes[0]).toBe(2);
		expect(myCreate).not.toHaveBeenCalled();
		expect(pgCreate).not.toHaveBeenCalled();
		expect(err()).toContain("Only PostgreSQL");
	});

	it("does not advertise MySQL creation in help", () => {
		expect(helpFor(["db", "create"])).not.toMatch(/mysql/i);
	});
});

describe("db info", () => {
	it("points at `tarout db external-access` (not the dashboard) when external access is off", async () => {
		h.client = clientWith({
			one: {
				query: async () => ({
					...PG,
					databaseName: "app_db",
					databaseUser: "app_user",
					externalAccessEnabled: false,
					externalAllowedCidrs: [],
					externalPublicAccess: false,
					externalSslRequired: false,
					externalPoolerHost: null,
					externalPoolerPort: null,
					externalConnectionString: null,
				}),
			},
		});

		await run(["db", "info", "main"]);

		expect(out()).toContain("tarout db external-access");
		expect(out()).not.toMatch(/dashboard/i);
	});
});

describe("db import", () => {
	function sqlFile(contents: string): string {
		const dir = mkdtempSync(join(tmpdir(), "tarout-db-import-"));
		const path = join(dir, "dump.sql");
		writeFileSync(path, contents);
		return path;
	}

	it("refuses a file over the 10,000-character console cap before sending", async () => {
		const executeSql = vi.fn();
		h.client = clientWith({ executeSql: { mutate: executeSql } });
		const path = sqlFile(`${"INSERT INTO t VALUES (1);\n".repeat(500)}`);

		await run(["db", "import", "main", path]);

		expect(exitCodes[0]).toBe(2);
		expect(executeSql).not.toHaveBeenCalled();
		expect(err()).toContain("10,000");
	});

	it("refuses COPY ... FROM stdin before sending", async () => {
		const executeSql = vi.fn();
		h.client = clientWith({ executeSql: { mutate: executeSql } });
		const path = sqlFile(
			"COPY public.users (id, email) FROM stdin;\n1\ta@b.c\n\\.\n",
		);

		await run(["db", "import", "main", path]);

		expect(exitCodes[0]).toBe(2);
		expect(executeSql).not.toHaveBeenCalled();
		expect(err()).toContain("FROM stdin");
		expect(err()).toContain("pg_dump --inserts");
	});

	it("refuses GRANT / REVOKE / role statements before sending", async () => {
		const executeSql = vi.fn();
		h.client = clientWith({ executeSql: { mutate: executeSql } });
		const path = sqlFile("CREATE TABLE t (id int);\nGRANT SELECT ON t TO reporting;\n");

		await run(["db", "import", "main", path]);

		expect(exitCodes[0]).toBe(2);
		expect(executeSql).not.toHaveBeenCalled();
		expect(err()).toContain("GRANT");
	});

	it("sends the trimmed SQL when it fits", async () => {
		const executeSql = vi.fn(async () => ({
			columns: [],
			command: "CREATE",
			rowCount: 0,
			rows: [],
		}));
		h.client = clientWith({ executeSql: { mutate: executeSql } });
		// Raw length is over the cap only because of surrounding blank lines;
		// the platform trims before it executes, so the CLI sends it trimmed.
		const body = `CREATE TABLE t (id int);\n${"-- padding comment line\n".repeat(400)}CREATE TABLE u (id int);`;
		const path = sqlFile(`${"\n".repeat(200)}${body}${"\n".repeat(300)}`);
		expect(body.length).toBeLessThan(10_000);
		expect(body.length + 500).toBeGreaterThan(10_000);

		await run(["db", "import", "main", path]);

		expect(exitCodes).toEqual([]);
		expect(executeSql).toHaveBeenCalledWith({
			postgresId: PG.postgresId,
			sql: body,
		});
	});
});

describe("db sql", () => {
	it("refuses role statements before sending", async () => {
		const executeSql = vi.fn();
		h.client = clientWith({ executeSql: { mutate: executeSql } });

		await run(["db", "sql", "main", "CREATE ROLE reporting"]);

		expect(exitCodes[0]).toBe(2);
		expect(executeSql).not.toHaveBeenCalled();
	});
});

describe("db preview", () => {
	for (const limit of ["0", "500", "abc"]) {
		it(`rejects --limit ${limit} (the platform takes 1-100) before sending`, async () => {
			const previewTable = vi.fn();
			h.client = clientWith({ previewTable: { mutate: previewTable } });

			await run(["db", "preview", "main", "users", "--limit", limit]);

			expect(exitCodes[0]).toBe(2);
			expect(previewTable).not.toHaveBeenCalled();
		});
	}
});
