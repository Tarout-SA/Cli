import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { serviceCatalog, stubFetch } from "./fixtures/ai";

const cli = cliHarness(registerAiCommands);

let dir: string;
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-video-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function job(status: string, extra: Record<string, unknown> = {}) {
	return {
		id: "video_abc123",
		object: "video",
		model: "tarout-video",
		status,
		progress: status === "completed" ? 100 : 40,
		created_at: 1_800_000_000,
		completed_at: null,
		expires_at: status === "completed" ? 1_800_086_400 : null,
		size: "1280x720",
		seconds: "5",
		quality: "standard",
		error: null,
		...extra,
	};
}

function mockClient(states: string[]) {
	const create = vi.fn(async (_input: unknown) => job("queued"));
	const retrieve = vi.fn(async (_input: unknown) => job(states.shift() ?? "completed"));
	const contentUrl = vi.fn(async (_input: unknown) => ({
		url: "https://storage.test/video.mp4?X-Goog-Signature=abc",
		expires_at: 1_800_003_600,
	}));
	h.client = {
		aiGateway: {
			getServiceCatalog: { query: async () => serviceCatalog() },
			videosCreate: { mutate: create },
			videosRetrieve: { query: retrieve },
			videosContentUrl: { query: contentUrl },
		},
	};
	return { create, retrieve, contentUrl };
}

describe("tarout ai video", () => {
	it('`ai video "<prompt>"` submits, polls until ready and saves the MP4 to -o', async () => {
		stubFetch({ downloadBody: "MP4" });
		const { create, retrieve } = mockClient(["in_progress", "completed"]);
		const out = join(dir, "clip.mp4");

		await cli.run(["ai", "video", "camels at sunset", "--seconds", "5", "-s", "1280x720", "-o", out, "-k", "key_9"]);

		expect(create.mock.calls[0]?.[0]).toEqual({
			keyId: "key_9",
			request: { model: "tarout-video", prompt: "camels at sunset", size: "1280x720", seconds: 5 },
		});
		expect(retrieve).toHaveBeenCalledTimes(2);
		expect(retrieve.mock.calls[0]?.[0]).toEqual({ keyId: "key_9", videoId: "video_abc123" });
		expect(cli.state.sleeps).toEqual([5000]);
		expect(await readFile(out, "utf8")).toBe("MP4");
		expect(cli.state.exitCodes).toEqual([]);
	});

	it("--no-wait returns the job id at once", async () => {
		const { retrieve } = mockClient([]);

		await cli.run(["ai", "video", "a quiet souq", "--no-wait"], { quiet: true });

		expect(cli.state.stdout).toEqual(["video_abc123"]);
		expect(retrieve).not.toHaveBeenCalled();
	});

	it("a failed job exits non-zero and says nothing was charged", async () => {
		mockClient(["failed"]);
		h.client.aiGateway.videosRetrieve.query = vi.fn(async () =>
			job("failed", { error: { code: "generation_failed", message: "The video could not be generated." } }),
		);

		await cli.run(["ai", "video", "x"]);

		expect(cli.state.exitCodes).toEqual([1]);
		expect(cli.err()).toContain("Nothing was charged");
	});

	it("stops at --timeout and points at `ai video status`", async () => {
		mockClient(["in_progress", "in_progress", "in_progress"]);

		await cli.run(["ai", "video", "x", "--timeout", "1"]);

		expect(cli.state.exitCodes).toEqual([1]);
		expect(cli.err()).toContain("tarout ai video status video_abc123");
	});

	it("`status <id>` and `download <id> -o` are subcommands that keep their own -k and -o", async () => {
		stubFetch({ downloadBody: "MP4" });
		const { retrieve, contentUrl } = mockClient(["completed"]);
		const out = join(dir, "later.mp4");

		await cli.run(["ai", "video", "status", "video_abc123", "-k", "key_2"]);
		expect(retrieve.mock.calls[0]?.[0]).toEqual({ keyId: "key_2", videoId: "video_abc123" });
		expect(cli.out()).toContain("Status: completed");

		await cli.run(["ai", "video", "download", "video_abc123", "-o", out]);
		expect(contentUrl.mock.calls[0]?.[0]).toEqual({ videoId: "video_abc123" });
		expect(await readFile(out, "utf8")).toBe("MP4");
		expect(cli.state.exitCodes).toEqual([]);
	});

	it("`download` without -o says where the file should go", async () => {
		const { contentUrl } = mockClient([]);

		await cli.run(["ai", "video", "download", "video_abc123"]);

		expect(cli.state.exitCodes).toEqual([2]);
		expect(cli.err()).toContain("Pass -o <file>");
		expect(contentUrl).not.toHaveBeenCalled();
	});

	it("refuses a length the catalog does not list", async () => {
		const { create } = mockClient([]);

		await cli.run(["ai", "video", "x", "--seconds", "7"]);

		expect(cli.state.exitCodes).toEqual([2]);
		expect(cli.err()).toContain("4, 5, 8 seconds");
		expect(create).not.toHaveBeenCalled();
	});
});
