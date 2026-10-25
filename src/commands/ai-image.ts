import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { billedSuffix, printSummary } from "../lib/ai-billing.js";
import { type AiRegion, parseAiRegion, pickModel } from "../lib/ai-catalog.js";
import { downloadToFile } from "../lib/ai-files.js";
import { parsePositiveInt } from "../lib/ai-poll.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError, InvalidArgumentError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, quietOutput } from "../lib/output.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export interface ImagesResult {
	created: number;
	data: Array<{ url: string; expires_at: number }>;
	size?: string;
	output_format?: string;
	model: string;
	billed_halalas?: number;
	request_id?: string;
}

export interface GenerateImagesInput {
	prompt: string;
	region: AiRegion;
	model?: string;
	size?: string;
	n?: number;
	/** Folder to save the images in (created when missing); none = URLs only. */
	outDir?: string;
	keyId?: string;
}

/**
 * Shared by `tarout ai image` and the `ai_image_generate` MCP tool:
 * aiGateway.imagesGenerate answers short-lived URLs; with `outDir` each image
 * is saved as `<request id>-<n>.<format>`.
 */
export async function generateImages(
	client: TrpcClient,
	input: GenerateImagesInput,
): Promise<{ result: ImagesResult; files: string[] }> {
	if (!input.prompt.trim()) throw new InvalidArgumentError("The prompt is empty.");
	const picked = await pickModel(client, "image", input.region, input.model);
	const limits = picked.model?.limits.kind === "image" ? picked.model.limits : null;
	if (input.size && limits?.sizes.length && !limits.sizes.includes(input.size)) {
		throw new InvalidArgumentError(
			`Unknown size "${input.size}" for ${picked.id}. Sizes: ${limits.sizes.join(", ")}.`,
		);
	}
	if (input.n !== undefined && limits?.maxImages && input.n > limits.maxImages) {
		throw new InvalidArgumentError(`${picked.id} makes at most ${limits.maxImages} images per request.`);
	}
	const result = (await client.aiGateway.imagesGenerate.mutate({
		...(input.keyId ? { keyId: input.keyId } : {}),
		request: {
			model: picked.id,
			prompt: input.prompt,
			...(input.size ? { size: input.size } : {}),
			...(input.n !== undefined ? { n: input.n } : {}),
		},
	})) as ImagesResult;
	const files: string[] = [];
	if (input.outDir) {
		const dir = resolve(input.outDir);
		await mkdir(dir, { recursive: true });
		const extension = result.output_format === "jpeg" ? "jpg" : (result.output_format ?? "png");
		const stem = result.request_id ?? String(result.created);
		for (const [index, image] of result.data.entries()) {
			if (!image.url) continue;
			const path = join(dir, `${stem}-${index + 1}.${extension}`);
			await downloadToFile(image.url, path);
			files.push(path);
		}
	}
	return { result, files };
}

/** `tarout ai image "<prompt>"`: image generation, saved to a folder. */
export function registerAiImageCommand(ai: Command) {
	ai.command("image <prompt>")
		.description("Generate images from a text prompt")
		.option("-s, --size <WxH>", "Image size, e.g. 1024x1024 (default: the model's default)")
		.option("-n, --n <count>", "How many images (default 1)")
		.option("-o, --out <dir>", "Folder to save the images in (default: print short-lived links)")
		.option("-r, --region <region>", "local (in Saudi Arabia) or global", "local")
		.option("-m, --model <id>", "Image model (default: the first available in the region)")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (prompt: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const region = parseAiRegion(options.region);
				const n = options.n === undefined ? undefined : parsePositiveInt(options.n, "--n");
				const client = getApiClient();
				const _spinner = startSpinner("Generating...");
				const { result, files } = await generateImages(client, {
					prompt,
					region,
					model: options.model,
					size: options.size,
					n,
					outDir: options.out,
					keyId: options.key ? String(options.key) : undefined,
				});
				succeedSpinner();

				if (isJsonMode()) {
					outputData({ ...result, files });
					return;
				}
				if (files.length > 0) {
					for (const file of files) {
						quietOutput(file);
						log(colors.success(`Wrote ${file}`));
					}
				} else {
					for (const image of result.data) {
						quietOutput(image.url);
						log(image.url);
					}
					const expires = result.data[0]?.expires_at;
					log(
						colors.dim(
							`${expires ? `Links expire at ${new Date(expires * 1000).toISOString()}. ` : ""}Pass -o <dir> to save the images.`,
						),
					);
				}
				printSummary(
					`${result.data.length} image${result.data.length === 1 ? "" : "s"}${result.size ? ` at ${result.size}` : ""} from ${result.model}${billedSuffix(result)}`,
				);
			} catch (err) {
				handleError(err);
			}
		});
}
