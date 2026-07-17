import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Vitest owns every spec except __test__/bun, which holds bun:test-native
		// specs (they rely on bun's `mock.module` to stub the `open` package by
		// resolved path — a bun feature Vitest can't replicate cleanly). Those run
		// under `bun test`; see bunfig.toml. `bun run test` runs both.
		include: ["__test__/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "__test__/bun/**"],
		setupFiles: ["./__test__/setup-browser-safety.ts"],
		// Single fork — the suite is small and this keeps it from spawning a fork
		// per file and pegging the machine.
		pool: "forks",
		poolOptions: { forks: { maxForks: 1, minForks: 1 } },
		// Unit tests must never launch external applications. Browser-specific
		// behavior lives under __test__/bun, where the `open` package is mocked.
		env: { TAROUT_NO_BROWSER: "1" },
	},
});
