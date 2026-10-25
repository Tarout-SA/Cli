import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { parseBatchEndpoint } from "../src/commands/ai-batches";
import { cliHarness } from "./fixtures/ai-cli-harness";
import { fileObject, SIGNED_UPLOAD, stubFetch } from "./fixtures/ai";

const cli = cliHarness(registerAiCommands);

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-batches-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
	h.confirm.mockReset();
});

function batch(status: string, extra: Record<string, unknown> = {}) {
	return {
		id: "batch_abc",
		object: "batch",
		endpoint: "/v1/embeddings",
		errors: null,
		input_file_id: SIGNED_UPLOAD.file_id,
		completion_window: "24h",
		status,
		output_file_id: null,
		error_file_id: null,
		created_at: 1_800_000_000,
		expires_at: 1_800_086_400,
		completed_at: null,
		request_counts: { total: 3, completed: status === "completed" ? 2 : 0, failed: status === "completed" ? 1 : 0 },
		metadata: {},
		...extra,
	};
}

function mockClient(states: string[] = []) {
	const done = { output_file_id: "file-OuTpUt0123456789AbCdEfGh", error_file_id: "file-ErRoRs0123456789AbCdEfGh" };
	const api = {
		filesCreateUpload: { mutate: vi.fn(async (_input: unknown) => SIGNED_UPLOAD) },
		filesCompleteUpload: { mutate: vi.fn(async () => fileObject(SIGNED_UPLOAD.file_id, "batch")) },
		batchesCreate: { mutate: vi.fn(async (_input: unknown) => batch("validating")) },
		batchesRetrieve: {
			query: vi.fn(async (_input: unknown) => {
				const status = states.shift() ?? "completed";
				return batch(status, status === "completed" ? done : {});
			}),
		},
		batchesList: { query: vi.fn(async () => ({ object: "list", data: [batch("in_progress")], has_more: false })) },
		batchesCancel: { mutate: vi.fn(async () => batch("cancelling")) },
		filesContentUrl: {
			query: vi.fn(async (input: any) => ({
				url: `https://storage.test/${input.fileId}?X-Goog-Signature=abc`,
				expires_at: 1_900_000_000,
				filename: `${input.fileId}.jsonl`,
			})),
		},
	};
	h.client = { aiGateway: api };
	return api;
}

describe("parseBatchEndpoint", () => {
	it("accepts the short and full forms of the five endpoints", () => {
		expect(parseBatchEndpoint("embeddings")).toBe("/v1/embeddings");
		expect(parseBatchEndpoint("/chat/completions")).toBe("/v1/chat/completions");
		expect(parseBatchEndpoint("/v1/images/generations")).toBe("/v1/images/generations");
		expect(() => parseBatchEndpoint("/v1/audio/speech")).toThrow(/Unknown --endpoint/);
	});
});

describe("tarout ai batches", () => {
	it("create uploads the JSONL with purpose batch and starts the batch", async () => {
		stubFetch();
		const api = mockClient();
		const path = join(dir, "lines.jsonl");
		await writeFile(path, '{"custom_id":"1","method":"POST","url":"/v1/embeddings","body":{}}\n');

		await cli.run(["ai", "batches", "create", path, "-e", "embeddings", "--metadata", "job=nightly"]);

		expect(api.filesCreateUpload.mutate.mock.calls[0]?.[0]).toMatchObject({
			purpose: "batch",
			contentType: "application/jsonl",
		});
		expect(api.batchesCreate.mutate.mock.calls[0]?.[0]).toEqual({
			inputFileId: SIGNED_UPLOAD.file_id,
			endpoint: "/v1/embeddings",
			completionWindow: "24h",
			metadata: { job: "nightly" },
		});
		expect(cli.out()).toContain("tarout ai batches get batch_abc");
	});

	it("create takes an uploaded file id as is and --wait polls to the end", async () => {
		const api = mockClient(["in_progress", "completed"]);

		await cli.run(["ai", "batches", "create", SIGNED_UPLOAD.file_id, "-e", "/v1/embeddings", "--wait"]);

		expect(api.filesCreateUpload.mutate).not.toHaveBeenCalled();
		expect(api.batchesRetrieve.query).toHaveBeenCalledTimes(2);
		expect(cli.state.sleeps).toEqual([15000]);
		expect(cli.out()).toContain("2 done, 1 failed of 3");
		expect(cli.out()).toContain("tarout ai batches results batch_abc");
	});

	it("results saves the output file, and the error file with --errors", async () => {
		const { calls } = stubFetch({ downloadBody: '{"custom_id":"1"}\n' });
		mockClient(["completed"]);
		const out = join(dir, "results.jsonl");
		const errors = join(dir, "errors.jsonl");

		await cli.run(["ai", "batches", "results", "batch_abc", "-o", out, "--errors", errors]);

		expect(calls).toHaveLength(2);
		expect(await readFile(out, "utf8")).toContain("custom_id");
		expect(await readFile(errors, "utf8")).toContain("custom_id");
		expect(cli.out()).not.toContain("X-Goog-Signature");
	});

	it("results on a running batch says it is not finished", async () => {
		mockClient(["in_progress"]);

		await cli.run(["ai", "batches", "results", "batch_abc", "-o", join(dir, "x.jsonl")]);

		expect(cli.state.exitCodes).toEqual([1]);
		expect(cli.err()).toContain("still in_progress");
	});

	it("cancel confirms first unless --yes", async () => {
		const api = mockClient();
		h.confirm.mockResolvedValue(false);

		await cli.run(["ai", "batches", "cancel", "batch_abc"]);
		expect(String(h.confirm.mock.calls[0]?.[0])).toContain("not charged");
		expect(api.batchesCancel.mutate).not.toHaveBeenCalled();

		await cli.run(["ai", "batches", "cancel", "batch_abc"], { yes: true });
		expect(api.batchesCancel.mutate.mock.calls[0]?.[0]).toEqual({ batchId: "batch_abc" });
	});
});
