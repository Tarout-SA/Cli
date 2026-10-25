/**
 * Shared fixtures for the AI Gateway command and MCP tool specs: a service
 * catalog shaped like `aiGateway.getServiceCatalog`, and a fetch stub for the
 * signed upload and download URLs. The prices are made-up test numbers.
 */
import { vi } from "vitest";
import type { AiCatalogModel, AiServiceCatalog } from "../../src/lib/ai-catalog";

const ALL_FAMILIES = [
	"chat",
	"ocr",
	"embeddings",
	"rerank",
	"moderation",
	"transcription",
	"speech",
	"images",
	"video",
	"file_search",
];

function model(partial: Partial<AiCatalogModel> & Pick<AiCatalogModel, "id" | "kind" | "residency" | "pricing" | "limits">): AiCatalogModel {
	return {
		alias: null,
		name: partial.id,
		lab: null,
		description: "",
		route: partial.kind,
		providerStatus: "available",
		capabilities: {},
		...partial,
	};
}

export function serviceCatalog(overrides: { closed?: Array<[string, "local" | "global"]> } = {}): AiServiceCatalog {
	const closed = new Set((overrides.closed ?? []).map(([family, region]) => `${family}:${region}`));
	return {
		families: ALL_FAMILIES.map((family) => ({
			family,
			enabled: {
				local: !closed.has(`${family}:local`),
				global: family !== "video" && !closed.has(`${family}:global`),
			},
		})),
		models: [
			model({
				id: "local/qwen/qwen3.8-flash-next",
				alias: "local/qwen3.8-flash",
				name: "Qwen3.8 Flash",
				kind: "chat",
				residency: "local",
				route: "local",
				pricing: { unit: "tokens", inputPer1M: 0.35, outputPer1M: 1.13 },
				limits: { kind: "chat", contextWindow: 262_144 },
			}),
			model({
				id: "local/deepseek-ai/deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				kind: "chat",
				residency: "local",
				route: "local",
				pricing: { unit: "tokens", inputPer1M: null, outputPer1M: null },
				limits: { kind: "chat", contextWindow: 1_048_576 },
			}),
			model({
				id: "z-ai/glm-5.3",
				name: "GLM 5.3",
				kind: "chat",
				residency: "global",
				route: "global",
				pricing: { unit: "tokens", inputPer1M: 2.1, outputPer1M: 6.6 },
				limits: { kind: "chat", contextWindow: 1_310_720 },
			}),
			model({
				id: "local/qwen/qwen3-embedding-8b",
				kind: "embedding",
				residency: "local",
				pricing: { unit: "input_tokens", inputPer1M: 0.02 },
				limits: { kind: "embedding", dimensions: 4096, maxInputTokens: 32_000, supportsDimensions: true },
			}),
			model({
				id: "qwen/qwen3-embedding-8b",
				kind: "embedding",
				residency: "global",
				pricing: { unit: "usage", ceiling: { unit: "input_tokens", inputPer1M: 0.01 } },
				limits: { kind: "embedding", dimensions: 4096, maxInputTokens: 32_000, supportsDimensions: true },
			}),
			model({
				id: "local/qwen/qwen3-reranker-4b",
				kind: "rerank",
				residency: "local",
				pricing: { unit: "input_tokens", inputPer1M: 0.02 },
				limits: { kind: "rerank", maxDocuments: 1000, maxTokensPerDocument: null },
			}),
			model({
				id: "tarout-transcribe",
				kind: "transcription",
				residency: "local",
				pricing: { unit: "audio_minutes", perMinute: 0.01 },
				limits: {
					kind: "transcription",
					maxFileBytes: 26_214_400,
					inputFormats: ["mp3", "wav"],
					responseFormats: ["json", "text"],
				},
			}),
			model({
				id: "tarout-transcribe-global",
				kind: "transcription",
				residency: "global",
				pricing: { unit: "audio_minutes", perMinute: 0.002 },
				limits: {
					kind: "transcription",
					maxFileBytes: 26_214_400,
					inputFormats: ["mp3", "wav"],
					responseFormats: ["json", "text", "srt", "vtt", "verbose_json"],
				},
			}),
			model({
				id: "tarout-tts",
				kind: "speech",
				residency: "local",
				pricing: { unit: "characters", per1M: 15 },
				limits: {
					kind: "speech",
					maxInputChars: 4096,
					voices: ["sau", "ars", "uae"],
					outputFormats: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
				},
			}),
			model({
				id: "tarout-image",
				kind: "image",
				residency: "local",
				pricing: { unit: "images", perImage: { "1328x1328": 0.03, "1024x1024": 0.03 } },
				limits: { kind: "image", sizes: ["1328x1328", "1024x1024"], maxImages: 4, outputFormat: "png" },
			}),
			model({
				id: "tarout-video",
				kind: "video",
				residency: "local",
				pricing: { unit: "video_seconds", perSecond: { "720p": 0.1, "480p": 0.05 } },
				limits: { kind: "video", resolutions: ["1280x720", "832x480"], durationsSeconds: [4, 5, 8] },
			}),
		],
	};
}

export interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	bodyBytes: number | null;
}

/**
 * Stub the global fetch: PUTs answer 200, GETs answer `downloadBody` (or the
 * status in `failWith`). Returns the recorded calls.
 */
export function stubFetch(options: { downloadBody?: string; failWith?: number } = {}) {
	const calls: FetchCall[] = [];
	const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
			headers[name] = value;
		}
		const body = init?.body as Buffer | undefined;
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			bodyBytes: body ? body.byteLength : null,
		});
		if (options.failWith) return new Response("denied", { status: options.failWith });
		if ((init?.method ?? "GET") === "PUT") return new Response(null, { status: 200 });
		return new Response(options.downloadBody ?? "bytes", { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { calls, fetchMock };
}

export const SIGNED_UPLOAD = {
	file_id: "file-AbCdEfGhIjKlMnOpQrStUvWx",
	upload_url: "https://storage.test/upload?X-Goog-Signature=abc",
	method: "PUT",
	required_headers: { "Content-Type": "audio/mpeg" },
	expires_at: 1_900_000_000,
};

export function fileObject(id = SIGNED_UPLOAD.file_id, purpose = "user_data") {
	return {
		id,
		object: "file" as const,
		bytes: 5,
		created_at: 1_800_000_000,
		expires_at: null,
		filename: "clip.mp3",
		purpose,
		status: "processed",
		status_details: null,
	};
}
