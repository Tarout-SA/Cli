import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const RUN_ID = "7f1c2a4e-9a0b-4c7d-8e1f-0123456789ab";
const PLAN = { plan: { provider: "render", sourceName: "api", services: [], jobs: [], databases: [], domains: [], issues: [] }, repoAccess: {} };
const finished = {
	runId: RUN_ID,
	state: "finished",
	result: {},
	copies: { db: { status: "done" } },
	deployments: [],
	report: { moved: [], notMoved: [], notes: [], domains: [], complete: true },
};

const fakeClient = {
	platformImport: {
		plan: { mutate: vi.fn() },
		start: { mutate: vi.fn() },
		status: { query: vi.fn() },
		finish: { mutate: vi.fn() },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerImportTools } from "../../src/mcp/tools/import";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerImportTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: SDK stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as { content: [{ text: string }]; isError?: boolean };
}

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tarout-mcp-import-"));
	writeFileSync(join(dir, "render.yaml"), "services:\n  - type: web\n    name: api\n");
	process.env.RENDER_API_KEY = "rnd_secret";
	fakeClient.platformImport.plan.mutate.mockReset().mockResolvedValue(PLAN);
	fakeClient.platformImport.start.mutate
		.mockReset()
		.mockResolvedValue({ runId: RUN_ID, apps: [{ appName: "api-x1" }], databases: [], next: "wait_for_copy" });
	fakeClient.platformImport.status.query.mockReset().mockResolvedValue(finished);
	fakeClient.platformImport.finish.mutate.mockReset();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

describe("import tools", () => {
	it("import_project plans by default with the token from the environment", async () => {
		const r = await invoke("import_project", {
			path: dir,
			databaseMode: "copy",
			databasePlan: "STARTER",
			deploy: true,
			execute: false,
			waitSeconds: 0,
		});
		const body = JSON.parse(r.content[0].text);
		expect(body.mode).toBe("plan");
		expect(body.sourceAuth).toBe("token found in the environment");
		expect(fakeClient.platformImport.plan.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "render", token: "rnd_secret" }),
		);
		expect(fakeClient.platformImport.start.mutate).not.toHaveBeenCalled();
		expect(r.content[0].text).not.toContain("rnd_secret");
	});

	it("import_project runs the import with execute=true and returns the report", async () => {
		const r = await invoke("import_project", {
			path: dir,
			only: ["api"],
			databaseMode: "keep",
			databasePlan: "STARTER",
			deploy: true,
			execute: true,
			waitSeconds: 0,
		});
		const body = JSON.parse(r.content[0].text);
		expect(body).toMatchObject({ mode: "import", runId: RUN_ID, state: "finished" });
		expect(fakeClient.platformImport.start.mutate.mock.calls[0][0].selection).toEqual({
			services: ["api"],
			databaseMode: "keep",
			databasePlan: "STARTER",
			deploy: true,
		});
	});

	it("import_project says how to provide a missing token", async () => {
		delete process.env.RENDER_API_KEY;
		const r = await invoke("import_project", { path: dir, databaseMode: "copy", databasePlan: "STARTER", deploy: true, execute: false, waitSeconds: 0 });
		expect(JSON.parse(r.content[0].text).sourceAuth).toContain("set RENDER_API_KEY");
	});

	it("import_status deploys a ready run", async () => {
		fakeClient.platformImport.status.query.mockResolvedValueOnce({ ...finished, state: "ready" });
		const r = await invoke("import_status", { runId: RUN_ID, deploy: true });
		expect(fakeClient.platformImport.finish.mutate).toHaveBeenCalledWith({ runId: RUN_ID });
		expect(JSON.parse(r.content[0].text).state).toBe("finished");
	});
});
