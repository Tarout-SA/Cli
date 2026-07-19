import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Self-update on deploy (src/lib/update-check.ts): the version comparison must
 * be strict (only a genuinely newer registry version triggers an update), the
 * registry probe must fail open (null on timeout/HTTP error/bad payload), and
 * every opt-out guard must short-circuit before any network call — a deploy
 * must never hang or die because the update path misbehaved.
 */

import {
	fetchLatestVersion,
	isNewerVersion,
	maybeSelfUpdate,
} from "../src/lib/update-check.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("isNewerVersion", () => {
	it("detects newer patch/minor/major versions", () => {
		expect(isNewerVersion("1.2.0", "1.2.1")).toBe(true);
		expect(isNewerVersion("1.2.0", "1.3.0")).toBe(true);
		expect(isNewerVersion("1.2.0", "2.0.0")).toBe(true);
	});

	it("rejects equal and older versions", () => {
		expect(isNewerVersion("1.2.0", "1.2.0")).toBe(false);
		expect(isNewerVersion("1.2.1", "1.2.0")).toBe(false);
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(false);
	});

	it("compares numerically, not lexically", () => {
		expect(isNewerVersion("1.9.0", "1.10.0")).toBe(true);
		expect(isNewerVersion("1.10.0", "1.9.0")).toBe(false);
	});

	it("ignores v-prefix and prerelease/build suffixes", () => {
		expect(isNewerVersion("v1.2.0", "1.2.1")).toBe(true);
		expect(isNewerVersion("1.2.0", "1.2.1-beta.1")).toBe(true);
		expect(isNewerVersion("1.2.0", "1.2.0-beta.1")).toBe(false);
		expect(isNewerVersion("1.2.0", "1.2.1+build5")).toBe(true);
	});

	it("refuses to update on malformed versions", () => {
		expect(isNewerVersion("1.2.0", "latest")).toBe(false);
		expect(isNewerVersion("garbage", "1.2.1")).toBe(false);
		expect(isNewerVersion("1.2.0", "")).toBe(false);
	});
});

describe("fetchLatestVersion", () => {
	it("returns the version field from the registry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ version: "1.3.0" }),
			})),
		);
		expect(await fetchLatestVersion()).toBe("1.3.0");
	});

	it("returns null on HTTP errors", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
		expect(await fetchLatestVersion()).toBeNull();
	});

	it("returns null when fetch rejects (offline / abort)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		expect(await fetchLatestVersion()).toBeNull();
	});

	it("returns null on a payload without a string version", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ version: 7 }) })),
		);
		expect(await fetchLatestVersion()).toBeNull();
	});
});

describe("maybeSelfUpdate guards", () => {
	it("does not touch the network when disabled via flag", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await maybeSelfUpdate({ currentVersion: "1.2.0", disabled: true });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not touch the network under TAROUT_NO_UPDATE_CHECK", async () => {
		vi.stubEnv("TAROUT_NO_UPDATE_CHECK", "1");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await maybeSelfUpdate({ currentVersion: "1.2.0" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not touch the network in a re-exec child", async () => {
		vi.stubEnv("TAROUT_UPDATE_REEXEC", "1");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		await maybeSelfUpdate({ currentVersion: "1.2.0" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns without updating when already on the latest version", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ version: "1.2.0" }),
			})),
		);
		// Would throw/exit if it tried to spawn npm; returning is the assertion.
		await expect(
			maybeSelfUpdate({ currentVersion: "1.2.0" }),
		).resolves.toBeUndefined();
	});
});
