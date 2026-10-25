import { existsSync } from "node:fs";
import type { Command } from "commander";
import { billedSuffix, printSummary } from "../lib/ai-billing.js";
import { parseAiRegion, regionLabel } from "../lib/ai-catalog.js";
import { type AiFileObject, isAiFileId, uploadAiFile } from "../lib/ai-files.js";
import { parsePositiveInt, parseTimeoutSeconds, pollUntil } from "../lib/ai-poll.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError, InvalidArgumentError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	isQuietMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
	warn,
} from "../lib/output.js";
import { confirm } from "../utils/prompts.js";
import { startSpinner, succeedSpinner, updateSpinner } from "../utils/spinner.js";
import { formatBytes, formatUnixTime } from "./ai-files.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export interface VectorStore {
	id: string;
	object: "vector_store";
	created_at: number;
	name: string | null;
	description: string | null;
	usage_bytes: number;
	file_counts: {
		in_progress: number;
		completed: number;
		failed: number;
		cancelled: number;
		total: number;
	};
	status: string;
	expires_after: { anchor: string; days: number } | null;
	expires_at: number | null;
	last_active_at: number;
	metadata: Record<string, string>;
	region: "local" | "global";
}

export interface VectorStoreFile {
	id: string;
	object: "vector_store.file";
	usage_bytes: number;
	created_at: number;
	vector_store_id: string;
	status: "in_progress" | "completed" | "failed" | "cancelled";
	last_error: { code: string; message: string } | null;
	attributes: Record<string, string | number | boolean>;
	region: "local" | "global";
}

export interface VectorSearchPage {
	object: string;
	search_query: string | string[];
	data: Array<{
		file_id: string;
		filename: string;
		score: number;
		attributes: Record<string, unknown>;
		content: Array<{ type: string; text: string }>;
	}>;
	billed_halalas?: number;
	request_id?: string;
}

const INDEX_POLL_INTERVAL_MS = 3_000;
const DEFAULT_INDEX_TIMEOUT_SECONDS = 600;
const STORE_FILE_STATUSES = ["in_progress", "completed", "failed", "cancelled"] as const;

/** Every file of a store (pages of 100). */
export async function listAllStoreFiles(
	client: TrpcClient,
	vectorStoreId: string,
): Promise<VectorStoreFile[]> {
	const files: VectorStoreFile[] = [];
	let after: string | undefined;
	for (let page = 0; page < 100; page++) {
		const result = (await client.aiGateway.vectorStoreFilesList.query({
			vectorStoreId,
			limit: 100,
			...(after ? { after } : {}),
		})) as { data: VectorStoreFile[]; has_more?: boolean; last_id?: string | null };
		files.push(...(result.data ?? []));
		if (!result.has_more || !result.last_id) break;
		after = result.last_id;
	}
	return files;
}

export interface AddFilesResult {
	uploaded: AiFileObject[];
	files: VectorStoreFile[];
	timedOut: boolean;
}

/**
 * Shared by `tarout ai vector-stores add` and the `ai_vector_store_add_files`
 * MCP tool. Each source is a file id (`file-...`) or a local path, uploaded
 * first (purpose assistants). Files are indexed in the background; with
 * `wait`, polls until none of them is still in progress.
 */
export async function addFilesToVectorStore(
	client: TrpcClient,
	vectorStoreId: string,
	sources: string[],
	options: { keyId?: string; wait?: boolean; timeoutMs?: number; onProgress?: (text: string) => void },
): Promise<AddFilesResult> {
	if (sources.length === 0) throw new InvalidArgumentError("Name at least one file path or file id.");
	const uploaded: AiFileObject[] = [];
	const fileIds: string[] = [];
	for (const source of sources) {
		if (isAiFileId(source) && !existsSync(source)) {
			fileIds.push(source);
			continue;
		}
		options.onProgress?.(`Uploading ${source}...`);
		const file = await uploadAiFile(client, source, "assistants");
		uploaded.push(file);
		fileIds.push(file.id);
	}
	let files: VectorStoreFile[] = [];
	for (const fileId of fileIds) {
		options.onProgress?.(`Adding ${fileId}...`);
		files.push(
			(await client.aiGateway.vectorStoreFilesAdd.mutate({
				...(options.keyId ? { keyId: options.keyId } : {}),
				vectorStoreId,
				fileId,
			})) as VectorStoreFile,
		);
	}
	if (!options.wait) return { uploaded, files, timedOut: false };

	const wanted = new Set(fileIds);
	const { value, timedOut } = await pollUntil(
		async () => (await listAllStoreFiles(client, vectorStoreId)).filter((file) => wanted.has(file.id)),
		(current) => current.every((file) => file.status !== "in_progress"),
		{
			intervalMs: INDEX_POLL_INTERVAL_MS,
			timeoutMs: options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_SECONDS * 1000,
			onTick: (current) => {
				const done = current.filter((file) => file.status !== "in_progress").length;
				options.onProgress?.(`Indexing: ${done} of ${wanted.size} done`);
			},
		},
	);
	files = value;
	return { uploaded, files, timedOut };
}

export interface SearchInput {
	query: string;
	maxNumResults?: number;
	scoreThreshold?: number;
	rewriteQuery?: boolean;
	keyId?: string;
}

/** Search one store (aiGateway.vectorStoresSearch); bills its embedding and any rerank calls. */
export async function searchVectorStore(
	client: TrpcClient,
	vectorStoreId: string,
	input: SearchInput,
): Promise<VectorSearchPage> {
	if (!input.query.trim()) throw new InvalidArgumentError("The query is empty.");
	return (await client.aiGateway.vectorStoresSearch.mutate({
		...(input.keyId ? { keyId: input.keyId } : {}),
		vectorStoreId,
		query: input.query,
		...(input.maxNumResults !== undefined ? { maxNumResults: input.maxNumResults } : {}),
		...(input.rewriteQuery ? { rewriteQuery: true } : {}),
		...(input.scoreThreshold !== undefined
			? { rankingOptions: { score_threshold: input.scoreThreshold } }
			: {}),
	})) as VectorSearchPage;
}

export function parseThreshold(value: unknown): number {
	const threshold = Number(value);
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
		throw new InvalidArgumentError(`Invalid --threshold "${value}". Pass a number from 0 to 1.`);
	}
	return threshold;
}

function printStore(store: VectorStore): void {
	const counts = store.file_counts;
	log("");
	log(colors.bold(store.name || store.id));
	log(`  ID: ${colors.cyan(store.id)}`);
	log(`  Region: ${regionLabel(store.region)}`);
	log(`  Status: ${store.status}`);
	log(
		`  Files: ${counts.total} (${counts.completed} ready, ${counts.in_progress} indexing, ${counts.failed} failed)`,
	);
	log(`  Size: ${formatBytes(store.usage_bytes)}`);
	if (store.expires_at) log(`  Expires: ${formatUnixTime(store.expires_at)}`);
	log("");
}

function preview(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/**
 * `tarout ai vector-stores`: file search. A store indexes uploaded files in
 * its region (local stays in Saudi Arabia); indexing and search bill their
 * embedding and rerank calls, and storage is billed per GB-day.
 */
export function registerAiVectorStoresCommand(ai: Command) {
	const stores = ai
		.command("vector-stores")
		.alias("vs")
		.description("Index files and search them (file search)");

	stores
		.command("create [name]")
		.description("Create a vector store")
		.option("-r, --region <region>", "local (files processed in Saudi Arabia) or global", "local")
		.option("--expires-after-days <n>", "Delete the store after this many days without use")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (name: string | undefined, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const region = parseAiRegion(options.region);
				const expiresAfterDays =
					options.expiresAfterDays === undefined
						? undefined
						: parsePositiveInt(options.expiresAfterDays, "--expires-after-days");
				const _spinner = startSpinner("Creating vector store...");
				const store = (await getApiClient().aiGateway.vectorStoresCreate.mutate({
					...(options.key ? { keyId: String(options.key) } : {}),
					...(name ? { name } : {}),
					region,
					...(expiresAfterDays !== undefined ? { expiresAfterDays } : {}),
				})) as VectorStore;
				succeedSpinner("Vector store created.");
				if (isJsonMode()) {
					outputData(store);
					return;
				}
				quietOutput(store.id);
				printStore(store);
				log(`Add files: ${colors.cyan(`tarout ai vector-stores add ${store.id} <path...> --wait`)}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	stores
		.command("list")
		.alias("ls")
		.description("List vector stores")
		.option("-n, --limit <n>", "How many (1 to 100)", "100")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const limit = parsePositiveInt(options.limit, "--limit", 100);
				const _spinner = startSpinner("Fetching vector stores...");
				const page = (await getApiClient().aiGateway.vectorStoresList.query({
					limit,
				})) as { data: VectorStore[]; has_more?: boolean };
				succeedSpinner();
				if (isJsonMode()) {
					outputData(page);
					return;
				}
				const items = page.data ?? [];
				if (items.length === 0) {
					log("\nNo vector stores.\n");
					return;
				}
				log("");
				table(
					["ID", "NAME", "REGION", "FILES", "SIZE", "STATUS"],
					items.map((store) => [
						colors.cyan(store.id),
						store.name ?? "-",
						regionLabel(store.region),
						String(store.file_counts?.total ?? 0),
						formatBytes(store.usage_bytes ?? 0),
						store.status,
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	stores
		.command("get <vectorStoreId>")
		.description("Show one vector store")
		.action(async (vectorStoreId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const _spinner = startSpinner("Fetching vector store...");
				const store = (await getApiClient().aiGateway.vectorStoresRetrieve.query({
					vectorStoreId,
				})) as VectorStore;
				succeedSpinner();
				if (isJsonMode()) {
					outputData(store);
					return;
				}
				quietOutput(store.id);
				printStore(store);
			} catch (err) {
				handleError(err);
			}
		});

	stores
		.command("rm <vectorStoreId>")
		.alias("delete")
		.description("Delete a vector store and its index (its files are kept)")
		.action(async (vectorStoreId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Delete vector store ${vectorStoreId}? Its index is deleted and search stops working; the uploaded files are kept.`,
						false,
						{
							field: "confirm_delete_vector_store",
							flag: "--yes",
							context: { vectorStoreId },
						},
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const _spinner = startSpinner("Deleting vector store...");
				const result = await getApiClient().aiGateway.vectorStoresDelete.mutate({ vectorStoreId });
				succeedSpinner("Vector store deleted.");
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				quietOutput(vectorStoreId);
			} catch (err) {
				handleError(err);
			}
		});

	stores
		.command("add <vectorStoreId> <files...>")
		.description("Add files to a store: local paths (uploaded first) or file ids")
		.option("--wait", "Wait until the files are indexed")
		.option("--timeout <seconds>", "Longest to wait with --wait", String(DEFAULT_INDEX_TIMEOUT_SECONDS))
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (vectorStoreId: string, sources: string[], options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const timeoutMs = parseTimeoutSeconds(options.timeout);
				const _spinner = startSpinner("Adding files...");
				const result = await addFilesToVectorStore(getApiClient(), vectorStoreId, sources, {
					keyId: options.key ? String(options.key) : undefined,
					wait: options.wait === true,
					timeoutMs,
					onProgress: (text) => updateSpinner(text),
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				if (isQuietMode()) {
					for (const file of result.files) quietOutput(file.id);
				} else {
					log("");
					table(
						["FILE", "STATUS", "ERROR"],
						result.files.map((file) => [
							colors.cyan(file.id),
							file.status,
							file.last_error?.message ?? "",
						]),
					);
					log("");
				}
				const failed = result.files.filter((file) => file.status === "failed");
				if (result.timedOut) {
					warn(
						`Some files are still indexing. Check with \`tarout ai vector-stores files ${vectorStoreId}\`.`,
					);
				} else if (!options.wait) {
					log(colors.dim("Files are indexed in the background. Pass --wait to wait for them."));
				}
				if (failed.length > 0) {
					throw new CliError(
						`${failed.length} file${failed.length === 1 ? "" : "s"} could not be indexed; see the ERROR column. Failed indexing is not charged.`,
						undefined,
						undefined,
						{ failed: failed.map((file) => ({ id: file.id, error: file.last_error })) },
					);
				}
			} catch (err) {
				handleError(err);
			}
		});

	stores
		.command("files <vectorStoreId>")
		.description("List a store's files and their indexing status")
		.option("--status <status>", `Only this status: ${STORE_FILE_STATUSES.join(", ")}`)
		.option("-n, --limit <n>", "How many (1 to 100)", "100")
		.action(async (vectorStoreId: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (
					options.status !== undefined &&
					!(STORE_FILE_STATUSES as readonly string[]).includes(options.status)
				) {
					throw new InvalidArgumentError(
						`Unknown --status "${options.status}". Use ${STORE_FILE_STATUSES.join(", ")}.`,
					);
				}
				const limit = parsePositiveInt(options.limit, "--limit", 100);
				const _spinner = startSpinner("Fetching files...");
				const page = (await getApiClient().aiGateway.vectorStoreFilesList.query({
					vectorStoreId,
					limit,
					...(options.status ? { filter: options.status } : {}),
				})) as { data: VectorStoreFile[]; has_more?: boolean };
				succeedSpinner();
				if (isJsonMode()) {
					outputData(page);
					return;
				}
				const items = page.data ?? [];
				if (items.length === 0) {
					log("\nNo files in this store.\n");
					return;
				}
				log("");
				table(
					["FILE", "STATUS", "SIZE", "ADDED", "ERROR"],
					items.map((file) => [
						colors.cyan(file.id),
						file.status,
						formatBytes(file.usage_bytes ?? 0),
						formatUnixTime(file.created_at),
						file.last_error?.message ?? "",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	stores
		.command("search <vectorStoreId> <query>")
		.description("Search a store's files")
		.option("--max <n>", "Most results to return")
		.option("--threshold <score>", "Drop results scoring below this (0 to 1)")
		.option("--rewrite", "Let a model rewrite the query for search first")
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (vectorStoreId: string, query: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const maxNumResults =
					options.max === undefined ? undefined : parsePositiveInt(options.max, "--max");
				const scoreThreshold =
					options.threshold === undefined ? undefined : parseThreshold(options.threshold);
				const _spinner = startSpinner("Searching...");
				const page = await searchVectorStore(getApiClient(), vectorStoreId, {
					query,
					maxNumResults,
					scoreThreshold,
					rewriteQuery: options.rewrite === true,
					keyId: options.key ? String(options.key) : undefined,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(page);
					return;
				}
				const results = page.data ?? [];
				if (isQuietMode()) {
					for (const result of results) quietOutput(result.file_id);
					return;
				}
				if (results.length === 0) {
					log("\nNo matches.\n");
				} else {
					log("");
					table(
						["SCORE", "FILE", "TEXT"],
						results.map((result) => [
							result.score.toFixed(3),
							result.filename,
							preview(result.content.map((part) => part.text).join(" ")),
						]),
					);
					log("");
				}
				printSummary(`${results.length} result${results.length === 1 ? "" : "s"}${billedSuffix(page)}`);
			} catch (err) {
				handleError(err);
			}
		});
}
