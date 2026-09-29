import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MANIFEST = {
	project: {
		id: "prj_1",
		name: "Shop",
		description: "Storefront and API",
		region: "me-central2",
	},
	applications: [
		{
			id: "app_1",
			name: "web",
			appName: "web-x1",
			status: "running",
			url: "https://web-x1.tarout.app",
			buildType: "nixpacks",
			source: { type: "github", repository: "acme/shop", branch: "main" },
			customDomains: ["shop.example.com"],
			databaseIds: ["pg_1"],
			envVarNames: ["DATABASE_URL", "NODE_ENV", "STRIPE_KEY"],
			scheduledJobCount: 2,
		},
		{
			id: "app_2",
			name: "worker",
			appName: "worker-y2",
			status: "idle",
			url: null,
			buildType: null,
			source: null,
			customDomains: [],
			databaseIds: [],
			envVarNames: [],
			scheduledJobCount: 0,
		},
	],
	databases: [
		{
			id: "pg_1",
			name: "main",
			engine: "postgres",
			status: "running",
			plan: "starter",
			linkedApplicationIds: ["app_1"],
			externalAccess: false,
		},
	],
	buckets: [{ id: "bkt_1", name: "assets", status: "active" }],
	domains: [
		{
			id: "dom_1",
			host: "shop.example.com",
			applicationId: "app_1",
			status: "verified",
		},
	],
	generatedAt: "2026-09-29T10:00:00.000Z",
};

const m = vi.hoisted(() => ({
	projectId: "prj_1" as string | null,
	manifest: (async () => ({})) as (input: unknown) => Promise<unknown>,
	inputs: [] as unknown[],
}));

vi.mock("../src/lib/config.js", async () => ({
	...(await vi.importActual<typeof import("../src/lib/config")>(
		"../src/lib/config",
	)),
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
}));

vi.mock("../src/lib/api.js", async () => ({
	...(await vi.importActual<typeof import("../src/lib/api")>(
		"../src/lib/api",
	)),
	getRequestProjectId: () => m.projectId,
	getApiClient: () => ({
		project: {
			manifest: {
				query: async (input: unknown) => {
					m.inputs.push(input);
					return m.manifest(input);
				},
			},
		},
	}),
}));

import { Command } from "commander";
import { registerAgentCommands } from "../src/commands/agent";
import { renderAgentManifest } from "../src/lib/agent-manifest";
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
	m.projectId = "prj_1";
	m.manifest = async () => MANIFEST;
	m.inputs = [];
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

async function manifest(...args: string[]): Promise<void> {
	const program = new Command();
	registerAgentCommands(program);
	try {
		await program.parseAsync(["node", "tarout", "agent", "manifest", ...args]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

describe("renderAgentManifest", () => {
	it("prints a compact tree with env vars as a count", () => {
		const text = renderAgentManifest(MANIFEST as never).join("\n");
		expect(text).toContain("Shop (prj_1) · region me-central2");
		expect(text).toContain("├─ apps (2)");
		expect(text).toContain("web · running · https://web-x1.tarout.app");
		expect(text).toContain("source: github acme/shop@main · build: nixpacks");
		expect(text).toContain("domains: shop.example.com");
		expect(text).toContain("databases: main");
		expect(text).toContain("env: 3 vars");
		expect(text).toContain("jobs: 2");
		expect(text).toContain("worker · idle · no url");
		expect(text).toContain("source: none");
		expect(text).toContain("env: 0 vars");
		expect(text).toContain(
			"main · postgres · running · plan starter · external access off",
		);
		expect(text).toContain("linked: web");
		expect(text).toContain("assets · active");
		expect(text).toContain("└─ domains (1)");
		expect(text).toContain("shop.example.com → web · verified");
		expect(text).not.toContain("STRIPE_KEY");
	});

	it("lists env var names with envNames", () => {
		const text = renderAgentManifest(MANIFEST as never, {
			envNames: true,
		}).join("\n");
		expect(text).toContain("env: DATABASE_URL, NODE_ENV, STRIPE_KEY");
		expect(text).toContain("env: none");
	});
});

describe("tarout agent manifest", () => {
	it("prints the tree and asks for the invocation's project", async () => {
		await manifest();
		expect(m.inputs).toEqual([{ projectId: "prj_1" }]);
		const text = stdout.join("\n");
		expect(text).toContain("Shop (prj_1)");
		expect(text).toContain("env: 3 vars");
		expect(exitCodes).toEqual([]);
	});

	it("passes --env-names through to the tree", async () => {
		await manifest("--env-names");
		expect(stdout.join("\n")).toContain(
			"env: DATABASE_URL, NODE_ENV, STRIPE_KEY",
		);
	});

	it("lets the server pick the active project when none is selected", async () => {
		m.projectId = null;
		await manifest();
		expect(m.inputs).toEqual([{}]);
	});

	it("prints the manifest in the standard envelope with --json", async () => {
		setGlobalOptions({ ...RESET, json: true });
		await manifest();
		expect(stdout).toHaveLength(1);
		const envelope = JSON.parse(stdout[0] as string);
		expect(envelope.success).toBe(true);
		expect(envelope.data).toEqual(MANIFEST);
		expect(exitCodes).toEqual([]);
	});

	it("fails with NOT_FOUND and a pointer on a server without project.manifest", async () => {
		m.manifest = async () => {
			throw Object.assign(
				new Error('No "query"-procedure on path "project.manifest"'),
				{ data: { code: "NOT_FOUND" } },
			);
		};
		setGlobalOptions({ ...RESET, json: true });
		await manifest();
		expect(exitCodes).toEqual([4]);
		const envelope = JSON.parse(stdout[0] as string);
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("NOT_FOUND");
		expect(envelope.error.message).toContain("project.manifest");
		expect(envelope.error.message).toContain("tarout apps list");
		expect(envelope.error.details).toEqual({
			procedure: "project.manifest",
			reason: "procedure_unavailable",
		});
	});

	it("does not mask other failures as an older server", async () => {
		m.manifest = async () => {
			throw Object.assign(new Error("Project not found"), {
				data: { code: "NOT_FOUND" },
			});
		};
		await manifest();
		expect(exitCodes).toEqual([4]);
		expect(stderr.join("\n")).toContain("Project not found");
		expect(stderr.join("\n")).not.toContain("tarout apps list");
	});
});
