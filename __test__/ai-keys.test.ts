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
	// The real response is the key row (`id`) plus the one-time plaintext.
	const mutate = vi.fn(async (_input: unknown) => ({
		id: "key_1",
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

const CATALOG = {
	global: {
		isEnabled: true,
		models: [
			{
				id: "z-ai/glm-5.3",
				name: "GLM 5.3",
				region: "global",
				contextWindow: 1_310_720,
				providerStatus: "available",
				costPer1MTokens: { input: 2.1, output: 6.6 },
			},
			{
				id: "moonshotai/kimi-k3",
				name: "Kimi K3",
				region: "global",
				contextWindow: 1_048_576,
				providerStatus: "unavailable",
				costPer1MTokens: { input: null, output: null },
			},
		],
	},
	saudi: {
		isEnabled: true,
		models: [
			{
				id: "groq/openai/gpt-oss-20b",
				name: "GPT-OSS 20B",
				region: "saudi",
				contextWindow: 131_072,
				providerStatus: "available",
				costPer1MTokens: { input: 0.1125, output: 0.45 },
			},
		],
	},
};

const ACTIVITY = {
	days: 7,
	totals: { requests: 3, promptTokens: 300, completionTokens: 30, costHalalas: 1234 },
	daily: [
		{ date: "2026-09-24", modelId: "z-ai/glm-5.3", requests: 2, promptTokens: 200, completionTokens: 20, costHalalas: 1000 },
		{ date: "2026-09-24", modelId: "groq/openai/gpt-oss-20b", requests: 1, promptTokens: 100, completionTokens: 10, costHalalas: 234 },
	],
	byModel: [
		{ modelId: "z-ai/glm-5.3", requests: 2, promptTokens: 200, completionTokens: 20, costHalalas: 1000 },
	],
	byKey: [],
};

describe("tarout ai (end-to-end command shapes)", () => {
	it("models lists every product's models from the real {global, saudi} response", async () => {
		h.client = {
			aiGateway: { getAvailableModels: { query: async () => CATALOG } },
		};

		await run(["ai", "models"]);

		const out = stdout.join("\n");
		expect(out).not.toContain("No AI models available");
		expect(out).toContain("z-ai/glm-5.3");
		expect(out).toContain("groq/openai/gpt-oss-20b");
		expect(out).toContain("Saudi Arabia");
		expect(out).toContain("$2.10");
		expect(out).toContain("unavailable");
	});

	it("models --quiet prints only callable model ids", async () => {
		h.client = {
			aiGateway: { getAvailableModels: { query: async () => CATALOG } },
		};
		setGlobalOptions({ ...RESET, quiet: true });
		const program = new Command();
		program.exitOverride();
		registerAiCommands(program);
		await program.parseAsync(["node", "tarout", "ai", "models"]);

		expect(stdout).toEqual(["z-ai/glm-5.3", "groq/openai/gpt-oss-20b"]);
	});

	it("keys list shows the full id every other command needs", async () => {
		h.client = {
			aiGateway: {
				listKeys: {
					query: async () => [
						{
							id: "cmfull0000000000000000001",
							keyName: "prod",
							isEnabled: true,
							createdAt: "2026-09-01T00:00:00Z",
						},
					],
				},
			},
		};

		await run(["ai", "keys", "list"]);

		expect(stdout.join("\n")).toContain("cmfull0000000000000000001");
	});

	it("keys create --quiet prints the new key id", async () => {
		mockGenerateKey();
		setGlobalOptions({ ...RESET, quiet: true });
		const program = new Command();
		program.exitOverride();
		registerAiCommands(program);
		await program.parseAsync(["node", "tarout", "ai", "keys", "create", "--name", "prod"]);

		expect(stdout).toEqual(["key_1"]);
	});

	it("keys create --expires 30 sends an expiry 30 days out", async () => {
		const mutate = mockGenerateKey();
		const before = Date.now();

		await run(["ai", "keys", "create", "--name", "prod", "--expires", "30"]);

		const sent = mutate.mock.calls[0]?.[0] as { expiresAt: Date };
		const days = (sent.expiresAt.getTime() - before) / 86_400_000;
		expect(days).toBeGreaterThan(29.99);
		expect(days).toBeLessThan(30.01);
	});

	it("keys update --expires never clears the expiry", async () => {
		const mutate = vi.fn(async (_input: unknown) => ({ id: "key_1" }));
		h.client = { aiGateway: { updateKey: { mutate } } };

		await run(["ai", "keys", "update", "key_1", "--expires", "never"]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({ keyId: "key_1", expiresAt: null });
	});

	it("keys create rejects a past --expires date", async () => {
		const mutate = mockGenerateKey();

		await expect(
			run(["ai", "keys", "create", "--name", "prod", "--expires", "2001-01-01"]),
		).rejects.toThrow();
		expect(mutate).not.toHaveBeenCalled();
	});

	it("usage reports the dashboard's SAR spend, not USD read as halalas", async () => {
		const query = vi.fn(async () => ACTIVITY);
		h.client = { aiGateway: { getActivity: { query } } };

		await run(["ai", "usage", "--days", "7"]);

		expect(query).toHaveBeenCalledWith({ days: 7 });
		const out = stdout.join("\n");
		expect(out).toContain("Requests: 3");
		expect(out).toContain("Spend: 12.3400 SAR");
		expect(out).toContain("z-ai/glm-5.3");
	});

	it("keys usage scopes Activity to the key and sums each day across models", async () => {
		const query = vi.fn(async () => ACTIVITY);
		h.client = { aiGateway: { getActivity: { query } } };

		await run(["ai", "keys", "usage", "key_1", "--days", "7"]);

		expect(query).toHaveBeenCalledWith({ days: 7, keyId: "key_1" });
		const out = stdout.join("\n");
		expect(out).toMatch(/2026-09-24\s+3\s+330\s+12\.3400/);
	});

	it("delete says what really happens: soft delete, history kept", async () => {
		h.confirm.mockResolvedValue(false);
		h.client = { aiGateway: { deleteKey: { mutate: vi.fn() } } };

		await run(["ai", "keys", "delete", "key_1"]);

		const prompt = String(h.confirm.mock.calls[0]?.[0]);
		expect(prompt).toContain("usage history stays");
		expect(prompt).not.toContain("cannot be undone");
	});

	it("revoke warns that a revoked key can never be re-enabled", async () => {
		h.confirm.mockResolvedValue(false);
		h.client = { aiGateway: { revokeKey: { mutate: vi.fn() } } };

		await run(["ai", "keys", "revoke", "key_1"]);

		expect(String(h.confirm.mock.calls[0]?.[0])).toContain("never be re-enabled");
	});
});
