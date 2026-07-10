/**
 * Shared setup for the deploy tool suite. Task 14 lands `deployment_status`
 * and `deployment_logs`; Task 15 will append `deploy` specs to this file, so
 * the fakeClient below is intentionally broader than the two tools need.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
	getProjectConfig: () => null,
	setProjectConfig: () => {},
	isProjectLinked: () => false,
	removeProjectConfig: () => {},
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
		getDeploymentStatus: {
			query: vi
				.fn()
				.mockResolvedValue({ status: "done", latestDeploymentId: "dep_1" }),
		},
	},
	deployment: {
		one: {
			query: vi.fn().mockResolvedValue({ deploymentId: "dep_1", status: "done" }),
		},
		getDeploymentLogs: {
			query: vi.fn().mockResolvedValue({ logs: [{ line: "hi" }], nextOffset: 1 }),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDeployTools } from "../../src/mcp/tools/deploy";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerDeployTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// SDK 1.29.x stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

describe("deployment_status", () => {
	it("resolves app by name then queries getDeploymentStatus", async () => {
		const r = await invoke("deployment_status", { app: "web" });
		const body = JSON.parse(r.content[0].text) as { status: string };
		expect(body.status).toBe("done");
	});

	it("uses deploymentId when provided", async () => {
		const r = await invoke("deployment_status", { deploymentId: "dep_1" });
		const body = JSON.parse(r.content[0].text) as { deploymentId: string };
		expect(body.deploymentId).toBe("dep_1");
	});

	it("returns INVALID_ARGUMENTS envelope when neither app nor deploymentId given", async () => {
		const r = await invoke("deployment_status", {});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("INVALID_ARGUMENTS");
	});
});

describe("deployment_logs", () => {
	it("returns log lines for a deployment id", async () => {
		const r = await invoke("deployment_logs", { deploymentId: "dep_1" });
		const body = JSON.parse(r.content[0].text) as { logs: unknown[] };
		expect(body.logs).toHaveLength(1);
	});
});
