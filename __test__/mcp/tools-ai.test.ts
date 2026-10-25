import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const h = vi.hoisted(() => ({ client: {} as any }));

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => h.client,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pollTiming } from "../../src/lib/ai-poll";
import { createMcpServer } from "../../src/mcp/server";
import { registerAiTools } from "../../src/mcp/tools/ai";
import { fileObject, SIGNED_UPLOAD, serviceCatalog, stubFetch } from "../fixtures/ai";

/** A Tarout-shaped signed URL: the result sanitizer would mangle it, so no tool may return one. */
const SIGNED_URL =
	"https://storage.googleapis.com/tarout-ai/tmp/media-images/Xk3pQ9rT2vW8yZ1aB4cD6eF7gH0jK5mN/a.mp3?X-Goog-Signature=abc";

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-mcp-ai-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
	vi.spyOn(pollTiming, "sleep").mockImplementation(async () => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function baseClient(extra: Record<string, unknown>) {
	h.client = {
		aiGateway: {
			getServiceCatalog: { query: vi.fn(async () => serviceCatalog()) },
			filesCreateUpload: { mutate: vi.fn(async (_input: unknown) => SIGNED_UPLOAD) },
			filesCompleteUpload: { mutate: vi.fn(async () => fileObject()) },
			filesDelete: { mutate: vi.fn(async (input: any) => ({ id: input.fileId, deleted: true })) },
			...extra,
		},
	};
	return h.client.aiGateway;
}

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerAiTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	const reg = (server as any)._registeredTools[name];
	const result = (await reg.handler(args)) as { content: [{ text: string }]; isError?: boolean };
	return { result, body: JSON.parse(result.content[0].text) };
}

describe("ai tools", () => {
	it("ai_embed returns dimensions and 8 values per vector; the full response only goes to outPath", async () => {
		const vector = Array.from({ length: 12 }, (_, i) => i / 10);
		const api = baseClient({
			embeddingsCreate: {
				mutate: vi.fn(async () => ({
					object: "list",
					data: [{ object: "embedding", index: 0, embedding: vector }],
					model: "local/qwen/qwen3-embedding-8b",
					usage: { prompt_tokens: 3, total_tokens: 3 },
					billed_halalas: 0.001,
					request_id: "att_1",
				})),
			},
		});
		const outPath = join(dir, "vectors.json");

		const { body } = await invoke("ai_embed", { input: "hello", outPath });

		expect(api.embeddingsCreate.mutate.mock.calls[0][0]).toEqual({
			request: { model: "local/qwen/qwen3-embedding-8b", input: "hello" },
		});
		expect(body.dimensions).toBe(12);
		expect(body.vectors[0].first8).toEqual(vector.slice(0, 8));
		expect(JSON.parse(await readFile(outPath, "utf8")).data[0].embedding).toEqual(vector);
	});

	it("ai_rerank maps results back to the caller's documents", async () => {
		baseClient({
			rerankCreate: {
				mutate: vi.fn(async () => ({
					model: "local/qwen/qwen3-reranker-4b",
					results: [{ index: 1, relevance_score: 0.8 }],
					billed_halalas: 0.01,
				})),
			},
		});

		const { body } = await invoke("ai_rerank", { query: "q", documents: ["a", "b"], region: "local" });

		expect(body.results).toEqual([{ index: 1, score: 0.8, document: "b" }]);
	});

	it("ai_transcribe uploads a local path, transcribes it by id and leaves the upload to expire", async () => {
		stubFetch();
		const api = baseClient({
			audioTranscriptionsCreate: {
				mutate: vi.fn(async () => ({ text: "مرحبا", billed_seconds: 3, billed_halalas: 0.1 })),
			},
		});
		const audio = join(dir, "a.mp3");
		await writeFile(audio, "audio");

		const { body } = await invoke("ai_transcribe", { path: audio, format: "json" });

		expect(api.audioTranscriptionsCreate.mutate.mock.calls[0][0].request).toMatchObject({
			model: "tarout-transcribe",
			response_format: "json",
			file: { type: "file_id", file_id: SIGNED_UPLOAD.file_id },
		});
		// A file delete waits for approval on operator-tier agent keys; the
		// one-hour expiry removes the upload instead.
		expect(api.filesDelete.mutate).not.toHaveBeenCalled();
		expect(body.text).toBe("مرحبا");
	});

	it("ai_transcribe wants exactly one of path or url", async () => {
		baseClient({});
		const { result } = await invoke("ai_transcribe", {});
		expect(result.isError).toBe(true);
	});

	it("ai_speak saves the audio to a local file and never returns the signed URL", async () => {
		stubFetch({ downloadBody: "ID3" });
		baseClient({
			audioSpeechCreate: {
				mutate: vi.fn(async () => ({
					audio_url: SIGNED_URL,
					expires_at: 1,
					content_type: "audio/mpeg",
					response_format: "mp3",
					bytes: 3,
					characters: 5,
					model: "tarout-tts",
					billed_halalas: 1,
				})),
			},
		});

		const { result, body } = await invoke("ai_speak", { text: "hello" });

		expect(result.content[0].text).not.toContain("X-Goog-Signature");
		expect(body.path).toMatch(/tarout-ai-.*speech\.mp3$/);
		expect(await readFile(body.path, "utf8")).toBe("ID3");
		await rm(body.path, { force: true });
	});

	it("ai_image_generate saves each image to outDir", async () => {
		stubFetch({ downloadBody: "PNG" });
		const api = baseClient({
			imagesGenerate: {
				mutate: vi.fn(async () => ({
					created: 1,
					data: [{ url: SIGNED_URL, expires_at: 1 }],
					size: "1328x1328",
					output_format: "png",
					model: "tarout-image",
					request_id: "att_7",
				})),
			},
		});
		const outDir = join(dir, "images");

		const { result, body } = await invoke("ai_image_generate", { prompt: "a falcon", outDir });

		expect(api.imagesGenerate.mutate.mock.calls[0][0]).toEqual({
			request: { model: "tarout-image", prompt: "a falcon" },
		});
		expect(body.files).toEqual([join(outDir, "att_7-1.png")]);
		expect(result.content[0].text).not.toContain("X-Goog-Signature");
	});

	it("ai_video_generate submits without waiting by default; ai_video_status saves a ready MP4", async () => {
		stubFetch({ downloadBody: "MP4" });
		const video = { id: "video_1", object: "video", model: "tarout-video", status: "queued", progress: 0, size: "1280x720", seconds: "5", error: null };
		const api = baseClient({
			videosCreate: { mutate: vi.fn(async () => video) },
			videosRetrieve: { query: vi.fn(async () => ({ ...video, status: "completed", progress: 100 })) },
			videosContentUrl: { query: vi.fn(async () => ({ url: SIGNED_URL, expires_at: 1 })) },
		});

		const created = await invoke("ai_video_generate", { prompt: "dunes" });
		expect(created.body.video.status).toBe("queued");
		expect(api.videosRetrieve.query).not.toHaveBeenCalled();

		const outPath = join(dir, "dunes.mp4");
		const status = await invoke("ai_video_status", { videoId: "video_1", outPath });
		expect(status.body.path).toBe(outPath);
		expect(await readFile(outPath, "utf8")).toBe("MP4");
		expect(status.result.content[0].text).not.toContain("X-Goog-Signature");
	});

	it("ai_files_upload, ai_files_list and ai_files_delete use the Files procedures", async () => {
		stubFetch();
		const api = baseClient({
			filesList: { query: vi.fn(async () => ({ data: [fileObject()], has_more: false })) },
		});
		const path = join(dir, "notes.md");
		await writeFile(path, "# notes");

		const uploaded = await invoke("ai_files_upload", { path, purpose: "assistants" });
		expect(api.filesCreateUpload.mutate.mock.calls[0][0]).toMatchObject({ purpose: "assistants", contentType: "text/markdown" });
		expect(uploaded.body.id).toBe(SIGNED_UPLOAD.file_id);

		const listed = await invoke("ai_files_list", { purpose: "assistants" });
		expect(api.filesList.query.mock.calls[0][0]).toEqual({ purpose: "assistants", limit: 100, order: "desc" });
		expect(listed.body.count).toBe(1);

		const deleted = await invoke("ai_files_delete", { fileId: SIGNED_UPLOAD.file_id });
		expect(deleted.body.deleted).toBe(true);
	});

	it("ai_vector_store_add_files uploads paths, attaches ids, and can wait for indexing", async () => {
		stubFetch();
		const existing = "file-ExIsTiNg0123456789AbCdEf";
		const api = baseClient({
			vectorStoreFilesAdd: { mutate: vi.fn(async (input: any) => ({ id: input.fileId, status: "in_progress" })) },
			vectorStoreFilesList: {
				query: vi.fn(async () => ({
					data: [
						{ id: existing, status: "completed" },
						{ id: SIGNED_UPLOAD.file_id, status: "completed" },
					],
					has_more: false,
				})),
			},
		});
		const path = join(dir, "policy.txt");
		await writeFile(path, "policy");

		const { body } = await invoke("ai_vector_store_add_files", {
			vectorStoreId: "vs_1",
			paths: [path],
			fileIds: [existing],
			wait: true,
		});

		expect(api.vectorStoreFilesAdd.mutate.mock.calls.map((call: any[]) => call[0].fileId)).toEqual([
			existing,
			SIGNED_UPLOAD.file_id,
		]);
		expect(body.files.every((file: { status: string }) => file.status === "completed")).toBe(true);
		expect(body.timedOut).toBe(false);
	});

	it("ai_vector_store_search sends the threshold as rankingOptions", async () => {
		const api = baseClient({
			vectorStoresSearch: { mutate: vi.fn(async () => ({ data: [], billed_halalas: 0 })) },
		});

		await invoke("ai_vector_store_search", { vectorStoreId: "vs_1", query: "leave", scoreThreshold: 0.5 });

		expect(api.vectorStoresSearch.mutate.mock.calls[0][0]).toEqual({
			vectorStoreId: "vs_1",
			query: "leave",
			rankingOptions: { score_threshold: 0.5 },
		});
	});

	it("ai_batch_create uploads a JSONL path; ai_batch_status saves the output once done", async () => {
		stubFetch({ downloadBody: '{"custom_id":"1"}\n' });
		const done = {
			id: "batch_1",
			status: "completed",
			output_file_id: "file-OuTpUt0123456789AbCdEfGh",
			error_file_id: null,
			request_counts: { total: 1, completed: 1, failed: 0 },
		};
		const api = baseClient({
			batchesCreate: { mutate: vi.fn(async () => ({ ...done, status: "validating", output_file_id: null })) },
			batchesRetrieve: { query: vi.fn(async () => done) },
			filesContentUrl: { query: vi.fn(async () => ({ url: SIGNED_URL, expires_at: 1, filename: "out.jsonl" })) },
		});
		const path = join(dir, "lines.jsonl");
		await writeFile(path, "{}\n");

		const created = await invoke("ai_batch_create", { path, endpoint: "/v1/embeddings" });
		expect(api.filesCreateUpload.mutate.mock.calls[0][0]).toMatchObject({ purpose: "batch" });
		expect(api.batchesCreate.mutate.mock.calls[0][0]).toEqual({
			inputFileId: SIGNED_UPLOAD.file_id,
			endpoint: "/v1/embeddings",
			completionWindow: "24h",
		});
		expect(created.body.batch.status).toBe("validating");

		const outPath = join(dir, "out.jsonl");
		const status = await invoke("ai_batch_status", { batchId: "batch_1", outPath });
		expect(status.body.saved.outPath).toBe(outPath);
		expect(existsSync(outPath)).toBe(true);
	});

	it("marks the deletes destructive and the file list read-only", () => {
		const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
		registerAiTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool internals.
		const tools = (server as any)._registeredTools;
		expect(tools.ai_files_delete.annotations).toEqual({ destructiveHint: true });
		expect(tools.ai_vector_store_delete.annotations).toEqual({ destructiveHint: true });
		expect(tools.ai_files_list.annotations).toEqual({ readOnlyHint: true });
		expect(Object.keys(tools).filter((name) => name.startsWith("ai_"))).toHaveLength(16);
	});

	it("the real server wires the AI tools, and a saved file's path survives the result sanitizer", async () => {
		stubFetch({ downloadBody: "ID3" });
		baseClient({
			audioSpeechCreate: {
				mutate: vi.fn(async () => ({
					audio_url: SIGNED_URL,
					response_format: "mp3",
					characters: 5,
					model: "tarout-tts",
				})),
			},
		});
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool internals.
		const tools = (createMcpServer() as any)._registeredTools;
		expect(tools.ai_embed).toBeDefined();
		expect(tools.ai_batch_status).toBeDefined();

		// The wrapped handler runs the sanitizer, as stdio does.
		const result = (await tools.ai_speak.handler({ text: "hello" })) as {
			content: [{ text: string }];
			structuredContent: { path: string };
		};
		const path = result.structuredContent.path;
		expect(path).not.toContain("redacted");
		expect(JSON.parse(result.content[0].text).path).toBe(path);
		expect(await readFile(path, "utf8")).toBe("ID3");
		await rm(path, { force: true });
	});
});
