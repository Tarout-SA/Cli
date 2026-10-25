import { resolve } from "node:path";
import type { Command } from "commander";
import {
	type AiFileObject,
	downloadToFile,
	parseUploadPurpose,
	uploadAiFile,
} from "../lib/ai-files.js";
import { parsePositiveInt } from "../lib/ai-poll.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError, InvalidArgumentError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm } from "../utils/prompts.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

const LIST_PURPOSES = ["user_data", "assistants", "batch", "batch_output"] as const;

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatUnixTime(seconds: number | null | undefined): string {
	if (!seconds) return "-";
	return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function printFile(file: AiFileObject): void {
	log("");
	log(colors.bold(file.filename));
	log(`  ID: ${colors.cyan(file.id)}`);
	log(`  Purpose: ${file.purpose}`);
	log(`  Size: ${formatBytes(file.bytes)}`);
	log(`  Status: ${file.status}${file.status_details ? ` (${file.status_details})` : ""}`);
	log(`  Created: ${formatUnixTime(file.created_at)}`);
	if (file.expires_at) log(`  Expires: ${formatUnixTime(file.expires_at)}`);
	log("");
}

/**
 * `tarout ai files`: the AI Gateway Files API (stored in Saudi Arabia). Files
 * feed vector stores, batches and transcription; they are not billed, only
 * counted against the organization's storage quota.
 */
export function registerAiFilesCommand(ai: Command) {
	const files = ai
		.command("files")
		.description("Upload and manage files for vector stores, batches and transcription");

	files
		.command("upload <path>")
		.description("Upload a local file")
		.option("-p, --purpose <purpose>", "user_data, assistants (vector stores) or batch", "user_data")
		.option("--expires-after <seconds>", "Delete the file automatically after this many seconds")
		.action(async (path: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const purpose = parseUploadPurpose(options.purpose);
				const expiresAfterSeconds =
					options.expiresAfter === undefined
						? undefined
						: parsePositiveInt(options.expiresAfter, "--expires-after");
				const _spinner = startSpinner("Uploading...");
				const file = await uploadAiFile(getApiClient(), path, purpose, { expiresAfterSeconds });
				succeedSpinner(`Uploaded ${file.filename}`);
				if (isJsonMode()) {
					outputData(file);
					return;
				}
				quietOutput(file.id);
				printFile(file);
			} catch (err) {
				handleError(err);
			}
		});

	files
		.command("list")
		.alias("ls")
		.description("List files, newest first")
		.option("-p, --purpose <purpose>", `Only this purpose: ${LIST_PURPOSES.join(", ")}`)
		.option("-n, --limit <n>", "How many", "100")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (
					options.purpose !== undefined &&
					!(LIST_PURPOSES as readonly string[]).includes(options.purpose)
				) {
					throw new InvalidArgumentError(
						`Unknown --purpose "${options.purpose}". Use ${LIST_PURPOSES.join(", ")}.`,
					);
				}
				const limit = parsePositiveInt(options.limit, "--limit", 10_000);
				const _spinner = startSpinner("Fetching files...");
				const page = (await getApiClient().aiGateway.filesList.query({
					...(options.purpose ? { purpose: options.purpose } : {}),
					limit,
					order: "desc",
				})) as { data: AiFileObject[]; has_more?: boolean };
				succeedSpinner();
				if (isJsonMode()) {
					outputData(page);
					return;
				}
				const items = page.data ?? [];
				if (items.length === 0) {
					log("\nNo files.\n");
					return;
				}
				log("");
				table(
					["ID", "FILENAME", "PURPOSE", "SIZE", "CREATED", "EXPIRES"],
					items.map((file) => [
						colors.cyan(file.id),
						file.filename,
						file.purpose,
						formatBytes(file.bytes),
						formatUnixTime(file.created_at),
						formatUnixTime(file.expires_at),
					]),
				);
				log("");
				if (page.has_more) log(colors.dim(`Showing ${items.length}; raise --limit for more.`));
			} catch (err) {
				handleError(err);
			}
		});

	files
		.command("get <fileId>")
		.description("Show one file")
		.action(async (fileId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const _spinner = startSpinner("Fetching file...");
				const file = (await getApiClient().aiGateway.filesRetrieve.query({
					fileId,
				})) as AiFileObject;
				succeedSpinner();
				if (isJsonMode()) {
					outputData(file);
					return;
				}
				quietOutput(file.id);
				printFile(file);
			} catch (err) {
				handleError(err);
			}
		});

	files
		.command("rm <fileId>")
		.alias("delete")
		.description("Delete a file (it is also removed from every vector store)")
		.action(async (fileId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Delete file ${fileId}? It is removed from every vector store that uses it, and cannot be recovered.`,
						false,
						{ field: "confirm_delete_ai_file", flag: "--yes", context: { fileId } },
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const _spinner = startSpinner("Deleting file...");
				const result = await getApiClient().aiGateway.filesDelete.mutate({ fileId });
				succeedSpinner("File deleted.");
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				quietOutput(fileId);
			} catch (err) {
				handleError(err);
			}
		});

	files
		.command("download <fileId>")
		.description("Save a file's contents")
		.requiredOption("-o, --out <path>", "Where to save it")
		.action(async (fileId: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const _spinner = startSpinner("Downloading...");
				const content = (await getApiClient().aiGateway.filesContentUrl.query({
					fileId,
				})) as { url: string; expires_at: number; filename: string };
				const path = resolve(String(options.out));
				const bytes = await downloadToFile(content.url, path);
				succeedSpinner();
				if (isJsonMode()) {
					outputData({ fileId, filename: content.filename, path, bytes });
					return;
				}
				quietOutput(path);
				log(colors.success(`Wrote ${path} (${formatBytes(bytes)})`));
			} catch (err) {
				handleError(err);
			}
		});
}
