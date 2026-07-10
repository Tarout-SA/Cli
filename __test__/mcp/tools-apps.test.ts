import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([
				{
					applicationId: "app_1",
					name: "web",
					status: "running",
					plan: "SHARED",
					deployedUrl: "https://web.tarout.sh",
				},
			]),
		},
		one: {
			query: vi.fn().mockResolvedValue({ applicationId: "app_1", name: "web" }),
		},
		create: {
			mutate: vi.fn().mockResolvedValue({ applicationId: "app_2", name: "api" }),
		},
		getApplicationLogs: {
			query: vi.fn().mockResolvedValue({ logs: [{ line: "hi" }] }),
		},
		restart: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		stop: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		delete: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppsTools } from "../../src/mcp/tools/apps";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerAppsTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// The SDK renamed the field from `callback` to `handler` in 1.29.x; the
	// stored value is the callback function itself, invoked with (args, extra).
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as { content: [{ text: string }]; isError?: boolean };
}

beforeEach(() => {
	fakeClient.application.allByOrganization.query.mockClear();
	fakeClient.application.one.query.mockClear();
	fakeClient.application.create.mutate.mockClear();
	fakeClient.application.getApplicationLogs.query.mockClear();
	fakeClient.application.restart.mutate.mockClear();
	fakeClient.application.stop.mutate.mockClear();
	fakeClient.application.delete.mutate.mockClear();
});

describe("apps tools", () => {
	it("app_list trims to essentials", async () => {
		const r = await invoke("app_list", {});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			count: number;
			apps: Array<{ id: string; name: string; status: string; plan: string; url: string | null }>;
		};
		expect(body.count).toBe(1);
		expect(body.apps).toHaveLength(1);
		expect(body.apps[0]).toEqual({
			id: "app_1",
			name: "web",
			status: "running",
			plan: "SHARED",
			url: "https://web.tarout.sh",
		});
	});

	it("app_info resolves by name and returns the full object", async () => {
		const r = await invoke("app_info", { app: "web" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { app: { name: string } };
		expect(body.app.name).toBe("web");
		expect(fakeClient.application.one.query).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
	});

	it("app_create forwards inputs to application.create", async () => {
		const r = await invoke("app_create", {
			name: "api",
			description: "backend",
			plan: "SHARED",
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.create.mutate).toHaveBeenCalledWith({
			name: "api",
			description: "backend",
			plan: "SHARED",
		});
		const body = JSON.parse(r.content[0].text) as { created: { applicationId: string } };
		expect(body.created.applicationId).toBe("app_2");
	});

	it("app_logs resolves app and forwards optional params", async () => {
		const r = await invoke("app_logs", {
			app: "web",
			lines: 100,
			level: "error",
			timeRange: "1h",
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.getApplicationLogs.query).toHaveBeenCalledWith({
			applicationId: "app_1",
			lines: 100,
			level: "error",
			timeRange: "1h",
		});
	});

	it("app_restart calls application.restart", async () => {
		const r = await invoke("app_restart", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.restart.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		const body = JSON.parse(r.content[0].text) as { restarted: boolean };
		expect(body.restarted).toBe(true);
	});

	it("app_stop calls application.stop", async () => {
		const r = await invoke("app_stop", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.stop.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		const body = JSON.parse(r.content[0].text) as { stopped: boolean };
		expect(body.stopped).toBe(true);
	});

	it("app_delete calls application.delete", async () => {
		const r = await invoke("app_delete", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.delete.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		const body = JSON.parse(r.content[0].text) as {
			deleted: boolean;
			applicationId: string;
			name: string;
		};
		expect(body.deleted).toBe(true);
		expect(body.applicationId).toBe("app_1");
		expect(body.name).toBe("web");
	});

	it("app_info returns NOT_FOUND envelope when app cannot be resolved", async () => {
		const r = await invoke("app_info", { app: "does-not-exist" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
	});
});
