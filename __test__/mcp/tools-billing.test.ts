import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	subscription: {
		getCurrent: {
			query: vi.fn().mockResolvedValue({ planKey: "shared", status: "ACTIVE" }),
		},
	},
	billing: {
		getUsageBreakdown: {
			query: vi.fn().mockResolvedValue({ totalHalalas: 1900, items: [] }),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

vi.mock("../../src/lib/billing-upgrade", () => ({
	performBillingChange: vi.fn().mockResolvedValue({
		status: "applied",
		kind: "plan",
		target: "dedicated_small",
	}),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { performBillingChange } from "../../src/lib/billing-upgrade";
import { registerBillingTools } from "../../src/mcp/tools/billing";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerBillingTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// SDK 1.29.x stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

describe("billing tools", () => {
	it("billing_status returns subscription + usage", async () => {
		const r = await invoke("billing_status", {});
		const body = JSON.parse(r.content[0].text) as {
			subscription: { planKey: string };
			usage: { totalHalalas: number } | null;
		};
		expect(body.subscription.planKey).toBe("shared");
		// Regression: usage must come from the real billing.getUsageBreakdown
		// procedure (the old subscription.getUsage does not exist).
		expect(fakeClient.billing.getUsageBreakdown.query).toHaveBeenCalledWith({});
		expect(body.usage?.totalHalalas).toBe(1900);
	});

	it("billing_upgrade delegates to performBillingChange", async () => {
		const r = await invoke("billing_upgrade", {
			plan: "dedicated_small",
			wait: true,
		});
		expect(r.isError).toBeUndefined();
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				kind: "plan",
				planKey: "dedicated_small",
				wait: true,
			}),
		);
	});

	it("billing_upgrade forwards billingPeriod as lowercase", async () => {
		(performBillingChange as any).mockClear();
		await invoke("billing_upgrade", {
			plan: "dedicated_small",
			billingPeriod: "yearly",
			wait: true,
		});
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ billingPeriod: "yearly" }),
		);
	});

	it("billing_upgrade maps planQuantity onto the engine's `quantity`", async () => {
		(performBillingChange as any).mockClear();
		await invoke("billing_upgrade", {
			plan: "shared",
			planQuantity: 5,
			wait: true,
		});
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: "plan", planKey: "shared", quantity: 5 }),
		);
		// Regression: the engine input has no `planQuantity` field — the old code
		// set it there where it was silently dropped.
		const arg = (performBillingChange as any).mock.calls[0][1];
		expect(arg.planQuantity).toBeUndefined();
	});

	it("billing_upgrade with only planQuantity uses plan_quantity kind", async () => {
		(performBillingChange as any).mockClear();
		await invoke("billing_upgrade", { planQuantity: 3, wait: false });
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: "plan_quantity", quantity: 3 }),
		);
	});
});
