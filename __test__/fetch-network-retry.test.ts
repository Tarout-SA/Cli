import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRetryingNetwork, platformFetch } from "../src/lib/password-gate.js";

const dropped = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

describe("GET retries a dropped connection", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("retries a transport failure and returns the eventual answer", async () => {
		const fetchMock = vi.fn().mockRejectedValueOnce(dropped()).mockResolvedValueOnce(new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchRetryingNetwork("https://tarout.sa/api/trpc/project.all", {}, { sleep });
		expect(await res.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(500);
	});

	it("gives up after 3 attempts and rethrows", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(dropped()));
		await expect(fetchRetryingNetwork("https://x", {}, { sleep: async () => {} })).rejects.toThrow("fetch failed");
	});

	it("never re-sends a mutation", async () => {
		const fetchMock = vi.fn().mockRejectedValue(dropped());
		vi.stubGlobal("fetch", fetchMock);
		await expect(platformFetch("https://tarout.sa/api/trpc/application.create", { method: "POST", body: "{}" })).rejects.toThrow("fetch failed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
