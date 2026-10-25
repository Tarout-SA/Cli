import { resolve } from "node:path";
import type { Command } from "commander";
import { printSummary } from "../lib/ai-billing.js";
import { type AiRegion, parseAiRegion, pickModel } from "../lib/ai-catalog.js";
import { downloadToFile } from "../lib/ai-files.js";
import { parsePositiveInt, parseTimeoutSeconds, pollUntil } from "../lib/ai-poll.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError, InvalidArgumentError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, quietOutput } from "../lib/output.js";
import { startSpinner, succeedSpinner, updateSpinner } from "../utils/spinner.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/** The OpenAI `video` job object. */
export interface VideoJob {
	id: string;
	object: "video";
	model: string;
	status: "queued" | "in_progress" | "completed" | "failed";
	progress: number;
	created_at: number;
	completed_at: number | null;
	expires_at: number | null;
	size: string;
	seconds: string;
	error: { code: string; message: string } | null;
}

const VIDEO_POLL_INTERVAL_MS = 5_000;
const DEFAULT_VIDEO_TIMEOUT_SECONDS = 900;

export function isVideoDone(job: VideoJob): boolean {
	return job.status === "completed" || job.status === "failed";
}

export interface CreateVideoInput {
	prompt: string;
	region: AiRegion;
	model?: string;
	size?: string;
	seconds?: number;
	keyId?: string;
}

/** Submit a video job (aiGateway.videosCreate); it is charged only once the video is stored. */
export async function createVideoJob(client: TrpcClient, input: CreateVideoInput): Promise<VideoJob> {
	if (!input.prompt.trim()) throw new InvalidArgumentError("The prompt is empty.");
	const picked = await pickModel(client, "video", input.region, input.model);
	const limits = picked.model?.limits.kind === "video" ? picked.model.limits : null;
	if (input.size && limits?.resolutions.length && !limits.resolutions.includes(input.size)) {
		throw new InvalidArgumentError(
			`Unknown size "${input.size}" for ${picked.id}. Sizes: ${limits.resolutions.join(", ")}.`,
		);
	}
	if (
		input.seconds !== undefined &&
		limits?.durationsSeconds.length &&
		!limits.durationsSeconds.includes(input.seconds)
	) {
		throw new InvalidArgumentError(
			`${picked.id} makes videos of ${limits.durationsSeconds.join(", ")} seconds.`,
		);
	}
	return (await client.aiGateway.videosCreate.mutate({
		...(input.keyId ? { keyId: input.keyId } : {}),
		request: {
			model: picked.id,
			prompt: input.prompt,
			...(input.size ? { size: input.size } : {}),
			...(input.seconds !== undefined ? { seconds: input.seconds } : {}),
		},
	})) as VideoJob;
}

export async function getVideoJob(
	client: TrpcClient,
	videoId: string,
	keyId?: string,
): Promise<VideoJob> {
	return (await client.aiGateway.videosRetrieve.query({
		...(keyId ? { keyId } : {}),
		videoId,
	})) as VideoJob;
}

/** Download a finished video's MP4 (aiGateway.videosContentUrl) to `outPath`. */
export async function downloadVideo(
	client: TrpcClient,
	videoId: string,
	outPath: string,
	keyId?: string,
): Promise<{ path: string; bytes: number }> {
	const content = (await client.aiGateway.videosContentUrl.query({
		...(keyId ? { keyId } : {}),
		videoId,
	})) as { url: string; expires_at: number };
	const path = resolve(outPath);
	return { path, bytes: await downloadToFile(content.url, path) };
}

function describeJob(job: VideoJob): string {
	const progress = job.status === "in_progress" ? ` (${job.progress}%)` : "";
	return `${job.id}: ${job.status}${progress}, ${job.size}, ${job.seconds} s`;
}

function failedError(job: VideoJob): CliError {
	return new CliError(
		`Video ${job.id} failed: ${job.error?.message ?? "the video could not be generated"}. Nothing was charged.`,
		undefined,
		undefined,
		{ videoId: job.id, error: job.error },
	);
}

/**
 * `tarout ai video "<prompt>"` (Local): submit, wait, download. `status` and
 * `download` follow a job later. Commander lets the parent command consume
 * its own options wherever they appear (`ai video download <id> -o x.mp4`
 * fills the parent's `-o`), so the subcommands read `-o` and `-k` from either
 * place.
 */
export function registerAiVideoCommand(ai: Command) {
	const video = ai
		.command("video")
		.description(
			"Generate a short video from a text prompt (in Saudi Arabia); `status` and `download` follow a job",
		)
		.argument("[prompt]", "What the video shows")
		.option("-s, --size <WxH>", "Frame size, e.g. 1280x720 (default: the model's default)")
		.option("--seconds <n>", "Length in seconds (default: the model's default)")
		.option("-o, --out <file>", "Save the MP4 here once it is ready")
		.option("--no-wait", "Submit and return the job id without waiting")
		.option(
			"--timeout <seconds>",
			"Longest to wait for the video",
			String(DEFAULT_VIDEO_TIMEOUT_SECONDS),
		)
		.option("-r, --region <region>", "local (in Saudi Arabia)", "local")
		.option("-m, --model <id>", "Video model (default: the first available)")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (prompt: string | undefined, options) => {
			try {
				if (!prompt) {
					video.help({ error: true });
					return;
				}
				if (!isLoggedIn()) throw new AuthError();
				const region = parseAiRegion(options.region);
				const seconds =
					options.seconds === undefined ? undefined : parsePositiveInt(options.seconds, "--seconds");
				const timeoutMs = parseTimeoutSeconds(options.timeout);
				const keyId = options.key ? String(options.key) : undefined;
				const client = getApiClient();
				const _spinner = startSpinner("Submitting...");
				const created = await createVideoJob(client, {
					prompt,
					region,
					model: options.model,
					size: options.size,
					seconds,
					keyId,
				});

				if (options.wait === false) {
					succeedSpinner(`Submitted ${created.id}`);
					if (isJsonMode()) {
						outputData(created);
						return;
					}
					quietOutput(created.id);
					log(`Check it: ${colors.cyan(`tarout ai video status ${created.id}`)}`);
					log(`Save it when ready: ${colors.cyan(`tarout ai video download ${created.id} -o clip.mp4`)}`);
					return;
				}

				const { value: job, timedOut } = await pollUntil(
					() => getVideoJob(client, created.id, keyId),
					isVideoDone,
					{
						intervalMs: VIDEO_POLL_INTERVAL_MS,
						timeoutMs,
						onTick: (current) => updateSpinner(`Generating: ${describeJob(current)}`),
					},
				);
				if (timedOut) {
					throw new CliError(
						`Video ${job.id} is still ${job.status} after ${timeoutMs / 1000} s. Check it later with \`tarout ai video status ${job.id}\`; it is charged only once it is ready.`,
						undefined,
						undefined,
						{ videoId: job.id, status: job.status, nextCommand: `tarout ai video status ${job.id}` },
					);
				}
				if (job.status === "failed") throw failedError(job);
				succeedSpinner(`Video ${job.id} is ready.`);

				const saved = options.out
					? await downloadVideo(client, job.id, String(options.out), keyId)
					: null;
				if (isJsonMode()) {
					outputData({ ...job, path: saved?.path ?? null, bytes: saved?.bytes ?? null });
					return;
				}
				quietOutput(saved?.path ?? job.id);
				if (saved) {
					log(colors.success(`Wrote ${saved.path} (${saved.bytes} bytes)`));
				} else {
					log(`Save it: ${colors.cyan(`tarout ai video download ${job.id} -o clip.mp4`)}`);
				}
				printSummary(`${job.seconds} s at ${job.size} from ${job.model}`);
			} catch (err) {
				handleError(err);
			}
		});

	video
		.command("status <videoId>")
		.description("Show a video job's status")
		.option("-k, --key <keyId>", "AI Gateway key id (default: the newest enabled key)")
		.action(async (videoId: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const key = options.key ?? video.opts().key;
				const _spinner = startSpinner("Fetching video...");
				const job = await getVideoJob(getApiClient(), videoId, key ? String(key) : undefined);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(job);
					return;
				}
				quietOutput(job.status);
				log("");
				log(colors.bold(job.id));
				log(`  Status: ${job.status}${job.status === "in_progress" ? ` (${job.progress}%)` : ""}`);
				log(`  Model: ${job.model}`);
				log(`  Size: ${job.size}, ${job.seconds} s`);
				if (job.expires_at) {
					log(`  Download until: ${new Date(job.expires_at * 1000).toISOString()}`);
				}
				if (job.error) log(colors.error(`  Error: ${job.error.message}`));
				if (job.status === "completed") {
					log("");
					log(`Save it: ${colors.cyan(`tarout ai video download ${job.id} -o clip.mp4`)}`);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	video
		.command("download <videoId>")
		.description("Save a finished video's MP4")
		.option("-o, --out <file>", "Where to save the MP4 (required)")
		.option("-k, --key <keyId>", "AI Gateway key id (default: the newest enabled key)")
		.action(async (videoId: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const out = options.out ?? video.opts().out;
				const key = options.key ?? video.opts().key;
				if (!out) throw new InvalidArgumentError("Pass -o <file>: where to save the MP4.");
				const _spinner = startSpinner("Downloading...");
				const saved = await downloadVideo(
					getApiClient(),
					videoId,
					String(out),
					key ? String(key) : undefined,
				);
				succeedSpinner();
				if (isJsonMode()) {
					outputData({ videoId, ...saved });
					return;
				}
				quietOutput(saved.path);
				log(colors.success(`Wrote ${saved.path} (${saved.bytes} bytes)`));
			} catch (err) {
				handleError(err);
			}
		});
}
