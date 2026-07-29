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
		// billing_upgrade classifies the target against the catalog's sortOrder
		// to decide whether the change is a downgrade needing confirmation.
		getCatalog: {
			query: vi.fn().mockResolvedValue({
				plans: [
					{ planKey: "free", sortOrder: 0 },
					{ planKey: "shared", sortOrder: 1 },
					{ planKey: "dedicated_small", sortOrder: 2 },
				],
				addons: [],
			}),
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

	it("billing_upgrade delegates to performBillingChange without waiting", async () => {
		const r = await invoke("billing_upgrade", { plan: "dedicated_small" });
		expect(r.isError).toBeUndefined();
		// wait is pinned false: over MCP there is no mid-call channel to hand the
		// hosted checkout URL to a human, so blocking would just burn the timeout.
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				kind: "plan",
				planKey: "dedicated_small",
				wait: false,
			}),
		);
	});

	it("billing_upgrade forwards billingPeriod as lowercase", async () => {
		(performBillingChange as any).mockClear();
		await invoke("billing_upgrade", {
			plan: "dedicated_small",
			billingPeriod: "yearly",
		});
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ billingPeriod: "yearly" }),
		);
	});

	it("billing_upgrade maps planQuantity onto the engine's `quantity`", async () => {
		(performBillingChange as any).mockClear();
		await invoke("billing_upgrade", {
			plan: "dedicated_small",
			planQuantity: 5,
		});
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				kind: "plan",
				planKey: "dedicated_small",
				quantity: 5,
			}),
		);
		// Regression: the engine input has no `planQuantity` field — the old code
		// set it there where it was silently dropped.
		const arg = (performBillingChange as any).mock.calls[0][1];
		expect(arg.planQuantity).toBeUndefined();
	});

	it("billing_upgrade with only planQuantity uses plan_quantity kind", async () => {
		(performBillingChange as any).mockClear();
		await invoke("billing_upgrade", { planQuantity: 3 });
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: "plan_quantity", quantity: 3 }),
		);
	});

	it("billing_upgrade refuses a downgrade without confirmDowngrade", async () => {
		(performBillingChange as any).mockClear();
		const r = await invoke("billing_upgrade", { plan: "free" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			remediation?: string;
		};
		// A downgrade never reaches the hosted checkout, so the checkout page
		// can't act as the consent surface — the flag is the only consent.
		expect(body.code).toBe("NEEDS_INPUT");
		expect(body.remediation).toContain("confirmDowngrade");
		expect(performBillingChange).not.toHaveBeenCalled();
	});

	it("billing_upgrade performs the downgrade once confirmed", async () => {
		(performBillingChange as any).mockClear();
		const r = await invoke("billing_upgrade", {
			plan: "free",
			confirmDowngrade: true,
		});
		expect(r.isError).toBeUndefined();
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: "plan", planKey: "free" }),
		);
	});

	it("billing_upgrade short-circuits when already on the target plan", async () => {
		(performBillingChange as any).mockClear();
		const r = await invoke("billing_upgrade", { plan: "shared" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { status: string };
		expect(body.status).toBe("no_change");
		expect(performBillingChange).not.toHaveBeenCalled();
	});

	it("billing_upgrade returns paymentUrl with a hint instead of blocking", async () => {
		(performBillingChange as any).mockClear();
		(performBillingChange as any).mockResolvedValueOnce({
			status: "payment_required",
			kind: "plan",
			target: "dedicated_small",
			paymentUrl: "https://pay.test/abc",
		});
		const r = await invoke("billing_upgrade", { plan: "dedicated_small" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			paymentUrl: string;
			hint: string;
		};
		expect(body.paymentUrl).toBe("https://pay.test/abc");
		expect(body.hint).toContain("billing_status");
	});

	it("billing_upgrade rejects contradictory argument combinations", async () => {
		(performBillingChange as any).mockClear();
		const both = await invoke("billing_upgrade", {
			plan: "dedicated_small",
			addon: "storage.standard",
		});
		expect(both.isError).toBe(true);
		const none = await invoke("billing_upgrade", {});
		expect(none.isError).toBe(true);
		// `quantity` is the addon unit count; plan seats use `planQuantity`.
		const orphanQuantity = await invoke("billing_upgrade", { quantity: 2 });
		expect(orphanQuantity.isError).toBe(true);
		expect(performBillingChange).not.toHaveBeenCalled();
	});
});
