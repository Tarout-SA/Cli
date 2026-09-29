import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/config")>(
		"../../src/lib/config",
	);
	return {
		...actual,
		isLoggedIn: () => true,
		getToken: () => "tok",
		getApiUrl: () => "https://tarout.sa",
	};
});

function item(id: string, at: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		router: "application",
		proc: "deployToCloud",
		surface: "mcp",
		status: "ok",
		at,
		apiKeyId: "key_abcdef123456",
		keyName: "Claude (OAuth)",
		...overrides,
	};
}

const fakeClient = {
	dashboard: {
		getAgentActivity: {
			query: vi.fn(),
		},
	},
	user: {
		listApiKeys: { query: vi.fn() },
		deleteApiKey: { mutate: vi.fn() },
		setApiKeyEnabled: { mutate: vi.fn() },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
	rememberRequestProjectId: vi.fn(),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../../src/mcp/server";
import { registerContextTools } from "../../src/mcp/tools/context";

// Registered through createMcpServer so the result sanitizer (the chokepoint
// every tool result passes) is part of what is tested.
function registered() {
	const server = createMcpServer();
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool is SDK-internal.
	return (server as any)._registeredTools as Record<string, any>;
}

async function invoke(name: string, args: unknown) {
	const reg = registered()[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

beforeEach(() => {
	fakeClient.dashboard.getAgentActivity.query.mockReset();
	fakeClient.user.listApiKeys.query.mockReset();
});

describe("agent tools", () => {
	it("registers agent_events and agent_sessions as read-only context tools", () => {
		const server = new McpServer(
			{ name: "t", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerContextTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool is SDK-internal.
		const tools = (server as any)._registeredTools as Record<string, any>;
		for (const name of ["agent_events", "agent_sessions"]) {
			expect(tools[name]).toBeDefined();
			expect(tools[name].annotations).toEqual({ readOnlyHint: true });
		}
		// Revoking or pausing a credential is a human dashboard action.
		for (const name of Object.keys(tools)) {
			expect(name).not.toMatch(/revoke|pause|disable|delete_key/);
		}
		expect(tools.agent_sessions.description).toMatch(/cannot revoke/i);
	});

	it("agent_events returns recent rows oldest first", async () => {
		fakeClient.dashboard.getAgentActivity.query.mockResolvedValue({
			items: [
				item("b", "2026-09-29T10:00:05.000Z", {
					status: "error",
					errorCode: "FORBIDDEN",
					errorMessage: "AGENT_READ_ONLY: read-only key",
				}),
				item("a", "2026-09-29T10:00:00.000Z"),
			],
		});
		const r = await invoke("agent_events", { limit: 5 });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			count: number;
			events: Array<Record<string, unknown>>;
		};
		expect(body.count).toBe(2);
		expect(body.events.map((e) => e.id)).toEqual(["a", "b"]);
		expect(body.events[1]).toMatchObject({
			procedure: "application.deployToCloud",
			surface: "mcp",
			status: "error",
			errorCode: "FORBIDDEN",
			keyName: "Claude (OAuth)",
		});
		expect(fakeClient.dashboard.getAgentActivity.query).toHaveBeenCalledWith({
			scope: "agent",
			limit: 5,
		});
	});

	it("agent_events with since pages up to 100 rows and drops older ones", async () => {
		const now = Date.now();
		fakeClient.dashboard.getAgentActivity.query.mockResolvedValue({
			items: [
				item("new", new Date(now - 60_000).toISOString()),
				item("old", new Date(now - 3 * 3600_000).toISOString()),
			],
			nextCursor: "old",
		});
		const r = await invoke("agent_events", { since: "1h" });
		const body = JSON.parse(r.content[0].text) as {
			events: Array<{ id: string }>;
		};
		expect(body.events.map((e) => e.id)).toEqual(["new"]);
		expect(fakeClient.dashboard.getAgentActivity.query).toHaveBeenCalledTimes(1);
		expect(fakeClient.dashboard.getAgentActivity.query).toHaveBeenCalledWith({
			scope: "agent",
			limit: 100,
		});
	});

	it("agent_events rejects a bad since as INVALID_ARGUMENTS", async () => {
		const r = await invoke("agent_events", { since: "later" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			error: string;
		};
		expect(body.code).toBe("INVALID_ARGUMENTS");
		expect(body.error).toMatch(/^since must be a duration/);
		expect(fakeClient.dashboard.getAgentActivity.query).not.toHaveBeenCalled();
	});

	it("agent_events explains a refusal instead of failing opaquely", async () => {
		fakeClient.dashboard.getAgentActivity.query.mockRejectedValue(
			Object.assign(new Error("AGENT_SCOPE: not allowed"), {
				data: { code: "FORBIDDEN", reason: "area_not_allowed" },
			}),
		);
		const r = await invoke("agent_events", {});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			remediation?: string;
			details?: { procedure?: string; reason?: string };
		};
		expect(body.code).toBe("FORBIDDEN");
		expect(body.details).toMatchObject({
			procedure: "dashboard.getAgentActivity",
			reason: "area_not_allowed",
		});
		expect(body.remediation).toMatch(/Agent > Keys/);
	});

	it("agent_sessions groups OAuth connections and keys without key material", async () => {
		fakeClient.user.listApiKeys.query.mockResolvedValue([
			{
				id: "k1",
				name: "Claude (OAuth)",
				prefix: "mcp",
				start: "mcp_SECRETSTART",
				enabled: true,
				lastRequest: "2026-09-29T09:00:00.000Z",
				expiresAt: "2099-01-01T00:00:00.000Z",
				createdAt: "2026-09-20T08:00:00.000Z",
				scope: { organizationId: "org_1", projectId: null },
				tier: "operator",
				areas: null,
			},
			{
				id: "k2",
				name: "laptop",
				prefix: "cli",
				start: "cli_SECRETSTART",
				enabled: false,
				lastRequest: null,
				expiresAt: null,
				createdAt: "2026-09-01T08:00:00.000Z",
				scope: { organizationId: "org_1", projectId: null },
				tier: "full",
				areas: null,
			},
		]);
		const r = await invoke("agent_sessions", {});
		expect(r.isError).toBeUndefined();
		const text = r.content[0].text;
		expect(text).not.toContain("SECRETSTART");
		expect(text).not.toContain("[redacted");
		const body = JSON.parse(text) as {
			oauthConnections: Array<Record<string, unknown>>;
			keys: Array<Record<string, unknown>>;
			dashboardUrl: string;
		};
		expect(body.oauthConnections).toHaveLength(1);
		expect(body.oauthConnections[0]).toMatchObject({
			name: "Claude",
			tier: "operator",
			status: "active",
		});
		expect(body.keys[0]).toMatchObject({
			name: "laptop",
			prefix: "cli",
			status: "paused",
		});
		expect(body.dashboardUrl).toBe("https://tarout.sa/dashboard/agent");
		expect(fakeClient.user.deleteApiKey.mutate).not.toHaveBeenCalled();
		expect(fakeClient.user.setApiKeyEnabled.mutate).not.toHaveBeenCalled();
	});
});
