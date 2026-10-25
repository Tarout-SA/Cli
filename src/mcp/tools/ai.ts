/**
 * Curated MCP tools for the AI Gateway services beyond chat and OCR. Every
 * billed call is charged to the organization's wallet through an AI Gateway
 * key (`keyId`, default the newest enabled key with the AI Gateway scope);
 * failed calls are free. `region` picks where the work runs: local (default,
 * in Saudi Arabia) or global (outside it); without `model` the first
 * available model of the kind in that region is used.
 *
 * Bytes never travel through tRPC (4 MB cap): local files are uploaded with a
 * signed URL (aiGateway.filesCreateUpload, then filesCompleteUpload), and
 * generated media is downloaded to a local path. Signed URLs are never
 * returned, because the result sanitizer would mangle them; media is saved
 * to `outPath`/`outDir`, or to a fresh folder under the system temp folder.
 * Audio is only ever written to a file, never played.
 *
 * - ai_embed: aiGateway.embeddingsCreate. Returns dimensions and the first 8
 *   values of each vector; the full vectors only go to `outPath`.
 * - ai_rerank: aiGateway.rerankCreate.
 * - ai_transcribe: aiGateway.audioTranscriptionsCreate (local path or URL).
 * - ai_speak: aiGateway.audioSpeechCreate, saved to a file.
 * - ai_image_generate: aiGateway.imagesGenerate, saved to a folder.
 * - ai_video_generate / ai_video_status: aiGateway.videosCreate,
 *   videosRetrieve and videosContentUrl (Local only).
 * - ai_files_upload / ai_files_list / ai_files_delete: the Files API.
 * - ai_vector_store_create / ai_vector_store_add_files /
 *   ai_vector_store_search / ai_vector_store_delete: file search.
 * - ai_batch_create / ai_batch_status: the Batch API.
 *
 * Annotations: destructiveHint on ai_files_delete and ai_vector_store_delete
 * (the platform may park them for a human's approval); readOnlyHint on
 * ai_files_list; every other tool spends wallet credit or writes local files.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	BATCH_ENDPOINTS,
	type Batch,
	createBatch,
	getBatch,
	isBatchDone,
} from "../../commands/ai-batches.js";
import type { EmbeddingsResult } from "../../commands/ai-embed.js";
import { generateImages } from "../../commands/ai-image.js";
import type { RerankResult } from "../../commands/ai-rerank.js";
import { speak } from "../../commands/ai-speak.js";
import { TRANSCRIPTION_FORMATS, transcribe } from "../../commands/ai-transcribe.js";
import {
	addFilesToVectorStore,
	searchVectorStore,
} from "../../commands/ai-vector-stores.js";
import {
	createVideoJob,
	downloadVideo,
	getVideoJob,
	isVideoDone,
	type VideoJob,
} from "../../commands/ai-video.js";
import { AI_REGIONS, pickModel } from "../../lib/ai-catalog.js";
import {
	AI_FILE_UPLOAD_PURPOSES,
	type AiFileObject,
	downloadToFile,
	uploadAiFile,
} from "../../lib/ai-files.js";
import { pollUntil } from "../../lib/ai-poll.js";
import { CliError } from "../../lib/errors.js";
import { type TrpcClient, withAuth } from "../runtime.js";

const region = z
	.enum(AI_REGIONS)
	.optional()
	.describe("local (default): runs in Saudi Arabia. global: runs outside Saudi Arabia.");
const keyId = z
	.string()
	.optional()
	.describe("AI Gateway key id to bill (default: the newest enabled key with the AI Gateway scope).");
const model = z
	.string()
	.optional()
	.describe("Model id (see `tarout ai models`); default the first available in the region.");

/** Longest a tool waits on a background job before answering its current state. */
const MAX_TOOL_WAIT_SECONDS = 600;

/** A fresh folder for media the caller gave no path for. */
async function mediaDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "tarout-ai-"));
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function registerAiTools(server: McpServer): void {
	server.registerTool(
		"ai_embed",
		{
			title: "Embed text (AI Gateway)",
			description:
				"Wraps aiGateway.embeddingsCreate. Turns one text or a list of texts into embedding vectors. Returns the model, dimensions, token usage, the charge (billed_halalas) and the first 8 values of each vector; pass `outPath` to write the full OpenAI embeddings response (every vector) to a JSON file.",
			inputSchema: {
				input: z
					.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
					.describe("A text, or a list of texts (one vector each)."),
				region,
				model,
				dimensions: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Shorter vectors, on models that support it."),
				outPath: z.string().optional().describe("Local JSON file for the full response."),
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const picked = await pickModel(client, "embedding", args.region ?? "local", args.model);
				const result = (await client.aiGateway.embeddingsCreate.mutate({
					...(args.keyId ? { keyId: args.keyId } : {}),
					request: {
						model: picked.id,
						input: args.input,
						...(args.dimensions !== undefined ? { dimensions: args.dimensions } : {}),
					},
				})) as EmbeddingsResult;
				let outPath: string | null = null;
				if (args.outPath) {
					outPath = resolve(args.outPath);
					await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
				}
				const first = result.data[0]?.embedding;
				return {
					model: result.model,
					dimensions: Array.isArray(first) ? first.length : null,
					count: result.data.length,
					usage: result.usage,
					billed_halalas: result.billed_halalas,
					request_id: result.request_id,
					outPath,
					vectors: result.data.map((item) => ({
						index: item.index,
						first8: Array.isArray(item.embedding) ? item.embedding.slice(0, 8) : [],
					})),
				};
			}),
	);

	server.registerTool(
		"ai_rerank",
		{
			title: "Rerank documents by relevance (AI Gateway)",
			description:
				"Wraps aiGateway.rerankCreate. Orders documents by relevance to a query and returns each document's index in your list with its score, most relevant first.",
			inputSchema: {
				query: z.string().min(1),
				documents: z.array(z.string().min(1)).min(1).describe("The texts to rank."),
				topN: z.number().int().min(1).optional().describe("Return only the n most relevant."),
				region,
				model,
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const picked = await pickModel(client, "rerank", args.region ?? "local", args.model);
				const result = (await client.aiGateway.rerankCreate.mutate({
					...(args.keyId ? { keyId: args.keyId } : {}),
					request: {
						model: picked.id,
						query: args.query,
						documents: args.documents,
						...(args.topN !== undefined ? { top_n: args.topN } : {}),
						return_documents: false,
					},
				})) as RerankResult;
				return {
					model: result.model,
					billed_halalas: result.billed_halalas,
					request_id: result.request_id,
					results: result.results.map((item) => ({
						index: item.index,
						score: item.relevance_score,
						document: truncate(args.documents[item.index] ?? "", 200),
					})),
				};
			}),
	);

	server.registerTool(
		"ai_transcribe",
		{
			title: "Transcribe audio to text (AI Gateway)",
			description:
				"Wraps aiGateway.audioTranscriptionsCreate. Pass exactly one of `path` (a local audio file, uploaded for the call; the upload expires after an hour and is not deleted explicitly) or `url` (public). Billed per second of audio. Local answers text and json only; srt, vtt and verbose_json (segments) need region global.",
			inputSchema: {
				path: z.string().optional().describe("Local audio file (mp3, m4a, wav, ogg, flac, webm, ...)."),
				url: z.string().url().optional().describe("Public http(s) URL of the audio."),
				format: z.enum(TRANSCRIPTION_FORMATS).optional().describe("Default text."),
				language: z.string().optional().describe("Spoken language, e.g. ar or en."),
				prompt: z.string().optional().describe("Context or spellings to guide the transcript."),
				region,
				model,
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				if (Boolean(args.path) === Boolean(args.url)) {
					throw new CliError("Pass exactly one of path or url.");
				}
				return await transcribe(client, {
					source: String(args.path ?? args.url),
					region: args.region ?? "local",
					model: args.model,
					format: args.format ?? "text",
					language: args.language,
					prompt: args.prompt,
					keyId: args.keyId,
				});
			}),
	);

	server.registerTool(
		"ai_speak",
		{
			title: "Turn text into speech (AI Gateway)",
			description:
				"Wraps aiGateway.audioSpeechCreate and saves the audio to `outPath` (default: a new file under the system temp folder); returns the local path. The audio is never played. Billed per character.",
			inputSchema: {
				text: z.string().min(1),
				outPath: z.string().optional().describe("Audio file to write, e.g. out.mp3."),
				voice: z.string().optional().describe("Voice name; default the model's first voice."),
				format: z
					.enum(["mp3", "opus", "aac", "flac", "wav", "pcm"])
					.optional()
					.describe("Default from outPath's extension, else mp3."),
				speed: z.number().positive().optional(),
				instructions: z.string().optional().describe("How to speak: tone, pace, emotion."),
				region,
				model,
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const outPath =
					args.outPath ?? join(await mediaDir(), `speech.${args.format ?? "mp3"}`);
				const { result, path, bytes } = await speak(client, {
					text: args.text,
					region: args.region ?? "local",
					model: args.model,
					voice: args.voice,
					format: args.format,
					outPath,
					speed: args.speed,
					instructions: args.instructions,
					keyId: args.keyId,
				});
				return {
					path,
					bytes,
					response_format: result.response_format,
					characters: result.characters,
					model: result.model,
					billed_halalas: result.billed_halalas,
					request_id: result.request_id,
				};
			}),
	);

	server.registerTool(
		"ai_image_generate",
		{
			title: "Generate images (AI Gateway)",
			description:
				"Wraps aiGateway.imagesGenerate and saves each image to `outDir` (default: a new folder under the system temp folder); returns the local file paths. Billed per image.",
			inputSchema: {
				prompt: z.string().min(1),
				size: z.string().optional().describe("e.g. 1024x1024; default the model's default."),
				n: z.number().int().min(1).optional().describe("How many images (default 1)."),
				outDir: z.string().optional().describe("Folder to save the images in."),
				region,
				model,
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const { result, files } = await generateImages(client, {
					prompt: args.prompt,
					region: args.region ?? "local",
					model: args.model,
					size: args.size,
					n: args.n,
					outDir: args.outDir ?? (await mediaDir()),
					keyId: args.keyId,
				});
				return {
					files,
					size: result.size,
					model: result.model,
					billed_halalas: result.billed_halalas,
					request_id: result.request_id,
				};
			}),
	);

	server.registerTool(
		"ai_video_generate",
		{
			title: "Generate a video (AI Gateway, Local)",
			description:
				"Wraps aiGateway.videosCreate. Submits a text-to-video job that runs in Saudi Arabia and returns the job (status queued). Charged only once the video is ready; a failed job is free. With wait:true it polls until the video is ready (up to timeoutSeconds) and saves it to `outPath` (default: under the system temp folder). Otherwise follow it with ai_video_status.",
			inputSchema: {
				prompt: z.string().min(1),
				size: z.string().optional().describe("e.g. 1280x720; default the model's default."),
				seconds: z.number().int().min(1).optional().describe("Length; default the model's default."),
				wait: z.boolean().optional().default(false),
				timeoutSeconds: z.number().int().min(1).max(MAX_TOOL_WAIT_SECONDS).optional(),
				outPath: z.string().optional().describe("Where to save the MP4 when waiting."),
				model,
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const created = await createVideoJob(client, {
					prompt: args.prompt,
					region: "local",
					model: args.model,
					size: args.size,
					seconds: args.seconds,
					keyId: args.keyId,
				});
				if (!args.wait) return { video: created };
				const { value: job, timedOut } = await pollUntil(
					() => getVideoJob(client, created.id, args.keyId),
					isVideoDone,
					{ intervalMs: 5_000, timeoutMs: (args.timeoutSeconds ?? MAX_TOOL_WAIT_SECONDS) * 1000 },
				);
				return await videoResult(client, job, timedOut, args.outPath, args.keyId);
			}),
	);

	server.registerTool(
		"ai_video_status",
		{
			title: "Check a video job (AI Gateway)",
			description:
				"Wraps aiGateway.videosRetrieve. Returns the job's status and progress; once it is completed and `outPath` is given, saves the MP4 there (aiGateway.videosContentUrl).",
			inputSchema: {
				videoId: z.string().min(1),
				outPath: z.string().optional().describe("Where to save the MP4 if it is ready."),
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const job = await getVideoJob(client, args.videoId, args.keyId);
				return await videoResult(client, job, false, args.outPath, args.keyId, false);
			}),
	);

	server.registerTool(
		"ai_files_upload",
		{
			title: "Upload a file (AI Gateway Files)",
			description:
				"Uploads a local file through a signed URL (aiGateway.filesCreateUpload, PUT, aiGateway.filesCompleteUpload) and returns the file object. Use purpose assistants for vector stores, batch for a Batch API JSONL. Files are not billed; they count toward the organization's file quota.",
			inputSchema: {
				path: z.string().min(1).describe("Local file to upload."),
				purpose: z.enum(AI_FILE_UPLOAD_PURPOSES).optional().default("user_data"),
				expiresAfterSeconds: z
					.number()
					.int()
					.min(3600)
					.max(2_592_000)
					.optional()
					.describe("Delete the file automatically after this many seconds."),
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) =>
				uploadAiFile(client, args.path, args.purpose ?? "user_data", {
					expiresAfterSeconds: args.expiresAfterSeconds,
				}),
			),
	);

	server.registerTool(
		"ai_files_list",
		{
			title: "List uploaded files (AI Gateway Files)",
			description: "Wraps aiGateway.filesList, newest first.",
			inputSchema: {
				purpose: z.enum(["user_data", "assistants", "batch", "batch_output"]).optional(),
				limit: z.number().int().min(1).max(10_000).optional().default(100),
			},
			annotations: { readOnlyHint: true },
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const page = (await client.aiGateway.filesList.query({
					...(args.purpose ? { purpose: args.purpose } : {}),
					limit: args.limit ?? 100,
					order: "desc",
				})) as { data: AiFileObject[]; has_more?: boolean };
				return { count: page.data?.length ?? 0, has_more: page.has_more ?? false, files: page.data ?? [] };
			}),
	);

	server.registerTool(
		"ai_files_delete",
		{
			title: "Delete an uploaded file (irreversible)",
			description:
				"Wraps aiGateway.filesDelete. The file is removed from every vector store that uses it, then its bytes are deleted.",
			inputSchema: { fileId: z.string().min(1) },
			annotations: { destructiveHint: true },
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const result = (await client.aiGateway.filesDelete.mutate({ fileId: args.fileId })) as unknown;
				return { deleted: true, fileId: args.fileId, result };
			}),
	);

	server.registerTool(
		"ai_vector_store_create",
		{
			title: "Create a vector store (file search)",
			description:
				"Wraps aiGateway.vectorStoresCreate. `region` local (default) processes and embeds the store's files in Saudi Arabia; global outside it. Indexing bills its embedding calls; storage is billed per GB-day. Add files with ai_vector_store_add_files.",
			inputSchema: {
				name: z.string().optional(),
				region,
				expiresAfterDays: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Delete the store after this many days without use."),
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) =>
				client.aiGateway.vectorStoresCreate.mutate({
					...(args.keyId ? { keyId: args.keyId } : {}),
					...(args.name ? { name: args.name } : {}),
					region: args.region ?? "local",
					...(args.expiresAfterDays !== undefined ? { expiresAfterDays: args.expiresAfterDays } : {}),
				}),
			),
	);

	server.registerTool(
		"ai_vector_store_add_files",
		{
			title: "Add files to a vector store (file search)",
			description:
				"Uploads each local path (purpose assistants), then attaches it and every given file id to the store with aiGateway.vectorStoreFilesAdd. Files are indexed in the background (status in_progress); wait:true polls until none is in progress (up to timeoutSeconds). Failed indexing is not charged.",
			inputSchema: {
				vectorStoreId: z.string().min(1),
				paths: z.array(z.string().min(1)).optional().describe("Local files to upload and add."),
				fileIds: z.array(z.string().min(1)).optional().describe("Files already uploaded."),
				wait: z.boolean().optional().default(false),
				timeoutSeconds: z.number().int().min(1).max(MAX_TOOL_WAIT_SECONDS).optional(),
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const sources = [...(args.fileIds ?? []), ...(args.paths ?? []).map((path) => resolve(path))];
				if (sources.length === 0) throw new CliError("Pass paths, fileIds or both.");
				return await addFilesToVectorStore(client, args.vectorStoreId, sources, {
					keyId: args.keyId,
					wait: args.wait === true,
					timeoutMs: (args.timeoutSeconds ?? MAX_TOOL_WAIT_SECONDS) * 1000,
				});
			}),
	);

	server.registerTool(
		"ai_vector_store_search",
		{
			title: "Search a vector store (file search)",
			description:
				"Wraps aiGateway.vectorStoresSearch. Returns the best matching chunks with file, score and text. Bills its embedding call (and any rerank or rewrite).",
			inputSchema: {
				vectorStoreId: z.string().min(1),
				query: z.string().min(1),
				maxNumResults: z.number().int().min(1).optional(),
				scoreThreshold: z.number().min(0).max(1).optional(),
				rewriteQuery: z.boolean().optional(),
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) =>
				searchVectorStore(client, args.vectorStoreId, {
					query: args.query,
					maxNumResults: args.maxNumResults,
					scoreThreshold: args.scoreThreshold,
					rewriteQuery: args.rewriteQuery,
					keyId: args.keyId,
				}),
			),
	);

	server.registerTool(
		"ai_vector_store_delete",
		{
			title: "Delete a vector store (irreversible)",
			description:
				"Wraps aiGateway.vectorStoresDelete. Deletes the store and its index (storage billing stops); the uploaded files are kept.",
			inputSchema: { vectorStoreId: z.string().min(1) },
			annotations: { destructiveHint: true },
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const result = (await client.aiGateway.vectorStoresDelete.mutate({
					vectorStoreId: args.vectorStoreId,
				})) as unknown;
				return { deleted: true, vectorStoreId: args.vectorStoreId, result };
			}),
	);

	server.registerTool(
		"ai_batch_create",
		{
			title: "Start a batch (AI Gateway Batch API)",
			description:
				"Wraps aiGateway.batchesCreate. Pass exactly one of `path` (a local JSONL file, uploaded with purpose batch) or `inputFileId`. Every line calls `endpoint`; lines run within 24 hours and each is billed as it runs at the normal price (no batch discount). Follow it with ai_batch_status.",
			inputSchema: {
				path: z.string().optional().describe("Local .jsonl file of requests."),
				inputFileId: z.string().optional().describe("A file uploaded with purpose batch."),
				endpoint: z.enum(BATCH_ENDPOINTS),
				metadata: z.record(z.string(), z.string()).optional(),
				keyId,
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				if (Boolean(args.path) === Boolean(args.inputFileId)) {
					throw new CliError("Pass exactly one of path or inputFileId.");
				}
				const { batch, uploaded } = await createBatch(client, {
					input: args.path ? resolve(args.path) : String(args.inputFileId),
					endpoint: args.endpoint,
					metadata: args.metadata,
					keyId: args.keyId,
				});
				return { batch, uploadedFile: uploaded };
			}),
	);

	server.registerTool(
		"ai_batch_status",
		{
			title: "Check a batch (AI Gateway Batch API)",
			description:
				"Wraps aiGateway.batchesRetrieve. Returns the batch's status and line counts; once it has finished and `outPath` (and/or `errorsPath`) is given, saves the output (error) JSONL there.",
			inputSchema: {
				batchId: z.string().min(1),
				outPath: z.string().optional().describe("Where to save the output JSONL when done."),
				errorsPath: z.string().optional().describe("Where to save the error JSONL when done."),
			},
		},
		async (args) =>
			withAuth(async (client: TrpcClient) => {
				const batch = await getBatch(client, args.batchId);
				const saved: Record<string, string> = {};
				if (isBatchDone(batch)) {
					if (args.outPath && batch.output_file_id) {
						saved.outPath = await saveFile(client, batch.output_file_id, args.outPath);
					}
					if (args.errorsPath && batch.error_file_id) {
						saved.errorsPath = await saveFile(client, batch.error_file_id, args.errorsPath);
					}
				}
				return { batch: batch as Batch, saved };
			}),
	);
}

async function saveFile(client: TrpcClient, fileId: string, outPath: string): Promise<string> {
	const content = (await client.aiGateway.filesContentUrl.query({ fileId })) as { url: string };
	const path = resolve(outPath);
	await downloadToFile(content.url, path);
	return path;
}

/** The job, plus where its MP4 was saved once it is ready. */
async function videoResult(
	client: TrpcClient,
	job: VideoJob,
	timedOut: boolean,
	outPath: string | undefined,
	keyId: string | undefined,
	saveByDefault = true,
): Promise<Record<string, unknown>> {
	if (job.status !== "completed" || (!outPath && !saveByDefault)) {
		return {
			video: job,
			...(timedOut ? { note: "Still running; check it again with ai_video_status." } : {}),
		};
	}
	const target = outPath ?? join(await mediaDir(), `${job.id}.mp4`);
	const saved = await downloadVideo(client, job.id, target, keyId);
	return { video: job, path: saved.path, bytes: saved.bytes };
}
