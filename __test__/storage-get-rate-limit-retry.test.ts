import { describe, expect, it, vi } from "vitest";
import { fetchRetryingRateLimit } from "../src/commands/storage.js";

// Production 2026-09-23: 21 parallel `tarout storage get` calls hit the
// per-user download limiter and three files failed with HTTP 429.
describe("fetchRetryingRateLimit", () => {
	it("waits out a 429 using Retry-After, then returns the file", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "7" } }))
			.mockResolvedValueOnce(new Response("bytes", { status: 200 }));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchRetryingRateLimit("https://tarout.sa/api/storage/download?cap=x", { fetchImpl, sleep });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("bytes");
		expect(sleep).toHaveBeenCalledWith(7000);
	});

	it("gives up after the attempt budget and returns the last 429", async () => {
		const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchRetryingRateLimit("https://x", { fetchImpl: fetchImpl as never, sleep, attempts: 3 });
		expect(res.status).toBe(429);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("never retries other failures", async () => {
		const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
		const res = await fetchRetryingRateLimit("https://x", { fetchImpl: fetchImpl as never, sleep: vi.fn() });
		expect(res.status).toBe(404);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
