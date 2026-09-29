import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isManagedDbEnvPlaceholder,
	MANAGED_DB_ENV_PLACEHOLDER,
	reportAppEnvNotices,
	resolveAppEnv,
	unavailableEnvField,
} from "../src/lib/app-env";
import { isMissingProcedureError } from "../src/lib/errors";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: true,
	yes: false,
	nonInteractive: false,
};

/** tRPC v10's error for a procedure the server does not have. */
function missingProcedure(path: string) {
	return Object.assign(new Error(`No "query"-procedure on path "${path}"`), {
		data: { code: "NOT_FOUND", httpStatus: 404, path },
	});
}

const UNAVAILABLE = {
	databaseId: "pg_2",
	name: "analytics",
	engine: "postgres" as const,
	keys: ["ANALYTICS_URL"],
	reason: "external_access_disabled" as const,
	hint: "Turn on external access: tarout db external-access analytics --enable",
};

function client(options: {
	variables?: Array<{ key: string; value: string | null }>;
	connections?: () => Promise<unknown>;
}) {
	return {
		envVariable: {
			list: { query: vi.fn(async () => options.variables ?? []) },
		},
		application: {
			connections: {
				query: vi.fn(
					options.connections ??
						(async () => ({ env: {}, unavailable: [] })),
				),
			},
		},
	};
}

beforeEach(() => setGlobalOptions(RESET));
afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

describe("isManagedDbEnvPlaceholder", () => {
	it("matches the platform's exact placeholder", () => {
		expect(
			isManagedDbEnvPlaceholder(
				"[managed database route hidden; use the external database endpoint]",
			),
		).toBe(true);
	});

	it("tolerates whitespace, quotes, case and a reworded tail", () => {
		for (const value of [
			`  ${MANAGED_DB_ENV_PLACEHOLDER}\n`,
			`"${MANAGED_DB_ENV_PLACEHOLDER}"`,
			`'${MANAGED_DB_ENV_PLACEHOLDER}'`,
			MANAGED_DB_ENV_PLACEHOLDER.toUpperCase(),
			"[managed  database route hidden;\tuse the external   database endpoint]",
			"[Managed database route hidden; connect through the public endpoint]",
		]) {
			expect(isManagedDbEnvPlaceholder(value)).toBe(true);
		}
	});

	it("leaves real values alone", () => {
		for (const value of [
			"postgres://u:p@db.tarout.sa:5432/app",
			"5432",
			"",
			"managed database route hidden",
			`prefix ${MANAGED_DB_ENV_PLACEHOLDER}`,
			null,
			undefined,
		]) {
			expect(isManagedDbEnvPlaceholder(value)).toBe(false);
		}
	});

	it("matches the placeholder the cloud checkout actually ships", () => {
		// Drift guard: runs only when the platform is checked out as a sibling.
		const here = fileURLToPath(new URL(".", import.meta.url));
		const source = ["cloud", "platform"]
			.map((name) =>
				join(
					here,
					"..",
					"..",
					name,
					"src/server/services/database-customer-details.ts",
				),
			)
			.find((path) => existsSync(path));
		if (!source) return;
		const match = readFileSync(source, "utf8").match(
			/MANAGED_DATABASE_ENV_PLACEHOLDER\s*=\s*"([^"]+)"/,
		);
		expect(match?.[1]).toBe(MANAGED_DB_ENV_PLACEHOLDER);
	});
});

describe("isMissingProcedureError", () => {
	it("recognizes tRPC v10 and v11 wording", () => {
		expect(isMissingProcedureError(missingProcedure("a.b"))).toBe(true);
		expect(
			isMissingProcedureError(
				Object.assign(new Error('No procedure found on path "a.b"'), {
					data: { code: "NOT_FOUND" },
				}),
			),
		).toBe(true);
	});

	it("does not treat a missing resource or another code as a missing procedure", () => {
		expect(
			isMissingProcedureError(
				Object.assign(new Error("Application not found"), {
					data: { code: "NOT_FOUND" },
				}),
			),
		).toBe(false);
		expect(
			isMissingProcedureError(
				Object.assign(new Error('No "query"-procedure on path "a.b"'), {
					data: { code: "FORBIDDEN" },
				}),
			),
		).toBe(false);
		expect(isMissingProcedureError(new TypeError("x is undefined"))).toBe(
			false,
		);
		expect(isMissingProcedureError(null)).toBe(false);
	});
});

describe("resolveAppEnv", () => {
	it("drops placeholders, removes unavailable keys, then overlays connections", async () => {
		const c = client({
			variables: [
				{ key: "NODE_ENV", value: "production" },
				{ key: "DATABASE_URL", value: MANAGED_DB_ENV_PLACEHOLDER },
				{ key: "PGHOST", value: ` ${MANAGED_DB_ENV_PLACEHOLDER} ` },
				{ key: "PGUSER", value: "app" },
				{ key: "ANALYTICS_URL", value: MANAGED_DB_ENV_PLACEHOLDER },
				{ key: "EMPTY", value: null },
			],
			connections: async () => ({
				env: {
					DATABASE_URL: "postgres://app:s3cret@ext.tarout.sa:6432/app",
					PGHOST: "ext.tarout.sa",
				},
				unavailable: [UNAVAILABLE],
			}),
		});

		const result = await resolveAppEnv(c, "app_1");

		expect(c.envVariable.list.query).toHaveBeenCalledWith({
			applicationId: "app_1",
			includeValues: true,
		});
		expect(c.application.connections.query).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		expect(result.env).toEqual({
			NODE_ENV: "production",
			PGUSER: "app",
			DATABASE_URL: "postgres://app:s3cret@ext.tarout.sa:6432/app",
			PGHOST: "ext.tarout.sa",
		});
		expect(result.env).not.toHaveProperty("ANALYTICS_URL");
		expect(result.hiddenKeys.sort()).toEqual(
			["ANALYTICS_URL", "DATABASE_URL", "PGHOST"].sort(),
		);
		expect(result.unavailable).toEqual([UNAVAILABLE]);
		expect(result.connectionsSupported).toBe(true);
		expect(unavailableEnvField(result)).toEqual({
			unavailableEnv: [UNAVAILABLE],
		});
	});

	it("removes an unavailable database's keys even when a stored value is real", async () => {
		const c = client({
			variables: [{ key: "ANALYTICS_URL", value: "postgres://internal" }],
			connections: async () => ({ env: {}, unavailable: [UNAVAILABLE] }),
		});
		const result = await resolveAppEnv(c, "app_1");
		expect(result.env).toEqual({});
	});

	it("never injects a placeholder that comes back from connections", async () => {
		const c = client({
			connections: async () => ({
				env: { DATABASE_URL: MANAGED_DB_ENV_PLACEHOLDER },
				unavailable: [],
			}),
		});
		expect((await resolveAppEnv(c, "app_1")).env).toEqual({});
	});

	it("continues without database keys on a server that predates application.connections", async () => {
		const c = client({
			variables: [
				{ key: "NODE_ENV", value: "production" },
				{ key: "DATABASE_URL", value: MANAGED_DB_ENV_PLACEHOLDER },
			],
			connections: async () => {
				throw missingProcedure("application.connections");
			},
		});
		const result = await resolveAppEnv(c, "app_1");
		expect(result).toEqual({
			env: { NODE_ENV: "production" },
			unavailable: [],
			hiddenKeys: ["DATABASE_URL"],
			connectionsSupported: false,
		});
		expect(unavailableEnvField(result)).toEqual({});
	});

	it("propagates any other connections failure", async () => {
		const notFound = Object.assign(new Error("Application not found"), {
			data: { code: "NOT_FOUND" },
		});
		await expect(
			resolveAppEnv(
				client({
					connections: async () => {
						throw notFound;
					},
				}),
				"app_1",
			),
		).rejects.toBe(notFound);
	});
});

describe("reportAppEnvNotices", () => {
	it("prints each unavailable database's hint to stderr, never on stdout", () => {
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errors.push(a.map(String).join(" "));
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		reportAppEnvNotices({
			env: { DATABASE_URL: "postgres://app:s3cret@ext/app" },
			unavailable: [UNAVAILABLE],
			hiddenKeys: [],
			connectionsSupported: true,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('Database "analytics"');
		expect(errors[0]).toContain(UNAVAILABLE.hint);
		expect(errors[0]).toContain("ANALYTICS_URL");
		expect(errors.join("\n")).not.toContain("s3cret");
		expect(log).not.toHaveBeenCalled();
	});

	it("prints exactly one warning for a server without connections", () => {
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			errors.push(a.map(String).join(" "));
		});
		reportAppEnvNotices({
			env: {},
			unavailable: [],
			hiddenKeys: ["DATABASE_URL", "PGHOST"],
			connectionsSupported: false,
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("application.connections");
		expect(errors[0]).toContain("DATABASE_URL, PGHOST");
	});

	it("stays silent in JSON mode", () => {
		setGlobalOptions({ ...RESET, json: true });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		reportAppEnvNotices({
			env: {},
			unavailable: [UNAVAILABLE],
			hiddenKeys: [],
			connectionsSupported: false,
		});
		expect(error).not.toHaveBeenCalled();
	});
});
