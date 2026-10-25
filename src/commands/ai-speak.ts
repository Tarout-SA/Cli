import { extname, resolve } from "node:path";
import type { Command } from "commander";
import { billedSuffix, printSummary } from "../lib/ai-billing.js";
import { type AiRegion, parseAiRegion, pickModel } from "../lib/ai-catalog.js";
import { downloadToFile } from "../lib/ai-files.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError, InvalidArgumentError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, quietOutput } from "../lib/output.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export interface SpeechResult {
	audio_url: string;
	expires_at: number;
	content_type: string;
	response_format: string;
	bytes: number;
	characters: number;
	model: string;
	billed_halalas?: number;
	request_id?: string;
}

export interface SpeakInput {
	text: string;
	region: AiRegion;
	model?: string;
	voice?: string;
	/** Output format; default from the output file's extension when it is one the model makes. */
	format?: string;
	outPath?: string;
	speed?: number;
	instructions?: string;
	keyId?: string;
}

/**
 * Shared by `tarout ai speak` and the `ai_speak` MCP tool: synthesize speech
 * (aiGateway.audioSpeechCreate answers a short-lived URL) and, when
 * `outPath` is set, download the audio there. Audio is only ever written to
 * a file, never played.
 */
export async function speak(
	client: TrpcClient,
	input: SpeakInput,
): Promise<{ result: SpeechResult; path: string | null; bytes: number | null }> {
	const text = input.text;
	if (!text.trim()) throw new InvalidArgumentError("Nothing to say: the text is empty.");
	const picked = await pickModel(client, "speech", input.region, input.model);
	const limits = picked.model?.limits.kind === "speech" ? picked.model.limits : null;
	if (limits?.maxInputChars && Array.from(text).length > limits.maxInputChars) {
		throw new InvalidArgumentError(
			`The text is ${Array.from(text).length} characters; ${picked.id} takes at most ${limits.maxInputChars}. Split it into several requests.`,
		);
	}
	const voice = input.voice?.trim() || limits?.voices[0];
	if (!voice) {
		throw new InvalidArgumentError(
			`Pass --voice: the catalog lists no voices for ${picked.id}. See \`tarout ai models --kind speech --json\`.`,
		);
	}
	// Voices are checked by the server: it also maps the OpenAI voice names.
	const extension = input.outPath ? extname(input.outPath).slice(1).toLowerCase() : "";
	const format =
		input.format?.trim().toLowerCase() ||
		(extension && limits?.outputFormats.includes(extension) ? extension : undefined);
	if (format && limits?.outputFormats.length && !limits.outputFormats.includes(format)) {
		throw new InvalidArgumentError(
			`Unknown format "${format}" for ${picked.id}. Formats: ${limits.outputFormats.join(", ")}.`,
		);
	}
	const result = (await client.aiGateway.audioSpeechCreate.mutate({
		...(input.keyId ? { keyId: input.keyId } : {}),
		request: {
			model: picked.id,
			input: text,
			voice,
			...(format ? { response_format: format } : {}),
			...(input.speed !== undefined ? { speed: input.speed } : {}),
			...(input.instructions ? { instructions: input.instructions } : {}),
		},
	})) as SpeechResult;
	if (!input.outPath) return { result, path: null, bytes: null };
	const path = resolve(input.outPath);
	const bytes = await downloadToFile(result.audio_url, path);
	return { result, path, bytes };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function parseSpeed(value: unknown): number {
	const speed = Number(value);
	if (!Number.isFinite(speed) || speed <= 0) {
		throw new InvalidArgumentError(`Invalid --speed "${value}". Pass a number such as 1 or 1.25.`);
	}
	return speed;
}

/** `tarout ai speak <text|->`: text to speech, written to a file. */
export function registerAiSpeakCommand(ai: Command) {
	ai.command("speak <text>")
		.description("Turn text into speech and write the audio to a file (- reads the text from stdin)")
		.requiredOption("-o, --out <file>", "Audio file to write, e.g. out.mp3")
		.option("--voice <voice>", "Voice name (default: the model's first voice)")
		.option("-f, --format <format>", "mp3, opus, aac, flac, wav or pcm (default: from --out)")
		.option("--speed <n>", "Speaking speed, 1 is normal")
		.option("--instructions <text>", "How to speak: tone, pace, emotion")
		.option("-r, --region <region>", "local (in Saudi Arabia) or global", "local")
		.option("-m, --model <id>", "Text to speech model (default: the first available in the region)")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (textArg: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const text = textArg === "-" ? await readStdin() : textArg;
				const region = parseAiRegion(options.region);
				const speed = options.speed === undefined ? undefined : parseSpeed(options.speed);
				const client = getApiClient();
				const _spinner = startSpinner("Speaking...");
				const { result, path, bytes } = await speak(client, {
					text,
					region,
					model: options.model,
					voice: options.voice,
					format: options.format,
					outPath: String(options.out),
					speed,
					instructions: options.instructions,
					keyId: options.key ? String(options.key) : undefined,
				});
				succeedSpinner();

				if (isJsonMode()) {
					outputData({ ...result, path, bytes });
					return;
				}
				quietOutput(path ?? "");
				log(colors.success(`Wrote ${path} (${bytes} bytes, ${result.response_format})`));
				printSummary(
					`${result.characters} characters spoken with ${result.model}${billedSuffix(result)}`,
				);
			} catch (err) {
				handleError(err);
			}
		});
}
