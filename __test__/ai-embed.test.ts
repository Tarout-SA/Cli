import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ client: {} as any }));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));
vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
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

import { registerAiCommands } from "../src/commands/ai";
import { cliHarness } from "./fixtures/ai-cli-harness";
import { serviceCatalog } from "./fixtures/ai";

const cli = cliHarness(registerAiCommands);

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-embed-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

const RESPONSE = {
	object: "list",
	data: [
		{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
		{ object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
	],
	model: "local/qwen/qwen3-embedding-8b",
	usage: { prompt_tokens: 7, total_tokens: 7 },
	billed_halalas: 0.0042,
	request_id: "att_1",
};

function mockClient() {
	const mutate = vi.fn(async (_input: unknown) => RESPONSE);
	h.client = {
		aiGateway: {
			getServiceCatalog: { query: async () => serviceCatalog() },
			embeddingsCreate: { mutate },
		},
	};
	return mutate;
}

describe("tarout ai embed", () => {
	it("embeds each argument as one input with the Local model the catalog offers", async () => {
		const mutate = mockClient();

		await cli.run(["ai", "embed", "hello world", "مرحبا"]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({
			request: { model: "local/qwen/qwen3-embedding-8b", input: ["hello world", "مرحبا"] },
		});
		expect(JSON.parse(cli.state.stdout.join(""))).toMatchObject({ model: RESPONSE.model });
		expect(cli.err()).toContain("2 inputs embedded with local/qwen/qwen3-embedding-8b (3 dimensions), 7 tokens, billed 0.000042 SAR");
	});

	it("reads --file lines, sends --dimensions, --key and --region global, and writes --out", async () => {
		const mutate = mockClient();
		const lines = join(dir, "lines.txt");
		const out = join(dir, "vectors.json");
		await writeFile(lines, "first\n\nsecond\n");

		await cli.run([
			"ai",
			"embed",
			"--file",
			lines,
			"--dimensions",
			"256",
			"-k",
			"key_1",
			"-r",
			"global",
			"-o",
			out,
		]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({
			keyId: "key_1",
			request: { model: "qwen/qwen3-embedding-8b", input: ["first", "second"], dimensions: 256 },
		});
		expect(JSON.parse(await readFile(out, "utf8")).data).toHaveLength(2);
		expect(cli.out()).toContain(`Wrote ${out}`);
	});

	it("sends a single input as a string and an explicit --model as given", async () => {
		const mutate = mockClient();

		await cli.run(["ai", "embed", "one", "-m", "openai/text-embedding-3-small"]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({
			request: { model: "openai/text-embedding-3-small", input: "one" },
		});
	});

	it("refuses an empty request before calling the platform", async () => {
		const mutate = mockClient();

		await cli.run(["ai", "embed"]);

		expect(cli.state.exitCodes).toEqual([2]);
		expect(cli.err()).toContain("Nothing to embed");
		expect(mutate).not.toHaveBeenCalled();
	});

	it("--json prints the platform response in the envelope", async () => {
		mockClient();

		await cli.run(["ai", "embed", "x"], { json: true });

		const envelope = JSON.parse(cli.out());
		expect(envelope.data.billed_halalas).toBe(0.0042);
	});
});
