import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `env bulk-set` with no `--vars` prompts for the JSON object. In agent mode
 * that prompt must emit a `needs_input` that names the real remedy — the
 * `--vars` flag — not the generic unannotated-prompt fallback (which wrongly
 * suggests `--yes`).
 */

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
import { registerEnvCommands } from "../src/commands/env";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

let logSpy: ReturnType<typeof vi.spyOn>;
let exitCodes: number[];

beforeEach(() => {
	exitCodes = [];
	// process.exit can't actually stop execution under test, so record every
	// code and throw to unwind. The real exit(6) is the first call; the action's
	// own catch then re-exits, which we ignore.
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

describe("env bulk-set — missing --vars in agent mode", () => {
	it("emits a needs_input naming the --vars flag and exits NEEDS_INPUT (6)", async () => {
		setGlobalOptions({ ...RESET, json: true });
		const program = new Command();
		program.exitOverride();
		registerEnvCommands(program);

		try {
			await program.parseAsync([
				"node",
				"tarout",
				"env",
				"bulk-set",
				"my-app",
			]);
		} catch (err) {
			if (!/__EXIT_/.test(String(err))) throw err;
		}

		// The real exit is NEEDS_INPUT (6), emitted by the annotated prompt.
		expect(exitCodes[0]).toBe(6);

		const events = logSpy.mock.calls
			.map((call) => {
				try {
					return JSON.parse(String(call[0]));
				} catch {
					return null;
				}
			})
			.filter((e): e is Record<string, unknown> => e?.type === "needs_input");

		expect(events).toHaveLength(1);
		expect(events[0]?.field).toBe("vars");
		expect(events[0]?.flag).toBe("--vars");
	});
});
