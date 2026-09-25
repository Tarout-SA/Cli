import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout wallet topup` printed `result.amount`, which the platform never
 * sends (it returns `amountHalalas`), and its --amount flag took halalas while
 * the prompt asked for SAR. `tarout wallet agree` is new: the Compute Wallet
 * agreement gates server creation and top-ups.
 */

const h = vi.hoisted(() => ({
	client: {} as any,
	input: vi.fn(),
	confirm: vi.fn(),
}));

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

vi.mock("../src/utils/prompts.js", () => ({
	input: h.input,
	confirm: h.confirm,
}));

import { Command } from "commander";
import { registerWalletCommands, sarToHalalas } from "../src/commands/wallet";
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
	h.input.mockReset();
	h.confirm.mockReset();
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
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	h.client = {} as any;
});

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerWalletCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

const out = () => stdout.join("\n");

function mockCheckout(amountHalalas = 5000) {
	const mutate = vi.fn(async (input: { amountHalalas?: number }) => ({
		paymentUrl: "https://tarout.sa/dashboard/wallet?order=top_1",
		publicPaymentUrl: "https://tarout.sa/pay/top_1",
		orderId: "top_1",
		amountHalalas: input.amountHalalas ?? amountHalalas,
	}));
	h.client = { wallet: { createTopupCheckout: { mutate } } };
	return mutate;
}

describe("tarout wallet topup", () => {
	it("--amount is SAR and the printed amount comes from amountHalalas", async () => {
		const mutate = mockCheckout();

		await run(["wallet", "topup", "--amount", "50"]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({ amountHalalas: 5000 });
		expect(out()).toContain("Amount: 50.00 SAR");
		expect(out()).toContain("Payment URL: https://tarout.sa/pay/top_1");
		expect(out()).not.toContain("Default");
	});

	it("rounds fractional SAR to whole halalas", async () => {
		const mutate = mockCheckout();

		await run(["wallet", "topup", "-a", "12.345"]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({ amountHalalas: 1235 });
		expect(out()).toContain("Amount: 12.35 SAR");
	});

	it("refuses less than the 5 SAR minimum instead of letting the platform raise it", async () => {
		const mutate = mockCheckout();

		await run(["wallet", "topup", "--amount", "2"]);

		expect(exitCodes[0]).toBe(2);
		expect(mutate).not.toHaveBeenCalled();
		expect(stderr.join("\n")).toContain("minimum top-up is 5 SAR");
	});

	it("rejects an amount that is not a number", async () => {
		const mutate = mockCheckout();

		await run(["wallet", "topup", "--amount", "fifty"]);

		expect(exitCodes[0]).toBe(2);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("keeps a hidden --halalas flag for old scripts", async () => {
		const mutate = mockCheckout();

		await run(["wallet", "topup", "--halalas", "1000"]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({ amountHalalas: 1000 });
		expect(out()).toContain("Amount: 10.00 SAR");
	});

	it("the prompt takes SAR too", async () => {
		const mutate = mockCheckout();
		h.input.mockResolvedValue("25");

		await run(["wallet", "topup"]);

		expect(String(h.input.mock.calls[0]?.[0])).toContain("SAR");
		expect(mutate.mock.calls[0]?.[0]).toEqual({ amountHalalas: 2500 });
	});

	it("a blank prompt uses the platform default and prints what it charges", async () => {
		const mutate = mockCheckout(500);
		h.input.mockResolvedValue("");

		await run(["wallet", "topup"]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({});
		expect(out()).toContain("Amount: 5.00 SAR");
	});

	it("help says SAR and hides --halalas", () => {
		const program = new Command();
		registerWalletCommands(program);
		const topup = program.commands
			.find((c) => c.name() === "wallet")
			?.commands.find((c) => c.name() === "topup");
		const help = topup?.helpInformation() ?? "";
		expect(help).toContain("--amount <sar>");
		expect(help).toContain("Amount in SAR");
		expect(help).not.toContain("--halalas");
		expect(help).not.toContain("100 halalas = 1 SAR");
	});

	it("sarToHalalas converts and validates", () => {
		expect(sarToHalalas("5")).toBe(500);
		expect(sarToHalalas(" 7.5 ")).toBe(750);
		expect(() => sarToHalalas("0")).toThrow();
		expect(() => sarToHalalas("")).toThrow();
		expect(() => sarToHalalas("-3")).toThrow();
	});
});

describe("tarout wallet agree", () => {
	function mockAccept() {
		const mutate = vi.fn(async () => ({
			balanceHalalas: "0",
			agreementAcceptedAt: "2026-09-25T10:00:00.000Z",
			isReady: false,
		}));
		h.client = { wallet: { acceptAgreement: { mutate } } };
		return mutate;
	}

	it("shows the terms link, asks, then accepts", async () => {
		const mutate = mockAccept();
		h.confirm.mockResolvedValue(true);

		await run(["wallet", "agree"]);

		expect(out()).toContain("https://tarout.sa/dashboard/wallet");
		expect(out()).toContain("before you can create cloud servers or top up the wallet");
		expect(h.confirm).toHaveBeenCalledTimes(1);
		expect((h.confirm.mock.calls[0]?.[2] as { flag: string }).flag).toBe("--yes");
		expect(mutate).toHaveBeenCalledTimes(1);
		expect(out()).toContain("Compute Wallet agreement accepted on");
		expect(out()).toContain("Balance: 0.00 SAR");
		expect(out()).toContain("tarout wallet topup --amount 5");
	});

	it("does nothing when the user declines", async () => {
		const mutate = mockAccept();
		h.confirm.mockResolvedValue(false);

		await run(["wallet", "agree"]);

		expect(mutate).not.toHaveBeenCalled();
		expect(out()).toContain("Not accepted.");
	});

	it("--yes skips the question", async () => {
		const mutate = mockAccept();

		await run(["wallet", "agree"], { yes: true });

		expect(h.confirm).not.toHaveBeenCalled();
		expect(mutate).toHaveBeenCalledTimes(1);
	});

	it("--json --yes prints the raw result", async () => {
		mockAccept();

		await run(["wallet", "agree"], { json: true, yes: true });

		const envelope = JSON.parse(stdout.join("\n"));
		expect(envelope).toEqual({
			success: true,
			data: {
				balanceHalalas: "0",
				agreementAcceptedAt: "2026-09-25T10:00:00.000Z",
				isReady: false,
			},
		});
	});

	it("a non-owner gets the platform's FORBIDDEN message", async () => {
		h.client = {
			wallet: {
				acceptAgreement: {
					mutate: async () => {
						throw Object.assign(new Error("Only the organization owner can manage the Compute Wallet"), {
							data: { code: "FORBIDDEN" },
						});
					},
				},
			},
		};

		await run(["wallet", "agree"], { yes: true });

		expect(exitCodes[0]).toBe(5);
		expect(stderr.join("\n")).toContain("Only the organization owner");
	});
});
