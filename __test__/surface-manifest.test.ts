import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect HOME so the cache file lands in a scratch dir per test.
// Note: brief suggested `vi.stubGlobal("process", ...)` but that pattern
// is fragile with vitest module hoisting; setting `process.env.HOME`
// directly reliably redirects `os.homedir()` which reads `HOME`.
const SCRATCH = join(tmpdir(), `tarout-manifest-${process.pid}`);
const ORIGINAL_HOME = process.env.HOME;

import { fetchManifestFresh, loadManifest } from "../src/lib/surface-manifest";

beforeEach(() => {
	rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(SCRATCH, { recursive: true });
	process.env.HOME = SCRATCH;
});
afterEach(() => {
	process.env.HOME = ORIGINAL_HOME;
	rmSync(SCRATCH, { recursive: true, force: true });
});

function fakeClient(list: Array<{ path: string; type: string; router: string }>) {
	return {
		settings: {
			getSurfaceManifest: { query: vi.fn().mockResolvedValue(list) },
		},
	};
}

describe("surface-manifest", () => {
	it("fetchManifestFresh calls settings.getSurfaceManifest and writes cache", async () => {
		const client = fakeClient([{ path: "user.get", type: "query", router: "user" }]);
		const list = await fetchManifestFresh(client, "https://api.test");
		expect(list).toHaveLength(1);
		expect(client.settings.getSurfaceManifest.query).toHaveBeenCalledTimes(1);
		expect(existsSync(join(SCRATCH, ".tarout", "surface-manifest-cache.json"))).toBe(true);
	});

	it("loadManifest returns cached result inside TTL without refetching", async () => {
		const client = fakeClient([{ path: "user.get", type: "query", router: "user" }]);
		await fetchManifestFresh(client, "https://api.test");
		client.settings.getSurfaceManifest.query.mockClear();
		const list = await loadManifest(client, "https://api.test");
		expect(list).toHaveLength(1);
		expect(client.settings.getSurfaceManifest.query).not.toHaveBeenCalled();
	});
});
