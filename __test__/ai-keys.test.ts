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
import { flattenModelCatalog, registerAiCommands } from "../src/commands/ai";
import { setGlobalOptions } from "../src/lib/output";
import { serviceCatalog } from "./fixtures/ai";

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

/** What a platform older than aiGateway.getServiceCatalog answers for it. */
function missingProcedure(path: string) {
	return Object.assign(new Error(`No "query"-procedure on path "${path}"`), {
		data: { code: "NOT_FOUND" },
	});
}

describe("tarout ai (end-to-end command shapes)", () => {
	it("models lists every kind from the service catalog with KIND, REGION and a per-unit PRICE", async () => {
		h.client = {
			aiGateway: { getServiceCatalog: { query: async () => serviceCatalog() } },
		};

		await run(["ai", "models"]);

		const out = stdout.join("\n");
		expect(out).toMatch(/MODEL\s+NAME\s+KIND\s+REGION\s+PRICE\s+STATUS/);
		expect(out).toMatch(/local\/qwen\/qwen3-embedding-8b\s+.*embedding\s+Local\s+\$0\.02 per 1M tokens\s+available/);
		expect(out).toMatch(/qwen\/qwen3-embedding-8b\s+.*Global\s+up to \$0\.01 per 1M tokens/);
		expect(out).toContain("$0.01 per audio minute");
		// An unpriced model is listed but cannot be called.
		expect(out).toMatch(/local\/deepseek-ai\/deepseek-v4\.1-flash.*-\s+unavailable/);
		expect(out).not.toContain("Saudi Arabia");
		// The footer example is a Local alias that exists.
		expect(out).toContain("local/qwen3.8-flash");
		expect(out).not.toMatch(/-ksa|kimi|gpt-oss-local/);
	});

	it("models --kind and --region filter the catalog", async () => {
		h.client = {
			aiGateway: { getServiceCatalog: { query: async () => serviceCatalog() } },
		};
		setGlobalOptions({ ...RESET, quiet: true });
		const program = new Command();
		program.exitOverride();
		registerAiCommands(program);
		await program.parseAsync(["node", "tarout", "ai", "models", "--kind", "transcription", "-r", "global"]);

		expect(stdout).toEqual(["tarout-transcribe-global"]);
	});

	it("models --quiet prints only callable model ids (priced, family open)", async () => {
		h.client = {
			aiGateway: {
				getServiceCatalog: {
					query: async () => serviceCatalog({ closed: [["images", "local"]] }),
				},
			},
		};
		setGlobalOptions({ ...RESET, quiet: true });
		const program = new Command();
		program.exitOverride();
		registerAiCommands(program);
		await program.parseAsync(["node", "tarout", "ai", "models", "--kind", "image"]);
		await program.parseAsync(["node", "tarout", "ai", "models", "--kind", "chat"]);

		expect(stdout).toEqual(["local/qwen/qwen3.8-flash-next", "z-ai/glm-5.3"]);
	});

	it("models falls back to the chat catalog on an older platform, the fast route as Global", async () => {
		h.client = {
			aiGateway: {
				getServiceCatalog: {
					query: async () => Promise.reject(missingProcedure("aiGateway.getServiceCatalog")),
				},
				getAvailableModels: { query: async () => CATALOG },
			},
		};

		await run(["ai", "models"]);

		const out = stdout.join("\n");
		expect(out).toContain("groq/openai/gpt-oss-20b");
		expect(out).not.toContain("Saudi Arabia");
		expect(out).toMatch(/groq\/openai\/gpt-oss-20b\s+.*chat\s+Global/);
		expect(out).toContain("$2.10 in / $6.60 out per 1M tokens");
	});

	it("flattenModelCatalog maps region through residency", () => {
		const rows = flattenModelCatalog({
			...CATALOG,
			local: {
				isEnabled: true,
				models: [{ id: "local/qwen/qwen3.8-flash-next", region: "local", providerStatus: "available" }],
			},
		});
		expect(Object.fromEntries(rows.map((row) => [row.id, row.region]))).toEqual({
			"z-ai/glm-5.3": "Global",
			"moonshotai/kimi-k3": "Global",
			"groq/openai/gpt-oss-20b": "Global",
			"local/qwen/qwen3.8-flash-next": "Local",
		});
	});

	it("status shows every service family, Local and Global", async () => {
		h.client = {
			aiGateway: {
				getServiceCatalog: {
					query: async () => serviceCatalog({ closed: [["speech", "local"]] }),
				},
			},
		};

		await run(["ai", "status"]);

		const out = stdout.join("\n");
		expect(out).toMatch(/SERVICE\s+LOCAL\s+GLOBAL/);
		expect(out).toMatch(/Text to speech\s+closed\s+open/);
		expect(out).toMatch(/Video\s+open\s+closed/);
		expect(out).toMatch(/File search\s+open\s+open/);
	});

	it("status falls back to the chat routes on an older platform", async () => {
		h.client = {
			aiGateway: {
				getServiceCatalog: {
					query: async () => Promise.reject(missingProcedure("aiGateway.getServiceCatalog")),
				},
				checkProviderAvailability: { query: async () => ({ global: true, saudi: false }) },
			},
		};

		await run(["ai", "status"]);

		const out = stdout.join("\n");
		expect(out).toContain("Global chat (global): available");
		expect(out).toContain("Global chat (saudi): unavailable");
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
