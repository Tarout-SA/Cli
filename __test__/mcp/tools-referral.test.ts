import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	referral: {
		getMyCode: {
			query: vi.fn().mockResolvedValue({ code: "ABCD2345", url: "https://tarout.sa/r/ABCD2345", rewardDays: 5 }),
		},
		getPartnerSummary: {
			query: vi.fn().mockResolvedValue({ signups: 2, availableHalalas: 500 }),
		},
		listCredits: { query: vi.fn().mockResolvedValue([{ id: "cr1" }]) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReferralTools } from "../../src/mcp/tools/referral";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerReferralTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: SDK stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("referral tools", () => {
	it("referral_status returns code, summary and history", async () => {
		const r = await invoke("referral_status", { historyLimit: 5 });
		const body = JSON.parse(r.content[0].text);
		expect(body.code).toBe("ABCD2345");
		expect(body.summary.availableHalalas).toBe(500);
		expect(body.history).toEqual([{ id: "cr1" }]);
		expect(fakeClient.referral.listCredits.query).toHaveBeenCalledWith({ limit: 5 });
	});
});
