import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	contentTypeFor,
	downloadToFile,
	isAiFileId,
	parseUploadPurpose,
	uploadAiFile,
} from "../src/lib/ai-files";
import { fileObject, SIGNED_UPLOAD, stubFetch } from "./fixtures/ai";

/**
 * The signed-upload flow every AI command and MCP tool uses: tRPC carries no
 * bytes (4 MB cap), so the file goes straight to storage with the URL and
 * headers filesCreateUpload signed, then filesCompleteUpload checks it.
 */

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-files-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function uploadClient() {
	const createUpload = vi.fn(async (_input: unknown) => SIGNED_UPLOAD);
	const completeUpload = vi.fn(async (_input: unknown) => fileObject());
	return {
		client: {
			aiGateway: {
				filesCreateUpload: { mutate: createUpload },
				filesCompleteUpload: { mutate: completeUpload },
			},
		},
		createUpload,
		completeUpload,
	};
}

describe("uploadAiFile", () => {
	it("creates the upload, PUTs the exact bytes with the signed headers, then completes it", async () => {
		const path = join(dir, "clip.mp3");
		await writeFile(path, "audio");
		const { calls } = stubFetch();
		const { client, createUpload, completeUpload } = uploadClient();

		const file = await uploadAiFile(client, path, "user_data", { expiresAfterSeconds: 3600 });

		expect(createUpload.mock.calls[0]?.[0]).toEqual({
			filename: "clip.mp3",
			bytes: 5,
			contentType: "audio/mpeg",
			purpose: "user_data",
			expiresAfterSeconds: 3600,
		});
		expect(calls).toEqual([
			{
				url: SIGNED_UPLOAD.upload_url,
				method: "PUT",
				headers: { "Content-Type": "audio/mpeg" },
				bodyBytes: 5,
			},
		]);
		expect(completeUpload.mock.calls[0]?.[0]).toEqual({ fileId: SIGNED_UPLOAD.file_id });
		expect(file.id).toBe(SIGNED_UPLOAD.file_id);
	});

	it("never completes a failed PUT and keeps the signed URL out of the error", async () => {
		const path = join(dir, "batch.jsonl");
		await writeFile(path, '{"custom_id":"1"}\n');
		stubFetch({ failWith: 403 });
		const { client, completeUpload } = uploadClient();

		const err = await uploadAiFile(client, path, "batch").catch((e) => e);

		expect(String(err.message)).toContain("HTTP 403");
		expect(String(err.message)).not.toContain("X-Goog-Signature");
		expect(completeUpload).not.toHaveBeenCalled();
	});

	it("completes the upload when the create-only PUT answers 412 (the bytes are already stored)", async () => {
		const path = join(dir, "notes.txt");
		await writeFile(path, "hello");
		stubFetch({ failWith: 412 });
		const { client, completeUpload } = uploadClient();

		const file = await uploadAiFile(client, path, "user_data");

		expect(completeUpload.mock.calls[0]?.[0]).toEqual({ fileId: SIGNED_UPLOAD.file_id });
		expect(file.id).toBe(SIGNED_UPLOAD.file_id);
	});

	it("refuses missing and empty files before calling the platform", async () => {
		const empty = join(dir, "empty.txt");
		await writeFile(empty, "");
		const { client, createUpload } = uploadClient();
		await expect(uploadAiFile(client, join(dir, "missing.pdf"), "assistants")).rejects.toThrow(/not found/);
		await expect(uploadAiFile(client, empty, "assistants")).rejects.toThrow(/empty/);
		expect(createUpload).not.toHaveBeenCalled();
	});
});

describe("downloadToFile", () => {
	it("streams the URL to the path, creating its folder", async () => {
		stubFetch({ downloadBody: "ID3-audio" });
		const path = join(dir, "nested", "out.mp3");
		expect(await downloadToFile("https://storage.test/get?sig=1", path)).toBe(9);
		expect(await readFile(path, "utf8")).toBe("ID3-audio");
		expect(existsSync(`${path}.part`)).toBe(false);
	});

	it("fails on an expired link without writing anything or naming the URL", async () => {
		stubFetch({ failWith: 400 });
		const path = join(dir, "expired.mp4");
		const err = await downloadToFile("https://storage.test/get?X-Goog-Signature=secret", path).catch((e) => e);
		expect(String(err.message)).toContain("HTTP 400");
		expect(String(err.message)).not.toContain("secret");
		expect(existsSync(path)).toBe(false);
	});
});

describe("file helpers", () => {
	it("knows file ids, purposes and content types", () => {
		expect(isAiFileId(SIGNED_UPLOAD.file_id)).toBe(true);
		expect(isAiFileId("./notes.pdf")).toBe(false);
		expect(parseUploadPurpose("batch")).toBe("batch");
		expect(() => parseUploadPurpose("batch_output")).toThrow(/Unknown --purpose/);
		expect(contentTypeFor("data/lines.JSONL")).toBe("application/jsonl");
		expect(contentTypeFor("report.docx")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(contentTypeFor("blob.bin")).toBe("application/octet-stream");
	});
});
