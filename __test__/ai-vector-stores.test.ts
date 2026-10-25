import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ client: {} as any, confirm: vi.fn() }));

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
vi.mock("../src/utils/prompts.js", () => ({ confirm: h.confirm, input: vi.fn() }));

import { registerAiCommands } from "../src/commands/ai";
import { cliHarness } from "./fixtures/ai-cli-harness";
import { fileObject, SIGNED_UPLOAD, stubFetch } from "./fixtures/ai";

const cli = cliHarness(registerAiCommands);

const UPLOADED_ID = SIGNED_UPLOAD.file_id;
const EXISTING_ID = "file-ExIsTiNg0123456789AbCdEf";

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-vs-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
	h.confirm.mockReset();
});

function store(extra: Record<string, unknown> = {}) {
	return {
		id: "vs_123",
		object: "vector_store",
		created_at: 1_800_000_000,
		name: "handbook",
		description: null,
		usage_bytes: 2048,
		file_counts: { in_progress: 0, completed: 2, failed: 0, cancelled: 0, total: 2 },
		status: "completed",
		expires_after: null,
		expires_at: null,
		last_active_at: 1_800_000_000,
		metadata: {},
		region: "local",
		...extra,
	};
}

function storeFile(id: string, status: string, lastError: unknown = null) {
	return {
		id,
		object: "vector_store.file",
		usage_bytes: 100,
		created_at: 1_800_000_000,
		vector_store_id: "vs_123",
		status,
		last_error: lastError,
		attributes: {},
		region: "local",
	};
}

function mockClient(listRounds: Array<Array<ReturnType<typeof storeFile>>> = []) {
	const api = {
		filesCreateUpload: { mutate: vi.fn(async () => SIGNED_UPLOAD) },
		filesCompleteUpload: { mutate: vi.fn(async () => fileObject(UPLOADED_ID, "assistants")) },
		vectorStoresCreate: { mutate: vi.fn(async (_input: unknown) => store()) },
		vectorStoresRetrieve: { query: vi.fn(async () => store()) },
		vectorStoresList: { query: vi.fn(async () => ({ object: "list", data: [store()], has_more: false })) },
		vectorStoresDelete: { mutate: vi.fn(async (input: any) => ({ id: input.vectorStoreId, deleted: true })) },
		vectorStoreFilesAdd: {
			mutate: vi.fn(async (input: any) => storeFile(input.fileId, "in_progress")),
		},
		vectorStoreFilesList: {
			query: vi.fn(async (_input: unknown) => ({
				object: "list",
				data: listRounds.shift() ?? [],
				has_more: false,
				last_id: null,
			})),
		},
		vectorStoresSearch: {
			mutate: vi.fn(async (_input: unknown) => ({
				object: "vector_store.search_results.page",
				search_query: "leave policy",
				data: [
					{
						file_id: UPLOADED_ID,
						filename: "handbook.pdf",
						score: 0.873,
						attributes: {},
						content: [{ type: "text", text: "Annual leave is 30 days." }],
					},
				],
				has_more: false,
				next_page: null,
				region: "local",
				billed_halalas: 0.3,
				request_id: "vss_1",
			})),
		},
	};
	h.client = { aiGateway: api };
	return api;
}

describe("tarout ai vector-stores", () => {
	it("create sends the name and region and shows the store's region", async () => {
		const api = mockClient();

		await cli.run(["ai", "vector-stores", "create", "handbook", "-r", "global", "--expires-after-days", "30"]);

		expect(api.vectorStoresCreate.mutate.mock.calls[0]?.[0]).toEqual({
			name: "handbook",
			region: "global",
			expiresAfterDays: 30,
		});
		expect(cli.out()).toContain("Region: Local");
	});

	it("add uploads local paths, attaches them with existing file ids, and --wait polls until indexed", async () => {
		stubFetch();
		const api = mockClient([
			[storeFile(UPLOADED_ID, "in_progress"), storeFile(EXISTING_ID, "completed")],
			[storeFile(UPLOADED_ID, "completed"), storeFile(EXISTING_ID, "completed")],
		]);
		const path = join(dir, "handbook.pdf");
		await writeFile(path, "%PDF-1.4");

		await cli.run(["ai", "vs", "add", "vs_123", path, EXISTING_ID, "--wait", "-k", "key_1"]);

		expect(api.filesCreateUpload.mutate.mock.calls[0]?.[0]).toMatchObject({ purpose: "assistants" });
		expect(api.vectorStoreFilesAdd.mutate.mock.calls.map((call) => call[0])).toEqual([
			{ keyId: "key_1", vectorStoreId: "vs_123", fileId: UPLOADED_ID },
			{ keyId: "key_1", vectorStoreId: "vs_123", fileId: EXISTING_ID },
		]);
		expect(api.vectorStoreFilesList.query).toHaveBeenCalledTimes(2);
		expect(cli.state.sleeps).toEqual([3000]);
		expect(cli.state.exitCodes).toEqual([]);
	});

	it("add exits non-zero when a file fails to index, with its error", async () => {
		mockClient([[storeFile(EXISTING_ID, "failed", { code: "unsupported_file", message: "This file type is not supported." })]]);

		await cli.run(["ai", "vector-stores", "add", "vs_123", EXISTING_ID, "--wait"]);

		expect(cli.state.exitCodes).toEqual([1]);
		expect(cli.out()).toContain("This file type is not supported.");
		expect(cli.err()).toContain("Failed indexing is not charged");
	});

	it("search sends max, threshold and rewrite in the procedure's shape", async () => {
		const api = mockClient();

		await cli.run([
			"ai",
			"vector-stores",
			"search",
			"vs_123",
			"leave policy",
			"--max",
			"5",
			"--threshold",
			"0.4",
			"--rewrite",
		]);

		expect(api.vectorStoresSearch.mutate.mock.calls[0]?.[0]).toEqual({
			vectorStoreId: "vs_123",
			query: "leave policy",
			maxNumResults: 5,
			rewriteQuery: true,
			rankingOptions: { score_threshold: 0.4 },
		});
		expect(cli.out()).toContain("Annual leave is 30 days.");
		expect(cli.err()).toContain("1 result, billed 0.0030 SAR");
	});

	it("search refuses a threshold outside 0 to 1", async () => {
		const api = mockClient();

		await cli.run(["ai", "vector-stores", "search", "vs_123", "q", "--threshold", "2"]);

		expect(cli.state.exitCodes).toEqual([2]);
		expect(api.vectorStoresSearch.mutate).not.toHaveBeenCalled();
	});

	it("rm confirms, and --yes skips the question", async () => {
		const api = mockClient();
		h.confirm.mockResolvedValue(false);

		await cli.run(["ai", "vector-stores", "rm", "vs_123"]);
		expect(String(h.confirm.mock.calls[0]?.[0])).toContain("uploaded files are kept");
		expect(api.vectorStoresDelete.mutate).not.toHaveBeenCalled();

		await cli.run(["ai", "vector-stores", "rm", "vs_123"], { yes: true });
		expect(api.vectorStoresDelete.mutate.mock.calls[0]?.[0]).toEqual({ vectorStoreId: "vs_123" });
	});
});
