import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout approvals`: list, get, and wait on the approval requests the
 * platform parks when an operator-tier key calls a destructive procedure.
 * There is no approve/deny command on purpose: only a human in the dashboard
 * can decide, and `wait` must exit 0 ONLY when the action actually ran.
 */

const h = vi.hoisted(() => ({
	// biome-ignore lint/suspicious/noExplicitAny: the tRPC client mock is untyped, like the CLI client.
	client: {} as any,
}));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	getApiUrl: () => "https://tarout.sa",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerApprovalsCommands } from "../src/commands/approvals";
import {
	formatWaitDuration,
	parseWaitTimeout,
	waitForApproval,
} from "../src/lib/approvals";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
const ANSI = /\x1b\[[0-9;]*m/g;

let stdout: string[];
let stderr: string[];
let exitCodes: number[];

beforeEach(() => {
	stdout = [];
	stderr = [];
	exitCodes = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
});

afterEach(() => {
	vi.useRealTimers();
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	// biome-ignore lint/suspicious/noExplicitAny: the tRPC client mock is untyped, like the CLI client.
	h.client = {} as any;
});

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerApprovalsCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON envelopes are asserted field by field.
type Envelope = Record<string, any>;

/** The terminal JSON envelopes on stdout (lines with a `success` key). */
function envelopes(): Envelope[] {
	return stdout
		.map((line) => {
			try {
				return JSON.parse(line) as Envelope;
			} catch {
				return null;
			}
		})
		.filter((v): v is Envelope => !!v && "success" in v);
}

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "pa_1",
		procedure: "application.delete",
		input: { applicationId: "app_1" },
		reason: "Deletes an application",
		status: "pending",
		resultSummary: null,
		apiKeyId: "key_abcdef123456",
		decidedAt: null,
		executedAt: null,
		createdAt: new Date("2026-09-29T08:00:00Z"),
		expiresAt: new Date("2026-09-30T08:00:00Z"),
		...overrides,
	};
}

function mockClient(options: {
	get?: Array<Record<string, unknown>> | Error;
	list?: { pending: unknown[]; decided: unknown[] };
}) {
	const get = vi.fn();
	if (options.get instanceof Error) {
		get.mockRejectedValue(options.get);
	} else {
		const states = options.get ?? [row()];
		for (const state of states) get.mockResolvedValueOnce(state);
		// Stay on the last state for any further poll.
		get.mockResolvedValue(states[states.length - 1]);
	}
	const list = vi
		.fn()
		.mockResolvedValue(options.list ?? { pending: [], decided: [] });
	h.client = { approvals: { get: { query: get }, list: { query: list } } };
	return { get, list };
}

describe("tarout approvals list", () => {
	const listResult = {
		pending: [row({ keyName: "ci-agent" })],
		decided: [
			row({
				id: "pa_2",
				status: "executed",
				resultSummary: "Executed successfully",
				keyName: "ci-agent",
			}),
			row({ id: "pa_3", status: "denied", keyName: null, apiKeyId: null }),
		],
	};

	it("prints pending first with the requesting key and the dashboard link", async () => {
		const { list } = mockClient({ list: listResult });

		await run(["approvals", "list"]);

		expect(list).toHaveBeenCalledWith({ limit: 20 });
		const text = out();
		expect(text).toContain("REQUESTED BY");
		expect(text.indexOf("pa_1")).toBeLessThan(text.indexOf("pa_2"));
		expect(text).toContain("ci-agent");
		expect(text).toContain("✓ executed");
		expect(text).toContain("✗ denied");
		expect(text).toContain("3 requests");
		expect(text).toContain(
			"Approve or deny pending requests at https://tarout.sa/dashboard/agent/approvals",
		);
		expect(exitCodes).toEqual([]);
	});

	it("--json returns one {success,data} envelope with every row", async () => {
		mockClient({ list: listResult });

		await run(["approvals", "list"], { json: true });

		expect(stdout).toHaveLength(1);
		const [env] = envelopes();
		expect(env?.success).toBe(true);
		expect(env?.data.map((r: { id: string }) => r.id)).toEqual([
			"pa_1",
			"pa_2",
			"pa_3",
		]);
	});

	it("--status filters client-side and --limit is sent and honored", async () => {
		const { list } = mockClient({ list: listResult });

		await run(["approvals", "list", "--status", "denied", "--limit", "5"], {
			json: true,
		});

		expect(list).toHaveBeenCalledWith({ limit: 5 });
		expect(envelopes()[0]?.data.map((r: { id: string }) => r.id)).toEqual([
			"pa_3",
		]);

		stdout = [];
		mockClient({ list: listResult });
		await run(["approvals", "list", "--limit", "2"], { json: true });
		expect(envelopes()[0]?.data).toHaveLength(2);
	});

	it("says so when there is nothing to show", async () => {
		mockClient({});
		await run(["approvals", "list", "--status", "pending"]);
		expect(out()).toContain("No pending approval requests.");
	});

	it("rejects an unknown status and an out-of-range limit before calling the API", async () => {
		const { list } = mockClient({ list: listResult });

		await run(["approvals", "list", "--status", "approvedd"]);
		expect(exitCodes).toEqual([2]);

		await run(["approvals", "list", "--limit", "51"]);
		expect(exitCodes).toEqual([2, 2]);
		expect(list).not.toHaveBeenCalled();
	});
});

describe("tarout approvals get", () => {
	it("shows the procedure, requesting key, expiry and the wait command", async () => {
		const { get } = mockClient({
			get: [row()],
			list: { pending: [row({ keyName: "ci-agent" })], decided: [] },
		});

		await run(["approvals", "get", "pa_1"]);

		expect(get).toHaveBeenCalledWith({ id: "pa_1" });
		const text = out();
		expect(text).toContain("application.delete");
		expect(text).toContain("○ pending");
		expect(text).toContain("Requested by:  ci-agent");
		expect(text).toContain('"applicationId":"app_1"');
		expect(text).toContain("Expires:");
		expect(text).toContain("https://tarout.sa/dashboard/agent/approvals");
		expect(text).toContain("tarout approvals wait pa_1");
	});

	it("shows the error of a failed request and falls back to the key id", async () => {
		mockClient({
			get: [
				row({
					status: "failed",
					resultSummary: "CONFLICT: application is deploying",
					executedAt: new Date("2026-09-29T09:00:00Z"),
				}),
			],
		});

		await run(["approvals", "get", "pa_1"]);

		const text = out();
		expect(text).toContain("✗ failed");
		expect(text).toContain("Error:         CONFLICT: application is deploying");
		expect(text).toContain("Requested by:  key key_abcd");
		expect(text).not.toContain("Expires:");
		expect(text).not.toContain("tarout approvals wait");
	});

	it("--json returns the approval with the key name", async () => {
		mockClient({
			get: [row({ status: "executed", resultSummary: "Executed successfully" })],
			list: { pending: [], decided: [row({ status: "executed", keyName: "ci-agent" })] },
		});

		await run(["approvals", "get", "pa_1"], { json: true });

		expect(stdout).toHaveLength(1);
		const [env] = envelopes();
		expect(env?.success).toBe(true);
		expect(env?.data).toMatchObject({
			id: "pa_1",
			status: "executed",
			keyName: "ci-agent",
			resultSummary: "Executed successfully",
		});
	});

	it("maps a missing approval to NOT_FOUND (exit 4)", async () => {
		mockClient({
			get: Object.assign(new Error("Approval not found"), {
				data: { code: "NOT_FOUND" },
			}),
		});

		await run(["approvals", "get", "pa_missing"], { json: true });

		expect(exitCodes).toEqual([4]);
		expect(envelopes()[0]?.error.code).toBe("NOT_FOUND");
	});
});

describe("tarout approvals wait", () => {
	it("exits 0 and prints the result once the action is executed", async () => {
		vi.useFakeTimers();
		const { get } = mockClient({
			get: [
				row(),
				row({ status: "approved" }),
				row({
					status: "executed",
					resultSummary: "Executed successfully",
					executedAt: new Date(),
				}),
			],
		});

		const done = run(["approvals", "wait", "pa_1", "--interval", "5"]);
		await vi.advanceTimersByTimeAsync(10_000);
		await done;

		expect(get).toHaveBeenCalledTimes(3);
		expect(exitCodes).toEqual([]);
		const text = out();
		expect(text).toContain("Waiting up to 30m");
		expect(text).toContain(
			"Approve or deny it at https://tarout.sa/dashboard/agent/approvals",
		);
		expect(text).toContain("Approved and executed: application.delete");
		expect(text).toContain("Executed successfully");
	});

	it("--json emits exactly one success envelope when executed", async () => {
		mockClient({
			get: [row({ status: "executed", resultSummary: "Executed successfully" })],
		});

		await run(["approvals", "wait", "pa_1"], { json: true });

		expect(exitCodes).toEqual([]);
		expect(stdout).toHaveLength(1);
		const [env] = envelopes();
		expect(env?.success).toBe(true);
		expect(env?.data).toMatchObject({ id: "pa_1", status: "executed" });
	});

	it("exits 5 (PERMISSION_DENIED) when a human denies it", async () => {
		mockClient({ get: [row({ status: "denied", decidedAt: new Date() })] });

		await run(["approvals", "wait", "pa_1"], { json: true });

		expect(exitCodes).toEqual([5]);
		expect(stdout).toHaveLength(1);
		const [env] = envelopes();
		expect(env?.success).toBe(false);
		expect(env?.error.code).toBe("APPROVAL_DENIED");
		expect(env?.error.message).toMatch(/Do not retry/);
		expect(env?.error.details).toMatchObject({
			id: "pa_1",
			status: "denied",
			dashboardUrl: "https://tarout.sa/dashboard/agent/approvals",
		});
	});

	it("exits 1 (GENERAL_ERROR) when the request expired", async () => {
		mockClient({ get: [row({ status: "expired" })] });

		await run(["approvals", "wait", "pa_1"], { json: true });

		expect(exitCodes).toEqual([1]);
		expect(stdout).toHaveLength(1);
		expect(envelopes()[0]?.error.code).toBe("APPROVAL_EXPIRED");
	});

	it("exits 1 (GENERAL_ERROR) with the server's error when the approved action failed", async () => {
		mockClient({
			get: [
				row({
					status: "failed",
					resultSummary: "CONFLICT: application is deploying",
				}),
			],
		});

		await run(["approvals", "wait", "pa_1"]);

		expect(exitCodes).toEqual([1]);
		expect(err()).toContain(
			"application.delete was approved but failed when it ran: CONFLICT: application is deploying",
		);
	});

	it("exits 11 with a resumable envelope when the timeout passes", async () => {
		vi.useFakeTimers();
		const { get } = mockClient({ get: [row()] });

		const done = run(
			["approvals", "wait", "pa_1", "--timeout", "10s", "--interval", "5"],
			{ json: true },
		);
		await vi.advanceTimersByTimeAsync(10_000);
		await done;

		// Once at the start, once per interval, once at the deadline.
		expect(get).toHaveBeenCalledTimes(3);
		expect(exitCodes).toEqual([11]);
		expect(stdout).toHaveLength(1);
		const [env] = envelopes();
		expect(env?.error.code).toBe("APPROVAL_PENDING");
		expect(env?.error.details).toMatchObject({
			stillPending: true,
			nextCommand: "tarout approvals wait pa_1",
			dashboardUrl: "https://tarout.sa/dashboard/agent/approvals",
		});
		expect(env?.error.details.interrupted).toBeUndefined();
	});

	it("Ctrl+C stops waiting as still pending (exit 11), never as success", async () => {
		vi.useFakeTimers();
		const listenersBefore = process.listenerCount("SIGINT");
		const { get } = mockClient({ get: [row()] });

		const done = run(["approvals", "wait", "pa_1", "--interval", "60"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(process.listenerCount("SIGINT")).toBe(listenersBefore + 1);
		process.emit("SIGINT");
		await done;

		expect(get).toHaveBeenCalledTimes(1);
		expect(exitCodes).toEqual([11]);
		expect(err()).toContain("Stopped waiting");
		expect(err()).toContain("Next: tarout approvals wait pa_1");
		expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
	});

	it("rejects a malformed or over-long --timeout (exit 2) before polling", async () => {
		const { get } = mockClient({ get: [row()] });

		await run(["approvals", "wait", "pa_1", "--timeout", "soon"]);
		await run(["approvals", "wait", "pa_1", "--timeout", "25h"]);
		await run(["approvals", "wait", "pa_1", "--interval", "0"]);

		expect(exitCodes).toEqual([2, 2, 2]);
		expect(get).not.toHaveBeenCalled();
	});
});

describe("tarout approvals --help", () => {
	it("says approving happens in the dashboard, and offers no approve/deny command", () => {
		const program = new Command();
		registerApprovalsCommands(program);
		const approvals = program.commands.find((c) => c.name() === "approvals");
		let help = "";
		approvals?.configureOutput({
			writeOut: (text) => {
				help += text;
			},
		});
		approvals?.outputHelp();

		expect(help).toContain(
			"a human approves or denies requests in the dashboard (https://tarout.sa/dashboard/agent/approvals); an agent cannot approve its own request.",
		);
		const names = approvals?.commands.map((c) => c.name());
		expect(names).toEqual(["list", "get", "wait"]);
	});
});

describe("approval wait helpers", () => {
	it("parses 30m, 90s, 2h, 1h30m and bare seconds", () => {
		expect(parseWaitTimeout("30m")).toBe(30 * 60_000);
		expect(parseWaitTimeout("90s")).toBe(90_000);
		expect(parseWaitTimeout("2h")).toBe(2 * 3_600_000);
		expect(parseWaitTimeout("1h30m")).toBe(90 * 60_000);
		expect(parseWaitTimeout("45")).toBe(45_000);
		expect(parseWaitTimeout("24h")).toBe(24 * 3_600_000);
		for (const bad of ["", "0", "0m", "-5", "1.5h", "5d", "m", "24h1s"]) {
			expect(() => parseWaitTimeout(bad)).toThrow();
		}
	});

	it("formats durations the way the flag takes them", () => {
		expect(formatWaitDuration(30 * 60_000)).toBe("30m");
		expect(formatWaitDuration(90 * 60_000)).toBe("1h30m");
		expect(formatWaitDuration(45_000)).toBe("45s");
	});

	it("reports status changes once each and keeps polling through `approved`", async () => {
		const states = [
			row(),
			row(),
			row({ status: "approved" }),
			row({ status: "executed" }),
		];
		const get = vi.fn();
		for (const state of states) get.mockResolvedValueOnce(state);
		const client = { approvals: { get: { query: get } } };
		const seen: string[] = [];
		let clock = 0;

		const result = await waitForApproval(client, "pa_1", {
			timeoutMs: 60_000,
			intervalMs: 1_000,
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			onStatus: (approval) => seen.push(approval.status),
		});

		expect(result.outcome).toBe("terminal");
		expect(result.approval.status).toBe("executed");
		expect(seen).toEqual(["pending", "approved", "executed"]);
		expect(get).toHaveBeenCalledTimes(4);
	});
});
