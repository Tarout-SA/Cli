import { describe, expect, it, vi } from "vitest";
import { finalizeBillingMutation } from "../src/lib/billing-upgrade";

/**
 * A CLI run is typically headless or agent-driven, so whatever checkout URL we
 * surface gets pasted to a human whose browser may not be signed in. The
 * platform now returns an unauthenticated twin (`publicPaymentUrl`) alongside
 * the dashboard URL; the CLI must prefer it, or the human lands on /auth/login
 * and the whole upgrade stalls there.
 */

const CTX = {
	kind: "plan" as const,
	target: "dedicated_small",
	wait: false,
};

function apiResult(over: Record<string, unknown> = {}) {
	return {
		applied: false,
		orderId: "sub_V1StGXR8Z5jdHi6Bmyxx",
		paymentUrl: "https://tarout.sa/dashboard/billing/checkout/pay?orderId=sub_V1StGXR8Z5jdHi6Bmyxx",
		publicPaymentUrl: "https://tarout.sa/pay/sub_V1StGXR8Z5jdHi6Bmyxx",
		proratedChargeHalalas: 15934,
		...over,
	};
}

describe("finalizeBillingMutation — checkout URL selection", () => {
	it("surfaces the unauthenticated checkout URL when the platform provides one", async () => {
		const result = await finalizeBillingMutation({}, apiResult(), CTX);

		expect(result.status).toBe("payment_required");
		expect(result.paymentUrl).toBe("https://tarout.sa/pay/sub_V1StGXR8Z5jdHi6Bmyxx");
	});

	it("opens the unauthenticated URL in the browser, not the dashboard one", async () => {
		const openBrowser = vi.fn(async () => {});

		await finalizeBillingMutation({}, apiResult(), { ...CTX, openBrowser });

		expect(openBrowser).toHaveBeenCalledWith(
			"https://tarout.sa/pay/sub_V1StGXR8Z5jdHi6Bmyxx",
		);
	});

	it("falls back to the dashboard URL against a platform that predates the public page", async () => {
		const result = await finalizeBillingMutation(
			{},
			apiResult({ publicPaymentUrl: undefined }),
			CTX,
		);

		expect(result.status).toBe("payment_required");
		expect(result.paymentUrl).toBe(
			"https://tarout.sa/dashboard/billing/checkout/pay?orderId=sub_V1StGXR8Z5jdHi6Bmyxx",
		);
	});

	it("still reports a deferred change when neither URL is present", async () => {
		const result = await finalizeBillingMutation(
			{},
			apiResult({ paymentUrl: undefined, publicPaymentUrl: undefined }),
			CTX,
		);

		expect(result.status).toBe("deferred");
		expect(result.paymentUrl).toBeUndefined();
	});
});
