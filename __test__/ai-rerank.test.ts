import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-rerank-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function mockClient() {
	const mutate = vi.fn(async (_input: unknown) => ({
		id: "rr_1",
		model: "local/qwen/qwen3-reranker-4b",
		object: "list",
		results: [
			{ index: 1, relevance_score: 0.91 },
			{ index: 0, relevance_score: 0.12 },
		],
		usage: { total_tokens: 40 },
		billed_halalas: 0.01,
		request_id: "att_2",
	}));
	h.client = {
		aiGateway: {
			getServiceCatalog: { query: async () => serviceCatalog() },
			rerankCreate: { mutate },
		},
	};
	return mutate;
}

describe("tarout ai rerank", () => {
	it("sends the query and --doc documents and prints them most relevant first", async () => {
		const mutate = mockClient();

		await cli.run([
			"ai",
			"rerank",
			"capital of Saudi Arabia",
			"--doc",
			"Jeddah is on the Red Sea",
			"--doc",
			"Riyadh is the capital",
			"--top",
			"2",
		]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({
			request: {
				model: "local/qwen/qwen3-reranker-4b",
				query: "capital of Saudi Arabia",
				documents: ["Jeddah is on the Red Sea", "Riyadh is the capital"],
				top_n: 2,
				return_documents: false,
			},
		});
		const out = cli.out();
		expect(out.indexOf("Riyadh is the capital")).toBeLessThan(out.indexOf("Jeddah"));
		expect(out).toContain("0.9100");
	});

	it("reads --docs as lines, or as a JSON array for a .json file", async () => {
		const mutate = mockClient();
		const lines = join(dir, "docs.txt");
		const json = join(dir, "docs.json");
		await writeFile(lines, "one\ntwo\n\n");
		await writeFile(json, JSON.stringify(["three", "four"]));

		await cli.run(["ai", "rerank", "q", "--docs", lines]);
		await cli.run(["ai", "rerank", "q", "--docs", json]);

		expect((mutate.mock.calls[0]?.[0] as any).request.documents).toEqual(["one", "two"]);
		expect((mutate.mock.calls[1]?.[0] as any).request.documents).toEqual(["three", "four"]);
	});

	it("--quiet prints the ranked document indexes", async () => {
		mockClient();

		await cli.run(["ai", "rerank", "q", "--doc", "a", "--doc", "b"], { quiet: true });

		expect(cli.state.stdout).toEqual(["1", "0"]);
	});

	it("refuses a request without documents", async () => {
		const mutate = mockClient();

		await cli.run(["ai", "rerank", "q"]);

		expect(cli.state.exitCodes).toEqual([2]);
		expect(mutate).not.toHaveBeenCalled();
	});
});
