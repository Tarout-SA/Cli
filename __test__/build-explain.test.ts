import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout build --explain`: asks the platform what a deploy would build from
 * the app's configured source and reports it. It must never run a local
 * command, read package.json or fetch env values; it exits 0 on ok, 12
 * (BUILD_FAILED) on failed, 11 when the answer is still pending after --wait,
 * and says plainly when the server is too old or the rate limit is hit.
 */

const m = vi.hoisted(() => ({
	linked: null as null | { applicationId: string; name: string },
	runs: 0,
	packageReads: 0,
	envListCalls: 0,
	explainBuild: null as unknown as ReturnType<typeof vi.fn>,
	explainBuildResult: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	getApiUrl: () => "https://tarout.sa",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
	isProjectLinked: () => m.linked !== null,
	getProjectConfig: () =>
		m.linked ? { ...m.linked, organizationId: "org_1", linkedAt: "x" } : null,
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		application: {
			allByOrganization: {
				query: async () => [
					{ applicationId: "app_1", name: "my-app", appName: "my-app-x1" },
				],
			},
			connections: { query: async () => ({ env: {}, unavailable: [] }) },
			explainBuild: { query: m.explainBuild },
			explainBuildResult: { query: m.explainBuildResult },
		},
		envVariable: {
			list: {
				query: async () => {
					m.envListCalls += 1;
					return [];
				},
			},
		},
	}),
}));

vi.mock("../src/lib/process.js", () => ({
	readPackageJson: () => {
		m.packageReads += 1;
		return { name: "my-app", scripts: { build: "tsc" } };
	},
	detectPackageManager: () => "npm",
	getBuildCommand: () => "npm run build",
	detectFramework: () => null,
	envVarsToObject: () => ({}),
	runCommand: async () => {
		m.runs += 1;
		return { exitCode: 0 };
	},
	runArgv: async () => {
		m.runs += 1;
		return { exitCode: 0, signal: null };
	},
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import {
	formatBuildExplainReport,
	registerBuildCommand,
} from "../src/commands/build";
import type { BuildExplainResult } from "../src/lib/build-explain";
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
	m.linked = null;
	m.runs = 0;
	m.packageReads = 0;
	m.envListCalls = 0;
	m.explainBuild = vi.fn();
	m.explainBuildResult = vi.fn();
	stdout = [];
	stderr = [];
	exitCodes = [];
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
	vi.useRealTimers();
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

function run(argv: string[], opts: Partial<typeof RESET> = {}): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerBuildCommand(program);
	return program
		.parseAsync(["node", "tarout", "build", ...argv])
		.then(() => undefined)
		.catch((err) => {
			if (!/__EXIT_/.test(String(err))) throw err;
		});
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON envelopes are asserted field by field.
type Envelope = Record<string, any>;

function envelopes(): Envelope[] {
	return stdout
		.map((line) => {
			try {
				return JSON.parse(line) as Envelope;
			} catch {
				return null;
			}
		})
		.filter((v): v is Envelope => !!v && "success" in v);
}

function explained(
	overrides: Partial<BuildExplainResult> = {},
): BuildExplainResult {
	return {
		status: "ok",
		detectedKind: "node",
		buildType: "railpack",
		summary: "A Node.js app built with npm; the deploy would get past preflight.",
		plan: {
			providers: ["node"],
			packages: [
				{ name: "node", version: "22.11.0", source: "package.json" },
				{ name: "npm", version: "10.9.0", source: null },
			],
			steps: [
				{ name: "install", commands: ["npm ci"] },
				{ name: "build", commands: ["npm run build"] },
			],
			startCommand: "node dist/server.js",
			port: 3000,
			buildEnv: ["DATABASE_URL", "NEXT_PUBLIC_API_URL"],
		},
		warnings: [],
		errors: [],
		source: {
			type: "github",
			repository: "https://github.com/acme/my-app",
			branch: "main",
			commitSha: "a1b2c3d4e5f60718",
		},
		...overrides,
	};
}

const FAILED = explained({
	status: "failed",
	detectedKind: null,
	summary: "The deploy would stop before the build starts.",
	plan: null,
	warnings: ["No lockfile was found, so versions may drift."],
	errors: [
		"No start command was detected. Add a start script.",
		"Port 99999 is out of range.",
	],
});

const PENDING = explained({
	status: "pending",
	jobId: "explain-42",
	detectedKind: null,
	summary:
		"Still inspecting the source. Poll application.explainBuildResult with this jobId.",
	plan: null,
});

describe("tarout build --explain", () => {
	it("prints the plan for an ok answer, exits 0 and runs nothing locally", async () => {
		m.explainBuild.mockResolvedValueOnce(explained());
		await run(["--explain", "--app", "my-app"]);

		expect(exitCodes).toEqual([]);
		expect(m.explainBuild).toHaveBeenCalledWith({ applicationId: "app_1" });
		expect(m.explainBuildResult).not.toHaveBeenCalled();
		// Remote mode: no local command, no package.json, no env values.
		expect(m.runs).toBe(0);
		expect(m.packageReads).toBe(0);
		expect(m.envListCalls).toBe(0);

		const text = out();
		expect(text).toContain("Build plan for my-app");
		expect(text).toContain("not your local files");
		expect(text).toContain(
			"Source:     https://github.com/acme/my-app@main (a1b2c3d) [github]",
		);
		expect(text).toContain("Detected:   node (build type: railpack)");
		expect(text).toContain("Summary:    A Node.js app built with npm");
		expect(text).toContain("Providers:  node");
		expect(text).toContain("Packages:   node 22.11.0, npm 10.9.0");
		expect(text).toContain("1. install");
		expect(text).toContain("$ npm ci");
		expect(text).toContain("2. build");
		expect(text).toContain("Start:      node dist/server.js");
		expect(text).toContain("Port:       3000");
		expect(text).toContain(
			"Build env:  DATABASE_URL, NEXT_PUBLIC_API_URL (names only)",
		);
		expect(text).not.toContain("Errors");
	});

	it("uses the linked app when --app is not given", async () => {
		m.linked = { applicationId: "app_9", name: "linked-app" };
		m.explainBuild.mockResolvedValueOnce(explained());
		await run(["--explain"]);
		expect(exitCodes).toEqual([]);
		expect(m.explainBuild).toHaveBeenCalledWith({ applicationId: "app_9" });
		expect(out()).toContain("Build plan for linked-app");
	});

	it("prints one success envelope with the raw answer under --json", async () => {
		m.explainBuild.mockResolvedValueOnce(explained());
		await run(["--explain", "--app", "my-app"], { json: true });

		expect(exitCodes).toEqual([]);
		const all = envelopes();
		expect(all).toHaveLength(1);
		expect(stdout).toHaveLength(1);
		expect(all[0]).toEqual({
			success: true,
			data: { applicationId: "app_1", name: "my-app", ...explained() },
		});
		expect(m.runs).toBe(0);
	});

	it("highlights warnings and errors and exits BUILD_FAILED (12) on failed", async () => {
		m.explainBuild.mockResolvedValueOnce(FAILED);
		await run(["--explain", "--app", "my-app"]);

		expect(exitCodes).toEqual([12]);
		const text = out();
		expect(text).toContain("Build plan for my-app  ✗ failed");
		expect(text).toContain("Warnings (1):");
		expect(text).toContain("⚠ No lockfile was found");
		expect(text).toContain("Errors (2):");
		expect(text).toContain("✗ No start command was detected. Add a start script.");
		expect(text).toContain("✗ Port 99999 is out of range.");
		expect(err()).toContain(
			"Error: A deploy of my-app would fail: No start command was detected. Add a start script. (+1 more)",
		);
		expect(m.runs).toBe(0);
	});

	it("emits a BUILD_FAILED envelope carrying the raw answer under --json", async () => {
		m.explainBuild.mockResolvedValueOnce(FAILED);
		await run(["--explain", "--app", "my-app"], { json: true });

		expect(exitCodes).toEqual([12]);
		const all = envelopes();
		expect(all).toHaveLength(1);
		expect(all[0].success).toBe(false);
		expect(all[0].error.code).toBe("BUILD_FAILED");
		expect(all[0].error.details).toEqual({
			applicationId: "app_1",
			name: "my-app",
			...FAILED,
		});
	});

	it("polls a pending answer until it settles", async () => {
		vi.useFakeTimers();
		m.explainBuild.mockResolvedValueOnce(PENDING);
		m.explainBuildResult
			.mockResolvedValueOnce(PENDING)
			.mockResolvedValueOnce(explained({ jobId: "explain-42" }));

		const done = run(["--explain", "--app", "my-app"], { json: true });
		await vi.advanceTimersByTimeAsync(10_000);
		await done;

		expect(exitCodes).toEqual([]);
		expect(m.explainBuildResult).toHaveBeenCalledTimes(2);
		expect(m.explainBuildResult).toHaveBeenCalledWith({
			applicationId: "app_1",
			jobId: "explain-42",
		});
		const [envelope] = envelopes();
		expect(envelope.success).toBe(true);
		expect(envelope.data.status).toBe("ok");
		expect(envelope.data.jobId).toBe("explain-42");
	});

	it("exits 11 with a resumable EXPLAIN_PENDING envelope when --wait runs out", async () => {
		vi.useFakeTimers();
		m.explainBuild.mockResolvedValueOnce(PENDING);
		m.explainBuildResult.mockResolvedValue(PENDING);

		const done = run(["--explain", "--app", "my-app", "--wait", "5"], {
			json: true,
		});
		await vi.advanceTimersByTimeAsync(10_000);
		await done;

		expect(exitCodes).toEqual([11]);
		// Polled every 2s inside the 5s budget, plus once at the deadline.
		expect(m.explainBuildResult).toHaveBeenCalledTimes(3);
		const all = envelopes();
		expect(all).toHaveLength(1);
		expect(all[0].success).toBe(false);
		expect(all[0].error.code).toBe("EXPLAIN_PENDING");
		expect(all[0].error.message).toContain("still inspecting my-app's source after 5s");
		expect(all[0].error.details).toMatchObject({
			applicationId: "app_1",
			status: "pending",
			jobId: "explain-42",
			stillPending: true,
			nextCommand: "tarout build --explain --app app_1",
		});
	});

	it("--wait 0 returns a pending answer at once, with the next step in human mode", async () => {
		m.explainBuild.mockResolvedValueOnce(PENDING);
		await run(["--explain", "--app", "my-app", "--wait", "0"]);

		expect(exitCodes).toEqual([11]);
		expect(m.explainBuildResult).not.toHaveBeenCalled();
		expect(err()).toContain("still inspecting my-app's source after 0s");
		expect(err()).toContain("Next: tarout build --explain --app app_1");
	});

	it("says a server without the procedure does not support build explain yet", async () => {
		m.explainBuild.mockRejectedValueOnce(
			Object.assign(
				new Error('No "query"-procedure on path "application.explainBuild"'),
				{ data: { code: "NOT_FOUND" } },
			),
		);
		await run(["--explain", "--app", "my-app"], { json: true });

		expect(exitCodes).toEqual([4]);
		const [envelope] = envelopes();
		expect(envelope.error.code).toBe("NOT_FOUND");
		expect(envelope.error.message).toContain(
			"This Tarout server does not support build explain yet",
		);
		expect(envelope.error.details).toEqual({
			procedure: "application.explainBuild",
			reason: "procedure_unavailable",
		});
	});

	it("keeps a real NOT_FOUND (unknown job) as it is", async () => {
		vi.useFakeTimers();
		m.explainBuild.mockResolvedValueOnce(PENDING);
		m.explainBuildResult.mockRejectedValueOnce(
			Object.assign(
				new Error(
					"No build explanation with that jobId for this application. It may have expired; call application.explainBuild again.",
				),
				{ data: { code: "NOT_FOUND" } },
			),
		);
		const done = run(["--explain", "--app", "my-app"], { json: true });
		await vi.advanceTimersByTimeAsync(5_000);
		await done;

		expect(exitCodes).toEqual([4]);
		const [envelope] = envelopes();
		expect(envelope.error.message).toContain("No build explanation with that jobId");
	});

	it("turns the rate limit into a wait-a-minute message", async () => {
		m.explainBuild.mockRejectedValueOnce(
			Object.assign(
				new Error(
					"Too many build explanations right now. Wait a minute and try again, or poll a pending one with application.explainBuildResult.",
				),
				{ data: { code: "TOO_MANY_REQUESTS" } },
			),
		);
		await run(["--explain", "--app", "my-app"], { json: true });

		expect(exitCodes).toEqual([1]);
		const [envelope] = envelopes();
		expect(envelope.error.code).toBe("TOO_MANY_REQUESTS");
		expect(envelope.error.message).toContain("10 a minute per user");
		expect(envelope.error.message).not.toContain("explainBuildResult");
		expect(envelope.error.details).toEqual({
			limitPerMinute: 10,
			retryAfterSeconds: 60,
		});
	});

	it("refuses --command with --explain before calling anything", async () => {
		await run(["--explain", "--app", "my-app", "--command", "npm run build"]);
		expect(exitCodes).toEqual([2]);
		expect(err()).toContain("--explain runs nothing locally");
		expect(m.explainBuild).not.toHaveBeenCalled();
		expect(m.runs).toBe(0);
	});

	it("refuses an out-of-range --wait, and --wait without --explain", async () => {
		await run(["--explain", "--app", "my-app", "--wait", "601"]);
		expect(exitCodes).toEqual([2]);
		expect(err()).toContain("--wait must be a whole number of seconds from 0 to 600");

		exitCodes = [];
		await run(["--app", "my-app", "--wait", "30"]);
		expect(exitCodes).toEqual([2]);
		expect(err()).toContain("--wait only applies with --explain");
		expect(m.explainBuild).not.toHaveBeenCalled();
		expect(m.runs).toBe(0);
	});

	it("prints only the status in quiet mode", async () => {
		m.explainBuild.mockResolvedValueOnce(explained());
		await run(["--explain", "--app", "my-app"], { quiet: true });
		expect(exitCodes).toEqual([]);
		expect(stdout).toEqual(["ok"]);
	});
});

describe("formatBuildExplainReport", () => {
	it("shortens a large plan and points at --json", () => {
		const report = formatBuildExplainReport(
			"big",
			explained({
				plan: {
					providers: ["node", "python"],
					packages: Array.from({ length: 11 }, (_, i) => ({
						name: `pkg${i}`,
						version: `1.${i}.0`,
						source: null,
					})),
					steps: Array.from({ length: 14 }, (_, i) => ({
						name: `step${i}`,
						commands: i === 0 ? ["a", "b", "c", "d", "e", "f"] : [`run ${"x".repeat(200)}`],
					})),
					startCommand: null,
					port: null,
					buildEnv: [],
				},
			}),
		).map((line) => line.replace(ANSI, ""));
		const text = report.join("\n");
		expect(text).toContain("pkg7 1.7.0 (+3 more)");
		expect(text).not.toContain("pkg8");
		expect(text).toContain("... 2 more commands");
		expect(text).toContain("... 2 more steps");
		expect(text).not.toContain("step12");
		expect(report.some((line) => line.length > 140)).toBe(false);
		expect(text).toContain("Start:      none detected");
		expect(text).toContain("Port:       none");
		expect(text).toContain("Build env:  none");
		expect(text).toContain("--json prints all of it");
	});

	it("describes an uploaded archive and a prebuilt image", () => {
		const archive = formatBuildExplainReport(
			"a",
			explained({ source: { type: "drop", repository: null, branch: null } }),
		).join("\n");
		expect(archive).toContain("Source:     last uploaded archive");

		const image = formatBuildExplainReport(
			"b",
			explained({
				source: {
					type: "dockerhub",
					repository: "nginx@sha256:abc",
					branch: null,
				},
			}),
		)
			.map((line) => line.replace(ANSI, ""))
			.join("\n");
		expect(image).toContain("Source:     nginx@sha256:abc [dockerhub]");
	});
});
