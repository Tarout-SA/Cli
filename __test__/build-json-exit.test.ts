import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed `tarout build --json` must (a) exit with the CLI's reserved
 * BUILD_FAILED (12), never the raw child exit code — which could collide with
 * 2/3/4/5 and be misread by an agent — and (b) emit a TOP-LEVEL failure envelope
 * (`{ success:false, error:{ code, message, details } }`), not a jsonSuccess
 * wrapper around `{ success:false }`, so an agent keying on the top-level
 * `.success` reads the failure as a failure. The child's real code is preserved
 * as `error.details.childExitCode`. The success path stays a jsonSuccess wrapper.
 */

const m = vi.hoisted(() => ({ childExitCode: 3 }));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	isProjectLinked: () => false,
	getProjectConfig: () => null,
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
		envVariable: { list: { query: async () => [] } },
	}),
}));

vi.mock("../src/lib/process.js", () => ({
	readPackageJson: () => ({ name: "my-app", scripts: { build: "tsc" } }),
	detectPackageManager: () => "npm",
	getBuildCommand: () => "npm run build",
	detectFramework: () => null,
	envVarsToObject: () => ({}),
	runCommand: async () => ({ exitCode: m.childExitCode }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerBuildCommand } from "../src/commands/build";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

let exitCodes: number[];
let logs: string[];

beforeEach(() => {
	exitCodes = [];
	logs = [];
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	});
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

describe("tarout build --json — failed build", () => {
	it("exits BUILD_FAILED (12) and preserves the child code in the envelope", async () => {
		m.childExitCode = 3; // collides with AUTH_ERROR if leaked raw
		setGlobalOptions({ ...RESET, json: true });
		const program = new Command();
		program.exitOverride();
		registerBuildCommand(program);

		try {
			await program.parseAsync([
				"node",
				"tarout",
				"build",
				"--app",
				"my-app",
				"--command",
				"npm run build",
			]);
		} catch (err) {
			if (!/__EXIT_/.test(String(err))) throw err;
		}

		expect(exitCodes[0]).toBe(12);

		const envelope = logs
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((p) => p?.error?.code === "BUILD_FAILED");

		// Top-level success MUST be false — the old code wrapped this in jsonSuccess,
		// emitting { success:true, data:{ success:false } }, which an agent keying on
		// the top-level `.success` misread as a pass.
		expect(envelope?.success).toBe(false);
		expect(envelope?.error?.details?.childExitCode).toBe(3);
		expect(envelope?.error?.details?.exitCode).toBe(3);
	});

	it("keeps the success envelope as a top-level jsonSuccess wrapper", async () => {
		m.childExitCode = 0;
		setGlobalOptions({ ...RESET, json: true });
		const program = new Command();
		program.exitOverride();
		registerBuildCommand(program);

		try {
			await program.parseAsync([
				"node",
				"tarout",
				"build",
				"--app",
				"my-app",
				"--command",
				"npm run build",
			]);
		} catch (err) {
			if (!/__EXIT_/.test(String(err))) throw err;
		}

		// A successful build never exits non-zero.
		expect(exitCodes).toEqual([]);

		const payload = logs
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((p) => p?.data && "exitCode" in p.data);

		// Byte-for-byte the historical success shape: jsonSuccess({ success:true, ... }).
		expect(payload?.success).toBe(true);
		expect(payload?.data?.success).toBe(true);
		expect(payload?.data?.exitCode).toBe(0);
		expect(payload?.data?.details?.childExitCode).toBe(0);
	});
});
