import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout dev` and `tarout build` resolve their env through the same helper as
 * `tarout run`: the managed-database placeholder is never injected as
 * DATABASE_URL, the external connection details are, and an older server
 * without `application.connections` still runs (without database keys).
 */

const PLACEHOLDER =
	"[managed database route hidden; use the external database endpoint]";

const m = vi.hoisted(() => ({
	connections: (async () => ({ env: {}, unavailable: [] })) as () => Promise<unknown>,
	runs: [] as Array<{ command: string; env: Record<string, string> }>,
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	isProjectLinked: () => false,
	getProjectConfig: () => null,
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		application: {
			allByOrganization: {
				query: async () => [
					{ applicationId: "app_1", name: "my-app", appName: "my-app" },
				],
			},
			connections: { query: async () => m.connections() },
		},
		envVariable: {
			list: {
				query: async () => [
					{ key: "NODE_ENV", value: "development" },
					{ key: "DATABASE_URL", value: PLACEHOLDER },
				],
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
		readPackageJson: () => ({ name: "my-app", scripts: { build: "tsc" } }),
		detectPackageManager: () => "npm",
		detectFramework: () => null,
		runCommand: async (command: string, env: Record<string, string>) => {
			m.runs.push({ command, env });
			return { exitCode: 0, signal: null };
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
import { registerBuildCommand } from "../src/commands/build";
import { registerDevCommand } from "../src/commands/dev";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: true,
	yes: false,
	nonInteractive: false,
};

let stdout: string[];
let stderr: string[];

beforeEach(() => {
	m.connections = async () => ({ env: {}, unavailable: [] });
	m.runs = [];
	stdout = [];
	stderr = [];
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
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

async function invoke(command: "dev" | "build", json = false) {
	setGlobalOptions({ ...RESET, json });
	const program = new Command();
	registerBuildCommand(program);
	registerDevCommand(program);
	await program.parseAsync([
		"node",
		"tarout",
		command,
		"--app",
		"my-app",
		"--command",
		"npm run check",
	]);
}

describe.each(["dev", "build"] as const)("tarout %s env", (command) => {
	it("injects the external DATABASE_URL, never the placeholder", async () => {
		m.connections = async () => ({
			env: { DATABASE_URL: "postgres://app:pw@ext.tarout.sa:6432/app" },
			unavailable: [],
		});
		await invoke(command);
		expect(m.runs).toHaveLength(1);
		expect(m.runs[0]?.env.DATABASE_URL).toBe(
			"postgres://app:pw@ext.tarout.sa:6432/app",
		);
		expect(m.runs[0]?.env.NODE_ENV).toBe("development");
	});

	it("drops the placeholder and still runs on a server without application.connections", async () => {
		m.connections = async () => {
			throw Object.assign(
				new Error('No "query"-procedure on path "application.connections"'),
				{ data: { code: "NOT_FOUND" } },
			);
		};
		await invoke(command);
		expect(m.runs).toHaveLength(1);
		expect(m.runs[0]?.env).not.toHaveProperty("DATABASE_URL");
		expect(
			stderr.filter((line) => line.includes("application.connections")),
		).toHaveLength(1);
	});

	it("lists unavailable databases in the --json result, without values", async () => {
		const unavailable = {
			databaseId: "pg_1",
			name: "main",
			engine: "postgres",
			keys: ["DATABASE_URL"],
			reason: "external_access_disabled",
			hint: "Enable external access first.",
		};
		m.connections = async () => ({ env: {}, unavailable: [unavailable] });
		await invoke(command, true);
		expect(m.runs[0]?.env).not.toHaveProperty("DATABASE_URL");
		const envelope = stdout
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.find((payload) => payload?.success === true);
		expect(envelope?.data?.unavailableEnv).toEqual([unavailable]);
		expect(stdout.join("\n")).not.toContain(PLACEHOLDER);
	});
});
