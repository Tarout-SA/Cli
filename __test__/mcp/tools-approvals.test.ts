import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const pending = {
	id: "pa_1",
	procedure: "application.delete",
	status: "pending",
	keyName: "ci-agent",
	apiKeyId: "key_1",
	createdAt: "2026-09-29T08:00:00.000Z",
	expiresAt: "2026-09-30T08:00:00.000Z",
};
const denied = { ...pending, id: "pa_2", status: "denied" };

const fakeClient = {
	approvals: {
		list: {
			query: vi.fn().mockResolvedValue({ pending: [pending], decided: [denied] }),
		},
		get: { query: vi.fn().mockResolvedValue({ ...pending, keyName: undefined }) },
		approve: { mutate: vi.fn() },
		deny: { mutate: vi.fn() },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerApprovalsTools } from "../../src/mcp/tools/approvals";

function registered() {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerApprovalsTools(server);
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
	fakeClient.approvals.list.query.mockClear();
	fakeClient.approvals.get.query.mockClear();
});

describe("approval tools", () => {
	it("registers only read tools, both annotated readOnlyHint", () => {
		const tools = registered();
		expect(Object.keys(tools).sort()).toEqual(["approvals_get", "approvals_list"]);
		for (const name of ["approvals_list", "approvals_get"]) {
			expect(tools[name].annotations).toEqual({ readOnlyHint: true });
			expect(tools[name].description).toMatch(/approve/i);
		}
	});

	it("approvals_list returns pending first and filters by status", async () => {
		const all = await invoke("approvals_list", {});
		expect(all.isError).toBeUndefined();
		const body = JSON.parse(all.content[0].text) as {
			count: number;
			approvals: Array<{ id: string; keyName: string }>;
		};
		expect(body.count).toBe(2);
		expect(body.approvals.map((a) => a.id)).toEqual(["pa_1", "pa_2"]);
		expect(body.approvals[0]?.keyName).toBe("ci-agent");
		expect(fakeClient.approvals.list.query).toHaveBeenCalledWith({ limit: 20 });

		const onlyDenied = await invoke("approvals_list", {
			status: "denied",
			limit: 10,
		});
		const filtered = JSON.parse(onlyDenied.content[0].text) as {
			approvals: Array<{ id: string }>;
		};
		expect(filtered.approvals.map((a) => a.id)).toEqual(["pa_2"]);
		expect(fakeClient.approvals.list.query).toHaveBeenLastCalledWith({
			limit: 10,
		});
	});

	it("approvals_get polls approvals.get and never approves", async () => {
		const r = await invoke("approvals_get", { id: "pa_1" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			approval: { id: string; status: string };
		};
		expect(body.approval).toMatchObject({ id: "pa_1", status: "pending" });
		expect(fakeClient.approvals.get.query).toHaveBeenCalledWith({ id: "pa_1" });
		// The poll target stays a single read: no key-name lookup per poll.
		expect(fakeClient.approvals.list.query).not.toHaveBeenCalled();
		expect(fakeClient.approvals.approve.mutate).not.toHaveBeenCalled();
		expect(fakeClient.approvals.deny.mutate).not.toHaveBeenCalled();
	});
});
