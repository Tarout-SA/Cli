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
	dir = await mkdtemp(join(tmpdir(), "tarout-ai-image-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

function mockClient(outputFormat = "png") {
	const mutate = vi.fn(async (input: any) => ({
		created: 1_800_000_000,
		data: Array.from({ length: input.request.n ?? 1 }, (_, i) => ({
			url: `https://storage.test/img_${i}.png?X-Goog-Signature=abc`,
			expires_at: 1_800_003_600,
		})),
		size: input.request.size ?? "1328x1328",
		output_format: outputFormat,
		model: input.request.model,
		billed_halalas: 12,
		request_id: "att_5",
	}));
	h.client = {
		aiGateway: {
			getServiceCatalog: { query: async () => serviceCatalog() },
			imagesGenerate: { mutate },
		},
	};
	return mutate;
}

describe("tarout ai image", () => {
	it("generates with the Local model and saves every image to -o <dir>", async () => {
		const { calls } = stubFetch({ downloadBody: "PNG" });
		const mutate = mockClient();
		const out = join(dir, "shots");

		await cli.run(["ai", "image", "a falcon over Riyadh", "-n", "2", "-s", "1024x1024", "-o", out]);

		// No response_format: the procedure always answers URLs and refuses the field.
		expect(mutate.mock.calls[0]?.[0]).toEqual({
			request: { model: "tarout-image", prompt: "a falcon over Riyadh", size: "1024x1024", n: 2 },
		});
		expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
		expect(await readFile(join(out, "att_5-1.png"), "utf8")).toBe("PNG");
		expect(await readFile(join(out, "att_5-2.png"), "utf8")).toBe("PNG");
		expect(cli.err()).toContain("2 images at 1024x1024 from tarout-image, billed 0.12 SAR");
	});

	it("names files after the output format the platform reports", async () => {
		stubFetch();
		mockClient("jpeg");
		const out = join(dir, "jpeg");

		await cli.run(["ai", "image", "dunes", "-o", out]);

		expect(await readFile(join(out, "att_5-1.jpg"), "utf8")).toBe("bytes");
	});

	it("without -o prints the short-lived links and when they expire", async () => {
		mockClient();

		await cli.run(["ai", "image", "dunes"]);

		expect(cli.out()).toContain("https://storage.test/img_0.png");
		expect(cli.out()).toContain(`Links expire at ${new Date(1_800_003_600_000).toISOString()}`);
	});

	it("refuses a size or count the catalog says the model does not make", async () => {
		const mutate = mockClient();

		await cli.run(["ai", "image", "x", "-s", "800x600"]);
		await cli.run(["ai", "image", "x", "-n", "9"]);

		expect(cli.state.exitCodes).toEqual([2, 2]);
		expect(cli.err()).toContain("Sizes: 1328x1328, 1024x1024");
		expect(cli.err()).toContain("at most 4 images");
		expect(mutate).not.toHaveBeenCalled();
	});
});
