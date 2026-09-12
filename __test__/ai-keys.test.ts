import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AI Gateway keys are no longer pinned to one model: one key calls every model
 * in the catalog and each request picks one. These specs pin the CLI side of
 * that contract. `keys create` never asks for or sends a model, the deprecated
 * `--model` / `--provider` flags still parse (with a warning) so old scripts
 * keep running, and list/info stop presenting a model as a property of a key.
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
import { registerAiCommands } from "../src/commands/ai";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

const ANSI = /\[[0-9;]*m/g;

let stdout: string[];
let stderr: string[];

beforeEach(() => {
	stdout = [];
	stderr = [];
	h.input.mockReset();
	h.confirm.mockReset();
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	h.client = {} as any;
});

async function run(argv: string[]): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true });
	const program = new Command();
	program.exitOverride();
	registerAiCommands(program);
	await program.parseAsync(["node", "tarout", ...argv]);
}

function mockGenerateKey() {
	const mutate = vi.fn(async (_input: unknown) => ({
		keyId: "key_1",
		apiKey: "sk_tarout_secret",
	}));
	h.client = { aiGateway: { generateKey: { mutate } } };
	return mutate;
}

describe("tarout ai keys", () => {
	it("create sends only the key name and never prompts for a model", async () => {
		const mutate = mockGenerateKey();

		await run(["ai", "keys", "create", "--name", "prod"]);

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(mutate.mock.calls[0]?.[0]).toEqual({ keyName: "prod" });
		expect(h.input).not.toHaveBeenCalled();
		expect(stderr).toEqual([]);

		const out = stdout.join("\n");
		expect(out).toContain("sk_tarout_secret");
		expect(out).toContain("tarout ai models");
		expect(out).not.toMatch(/Model:|Provider:/);
	});

	it("create converts --monthly-cap from SAR to halalas", async () => {
		const mutate = mockGenerateKey();

		await run([
			"ai",
			"keys",
			"create",
			"--name",
			"prod",
			"--monthly-cap",
			"12.5",
		]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({
			keyName: "prod",
			monthlySpendCapHalalas: 1250,
		});
		expect(stdout.join("\n")).toContain("Monthly credit limit: 12.50 SAR");
	});

	it("create accepts the deprecated --model and --provider, warns once, and sends neither", async () => {
		const mutate = mockGenerateKey();

		await run([
			"ai",
			"keys",
			"create",
			"--name",
			"prod",
			"--model",
			"z-ai/glm-5.3",
			"--provider",
			"saudi",
		]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({ keyName: "prod" });
		expect(stderr).toHaveLength(1);
		expect(stderr[0]).toContain("deprecated");
		expect(stderr[0]).toContain("every model");
	});

	it("list has no MODEL column", async () => {
		h.client = {
			aiGateway: {
				listKeys: {
					query: async () => [
						{
							keyId: "key_12345678",
							keyName: "prod",
							modelId: "z-ai/glm-5.3",
							isEnabled: true,
							createdAt: "2026-09-01T00:00:00Z",
						},
					],
				},
			},
		};

		await run(["ai", "keys", "list"]);

		const out = stdout.join("\n");
		expect(out).toContain("NAME");
		expect(out).toContain("prod");
		expect(out).not.toContain("MODEL");
		expect(out).not.toContain("z-ai/glm-5.3");
	});

	it("info omits Model and Provider for a key with no legacy model", async () => {
		h.client = {
			aiGateway: {
				getKeyDetails: {
					query: async () => ({
						keyId: "key_1",
						keyName: "prod",
						modelId: null,
						modelProvider: null,
						isEnabled: true,
						createdAt: "2026-09-01T00:00:00Z",
					}),
				},
			},
		};

		await run(["ai", "keys", "info", "key_1"]);

		const out = stdout.join("\n");
		expect(out).toContain("Status: enabled");
		expect(out).not.toMatch(/Model:|Provider:/);
	});

	it("info still shows a legacy model, marked as not enforced", async () => {
		h.client = {
			aiGateway: {
				getKeyDetails: {
					query: async () => ({
						keyId: "key_1",
						keyName: "prod",
						modelId: "z-ai/glm-5.3",
						modelProvider: "global",
						monthlySpendCapHalalas: 5000,
						isEnabled: true,
						createdAt: "2026-09-01T00:00:00Z",
					}),
				},
			},
		};

		await run(["ai", "keys", "info", "key_1"]);

		const out = stdout.join("\n");
		expect(out).toContain("Model: z-ai/glm-5.3 (legacy, not enforced)");
		expect(out).toContain("Provider: global");
		expect(out).toContain("Monthly credit limit: 50.00 SAR");
	});
});
