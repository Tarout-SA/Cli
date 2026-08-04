import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed or timed-out `--json` deploy must print exactly ONE terminal
 * envelope on stdout.
 *
 * It used to print two. `streamDeploymentWithLogs` emitted a full envelope and
 * then threw a CliError, and every caller ends in `handleError`, which emits a
 * second one. The second is strictly lossier: `CliError.details` is undefined
 * for BuildFailedError/DeploymentFailedError, and `errorAnalysis`,
 * `deploymentId` and `logs` are own-properties `handleError` never reads. So an
 * agent parsing stdout as one JSON document failed outright, and one taking
 * last-line-wins silently lost the suggested fixes that the scaffolded
 * CLAUDE.md explicitly tells it to read.
 *
 * NDJSON progress events on stdout are by design — the invariant is one
 * *terminal* envelope, i.e. one object carrying a top-level `success` key.
 */

vi.mock("../src/lib/websocket.js", () => ({
	// No WS in tests: the HTTP status poll is authoritative anyway.
	connectDeploymentLogs: () => ({ close: () => {} }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { streamDeploymentWithLogs } from "../src/commands/deploy";
import { handleError } from "../src/lib/errors";
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

function clientReturning(deployment: Record<string, unknown>) {
	return {
		deployment: {
			one: { query: async () => deployment },
			getDeploymentLogs: {
				query: async () => ({ lines: ["boom"], nextOffset: 1 }),
			},
		},
		application: {
			one: { query: async () => ({ appSubdomain: "demo.tarout.app" }) },
		},
	};
}

/** Terminal envelopes only — the NDJSON progress events have no `success`. */
function terminalEnvelopes() {
	return logs
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter((parsed) => parsed && typeof parsed.success === "boolean");
}

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

/**
 * Drive the function the way the real commands do: run it, and route anything
 * it throws through handleError exactly as `up.ts` and `deploy.ts` do. That is
 * what produced the second envelope.
 */
async function runAsCommandWould(client: unknown) {
	try {
		await streamDeploymentWithLogs(
			client as never,
			"dep_1",
			"my-app",
			"app_1",
		);
	} catch (err) {
		if (/__EXIT_/.test(String(err))) return;
		try {
			handleError(err);
		} catch (inner) {
			if (!/__EXIT_/.test(String(inner))) throw inner;
		}
	}
}

describe("tarout deploy --json — failed deployment", () => {
	it("prints exactly one terminal envelope", async () => {
		setGlobalOptions({ ...RESET, json: true });

		await runAsCommandWould(
			clientReturning({
				deploymentId: "dep_1",
				status: "error",
				phase: "failed",
				errorMessage: "Build failed: tsc exited 1",
				logPath: null,
			}),
		);

		expect(terminalEnvelopes()).toHaveLength(1);
	});

	it("keeps the diagnostic payload in that envelope", async () => {
		setGlobalOptions({ ...RESET, json: true });

		await runAsCommandWould(
			clientReturning({
				deploymentId: "dep_1",
				status: "error",
				phase: "failed",
				errorMessage: "Build failed: tsc exited 1",
				logPath: null,
			}),
		);

		const envelope = terminalEnvelopes()[0];
		expect(envelope.success).toBe(false);
		// The lossier second envelope dropped all three of these.
		expect(envelope.error.details.deploymentId).toBe("dep_1");
		expect(envelope.error.details.errorAnalysis).toBeDefined();
		expect(envelope.error.details).toHaveProperty("logs");
	});

	it("exits with a deploy failure code rather than UNKNOWN_ERROR", async () => {
		setGlobalOptions({ ...RESET, json: true });

		await runAsCommandWould(
			clientReturning({
				deploymentId: "dep_1",
				status: "error",
				phase: "failed",
				errorMessage: "Build failed: tsc exited 1",
				logPath: null,
			}),
		);

		// 10 = DEPLOYMENT_FAILED, 12 = BUILD_FAILED. Which one depends on the
		// classifier; both are correct here, UNKNOWN is not.
		expect([10, 12]).toContain(exitCodes[0]);
	});

	it("agrees between the envelope code and the exit code", async () => {
		// These were computed from two different category lists: `docker_build`
		// was in the exit-code list and missing from the envelope list, so a
		// Docker failure said DEPLOYMENT_FAILED and exited 12 (BUILD_FAILED).
		setGlobalOptions({ ...RESET, json: true });

		await runAsCommandWould(
			clientReturning({
				deploymentId: "dep_1",
				status: "error",
				phase: "failed",
				errorMessage:
					"failed to solve: executor failed running [/bin/sh -c docker build]: exit code: 1",
				logPath: null,
			}),
		);

		const envelope = terminalEnvelopes()[0];
		const expectedExit =
			envelope.error.code === "BUILD_FAILED"
				? 12
				: envelope.error.code === "DEPLOYMENT_FAILED"
					? 10
					: null;
		expect(exitCodes[0]).toBe(expectedExit);
	});
});
