import { describe, expect, it } from "vitest";
import { normalizeEnvCommandArgs } from "../src/commands/env";

describe("environment command argument normalization", () => {
	it("supports the documented app-first syntax", () => {
		expect(
			normalizeEnvCommandArgs([
				"node",
				"tarout",
				"env",
				"my-app",
				"set",
				"KEY=value",
			]),
		).toEqual([
			"node",
			"tarout",
			"env",
			"set",
			"my-app",
			"KEY=value",
		]);
	});

	it("leaves the canonical subcommand-first syntax unchanged", () => {
		const argv = ["node", "tarout", "--json", "env", "list", "my-app"];
		expect(normalizeEnvCommandArgs(argv)).toEqual(argv);
	});

	it("normalizes every app-first command without moving its remaining args", () => {
		for (const command of [
			"list",
			"ls",
			"set",
			"unset",
			"pull",
			"push",
			"audit",
			"reveal",
			"get",
			"get-string",
			"list-all-envs",
			"bulk-set",
			"bulk-delete",
			"copy",
		]) {
			expect(
				normalizeEnvCommandArgs([
					"node",
					"tarout",
					"env",
					"app-id",
					command,
					"remaining",
				]),
			).toEqual([
				"node",
				"tarout",
				"env",
				command,
				"app-id",
				"remaining",
			]);
		}
	});
});
