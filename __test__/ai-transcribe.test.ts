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
import { fileObject, SIGNED_UPLOAD, serviceCatalog, stubFetch } from "./fixtures/ai";

/**
 * Audio is only ever uploaded and transcribed here: nothing is synthesized and
 * nothing is played, so no playback needs mocking.
 */

const cli = cliHarness(registerAiCommands);

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-transcribe-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function mockClient(result: unknown = { text: "السلام عليكم", billed_seconds: 12, billed_halalas: 0.5, request_id: "att_3" }) {
	const transcribe = vi.fn(async (_input: unknown) => result);
	const remove = vi.fn(async (_input: unknown) => ({ id: SIGNED_UPLOAD.file_id, deleted: true }));
	h.client = {
		aiGateway: {
			getServiceCatalog: { query: async () => serviceCatalog() },
			filesCreateUpload: { mutate: vi.fn(async () => SIGNED_UPLOAD) },
			filesCompleteUpload: { mutate: vi.fn(async () => fileObject()) },
			audioTranscriptionsCreate: { mutate: transcribe },
			filesDelete: { mutate: remove },
		},
	};
	return { transcribe, remove };
}

describe("tarout ai transcribe", () => {
	it("passes a URL straight to the API", async () => {
		const { transcribe } = mockClient();

		await cli.run(["ai", "transcribe", "https://example.com/talk.mp3", "-l", "ar"]);

		expect(transcribe.mock.calls[0]?.[0]).toEqual({
			request: {
				model: "tarout-transcribe",
				response_format: "text",
				language: "ar",
				file: { type: "url", url: "https://example.com/talk.mp3" },
			},
		});
		expect(cli.out()).toContain("السلام عليكم");
		expect(cli.err()).toContain("12 s of audio transcribed, billed 0.0050 SAR");
	});

	it("uploads a local file with a one-hour expiry, transcribes it by id, and leaves it to expire", async () => {
		const { calls } = stubFetch();
		const { transcribe, remove } = mockClient();
		const audio = join(dir, "clip.mp3");
		await writeFile(audio, "audio");

		await cli.run(["ai", "transcribe", audio]);

		expect(calls[0]?.method).toBe("PUT");
		expect((h.client.aiGateway.filesCreateUpload.mutate as any).mock.calls[0][0]).toMatchObject({
			purpose: "user_data",
			expiresAfterSeconds: 3600,
		});
		expect((transcribe.mock.calls[0]?.[0] as any).request.file).toEqual({
			type: "file_id",
			file_id: SIGNED_UPLOAD.file_id,
		});
		// A file delete waits for approval on operator-tier agent keys; the
		// one-hour expiry removes the upload instead.
		expect(remove).not.toHaveBeenCalled();
	});

	it("does not delete the upload when the transcription fails either", async () => {
		stubFetch();
		const { transcribe, remove } = mockClient();
		transcribe.mockRejectedValueOnce(Object.assign(new Error("Insufficient balance"), { data: { code: "PRECONDITION_FAILED" } }));
		const audio = join(dir, "fail.mp3");
		await writeFile(audio, "audio");

		await cli.run(["ai", "transcribe", audio]);

		expect(remove).not.toHaveBeenCalled();
		expect(cli.state.exitCodes).toEqual([2]);
	});

	it("refuses subtitles on Local before uploading anything, and sends them on Global", async () => {
		const { transcribe } = mockClient({ content: "1\n00:00:00,000 --> 00:00:01,000\nhi\n", content_type: "application/x-subrip" });

		await cli.run(["ai", "transcribe", "https://example.com/a.mp3", "-f", "srt"]);
		expect(cli.state.exitCodes).toEqual([2]);
		expect(cli.err()).toContain("tarout-transcribe answers json and text only");
		expect(transcribe).not.toHaveBeenCalled();

		const out = join(dir, "talk.srt");
		await cli.run(["ai", "transcribe", "https://example.com/a.mp3", "-f", "srt", "-r", "global", "-o", out]);
		expect((transcribe.mock.calls[0]?.[0] as any).request).toMatchObject({
			model: "tarout-transcribe-global",
			response_format: "srt",
		});
		expect(await readFile(out, "utf8")).toContain("00:00:00,000 --> 00:00:01,000");
	});
});
