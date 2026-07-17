import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captures the payload the `env unset` action sends to envVariable.delete so the
// test can assert the platform contract (restart must be the literal `true`).
const captured = vi.hoisted(() => ({
	deletePayload: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		application: {
			allByOrganization: {
				query: async () => [
					{ applicationId: "app_1", name: "my-app", appName: "my-app" },
				],
			},
		},
		envVariable: {
			delete: {
				mutate: async (input: Record<string, unknown>) => {
					captured.deletePayload = input;
					return { deleted: true };
				},
			},
		},
	}),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { normalizeEnvCommandArgs, registerEnvCommands } from "../src/commands/env";

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

describe("env unset delete payload", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		captured.deletePayload = undefined;
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	async function runUnset(args: string[]) {
		const program = new Command();
		program.exitOverride();
		registerEnvCommands(program);
		await program.parseAsync(["node", "tarout", "env", "unset", ...args]);
	}

	it("always sends restart:true (platform contract requires the literal true)", async () => {
		await runUnset(["my-app", "SECRET_KEY"]);
		expect(captured.deletePayload).toEqual({
			applicationId: "app_1",
			key: "SECRET_KEY",
			restart: true,
		});
	});

	it("still sends restart:true when --restart is passed (flag is a no-op)", async () => {
		await runUnset(["my-app", "SECRET_KEY", "--restart"]);
		expect(captured.deletePayload?.restart).toBe(true);
	});
});
