import { writeFile } from "node:fs/promises";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError } from "../lib/errors.js";
import {
	buildOcrDocument,
	joinOcrPages,
	type OcrResult,
	parsePageList,
} from "../lib/ocr.js";
import { colors, isJsonMode, log, outputData, warn } from "../lib/output.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

/**
 * `tarout ai ocr <file|url>`: Tarout OCR (aiGateway.ocrProcess). Reads a PDF,
 * scan or photo into Markdown, plain text or JSON, billed per successful page
 * to the organization's wallet through an AI Gateway key.
 */
export function registerAiOcrCommand(ai: Command) {
	ai.command("ocr <source>")
		.description("Read a PDF or image (local path or URL) into Markdown, text or JSON")
		.option("-p, --pages <list>", "Pages to read, 1-based (e.g. 1-3,5); default all")
		.option("-f, --format <format>", "md, txt or json", "md")
		.option("-o, --out <file>", "Write the result to a file instead of stdout")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.option("--latin-digits", "Convert Arabic-Indic digits to 0-9 (default: keep as printed)")
		.action(async (source: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const format = String(options.format);
				if (!["md", "txt", "json"].includes(format)) {
					throw new CliError(`Unknown format "${format}". Use md, txt or json.`);
				}

				const document = await buildOcrDocument(source);
				const _spinner = startSpinner("Reading document...");
				const result = (await getApiClient().aiGateway.ocrProcess.mutate({
					...(options.key ? { keyId: String(options.key) } : {}),
					request: {
						model: "tarout-ocr",
						document,
						...(options.pages ? { pages: parsePageList(String(options.pages)) } : {}),
						...(options.latinDigits ? { normalize: { digits: "latin" } } : {}),
					},
				})) as OcrResult;
				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				const output =
					format === "json"
						? `${JSON.stringify(result, null, 2)}\n`
						: `${joinOcrPages(result, format === "txt" ? "text" : "markdown")}\n`;
				if (options.out) {
					await writeFile(String(options.out), output, "utf8");
					log(colors.success(`Wrote ${options.out}`));
				} else {
					process.stdout.write(output);
				}

				const usage = result.usage_info;
				const summary = `${usage.pages_processed} page${usage.pages_processed === 1 ? "" : "s"} read in ${(result.latency_ms / 1000).toFixed(1)}s, billed ${(usage.billed_halalas / 100).toFixed(2)} SAR`;
				process.stderr.write(`${colors.dim(summary)}\n`);
				for (const page of result.pages.filter((item) => item.status === "failed")) {
					warn(`Page ${page.index + 1} failed and was not billed: ${page.error?.message ?? "unknown error"}`);
				}
			} catch (err) {
				handleError(err);
			}
		});
}
