import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout backups` sent inputs the platform schema rejects (no
 * databaseId/databaseType on the file commands, no prefix on create, nulls on
 * update) and read fields the backup record does not have. These specs drive
 * each command against the real `backup.*` shapes (cloud/src/server/api/
 * routers/backup.ts, validations/backup.ts) and pin what the CLI sends.
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
import { registerBackupsCommands } from "../src/commands/backups";
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
	registerBackupsCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

const PG_ID = "pg_0123456789abcdefghij";
const MY_ID = "my_0123456789abcdefghij";
const DEST_ID = "dest_0123456789abcdefgh";

/** A sanitized `backup.one` record, as the platform returns it. */
const BACKUP = {
	backupId: "bk_0123456789abcdefghijk",
	schedule: "0 2 * * *",
	enabled: true,
	database: "app_db",
	prefix: "tarout-backups",
	destinationId: DEST_ID,
	databaseType: "postgres",
	postgresId: PG_ID,
	mysqlId: null,
	keepLatestCount: 7,
	backupType: "database",
	postgres: { postgresId: PG_ID, name: "main", databaseName: "app_db" },
	mysql: null,
	destination: {
		destinationId: DEST_ID,
		name: "r2-main",
		bucket: "tarout-backups-bucket",
		provider: "cloudflare",
	},
};

const MYSQL_BACKUP = {
	...BACKUP,
	backupId: "bk_mysql0123456789abcde",
	databaseType: "mysql",
	postgresId: null,
	mysqlId: MY_ID,
	postgres: null,
	mysql: { mysqlId: MY_ID, name: "legacy", databaseName: "legacy_db" },
};

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

describe("backups files", () => {
	it("resolves databaseId, databaseType and destinationId from the backup schedule", async () => {
		const one = vi.fn(async () => BACKUP);
		const listBackupFiles = vi.fn(async () => [
			{
				Path: "tarout-backups/app_db/app_db-2026-09-25T02-00-00-000Z.dump",
				Name: "app_db-2026-09-25T02-00-00-000Z.dump",
				Size: 2048,
				IsDir: false,
			},
		]);
		h.client = { backup: { one: { query: one }, listBackupFiles: { query: listBackupFiles } } };

		await run(["backups", "files", BACKUP.backupId, "--search", "2026-09"]);

		expect(one).toHaveBeenCalledWith({ backupId: BACKUP.backupId });
		expect(listBackupFiles).toHaveBeenCalledWith({
			databaseId: PG_ID,
			databaseType: "postgres",
			destinationId: DEST_ID,
			search: "2026-09",
		});
		// The full object key is what download-url needs, not the bare file name.
		expect(out()).toContain(
			"tarout-backups/app_db/app_db-2026-09-25T02-00-00-000Z.dump",
		);
	});

	it("uses the mysql id and type for a mysql schedule", async () => {
		const listBackupFiles = vi.fn(async () => []);
		h.client = {
			backup: {
				one: { query: async () => MYSQL_BACKUP },
				listBackupFiles: { query: listBackupFiles },
			},
		};

		await run(["backups", "files", MYSQL_BACKUP.backupId]);

		expect(listBackupFiles).toHaveBeenCalledWith({
			databaseId: MY_ID,
			databaseType: "mysql",
			destinationId: DEST_ID,
			search: "",
		});
	});

	it("explains a schedule with no destination instead of sending a doomed request", async () => {
		const listBackupFiles = vi.fn();
		h.client = {
			backup: {
				one: { query: async () => ({ ...BACKUP, destinationId: null, destination: null }) },
				listBackupFiles: { query: listBackupFiles },
			},
		};

		await run(["backups", "files", BACKUP.backupId]);

		expect(exitCodes[0]).toBe(2);
		expect(listBackupFiles).not.toHaveBeenCalled();
		expect(err()).toContain("no destination");
	});
});

describe("backups download-url", () => {
	it("sends backupFile with the schedule's databaseId, databaseType and destinationId", async () => {
		const mutate = vi.fn(async () => ({ url: "https://signed.example/file" }));
		h.client = {
			backup: {
				one: { query: async () => BACKUP },
				getBackupDownloadUrl: { mutate },
			},
		};
		const file = "tarout-backups/app_db/app_db-2026-09-25T02-00-00-000Z.dump";

		await run(["backups", "download-url", BACKUP.backupId, file]);

		expect(mutate).toHaveBeenCalledWith({
			backupFile: file,
			databaseId: PG_ID,
			databaseType: "postgres",
			destinationId: DEST_ID,
		});
		expect(out()).toContain("https://signed.example/file");
	});
});

describe("backups create", () => {
	const base = [
		"backups",
		"create",
		"--postgres-id",
		PG_ID,
		"--destination-id",
		DEST_ID,
		"--database",
		"app_db",
	];

	it("defaults the required prefix and sends a schema-valid payload", async () => {
		const create = vi.fn(async () => undefined);
		h.client = { backup: { create: { mutate: create } } };

		await run(base);

		expect(exitCodes).toEqual([]);
		expect(create).toHaveBeenCalledWith({
			databaseType: "postgres",
			postgresId: PG_ID,
			database: "app_db",
			destinationId: DEST_ID,
			schedule: "0 2 * * *",
			prefix: "tarout-backups",
			keepLatestCount: 7,
			enabled: true,
		});
	});

	it("passes an explicit --prefix through", async () => {
		const create = vi.fn(async () => undefined);
		h.client = { backup: { create: { mutate: create } } };

		await run([...base, "--prefix", "nightly"]);

		expect(create.mock.calls[0]?.[0]).toMatchObject({ prefix: "nightly" });
	});

	it("defaults --database to the database's own name instead of prompting", async () => {
		const create = vi.fn(async () => undefined);
		const one = vi.fn(async () => ({ postgresId: PG_ID, databaseName: "app_db" }));
		h.client = { postgres: { one: { query: one } }, backup: { create: { mutate: create } } };

		await run(["backups", "create", "--postgres-id", PG_ID, "--destination-id", DEST_ID]);

		expect(one).toHaveBeenCalledWith({ postgresId: PG_ID });
		expect(h.input).not.toHaveBeenCalled();
		expect(create.mock.calls[0]?.[0]).toMatchObject({ database: "app_db" });
	});

	for (const schedule of ["every day", "0 2 * *", "0 2 * * * * *", "0 2 * * mon;"]) {
		it(`rejects the malformed cron schedule "${schedule}" before sending`, async () => {
			const create = vi.fn();
			h.client = { backup: { create: { mutate: create } } };

			await run([...base, "--schedule", schedule]);

			expect(exitCodes[0]).toBe(2);
			expect(create).not.toHaveBeenCalled();
			expect(err()).toMatch(/cron/i);
		});
	}

	for (const schedule of ["0 */6 * * *", "30 3 * * 1-5", "0 0 2 * * *"]) {
		it(`accepts the cron schedule "${schedule}"`, async () => {
			const create = vi.fn(async () => undefined);
			h.client = { backup: { create: { mutate: create } } };

			await run([...base, "--schedule", schedule]);

			expect(exitCodes).toEqual([]);
			expect(create.mock.calls[0]?.[0]).toMatchObject({ schedule });
		});
	}

	for (const keep of ["0", "-3", "abc", "2.5"]) {
		it(`rejects --keep ${keep} (must be a positive whole number)`, async () => {
			const create = vi.fn();
			h.client = { backup: { create: { mutate: create } } };

			await run([...base, "--keep", keep]);

			expect(exitCodes[0]).toBe(2);
			expect(create).not.toHaveBeenCalled();
			expect(err()).toContain("--keep");
		});
	}
});

describe("backups update", () => {
	it("sends only the fields that changed, never null", async () => {
		const update = vi.fn(async () => undefined);
		const one = vi.fn(async () => ({
			...BACKUP,
			// A legacy row: nullable columns the update schema does not accept.
			enabled: null,
			keepLatestCount: null,
			destinationId: null,
		}));
		h.client = { backup: { one: { query: one }, update: { mutate: update } } };

		await run(["backups", "update", BACKUP.backupId, "--keep", "3"]);

		expect(exitCodes).toEqual([]);
		expect(update).toHaveBeenCalledWith({
			backupId: BACKUP.backupId,
			keepLatestCount: 3,
		});
		const sent = update.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(Object.values(sent)).not.toContain(null);
	});

	it("maps --disable and --schedule", async () => {
		const update = vi.fn(async () => undefined);
		h.client = { backup: { one: { query: async () => BACKUP }, update: { mutate: update } } };

		await run([
			"backups",
			"update",
			BACKUP.backupId,
			"--disable",
			"--schedule",
			"15 4 * * *",
		]);

		expect(update).toHaveBeenCalledWith({
			backupId: BACKUP.backupId,
			enabled: false,
			schedule: "15 4 * * *",
		});
	});

	it("refuses an update with nothing to change", async () => {
		const update = vi.fn();
		h.client = { backup: { one: { query: async () => BACKUP }, update: { mutate: update } } };

		await run(["backups", "update", BACKUP.backupId]);

		expect(exitCodes[0]).toBe(2);
		expect(update).not.toHaveBeenCalled();
	});

	it("rejects --keep 0 and a malformed --schedule", async () => {
		const update = vi.fn();
		h.client = { backup: { one: { query: async () => BACKUP }, update: { mutate: update } } };

		await run(["backups", "update", BACKUP.backupId, "--keep", "0"]);
		await run(["backups", "update", BACKUP.backupId, "--schedule", "nightly"]);

		expect(exitCodes).toEqual([2, 2]);
		expect(update).not.toHaveBeenCalled();
	});
});

describe("backups info", () => {
	it("prints the fields the backup record has (no phantom createdAt)", async () => {
		h.client = { backup: { one: { query: async () => BACKUP } } };

		await run(["backups", "info", BACKUP.backupId]);

		const text = out();
		expect(text).toContain(PG_ID);
		expect(text).toContain(DEST_ID);
		expect(text).toContain("r2-main");
		expect(text).toMatch(/Prefix:\s+tarout-backups/);
		expect(text).not.toContain("Created");
	});
});

describe("backups run", () => {
	it("routes by the record's databaseType", async () => {
		const pg = vi.fn(async () => true);
		const my = vi.fn(async () => true);
		h.client = {
			backup: {
				// databaseType is the authoritative engine; the nested relation
				// is not always present on the sanitized record.
				one: { query: async () => ({ ...MYSQL_BACKUP, mysql: undefined }) },
				manualBackupPostgres: { mutate: pg },
				manualBackupMySql: { mutate: my },
			},
		};

		await run(["backups", "run", MYSQL_BACKUP.backupId]);

		expect(my).toHaveBeenCalledWith({ backupId: MYSQL_BACKUP.backupId });
		expect(pg).not.toHaveBeenCalled();
	});
});

describe("backups restore", () => {
	it("points at the dashboard Backups tab and exits non-zero", async () => {
		await run(["backups", "restore", BACKUP.backupId, "file.dump"]);

		expect(exitCodes[0]).toBe(1);
		expect(err()).toContain("Backups tab");
		expect(err()).not.toContain(String.fromCharCode(0x2014));
	});
});

describe("backups backup-web", () => {
	it("explains web server backups are not supported without calling the API", async () => {
		const mutate = vi.fn();
		h.client = { backup: { manualBackupWebServer: { mutate } } };

		await run(["backups", "backup-web", BACKUP.backupId]);

		expect(exitCodes[0]).toBe(1);
		expect(mutate).not.toHaveBeenCalled();
		expect(err()).toMatch(/not supported/i);
	});
});
