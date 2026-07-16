import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient: {
	settings: { getSurfaceManifest: { query: ReturnType<typeof vi.fn> } };
	user: { get: { query: ReturnType<typeof vi.fn> } };
	application: { create: { mutate: ReturnType<typeof vi.fn> } };
} = {
	settings: {
		getSurfaceManifest: {
			query: vi.fn().mockResolvedValue([
				{ path: "user.get", type: "query", router: "user" },
				{ path: "application.create", type: "mutation", router: "application" },
			]),
		},
	},
	user: { get: { query: vi.fn().mockResolvedValue({ id: "u1" }) } },
	application: { create: { mutate: vi.fn().mockResolvedValue({ id: "a1" }) } },
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCallTools } from "../../src/mcp/tools/call";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerCallTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// The SDK renamed the field from `callback` to `handler` in 1.29.x; the
	// stored value is the callback function itself, invoked with (args, extra).
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("call tool", () => {
	it("dispatches queries via the manifest", async () => {
		const r = await invoke("call", { procedure: "user.get", input: {} });
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content[0].text)).toEqual({ id: "u1" });
		expect(fakeClient.user.get.query).toHaveBeenCalledWith({});
	});

	it("dispatches mutations via the manifest", async () => {
		const r = await invoke("call", {
			procedure: "application.create",
			input: { name: "x" },
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.create.mutate).toHaveBeenCalledWith({ name: "x" });
	});

	it("returns a structured error for unknown procedures", async () => {
		const r = await invoke("call", { procedure: "does.not.exist", input: {} });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
	});
});

describe("list_procedures tool", () => {
	it("returns the full manifest with no filter", async () => {
		const r = await invoke("list_procedures", {});
		const body = JSON.parse(r.content[0].text) as { count: number };
		expect(body.count).toBeGreaterThanOrEqual(2);
	});

	it("filters by substring", async () => {
		const r = await invoke("list_procedures", { filter: "application" });
		const body = JSON.parse(r.content[0].text) as { count: number };
		expect(body.count).toBe(1);
	});
});
