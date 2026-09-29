import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout run` wiring: app resolution, the env it hands the child (placeholders
 * dropped, connections overlaid, unavailable keys unset), argv passthrough,
 * exit-code propagation, --json rejection and the older-server fallback. The
 * real spawn behaviour is covered by run-argv.test.ts; here `runArgv` is
 * stubbed so the test sees exactly what the command asked it to run.
 */

const PLACEHOLDER =
	"[managed database route hidden; use the external database endpoint]";

const m = vi.hoisted(() => ({
	linked: null as null | { applicationId: string; name: string },
	variables: [] as Array<{ key: string; value: string | null }>,
	connections: (async () => ({ env: {}, unavailable: [] })) as () => Promise<unknown>,
	runResult: { exitCode: 0, signal: null } as Record<string, unknown>,
	runCalls: [] as Array<{
		command: string;
		args: string[];
		env: Record<string, string>;
	}>,
	listCalls: 0,
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	isProjectLinked: () => m.linked !== null,
	getProjectConfig: () =>
		m.linked ? { ...m.linked, organizationId: "org_1", linkedAt: "x" } : null,
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		application: {
			allByOrganization: {
				query: async () => [
					{ applicationId: "app_1", name: "web", appName: "web-x1" },
					{ applicationId: "app_2", name: "api", appName: "api-y2" },
				],
			},
			connections: { query: async () => m.connections() },
		},
		envVariable: {
			list: {
				query: async () => {
					m.listCalls += 1;
					return m.variables;
				},
			},
		},
	}),
}));

vi.mock("../src/lib/process.js", async () => {
	const actual = await vi.importActual<typeof import("../src/lib/process")>(
		"../src/lib/process",
	);
	return {
		...actual,
		runArgv: async (
			command: string,
			args: string[],
			options: { env: Record<string, string> },
		) => {
			m.runCalls.push({ command, args, env: options.env });
			return m.runResult;
		},
	};
});

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerRunCommand } from "../src/commands/run";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: true,
	yes: false,
	nonInteractive: false,
};

let exitCodes: number[];
let stdout: string[];
let stderr: string[];

beforeEach(() => {
	m.linked = { applicationId: "app_1", name: "web" };
	m.variables = [];
	m.connections = async () => ({ env: {}, unavailable: [] });
	m.runResult = { exitCode: 0, signal: null };
	m.runCalls = [];
	m.listCalls = 0;
	exitCodes = [];
	stdout = [];
	stderr = [];
	setGlobalOptions(RESET);
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" "));
	});
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

async function run(...args: string[]): Promise<void> {
	const program = new Command();
	program.option("--json");
	registerRunCommand(program);
	try {
		await program.parseAsync(["node", "tarout", "run", ...args]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

describe("tarout run", () => {
	it("passes the argv after -- through untouched, including spaces and quotes", async () => {
		await run(
			"--",
			"node",
			"-e",
			'console.log("a b")',
			"two words",
			"it's \"quoted\"",
			"--json",
			"--app",
			"other",
		);
		expect(m.runCalls).toHaveLength(1);
		expect(m.runCalls[0]?.command).toBe("node");
		expect(m.runCalls[0]?.args).toEqual([
			"-e",
			'console.log("a b")',
			"two words",
			"it's \"quoted\"",
			"--json",
			"--app",
			"other",
		]);
		expect(exitCodes).toEqual([0]);
	});

	it("injects the linked app's env without placeholders and overlays connections", async () => {
		m.variables = [
			{ key: "NODE_ENV", value: "production" },
			{ key: "DATABASE_URL", value: PLACEHOLDER },
			{ key: "PGPORT", value: PLACEHOLDER },
		];
		m.connections = async () => ({
			env: {
				DATABASE_URL: "postgres://app:s3cret@ext.tarout.sa:6432/app",
				PGPORT: "6432",
			},
			unavailable: [],
		});
		await run("--", "npm", "test");
		expect(m.runCalls[0]?.env).toEqual({
			NODE_ENV: "production",
			DATABASE_URL: "postgres://app:s3cret@ext.tarout.sa:6432/app",
			PGPORT: "6432",
		});
		// Values are never printed, on either stream.
		expect([...stdout, ...stderr].join("\n")).not.toContain("s3cret");
		expect(stdout).toEqual([]);
	});

	it("leaves an unavailable database's keys unset and prints its hint to stderr", async () => {
		m.variables = [{ key: "DATABASE_URL", value: PLACEHOLDER }];
		m.connections = async () => ({
			env: {},
			unavailable: [
				{
					databaseId: "pg_1",
					name: "main",
					engine: "postgres",
					keys: ["DATABASE_URL"],
					reason: "external_access_disabled",
					hint: "Enable external access with `tarout db external-access main --enable`.",
				},
			],
		});
		await run("--", "npm", "test");
		expect(m.runCalls[0]?.env).toEqual({});
		expect(stderr.join("\n")).toContain(
			"Enable external access with `tarout db external-access main --enable`.",
		);
		expect(stdout).toEqual([]);
	});

	it("warns once and runs without database keys on a server without application.connections", async () => {
		m.variables = [
			{ key: "NODE_ENV", value: "production" },
			{ key: "DATABASE_URL", value: PLACEHOLDER },
		];
		m.connections = async () => {
			throw Object.assign(
				new Error('No "query"-procedure on path "application.connections"'),
				{ data: { code: "NOT_FOUND" } },
			);
		};
		await run("--", "npm", "test");
		expect(m.runCalls[0]?.env).toEqual({ NODE_ENV: "production" });
		const warnings = stderr.filter((line) =>
			line.includes("application.connections"),
		);
		expect(warnings).toHaveLength(1);
		expect(exitCodes).toEqual([0]);
	});

	it("exits with the child's code, not one of the CLI's own", async () => {
		m.runResult = { exitCode: 3, signal: null };
		await run("--", "npm", "test");
		expect(exitCodes).toEqual([3]);
		m.runResult = { exitCode: 130, signal: "SIGINT" };
		await run("--", "npm", "test");
		expect(exitCodes).toEqual([3, 130]);
	});

	it("exits 127 with a hint when the command does not exist", async () => {
		m.runResult = {
			exitCode: 127,
			signal: null,
			error: Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" }),
		};
		await run("--", "nope");
		expect(exitCodes).toEqual([127]);
		expect(stderr.join("\n")).toContain("Command not found: nope");
	});

	it("resolves --app by name, slug or id instead of the linked app", async () => {
		await run("--app", "api-y2", "--", "true");
		expect(m.runCalls).toHaveLength(1);
		m.linked = null;
		await run("--app", "app_2", "--", "true");
		expect(m.runCalls).toHaveLength(2);
		expect(exitCodes).toEqual([0, 0]);
	});

	it("rejects an unlinked directory without --app", async () => {
		m.linked = null;
		await run("--", "true");
		expect(exitCodes).toEqual([2]);
		expect(m.runCalls).toEqual([]);
	});

	it("rejects a missing command with INVALID_ARGUMENTS", async () => {
		await run();
		expect(exitCodes).toEqual([2]);
		expect(m.runCalls).toEqual([]);
	});

	it("rejects --json before touching the network", async () => {
		setGlobalOptions({ ...RESET, json: true });
		await run("--", "npm", "test");
		expect(exitCodes).toEqual([2]);
		expect(m.listCalls).toBe(0);
		expect(m.runCalls).toEqual([]);
		const envelope = JSON.parse(stdout.join("\n"));
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("INVALID_ARGUMENTS");
	});
});
