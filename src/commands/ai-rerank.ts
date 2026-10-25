import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Command } from "commander";
import { billedSuffix, printSummary } from "../lib/ai-billing.js";
import { parseAiRegion, pickModel } from "../lib/ai-catalog.js";
import { parsePositiveInt } from "../lib/ai-poll.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError, InvalidArgumentError } from "../lib/errors.js";
import { colors, isJsonMode, isQuietMode, log, outputData, quietOutput, table } from "../lib/output.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

export interface RerankResult {
	id?: string;
	model: string;
	object?: "list";
	results: Array<{ index: number; relevance_score: number }>;
	usage?: { total_tokens: number };
	billed_halalas?: number;
	request_id?: string;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/**
 * Documents from `--doc` (one each) and `--docs <file>`: a JSON array of
 * strings for a .json file, otherwise one document per non-empty line.
 */
export async function collectRerankDocuments(
	docs: string[],
	file: string | undefined,
): Promise<string[]> {
	const documents = docs.filter((doc) => doc.trim() !== "");
	if (file) {
		const content = await readFile(file, "utf8").catch(() => {
			throw new InvalidArgumentError(`Cannot read --docs ${file}.`);
		});
		if (extname(file).toLowerCase() === ".json") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(content);
			} catch {
				throw new InvalidArgumentError(`--docs ${file} is not valid JSON.`);
			}
			if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
				throw new InvalidArgumentError(`--docs ${file} must be a JSON array of strings.`);
			}
			documents.push(...parsed.filter((item) => item.trim() !== ""));
		} else {
			documents.push(...content.split(/\r?\n/).filter((line) => line.trim() !== ""));
		}
	}
	if (documents.length === 0) {
		throw new InvalidArgumentError("No documents. Pass --doc <text> (repeatable) or --docs <file>.");
	}
	return documents;
}

function preview(text: string, max = 70): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/** `tarout ai rerank`: aiGateway.rerankCreate, most relevant document first. */
export function registerAiRerankCommand(ai: Command) {
	ai.command("rerank <query>")
		.description("Order documents by relevance to a query")
		.option("--doc <text>", "A document (repeatable)", collect, [])
		.option("--docs <file>", "Documents file: one per line, or a .json array of strings")
		.option("--top <n>", "Return only the n most relevant documents")
		.option("-r, --region <region>", "local (in Saudi Arabia) or global", "local")
		.option("-m, --model <id>", "Rerank model (default: the first available in the region)")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (query: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!query.trim()) throw new InvalidArgumentError("The query is empty.");
				const documents = await collectRerankDocuments(options.doc ?? [], options.docs);
				const region = parseAiRegion(options.region);
				const top = options.top === undefined ? undefined : parsePositiveInt(options.top, "--top");
				const client = getApiClient();
				const model = await pickModel(client, "rerank", region, options.model);
				const _spinner = startSpinner("Ranking...");
				const result = (await client.aiGateway.rerankCreate.mutate({
					...(options.key ? { keyId: String(options.key) } : {}),
					request: {
						model: model.id,
						query,
						documents,
						...(top !== undefined ? { top_n: top } : {}),
						return_documents: false,
					},
				})) as RerankResult;
				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}
				if (isQuietMode()) {
					for (const item of result.results) quietOutput(String(item.index));
					return;
				}
				log("");
				table(
					["RANK", "INDEX", "SCORE", "DOCUMENT"],
					result.results.map((item, rank) => [
						String(rank + 1),
						String(item.index),
						item.relevance_score.toFixed(4),
						preview(documents[item.index] ?? ""),
					]),
				);
				log("");
				log(colors.dim("INDEX is the document's position in your input, from 0."));
				printSummary(
					`${documents.length} document${documents.length === 1 ? "" : "s"} ranked with ${result.model}${billedSuffix(result)}`,
				);
			} catch (err) {
				handleError(err);
			}
		});
}
