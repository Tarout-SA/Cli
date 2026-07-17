import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	input: vi.fn(),
	confirm: vi.fn(async () => true),
	select: vi.fn(),
	previewPlanChange: vi.fn(),
	changePlan: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getApiUrl: () => "https://tarout.sa",
	getCurrentProfile: () => ({ organizationId: "org-1" }),
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		subscription: {
			previewPlanChange: { query: mocks.previewPlanChange },
			changePlan: { mutate: mocks.changePlan },
		},
	}),
}));

vi.mock("../src/utils/prompts.js", () => ({
	input: mocks.input,
	confirm: mocks.confirm,
	select: mocks.select,
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
}));

import { registerBillingCommands } from "../src/commands/billing";
import { setGlobalOptions } from "../src/lib/output";

describe("Starter flat five-app bundle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setGlobalOptions({
			json: false,
			quiet: true,
			yes: false,
			nonInteractive: false,
		});
		mocks.input.mockImplementation(async (question: string) => {
			if (/database/i.test(question)) return "0";
			if (/storage/i.test(question)) return "0";
			if (/app/i.test(question)) return "3";
			return "0";
		});
		mocks.previewPlanChange.mockResolvedValue({
			proratedChargeHalalas: 0,
			newPeriodTotalHalalas: 1900,
		});
		mocks.changePlan.mockResolvedValue({
			applied: true,
			proratedChargeHalalas: 0,
		});
	});

	afterEach(() => {
		setGlobalOptions({
			json: false,
			quiet: false,
			yes: false,
			nonInteractive: false,
		});
	});

	it("upgrades to Starter without asking for or sending a plan quantity", async () => {
		const program = new Command();
		program.exitOverride();
		registerBillingCommands(program);

		await program.parseAsync(
			["node", "tarout", "billing", "upgrade", "shared"],
			{ from: "node" },
		);

		const questions = mocks.input.mock.calls.map(([question]) => String(question));
		expect(questions.some((question) => /how many apps/i.test(question))).toBe(
			false,
		);
		expect(mocks.previewPlanChange).toHaveBeenCalledWith(
			expect.not.objectContaining({ planQuantity: expect.anything() }),
		);
		expect(mocks.changePlan).toHaveBeenCalledWith(
			expect.not.objectContaining({ planQuantity: expect.anything() }),
		);
	});
});
