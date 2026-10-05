import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout referral` shows the code, link and compute-credit earnings;
 * `tarout referral history` lists credit per customer payment.
 */

const h = vi.hoisted(() => ({ client: {} as any }));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));
vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1", projectName: undefined }),
	getApiUrl: () => "https://api.test",
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
import { formatSar, registerReferralCommands } from "../src/commands/referral";
import { commandRequiresProject } from "../src/lib/command-gates";
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

beforeEach(() => {
	stdout = [];
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	h.client = {
		referral: {
			getMyCode: {
				query: vi.fn().mockResolvedValue({
					code: "ABCD2345",
					url: "https://tarout.sa/r/ABCD2345",
					rewardDays: 5,
				}),
			},
			getPartnerSummary: {
				query: vi.fn().mockResolvedValue({
					clicks: 40,
					signups: 6,
					payingCustomers: 3,
					pendingHalalas: 3990,
					reviewHalalas: 0,
					availableHalalas: 12000,
					reversedHalalas: 0,
					isPartner: true,
					codeDisabled: false,
					program: {
						enabled: true,
						creditBps: 1500,
						durationMonths: 12,
						holdDays: 30,
						welcomeBonusDays: 5,
						lateClaimDays: 30,
					},
				}),
			},
			listCredits: {
				query: vi.fn().mockResolvedValue([
					{
						id: "cr1",
						kind: "subscription_renewal",
						paymentAmountHalalas: 39900,
						percentBps: 1000,
						amountHalalas: 3990,
						reversedHalalas: 0,
						status: "PENDING",
						holdUntil: "2026-11-04T00:00:00.000Z",
						availableAt: null,
						createdAt: "2026-10-05T00:00:00.000Z",
						customerName: "Client Co",
					},
				]),
			},
		},
	};
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

async function run(argv: string[], opts: Partial<typeof RESET> = {}) {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerReferralCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
	return program;
}

const out = () => stdout.join("\n");

describe("tarout referral", () => {
	it("formats halalas as SAR", () => {
		expect(formatSar(12000)).toBe("120.00 SAR");
		expect(formatSar(5)).toBe("0.05 SAR");
	});

	it("shows code, link, funnel and earnings", async () => {
		await run(["referral"]);
		const text = out();
		expect(text).toContain("ABCD2345");
		expect(text).toContain("https://tarout.sa/r/ABCD2345");
		expect(text).toContain("partner");
		expect(text).toMatch(/Paying customers\s+3/);
		expect(text).toContain("39.90 SAR");
		expect(text).toContain("120.00 SAR");
		expect(text).toContain("15% of each payment");
		expect(text).toContain("no cash value");
	});

	it("emits merged JSON in --json mode", async () => {
		await run(["referral"], { json: true });
		const json = JSON.parse(out());
		expect(json.data.code).toBe("ABCD2345");
		expect(json.data.availableHalalas).toBe(12000);
	});

	it("lists per-payment history", async () => {
		await run(["referral", "history", "--limit", "10"]);
		expect(h.client.referral.listCredits.query).toHaveBeenCalledWith({ limit: 10 });
		const text = out();
		expect(text).toContain("Client Co");
		expect(text).toContain("Plan renewal");
		expect(text).toContain("pending");
		expect(text).toContain("2026-11-04");
	});

	it("does not need an active project", async () => {
		const program = await run(["referral"]);
		const cmd = program.commands.find((c) => c.name() === "referral");
		expect(commandRequiresProject(cmd, program)).toBe(false);
		const history = cmd?.commands.find((c) => c.name() === "history");
		expect(commandRequiresProject(history, program)).toBe(false);
	});
});
