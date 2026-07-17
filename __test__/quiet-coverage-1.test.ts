import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quiet-mode (`-q`) coverage spot-checks. In quiet mode every human helper
 * (`log`, `box`, `table` header/borders, spinners) is silenced, so the ONLY
 * thing a command writes to stdout is its `quietOutput(...)` call — the essential
 * identifier(s). These tests drive a representative command from several files
 * and assert exactly those bare id/value lines land on stdout.
 */

const h = vi.hoisted(() => ({ client: {} as any }));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1", projectName: undefined }),
	getApiUrl: () => "https://api.test",
	getToken: () => "tok_test",
}));

// Spinners must never write to stdout — they're no-ops in quiet mode anyway,
// but mocking them keeps the captured output limited to quietOutput().
vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerAccountCommands } from "../src/commands/account";
import { registerAiCommands } from "../src/commands/ai";
import { registerBillingCommands } from "../src/commands/billing";
import { registerMonitorCommands } from "../src/commands/monitor";
import { registerServersCommands } from "../src/commands/servers";
import { registerWalletCommands } from "../src/commands/wallet";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

let logs: string[];

beforeEach(() => {
	logs = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	});
	// Errors (handleError) go to stderr — swallow so a failing path is visible
	// only through the missing expected stdout line.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	h.client = {} as any;
});

async function runQuiet(
	register: (program: Command) => void,
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, quiet: true, ...opts });
	const program = new Command();
	program.exitOverride();
	register(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/commander|__EXIT_/.test(String(err))) throw err;
	}
}

describe("quiet-mode coverage sweep", () => {
	it("billing status emits the plan key", async () => {
		h.client = {
			subscription: {
				getCurrent: { query: async () => ({ planKey: "shared", items: [] }) },
			},
		};
		await runQuiet(registerBillingCommands, ["billing", "status"]);
		expect(logs).toEqual(["shared"]);
	});

	it('billing status emits "free" when there is no subscription', async () => {
		h.client = {
			subscription: { getCurrent: { query: async () => null } },
		};
		await runQuiet(registerBillingCommands, ["billing", "status"]);
		expect(logs).toEqual(["free"]);
	});

	it("wallet balance emits the raw halala balance", async () => {
		h.client = {
			wallet: { getBalance: { query: async () => ({ balanceHalalas: 12345 }) } },
		};
		await runQuiet(registerWalletCommands, ["wallet", "balance"]);
		expect(logs).toEqual(["12345"]);
	});

	it("account info emits the resolved user id", async () => {
		h.client = {
			user: {
				get: {
					query: async () => ({
						id: "usr_1",
						email: "a@b.co",
						role: "owner",
						name: "Ada",
					}),
				},
			},
		};
		await runQuiet(registerAccountCommands, ["account", "info"]);
		expect(logs).toEqual(["usr_1"]);
	});

	it("ai models emits one model id per line", async () => {
		h.client = {
			aiGateway: {
				getAvailableModels: {
					query: async () => [{ id: "gpt-4o" }, { modelId: "claude-3" }],
				},
			},
		};
		await runQuiet(registerAiCommands, ["ai", "models"]);
		expect(logs).toEqual(["gpt-4o", "claude-3"]);
	});

	it("monitor delete emits the monitor id", async () => {
		h.client = {
			uptimeMonitor: { delete: { mutate: async () => ({}) } },
		};
		await runQuiet(
			registerMonitorCommands,
			["monitor", "delete", "mon_1"],
			{ yes: true },
		);
		expect(logs).toEqual(["mon_1"]);
	});

	it("servers info emits the resolved server id", async () => {
		h.client = {
			virtualMachine: {
				list: { query: async () => [{ id: "srv_1", name: "web" }] },
				get: {
					query: async () => ({
						id: "srv_1",
						name: "web",
						status: "running",
					}),
				},
			},
		};
		await runQuiet(registerServersCommands, ["servers", "info", "srv_1"]);
		expect(logs).toEqual(["srv_1"]);
	});

	it("servers list emits one FULL server id per line (pipe-able, untruncated)", async () => {
		h.client = {
			virtualMachine: {
				list: {
					query: async () => [
						// >8 chars so any accidental .slice(0,8) truncation would show.
						{ id: "srv_abcdef123456", name: "web", status: "running" },
						{ serverId: "srv_ZYXW98765432", name: "db", status: "stopped" },
					],
				},
			},
		};
		await runQuiet(registerServersCommands, ["servers", "list"]);
		// Full ids, one per line, no header/table rows, no truncation.
		expect(logs).toEqual(["srv_abcdef123456", "srv_ZYXW98765432"]);
	});

	it("servers list skips entries with no id instead of printing a blank line", async () => {
		h.client = {
			virtualMachine: {
				list: {
					query: async () => [
						{ id: "srv_present", name: "web" },
						{ name: "orphan-no-id" },
					],
				},
			},
		};
		await runQuiet(registerServersCommands, ["servers", "list"]);
		// The id-less row is dropped; no empty string sneaks onto stdout.
		expect(logs).toEqual(["srv_present"]);
		expect(logs).not.toContain("");
	});
});
