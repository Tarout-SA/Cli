import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	emitUpgradeResult,
	registerUpgradeCommand,
} from "../src/commands/upgrade.js";
import { setGlobalOptions } from "../src/lib/output.js";

const OUTPUT_DEFAULTS = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

const originalExitCode = process.exitCode;

beforeEach(() => {
	setGlobalOptions({ ...OUTPUT_DEFAULTS, json: true, nonInteractive: true });
	process.exitCode = undefined;
});

afterEach(() => {
	setGlobalOptions(OUTPUT_DEFAULTS);
	process.exitCode = originalExitCode;
	vi.restoreAllMocks();
});

describe("tarout upgrade command", () => {
	it("registers a root command and emits its successful result as JSON", async () => {
		const upgradeCli = vi.fn(async () => ({
			status: "upgraded" as const,
			previousVersion: "1.2.0",
			currentVersion: "1.3.0",
		}));
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			output.push(String(line));
		});
		const program = new Command();
		registerUpgradeCommand(program, { currentVersion: "1.2.0", upgradeCli });

		await program.parseAsync(["node", "tarout", "upgrade"]);

		expect(upgradeCli).toHaveBeenCalledWith({
			currentVersion: "1.2.0",
			onUpdateAvailable: expect.any(Function),
		});
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0] ?? "")).toEqual({
			success: true,
			data: {
				status: "upgraded",
				previousVersion: "1.2.0",
				currentVersion: "1.3.0",
			},
		});
		expect(process.exitCode).toBeUndefined();
	});

	it("emits a structured non-zero registry error", () => {
		const output: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			output.push(String(line));
		});

		emitUpgradeResult({ status: "check_failed", currentVersion: "1.2.0" });

		expect(process.exitCode).toBe(1);
		expect(JSON.parse(output[0] ?? "")).toEqual({
			success: false,
			error: {
				code: "UPGRADE_CHECK_FAILED",
				message: "Could not determine the latest published Tarout CLI version.",
				details: { currentVersion: "1.2.0" },
			},
		});
	});
});
