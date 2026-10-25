import { describe, expect, it, vi } from "vitest";
import {
	formatPricing,
	formatUsd,
	isCallableModel,
	isPriced,
	parseAiKind,
	parseAiRegion,
	pickModel,
	regionLabel,
} from "../src/lib/ai-catalog";
import { CliError } from "../src/lib/errors";
import { serviceCatalog } from "./fixtures/ai";

function clientWith(catalog: unknown) {
	const query = vi.fn(async () => catalog);
	return { client: { aiGateway: { getServiceCatalog: { query } } }, query };
}

describe("pickModel", () => {
	it("picks the first callable model of the kind in the region, from the catalog", async () => {
		const { client } = clientWith(serviceCatalog());
		expect((await pickModel(client, "embedding", "local")).id).toBe("local/qwen/qwen3-embedding-8b");
		expect((await pickModel(client, "embedding", "global")).id).toBe("qwen/qwen3-embedding-8b");
		expect((await pickModel(client, "chat", "local")).id).toBe("local/qwen/qwen3.8-flash-next");
	});

	it("skips unpriced models and families closed in the region", async () => {
		const catalog = serviceCatalog({ closed: [["embeddings", "local"]] });
		const { client } = clientWith(catalog);
		await expect(pickModel(client, "embedding", "local")).rejects.toThrow(/Try --region global/);
		const unpriced = catalog.models.find((model) => model.id === "local/deepseek-ai/deepseek-v4.1-flash");
		expect(unpriced && isCallableModel(unpriced, catalog)).toBe(false);
	});

	it("says the service is not open when no region has it (the launch gate lists chat only)", async () => {
		const { client } = clientWith({
			families: [{ family: "chat", enabled: { local: true, global: true } }],
			models: serviceCatalog().models.filter((model) => model.kind === "chat"),
		});
		const err = await pickModel(client, "speech", "local").catch((e) => e);
		expect(err).toBeInstanceOf(CliError);
		expect(err.message).toContain("Text to speech is not available in the Local region");
		expect(err.message).toContain("tarout ai status");
	});

	it("passes an explicit model through and returns its catalog entry when listed", async () => {
		const { client } = clientWith(serviceCatalog());
		const picked = await pickModel(client, "speech", "local", "tarout-tts");
		expect(picked.id).toBe("tarout-tts");
		expect(picked.model?.limits.kind).toBe("speech");
		const alias = await pickModel(client, "chat", "global", "local/qwen3.8-flash");
		expect(alias.model?.id).toBe("local/qwen/qwen3.8-flash-next");
	});

	it("keeps an explicit model when the catalog cannot be read", async () => {
		const client = {
			aiGateway: { getServiceCatalog: { query: vi.fn(async () => Promise.reject(new Error("down"))) } },
		};
		expect(await pickModel(client, "image", "local", "custom-image")).toEqual({
			id: "custom-image",
			model: null,
		});
	});
});

describe("catalog helpers", () => {
	it("parses regions and kinds, refusing anything else", () => {
		expect(parseAiRegion(" Global ")).toBe("global");
		expect(() => parseAiRegion("saudi")).toThrow(/local \(in Saudi Arabia\) or global/);
		expect(parseAiKind("Speech")).toBe("speech");
		expect(() => parseAiKind("audio")).toThrow(/Unknown --kind/);
	});

	it("labels residency: local is Local, every other route is Global", () => {
		expect(regionLabel("local")).toBe("Local");
		expect(regionLabel("saudi")).toBe("Global");
		expect(regionLabel("global")).toBe("Global");
	});

	it("treats a usage price as priced only through its ceiling", () => {
		expect(isPriced({ unit: "usage", ceiling: { unit: "characters", per1M: 1 } })).toBe(true);
		expect(isPriced({ unit: "usage", ceiling: { unit: "characters", per1M: null } })).toBe(false);
		expect(isPriced({ unit: "images", perImage: { "1024x1024": 1, "1328x1328": null } })).toBe(false);
		expect(isPriced({ unit: "images", perImage: {} })).toBe(false);
	});

	it("formats each unit, with small prices kept readable", () => {
		expect(formatUsd(2.1)).toBe("$2.10");
		expect(formatUsd(0.0004)).toBe("$0.0004");
		expect(formatUsd(null)).toBe("-");
		expect(formatPricing({ unit: "tokens", inputPer1M: 0.35, outputPer1M: 1.13 })).toBe(
			"$0.35 in / $1.13 out per 1M tokens",
		);
		expect(formatPricing({ unit: "audio_minutes", perMinute: 0.01 })).toBe("$0.01 per audio minute");
		expect(formatPricing({ unit: "images", perImage: { a: 0.04, b: 0.03 } })).toBe("from $0.03 per image");
		expect(
			formatPricing({ unit: "usage", ceiling: { unit: "input_tokens", inputPer1M: 0.01 } }),
		).toBe("up to $0.01 per 1M tokens");
		expect(formatPricing({ unit: "searches", per1K: null })).toBe("-");
	});
});
