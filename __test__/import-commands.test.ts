import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout import` reads the repo's vercel.json / render.yaml, takes the source
 * token from the environment, and drives platformImport plan → start →
 * status → finish.
 */

const h = vi.hoisted(() => ({ client: {} as any }));

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

import { Command } from "commander";
import { registerImportCommands } from "../src/commands/import";
import { commandRequiresProject } from "../src/lib/command-gates";
import { setGlobalOptions } from "../src/lib/output";
import {
	buildSourceInput,
	detectImportProvider,
	readDatabaseUrls,
	readSourceToken,
	waitForImport,
} from "../src/lib/platform-import";

const RESET = { json: false, quiet: false, verbose: false, noColor: false, yes: false, nonInteractive: false };
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
const ANSI = /\x1b\[[0-9;]*m/g;

const PLAN = {
	plan: {
		provider: "vercel",
		sourceName: "shop",
		services: [
			{
				key: "web",
				name: "shop",
				kind: "web",
				repo: { owner: "acme", repository: "shop", branch: "main" },
				env: [
					{ key: "A", source: "api" },
					{ key: "POSTGRES_URL", source: "database" },
					{ key: "S", source: "missing" },
				],
			},
		],
		jobs: [{ key: "cron-1", name: "cron-1", serviceKey: "web", cron: "0 3 * * *", jobType: "HTTP" }],
		databases: [{ key: "db", name: "shop-db", engine: "postgres", serviceKeys: ["web"] }],
		domains: [{ host: "shop.example.com", serviceKey: "web", onTarout: false }],
		issues: [{ severity: "warning", code: "vercel.rewrites", serviceKey: "web", message: "Rewrites do nothing.", fix: "Move them." }],
	},
	repoAccess: { web: true },
};

const REPORT = {
	moved: [{ kind: "app", name: "shop", detail: "web app shop-x1" }],
	notMoved: [{ name: "shop", message: "Rewrites do nothing.", fix: "Move them." }],
	notes: [],
	domains: [{ host: "shop.example.com", app: "shop-x1", onTarout: false, command: "tarout domains link shop-x1 shop.example.com", steps: "Point DNS." }],
	complete: true,
};

const RUN_ID = "7f1c2a4e-9a0b-4c7d-8e1f-0123456789ab";

let stdout: string[];
let dir: string;
let cwd: string;
const savedEnv = { ...process.env };

function status(state: "copying" | "ready" | "finished") {
	return {
		runId: RUN_ID,
		state,
		result: { runId: RUN_ID, apps: [], databases: [], next: "wait_for_copy" },
		copies: { db: { status: state === "copying" ? "copying" : "done", message: "Dumping" } },
		deployments: [],
		report: REPORT,
	};
}

beforeEach(() => {
	stdout = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	cwd = process.cwd();
	dir = mkdtempSync(join(tmpdir(), "tarout-import-"));
	writeFileSync(join(dir, "vercel.json"), JSON.stringify({ crons: [] }));
	mkdirSync(join(dir, ".vercel"));
	writeFileSync(join(dir, ".vercel/project.json"), JSON.stringify({ projectId: "prj_1", orgId: "team_1" }));
	writeFileSync(join(dir, ".env"), "SECRET=never-sent");
	process.chdir(dir);
	process.env.VERCEL_TOKEN = "vercel-secret-token";
	h.client = {
		platformImport: {
			plan: { mutate: vi.fn().mockResolvedValue(PLAN) },
			start: {
				mutate: vi.fn().mockResolvedValue({
					runId: RUN_ID,
					apps: [{ serviceKey: "web", name: "shop", kind: "web", applicationId: "app-1", appName: "shop-x1", url: "https://shop-x1.tarout.app" }],
					databases: [{ databaseKey: "db", name: "shop-db", postgresId: "pg-1", copy: "queued" }],
					next: "wait_for_copy",
				}),
			},
			status: { query: vi.fn().mockResolvedValueOnce(status("ready")).mockResolvedValue(status("finished")) },
			finish: { mutate: vi.fn().mockResolvedValue({ deployments: [], alreadyFinished: false }) },
		},
	};
});

afterEach(() => {
	process.chdir(cwd);
	rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
	vi.restoreAllMocks();
	setGlobalOptions(RESET);
});

async function run(argv: string[], options: Partial<typeof RESET> = {}) {
	setGlobalOptions({ ...RESET, ...options });
	const program = new Command();
	program.exitOverride();
	registerImportCommands(program);
	await program.parseAsync(["node", "tarout", ...argv]);
}

describe("tarout import", () => {
	it("plans only on --dry-run, sending config files and the env token", async () => {
		await run(["import", "--dry-run"]);
		const input = h.client.platformImport.plan.mutate.mock.calls[0][0];
		expect(input.provider).toBe("vercel");
		expect(input.token).toBe("vercel-secret-token");
		expect(input.files.map((file: { path: string }) => file.path).sort()).toEqual([".vercel/project.json", "vercel.json"]);
		// .env is never read or sent.
		expect(JSON.stringify(input.files)).not.toContain("never-sent");
		expect(h.client.platformImport.start.mutate).not.toHaveBeenCalled();
		const out = stdout.join("\n");
		expect(out).toContain("Import from Vercel: shop");
		expect(out).toContain("variables: 3 (1 api, 1 database, 1 missing)");
		expect(out).toContain("Rewrites do nothing.");
		expect(out).not.toContain("vercel-secret-token");
	});

	it("imports, waits for the copy, deploys and prints the report", async () => {
		await run(["import", "--database", "copy", "--only", "web"], { yes: true });
		expect(h.client.platformImport.start.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "vercel",
				selection: { services: ["web"], databaseMode: "copy", databasePlan: "STARTER", deploy: true },
			}),
		);
		expect(h.client.platformImport.finish.mutate).toHaveBeenCalledWith({ runId: RUN_ID });
		const out = stdout.join("\n");
		expect(out).toContain("Import complete");
		expect(out).toContain("tarout domains link shop-x1 shop.example.com");
		expect(out).toContain("shop-x1  https://shop-x1.tarout.app");
	});

	it("does not deploy with --no-deploy and tells how to finish", async () => {
		h.client.platformImport.status.query = vi.fn().mockResolvedValue(status("ready"));
		await run(["import", "--no-deploy"], { yes: true });
		expect(h.client.platformImport.finish.mutate).not.toHaveBeenCalled();
		expect(h.client.platformImport.start.mutate.mock.calls[0][0].selection.deploy).toBe(false);
		expect(stdout.join("\n")).toContain(`tarout import status ${RUN_ID} --deploy`);
	});

	it("refuses before creating anything when the repo is not readable", async () => {
		h.client.platformImport.plan.mutate.mockResolvedValue({ ...PLAN, repoAccess: { web: false } });
		await expect(run(["import"], { yes: true })).rejects.toThrow("__EXIT_2");
		expect(h.client.platformImport.start.mutate).not.toHaveBeenCalled();
	});

	it("asks for the token as needs_input in agent mode instead of a flag", async () => {
		delete process.env.VERCEL_TOKEN;
		// The mocked process.exit(6) throws inside the command; a real run exits there.
		await expect(run(["import"], { json: true })).rejects.toThrow(/__EXIT_/);
		expect(process.exit).toHaveBeenCalledWith(6);
		expect(h.client.platformImport.plan.mutate).not.toHaveBeenCalled();
		const event = stdout.find((line) => line.includes("needs_input"));
		expect(event).toContain('"sensitive":true');
		expect(event).toContain("--token-env");
	});

	it("validates its options", async () => {
		await expect(run(["import", "--database", "move"], { yes: true })).rejects.toThrow("__EXIT_2");
		await expect(run(["import", "--from", "heroku"], { yes: true })).rejects.toThrow("__EXIT_2");
	});

	it("is project-scoped", () => {
		const program = new Command();
		registerImportCommands(program);
		const command = program.commands.find((c) => c.name() === "import");
		expect(commandRequiresProject(command, program)).toBe(true);
	});

	it("import status --deploy finishes a ready run", async () => {
		h.client.platformImport.status.query = vi
			.fn()
			.mockResolvedValueOnce(status("ready"))
			.mockResolvedValueOnce(status("finished"));
		await run(["import", "status", RUN_ID, "--deploy"]);
		expect(h.client.platformImport.finish.mutate).toHaveBeenCalledWith({ runId: RUN_ID });
		expect(stdout.join("\n")).toContain("Import complete");
	});
});

describe("platform-import lib", () => {
	it("detects the platform from the repo, render.yaml first", () => {
		expect(detectImportProvider(dir)).toBe("vercel");
		writeFileSync(join(dir, "render.yaml"), "services: []");
		expect(detectImportProvider(dir)).toBe("render");
		const empty = mkdtempSync(join(tmpdir(), "tarout-empty-"));
		expect(detectImportProvider(empty)).toBeNull();
		rmSync(empty, { recursive: true, force: true });
	});

	it("reads tokens and database URLs from the environment only", () => {
		expect(readSourceToken("render", undefined, { RENDER_API_KEY: " rnd " })).toBe("rnd");
		expect(readSourceToken("vercel", "MY_TOKEN", { MY_TOKEN: "x" })).toBe("x");
		expect(readSourceToken("vercel", undefined, {})).toBeUndefined();
		expect(readDatabaseUrls(["db=SRC"], { SRC: "postgres://u:p@h/d" })).toEqual({ db: "postgres://u:p@h/d" });
		expect(() => readDatabaseUrls(["db=MISSING"], {})).toThrow(/MISSING is empty/);
		expect(() => readDatabaseUrls(["nope"], {})).toThrow(/expects/);
	});

	it("builds provider-specific source input", () => {
		writeFileSync(join(dir, "render.yaml"), "services: []");
		const render = buildSourceInput({ provider: "render", cwd: dir, services: ["api"], project: "ignored" });
		expect(render).toMatchObject({ provider: "render", services: ["api"] });
		expect(render).not.toHaveProperty("project");
		expect(render.files.map((file) => file.path)).toEqual(["render.yaml"]);
		expect(render.repoPaths).toEqual(expect.arrayContaining(["render.yaml", "vercel.json"]));
	});

	it("waits until the copy ends, then deploys once", async () => {
		const client = {
			platformImport: {
				status: {
					query: vi
						.fn()
						.mockResolvedValueOnce(status("copying"))
						.mockResolvedValueOnce(status("copying"))
						.mockResolvedValueOnce(status("ready"))
						.mockResolvedValueOnce(status("finished")),
				},
				finish: { mutate: vi.fn().mockResolvedValue({}) },
			},
		};
		const progress = vi.fn();
		const result = await waitForImport(client, RUN_ID, {
			deploy: true,
			timeoutMs: 60_000,
			onProgress: progress,
			sleepFn: async () => {},
		});
		expect(result.timedOut).toBe(false);
		expect(result.status.state).toBe("finished");
		expect(progress).toHaveBeenCalledTimes(2);
		expect(client.platformImport.finish.mutate).toHaveBeenCalledTimes(1);
	});

	it("gives up waiting at the deadline", async () => {
		const client = {
			platformImport: {
				status: { query: vi.fn().mockResolvedValue(status("copying")) },
				finish: { mutate: vi.fn() },
			},
		};
		const result = await waitForImport(client, RUN_ID, { deploy: true, timeoutMs: 0, sleepFn: async () => {} });
		expect(result.timedOut).toBe(true);
		expect(client.platformImport.finish.mutate).not.toHaveBeenCalled();
	});
});
