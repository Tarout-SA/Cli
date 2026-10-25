import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ client: {} as any, spawn: vi.fn(), exec: vi.fn() }));

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
// Playback guard: nothing in `ai speak` may start a process (a player).
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: h.spawn,
	exec: h.exec,
}));

import { registerAiCommands } from "../src/commands/ai";
import { cliHarness } from "./fixtures/ai-cli-harness";
import { serviceCatalog, stubFetch } from "./fixtures/ai";

const cli = cliHarness(registerAiCommands);

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-speak-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
	expect(h.spawn).not.toHaveBeenCalled();
	expect(h.exec).not.toHaveBeenCalled();
});

function mockClient() {
	const mutate = vi.fn(async (input: any) => ({
		audio_url: "https://storage.test/speech.mp3?X-Goog-Signature=abc",
		expires_at: 1_900_000_000,
		content_type: "audio/wav",
		response_format: input.request.response_format ?? "mp3",
		bytes: 9,
		characters: input.request.input.length,
		model: input.request.model,
		billed_halalas: 2,
		request_id: "att_4",
	}));
	h.client = {
		aiGateway: {
			getServiceCatalog: { query: async () => serviceCatalog() },
			audioSpeechCreate: { mutate },
		},
	};
	return mutate;
}

describe("tarout ai speak", () => {
	it("writes the audio to --out, with the catalog's first voice and the format from the extension", async () => {
		stubFetch({ downloadBody: "RIFF-wave" });
		const mutate = mockClient();
		const out = join(dir, "hello.wav");

		await cli.run(["ai", "speak", "أهلا وسهلا", "-o", out]);

		expect(mutate.mock.calls[0]?.[0]).toEqual({
			request: { model: "tarout-tts", input: "أهلا وسهلا", voice: "sau", response_format: "wav" },
		});
		expect(await readFile(out, "utf8")).toBe("RIFF-wave");
		expect(cli.out()).toContain(`Wrote ${out}`);
		expect(cli.out()).not.toContain("X-Goog-Signature");
		expect(cli.err()).toContain("characters spoken with tarout-tts, billed 0.02 SAR");
	});

	it("passes --voice (OpenAI names are mapped by the server), --speed and --format", async () => {
		stubFetch();
		const mutate = mockClient();

		await cli.run([
			"ai",
			"speak",
			"hi",
			"-o",
			join(dir, "hi.audio"),
			"--voice",
			"alloy",
			"--speed",
			"1.25",
			"-f",
			"opus",
		]);

		expect((mutate.mock.calls[0]?.[0] as any).request).toEqual({
			model: "tarout-tts",
			input: "hi",
			voice: "alloy",
			response_format: "opus",
			speed: 1.25,
		});
	});

	it("requires --out: audio only ever goes to a file", async () => {
		const mutate = mockClient();

		await cli.run(["ai", "speak", "hi"]);

		expect(cli.state.exitCodes[0]).toBe(1);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("refuses text longer than the model takes, before any charge", async () => {
		const mutate = mockClient();
		const out = join(dir, "long.mp3");

		await cli.run(["ai", "speak", "x".repeat(4097), "-o", out]);

		expect(cli.state.exitCodes).toEqual([2]);
		expect(cli.err()).toContain("at most 4096");
		expect(mutate).not.toHaveBeenCalled();
		expect(existsSync(out)).toBe(false);
	});
});
