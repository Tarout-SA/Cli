import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the cache without changing process-wide HOME or touching user data.
const { scratch } = vi.hoisted(() => ({ scratch: { path: "" } }));
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => scratch.path,
}));

import { fetchManifestFresh, loadManifest } from "../src/lib/surface-manifest";

beforeEach(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	scratch.path = mkdtempSync(join(tmpdir(), "tarout-manifest-"));
});
afterEach(() => {
	rmSync(scratch.path, { recursive: true, force: true });
});

function fakeClient(
	list: Array<{ path: string; type: string; router: string }>,
) {
	return {
		settings: {
			getSurfaceManifest: { query: vi.fn().mockResolvedValue(list) },
		},
	};
}

describe("surface-manifest", () => {
	it("fetchManifestFresh calls settings.getSurfaceManifest and writes cache", async () => {
		const client = fakeClient([
			{ path: "user.get", type: "query", router: "user" },
		]);
		const list = await fetchManifestFresh(client, "https://api.test");
		expect(list).toHaveLength(1);
		expect(client.settings.getSurfaceManifest.query).toHaveBeenCalledTimes(1);
		expect(
			existsSync(join(scratch.path, ".tarout", "surface-manifest-cache.json")),
		).toBe(true);
	});

	it("loadManifest returns cached result inside TTL without refetching", async () => {
		const client = fakeClient([
			{ path: "user.get", type: "query", router: "user" },
		]);
		await fetchManifestFresh(client, "https://api.test");
		client.settings.getSurfaceManifest.query.mockClear();
		const list = await loadManifest(client, "https://api.test");
		expect(list).toHaveLength(1);
		expect(client.settings.getSurfaceManifest.query).not.toHaveBeenCalled();
	});
});
