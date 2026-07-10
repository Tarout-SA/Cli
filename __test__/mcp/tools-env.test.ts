import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
	},
	envVariable: {
		list: {
			query: vi.fn().mockResolvedValue([
				{ key: "A", value: "1" },
				{ key: "B", value: "2" },
			]),
		},
		import: { mutate: vi.fn().mockResolvedValue({ inserted: 2 }) },
		export: { query: vi.fn().mockResolvedValue({ content: "A=1\nB=2\n" }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEnvTools } from "../../src/mcp/tools/env";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerEnvTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// The SDK renamed the field from `callback` to `handler` in 1.29.x; the
	// stored value is the callback function itself, invoked with (args, extra).
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as { content: [{ text: string }]; isError?: boolean };
}

beforeEach(() => {
	fakeClient.application.allByOrganization.query.mockClear();
	fakeClient.envVariable.list.query.mockClear();
	fakeClient.envVariable.import.mutate.mockClear();
	fakeClient.envVariable.export.query.mockClear();
	fakeClient.envVariable.list.query.mockResolvedValue([
		{ key: "A", value: "1" },
		{ key: "B", value: "2" },
	]);
});

describe("env_list", () => {
	it("resolves app by name and returns keys", async () => {
		const r = await invoke("env_list", { app: "web" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			keys: string[];
			app: { applicationId: string; name: string };
		};
		expect(body.keys).toEqual(["A", "B"]);
		expect(body.app).toEqual({ applicationId: "app_1", name: "web" });
		expect(fakeClient.envVariable.list.query).toHaveBeenCalledWith({
			applicationId: "app_1",
			includeValues: false,
		});
	});

	it("returns values when reveal=true", async () => {
		const r = await invoke("env_list", { app: "web", reveal: true });
		const body = JSON.parse(r.content[0].text) as {
			vars: Record<string, string>;
		};
		expect(body.vars).toEqual({ A: "1", B: "2" });
		expect(fakeClient.envVariable.list.query).toHaveBeenCalledWith({
			applicationId: "app_1",
			includeValues: true,
		});
	});

	it("returns NOT_FOUND envelope when app cannot be resolved", async () => {
		const r = await invoke("env_list", { app: "does-not-exist" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
	});
});

describe("env_set", () => {
	it("serializes vars and imports with merge=true", async () => {
		const r = await invoke("env_set", {
			app: "web",
			vars: { NEW_KEY: "hello" },
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.envVariable.import.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "app_1",
				format: "dotenv",
				merge: true,
				restart: false,
			}),
		);
		const call = fakeClient.envVariable.import.mutate.mock.calls[0][0];
		expect(call.content).toContain("NEW_KEY=hello");
	});
});

describe("env_unset", () => {
	it("re-uploads the remaining vars with merge=false", async () => {
		const r = await invoke("env_unset", { app: "web", keys: ["A"] });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.envVariable.import.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "app_1",
				format: "dotenv",
				merge: false,
			}),
		);
		const call = fakeClient.envVariable.import.mutate.mock.calls[0][0];
		expect(call.content).not.toContain("A=");
		expect(call.content).toContain("B=2");
	});
});

describe("env_pull", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "envpull-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("writes the exported dotenv to <path>/.env with mode 0600", async () => {
		const r = await invoke("env_pull", { app: "web", path: dir });
		expect(r.isError).toBeUndefined();
		const target = join(dir, ".env");
		const text = readFileSync(target, "utf8");
		expect(text).toBe("A=1\nB=2\n");
		// mode & 0o777 masks to permission bits; expect exactly 0o600.
		const mode = statSync(target).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

describe("env_push", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "envpush-"));
		writeFileSync(join(dir, ".env"), "A=1\nB=hi\n");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("reads a dotenv file, resolves app, calls import", async () => {
		const r = await invoke("env_push", { app: "web", path: dir });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.envVariable.import.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "app_1",
				format: "dotenv",
				merge: true,
			}),
		);
	});
});
