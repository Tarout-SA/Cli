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
import { cliHarness } from "./fixtures/ai-cli-harness";
import { fileObject, SIGNED_UPLOAD, stubFetch } from "./fixtures/ai";

const cli = cliHarness(registerAiCommands);

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-files-cmd-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
	h.confirm.mockReset();
});

function mockClient() {
	const client = {
		aiGateway: {
			filesCreateUpload: { mutate: vi.fn(async (_input: unknown) => SIGNED_UPLOAD) },
			filesCompleteUpload: { mutate: vi.fn(async (_input: unknown) => fileObject(SIGNED_UPLOAD.file_id, "assistants")) },
			filesList: {
				query: vi.fn(async (_input: unknown) => ({
					object: "list",
					data: [fileObject(), fileObject("file-ZyXwVuTsRqPoNmLkJiHgFeDc", "batch")],
					has_more: false,
				})),
			},
			filesRetrieve: { query: vi.fn(async (_input: unknown) => fileObject()) },
			filesDelete: { mutate: vi.fn(async (input: any) => ({ id: input.fileId, object: "file", deleted: true })) },
			filesContentUrl: {
				query: vi.fn(async (_input: unknown) => ({
					url: "https://storage.test/f?X-Goog-Signature=abc",
					expires_at: 1_900_000_000,
					filename: "clip.mp3",
				})),
			},
		},
	};
	h.client = client;
	return client.aiGateway;
}

describe("tarout ai files", () => {
	it("upload sends the purpose and expiry and prints the new id in quiet mode", async () => {
		stubFetch();
		const api = mockClient();
		const path = join(dir, "handbook.pdf");
		await writeFile(path, "%PDF-1.4");

		await cli.run(["ai", "files", "upload", path, "-p", "assistants", "--expires-after", "86400"], {
			quiet: true,
		});

		expect(api.filesCreateUpload.mutate.mock.calls[0]?.[0]).toEqual({
			filename: "handbook.pdf",
			bytes: 8,
			contentType: "application/pdf",
			purpose: "assistants",
			expiresAfterSeconds: 86400,
		});
		expect(cli.state.stdout).toEqual([SIGNED_UPLOAD.file_id]);
	});

	it("upload refuses a purpose callers cannot use", async () => {
		const api = mockClient();

		await cli.run(["ai", "files", "upload", "x.jsonl", "-p", "batch_output"]);

		expect(cli.state.exitCodes).toEqual([2]);
		expect(api.filesCreateUpload.mutate).not.toHaveBeenCalled();
	});

	it("list asks for newest first with the purpose filter and shows every file", async () => {
		const api = mockClient();

		await cli.run(["ai", "files", "list", "-p", "batch", "-n", "50"]);

		expect(api.filesList.query.mock.calls[0]?.[0]).toEqual({ purpose: "batch", limit: 50, order: "desc" });
		expect(cli.out()).toContain(SIGNED_UPLOAD.file_id);
		expect(cli.out()).toContain("file-ZyXwVuTsRqPoNmLkJiHgFeDc");
	});

	it("rm asks first and deletes nothing when declined", async () => {
		const api = mockClient();
		h.confirm.mockResolvedValue(false);

		await cli.run(["ai", "files", "rm", SIGNED_UPLOAD.file_id]);

		expect(String(h.confirm.mock.calls[0]?.[0])).toContain("removed from every vector store");
		expect(h.confirm.mock.calls[0]?.[2]).toMatchObject({ flag: "--yes" });
		expect(api.filesDelete.mutate).not.toHaveBeenCalled();
		expect(cli.out()).toContain("Cancelled.");
	});

	it("rm --yes deletes without asking", async () => {
		const api = mockClient();

		await cli.run(["ai", "files", "rm", SIGNED_UPLOAD.file_id], { yes: true });

		expect(h.confirm).not.toHaveBeenCalled();
		expect(api.filesDelete.mutate.mock.calls[0]?.[0]).toEqual({ fileId: SIGNED_UPLOAD.file_id });
	});

	it("download saves the contents to -o", async () => {
		stubFetch({ downloadBody: "contents" });
		const api = mockClient();
		const out = join(dir, "copy.mp3");

		await cli.run(["ai", "files", "download", SIGNED_UPLOAD.file_id, "-o", out]);

		expect(api.filesContentUrl.query.mock.calls[0]?.[0]).toEqual({ fileId: SIGNED_UPLOAD.file_id });
		expect(await readFile(out, "utf8")).toBe("contents");
		expect(cli.out()).not.toContain("X-Goog-Signature");
	});
});
