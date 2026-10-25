import { readFile, writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { billedSuffix, printSummary } from "../lib/ai-billing.js";
import { parseAiRegion, pickModel } from "../lib/ai-catalog.js";
import { parsePositiveInt } from "../lib/ai-poll.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError, InvalidArgumentError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData } from "../lib/output.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

export interface EmbeddingsResult {
	object: "list";
	data: Array<{ object: "embedding"; index: number; embedding: number[] | string }>;
	model: string;
	usage: { prompt_tokens: number; total_tokens: number };
	billed_halalas?: number;
	request_id?: string;
}

/** Inputs from the arguments (one each) and `--file` (one per non-empty line). */
export async function collectEmbeddingInputs(
	texts: string[],
	file: string | undefined,
): Promise<string[]> {
	const inputs = texts.filter((text) => text.trim() !== "");
	if (file) {
		const content = await readFile(file, "utf8").catch(() => {
			throw new InvalidArgumentError(`Cannot read --file ${file}.`);
		});
		inputs.push(...content.split(/\r?\n/).filter((line) => line.trim() !== ""));
	}
	if (inputs.length === 0) {
		throw new InvalidArgumentError(
			"Nothing to embed. Pass the text as arguments (quote each input) or --file with one input per line.",
		);
	}
	return inputs;
}

/**
 * `tarout ai embed`: aiGateway.embeddingsCreate. Prints the OpenAI embeddings
 * response (vectors included) as JSON, or writes it to `--out`; a summary
 * line goes to stderr.
 */
export function registerAiEmbedCommand(ai: Command) {
	ai.command("embed [text...]")
		.description("Turn text into embedding vectors (each argument is one input)")
		.option("--file <path>", "Read inputs from a file, one per line")
		.option("-r, --region <region>", "local (in Saudi Arabia) or global", "local")
		.option("-m, --model <id>", "Embedding model (default: the first available in the region)")
		.option("--dimensions <n>", "Shorter vectors, on models that support it")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.option("-o, --out <file>", "Write the full response (vectors included) to a JSON file")
		.action(async (texts: string[], options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const inputs = await collectEmbeddingInputs(texts ?? [], options.file);
				const region = parseAiRegion(options.region);
				const dimensions =
					options.dimensions === undefined
						? undefined
						: parsePositiveInt(options.dimensions, "--dimensions");
				const client = getApiClient();
				const model = await pickModel(client, "embedding", region, options.model);
				const _spinner = startSpinner("Embedding...");
				const result = (await client.aiGateway.embeddingsCreate.mutate({
					...(options.key ? { keyId: String(options.key) } : {}),
					request: {
						model: model.id,
						input: inputs.length === 1 ? inputs[0] : inputs,
						...(dimensions !== undefined ? { dimensions } : {}),
					},
				})) as EmbeddingsResult;
				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const body = `${JSON.stringify(result, null, 2)}\n`;
				if (options.out) {
					await writeFile(String(options.out), body, "utf8");
					log(colors.success(`Wrote ${options.out}`));
				} else {
					process.stdout.write(body);
				}
				const first = result.data[0]?.embedding;
				const dims = Array.isArray(first) ? first.length : null;
				printSummary(
					`${result.data.length} input${result.data.length === 1 ? "" : "s"} embedded with ${result.model}${dims ? ` (${dims} dimensions)` : ""}, ${result.usage?.prompt_tokens ?? 0} tokens${billedSuffix(result)}`,
				);
			} catch (err) {
				handleError(err);
			}
		});
}
