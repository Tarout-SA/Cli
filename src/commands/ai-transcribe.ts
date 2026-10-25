import { stat, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { billedSuffix, printSummary } from "../lib/ai-billing.js";
import { type AiRegion, parseAiRegion, pickModel } from "../lib/ai-catalog.js";
import { uploadAiFile } from "../lib/ai-files.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError, InvalidArgumentError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, warn } from "../lib/output.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/** The formats the API takes; Local answers json and text only. */
export const TRANSCRIPTION_FORMATS = ["text", "json", "verbose_json", "srt", "vtt"] as const;
export type TranscriptionFormat = (typeof TRANSCRIPTION_FORMATS)[number];

/**
 * How long the temporary upload of a local file lives (the API minimum). It is
 * never deleted explicitly: the platform treats a file delete as destructive
 * and parks it for a human's approval on agent keys, so the expiry removes it.
 */
const TEMP_UPLOAD_TTL_SECONDS = 3600;

export interface TranscriptionResult {
	text?: string;
	content?: string;
	content_type?: string;
	response_format?: string;
	billed_seconds?: number;
	billed_halalas?: number;
	request_id?: string;
	[key: string]: unknown;
}

export interface TranscribeInput {
	source: string;
	region: AiRegion;
	model?: string;
	format: TranscriptionFormat;
	language?: string;
	prompt?: string;
	keyId?: string;
}

export function parseTranscriptionFormat(value: unknown): TranscriptionFormat {
	const format = String(value ?? "text").trim().toLowerCase();
	if ((TRANSCRIPTION_FORMATS as readonly string[]).includes(format)) {
		return format as TranscriptionFormat;
	}
	throw new InvalidArgumentError(
		`Unknown --format "${value}". Use ${TRANSCRIPTION_FORMATS.join(", ")}.`,
	);
}

/**
 * Shared by `tarout ai transcribe` and the `ai_transcribe` MCP tool. A URL is
 * passed to the API as is; a local file is uploaded (Files API, purpose
 * user_data, expiring after an hour) and transcribed by file id. The upload
 * is left to expire: an explicit delete would wait for approval on every
 * operator-tier agent key.
 */
export async function transcribe(
	client: TrpcClient,
	input: TranscribeInput,
): Promise<TranscriptionResult> {
	const picked = await pickModel(client, "transcription", input.region, input.model);
	const limits = picked.model?.limits.kind === "transcription" ? picked.model.limits : null;
	if (limits?.responseFormats.length && !limits.responseFormats.includes(input.format)) {
		throw new InvalidArgumentError(
			`${picked.id} answers ${limits.responseFormats.join(" and ")} only. Use one of those, or --region global for srt, vtt or verbose_json.`,
		);
	}
	const request = {
		model: picked.id,
		response_format: input.format,
		...(input.language ? { language: input.language } : {}),
		...(input.prompt ? { prompt: input.prompt } : {}),
	};
	const keyId = input.keyId ? { keyId: input.keyId } : {};

	if (/^https?:\/\//i.test(input.source)) {
		return (await client.aiGateway.audioTranscriptionsCreate.mutate({
			...keyId,
			request: { ...request, file: { type: "url", url: input.source } },
		})) as TranscriptionResult;
	}

	const info = await stat(input.source).catch(() => null);
	if (!info?.isFile()) throw new CliError(`File not found: ${input.source}`);
	if (limits?.maxFileBytes && info.size > limits.maxFileBytes) {
		throw new InvalidArgumentError(
			`${input.source} is ${info.size} bytes; the limit is ${limits.maxFileBytes} bytes. Send a shorter or more compressed recording.`,
		);
	}
	const file = await uploadAiFile(client, input.source, "user_data", {
		expiresAfterSeconds: TEMP_UPLOAD_TTL_SECONDS,
	});
	return (await client.aiGateway.audioTranscriptionsCreate.mutate({
		...keyId,
		request: { ...request, file: { type: "file_id", file_id: file.id } },
	})) as TranscriptionResult;
}

/** The transcript as text: `content` (text, srt, vtt) or JSON (json, verbose_json). */
export function transcriptText(result: TranscriptionResult, format: TranscriptionFormat): string {
	if (typeof result.content === "string") return result.content;
	if (format === "text" && typeof result.text === "string") return result.text;
	const billing = new Set(["billed_halalas", "billed_seconds", "request_id", "response_format"]);
	const body = Object.fromEntries(Object.entries(result).filter(([key]) => !billing.has(key)));
	return JSON.stringify(body, null, 2);
}

/** `tarout ai transcribe <file|url>`: aiGateway.audioTranscriptionsCreate. */
export function registerAiTranscribeCommand(ai: Command) {
	ai.command("transcribe <source>")
		.description(
			"Transcribe speech in an audio file (local path or URL) to text. A local file is uploaded for the call and expires after an hour.",
		)
		.option("-r, --region <region>", "local (in Saudi Arabia) or global", "local")
		.option("-m, --model <id>", "Speech to text model (default: the first available in the region)")
		.option(
			"-f, --format <format>",
			"text, json, verbose_json, srt or vtt (Local answers text and json only)",
			"text",
		)
		.option("-l, --language <code>", "Spoken language, e.g. ar or en (default: detected)")
		.option("--prompt <text>", "Context or spellings to guide the transcript (Global)")
		.option("-o, --out <file>", "Write the transcript to a file instead of stdout")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (source: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const format = parseTranscriptionFormat(options.format);
				const region = parseAiRegion(options.region);
				const client = getApiClient();
				const _spinner = startSpinner("Transcribing...");
				const result = await transcribe(client, {
					source,
					region,
					model: options.model,
					format,
					language: options.language,
					prompt: options.prompt,
					keyId: options.key ? String(options.key) : undefined,
				});
				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const text = transcriptText(result, format);
				const body = text.endsWith("\n") ? text : `${text}\n`;
				if (options.out) {
					await writeFile(String(options.out), body, "utf8");
					log(colors.success(`Wrote ${options.out}`));
				} else {
					process.stdout.write(body);
				}
				if (!text.trim()) warn("No speech was recognized.");
				const seconds =
					typeof result.billed_seconds === "number"
						? `${result.billed_seconds} s of audio`
						: "Audio";
				printSummary(`${seconds} transcribed${billedSuffix(result)}`);
			} catch (err) {
				handleError(err);
			}
		});
}
