import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { type AiFileObject, downloadToFile, isAiFileId, uploadAiFile } from "../lib/ai-files.js";
import { parsePositiveInt, parseTimeoutSeconds, pollUntil } from "../lib/ai-poll.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError, InvalidArgumentError } from "../lib/errors.js";
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
import { startSpinner, succeedSpinner, updateSpinner } from "../utils/spinner.js";
import { formatUnixTime } from "./ai-files.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/** The endpoints a batch line may call. */
export const BATCH_ENDPOINTS = [
	"/v1/chat/completions",
	"/v1/embeddings",
	"/v1/responses",
	"/v1/moderations",
	"/v1/images/generations",
] as const;

const TERMINAL_STATUSES = ["failed", "completed", "expired", "cancelled"];
const BATCH_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_TIMEOUT_SECONDS = 3600;

/** The OpenAI `batch` object. */
export interface Batch {
	id: string;
	object: "batch";
	endpoint: string;
	errors: { object: "list"; data: Array<{ code: string; message: string; line?: number }> } | null;
	input_file_id: string;
	completion_window: string;
	status: string;
	output_file_id: string | null;
	error_file_id: string | null;
	created_at: number;
	expires_at: number;
	completed_at: number | null;
	request_counts: { total: number; completed: number; failed: number };
	metadata: Record<string, string>;
}

/** `chat/completions`, `/chat/completions` or `/v1/chat/completions`: the API path. */
export function parseBatchEndpoint(value: unknown): (typeof BATCH_ENDPOINTS)[number] {
	const path = String(value ?? "")
		.trim()
		.replace(/^\/+/, "")
		.replace(/^v1\//, "");
	const endpoint = `/v1/${path}`;
	if ((BATCH_ENDPOINTS as readonly string[]).includes(endpoint)) {
		return endpoint as (typeof BATCH_ENDPOINTS)[number];
	}
	throw new InvalidArgumentError(
		`Unknown --endpoint "${value}". Use one of: ${BATCH_ENDPOINTS.join(", ")}.`,
	);
}

/** `key=value` pairs to a metadata record. */
export function parseMetadata(pairs: string[]): Record<string, string> | undefined {
	if (pairs.length === 0) return undefined;
	const metadata: Record<string, string> = {};
	for (const pair of pairs) {
		const at = pair.indexOf("=");
		if (at <= 0) throw new InvalidArgumentError(`Invalid --metadata "${pair}". Use key=value.`);
		metadata[pair.slice(0, at)] = pair.slice(at + 1);
	}
	return metadata;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function isBatchDone(batch: Batch): boolean {
	return TERMINAL_STATUSES.includes(batch.status);
}

export interface CreateBatchInput {
	/** A local JSONL file (uploaded with purpose batch) or an uploaded file id. */
	input: string;
	endpoint: (typeof BATCH_ENDPOINTS)[number];
	metadata?: Record<string, string>;
	keyId?: string;
}

/**
 * Shared by `tarout ai batches create` and the `ai_batch_create` MCP tool:
 * upload the JSONL when it is a local file, then aiGateway.batchesCreate.
 * Lines run within 24 hours, each billed as it runs at the normal price.
 */
export async function createBatch(
	client: TrpcClient,
	input: CreateBatchInput,
): Promise<{ batch: Batch; uploaded: AiFileObject | null }> {
	let inputFileId = input.input;
	let uploaded: AiFileObject | null = null;
	if (!(isAiFileId(input.input) && !existsSync(input.input))) {
		uploaded = await uploadAiFile(client, input.input, "batch");
		inputFileId = uploaded.id;
	}
	const batch = (await client.aiGateway.batchesCreate.mutate({
		...(input.keyId ? { keyId: input.keyId } : {}),
		inputFileId,
		endpoint: input.endpoint,
		completionWindow: "24h",
		...(input.metadata ? { metadata: input.metadata } : {}),
	})) as Batch;
	return { batch, uploaded };
}

export async function getBatch(client: TrpcClient, batchId: string): Promise<Batch> {
	return (await client.aiGateway.batchesRetrieve.query({ batchId })) as Batch;
}

function describeCounts(batch: Batch): string {
	const counts = batch.request_counts;
	return counts
		? `${counts.completed} done, ${counts.failed} failed of ${counts.total}`
		: "no lines counted yet";
}

function printBatch(batch: Batch): void {
	log("");
	log(colors.bold(batch.id));
	log(`  Status: ${batch.status}`);
	log(`  Endpoint: ${batch.endpoint}`);
	log(`  Lines: ${describeCounts(batch)}`);
	log(`  Input file: ${batch.input_file_id}`);
	if (batch.output_file_id) log(`  Output file: ${batch.output_file_id}`);
	if (batch.error_file_id) log(`  Error file: ${batch.error_file_id}`);
	log(`  Created: ${formatUnixTime(batch.created_at)}`);
	if (!isBatchDone(batch)) log(`  Expires: ${formatUnixTime(batch.expires_at)}`);
	for (const error of batch.errors?.data ?? []) {
		log(colors.error(`  ${error.line ? `Line ${error.line}: ` : ""}${error.message}`));
	}
	log("");
}

async function downloadFileContent(client: TrpcClient, fileId: string, path: string) {
	const content = (await client.aiGateway.filesContentUrl.query({ fileId })) as {
		url: string;
	};
	const target = resolve(path);
	return { path: target, bytes: await downloadToFile(content.url, target) };
}

/**
 * `tarout ai batches`: the Batch API. A JSONL file of requests runs on
 * Tarout's workers within 24 hours; every line is billed as it runs at the
 * normal price (there is no batch discount), and results come back as files.
 */
export function registerAiBatchesCommand(ai: Command) {
	const batches = ai
		.command("batches")
		.description("Run a JSONL file of AI requests in the background (Batch API)");

	batches
		.command("create <input>")
		.description("Start a batch from a local .jsonl file or an uploaded file id")
		.requiredOption(
			"-e, --endpoint <path>",
			"What every line calls: chat/completions, embeddings, responses, moderations or images/generations",
		)
		.option("--metadata <key=value>", "Label the batch (repeatable)", collect, [])
		.option("--wait", "Wait until the batch finishes")
		.option("--timeout <seconds>", "Longest to wait with --wait", String(DEFAULT_BATCH_TIMEOUT_SECONDS))
		.option("-k, --key <keyId>", "AI Gateway key id to bill (default: the newest enabled key)")
		.action(async (input: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const endpoint = parseBatchEndpoint(options.endpoint);
				const metadata = parseMetadata(options.metadata ?? []);
				const timeoutMs = parseTimeoutSeconds(options.timeout);
				const keyId = options.key ? String(options.key) : undefined;
				const client = getApiClient();
				const _spinner = startSpinner("Creating batch...");
				let { batch } = await createBatch(client, { input, endpoint, metadata, keyId });
				if (options.wait === true) {
					const polled = await pollUntil(() => getBatch(client, batch.id), isBatchDone, {
						intervalMs: BATCH_POLL_INTERVAL_MS,
						timeoutMs,
						onTick: (current) => updateSpinner(`Batch ${current.status}: ${describeCounts(current)}`),
					});
					batch = polled.value;
					if (polled.timedOut) {
						throw new CliError(
							`Batch ${batch.id} is still ${batch.status} (${describeCounts(batch)}). It keeps running; check it with \`tarout ai batches get ${batch.id}\`.`,
							undefined,
							undefined,
							{ batchId: batch.id, status: batch.status, nextCommand: `tarout ai batches get ${batch.id}` },
						);
					}
				}
				succeedSpinner(options.wait === true ? `Batch ${batch.status}.` : `Batch ${batch.id} created.`);
				if (isJsonMode()) {
					outputData(batch);
					return;
				}
				quietOutput(batch.id);
				printBatch(batch);
				if (batch.output_file_id || batch.error_file_id) {
					log(`Results: ${colors.cyan(`tarout ai batches results ${batch.id} -o results.jsonl`)}`);
				} else if (!isBatchDone(batch)) {
					log(`Check it: ${colors.cyan(`tarout ai batches get ${batch.id}`)}`);
				}
				log("");
				if (batch.status === "failed") {
					throw new CliError(`Batch ${batch.id} failed; see the errors above.`);
				}
			} catch (err) {
				handleError(err);
			}
		});

	batches
		.command("list")
		.alias("ls")
		.description("List batches, newest first")
		.option("-n, --limit <n>", "How many (1 to 100)", "20")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const limit = parsePositiveInt(options.limit, "--limit", 100);
				const _spinner = startSpinner("Fetching batches...");
				const page = (await getApiClient().aiGateway.batchesList.query({ limit })) as {
					data: Batch[];
					has_more?: boolean;
				};
				succeedSpinner();
				if (isJsonMode()) {
					outputData(page);
					return;
				}
				const items = page.data ?? [];
				if (items.length === 0) {
					log("\nNo batches.\n");
					return;
				}
				log("");
				table(
					["ID", "STATUS", "ENDPOINT", "LINES", "CREATED"],
					items.map((batch) => [
						colors.cyan(batch.id),
						batch.status,
						batch.endpoint,
						describeCounts(batch),
						formatUnixTime(batch.created_at),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	batches
		.command("get <batchId>")
		.description("Show a batch's status and result files")
		.action(async (batchId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const _spinner = startSpinner("Fetching batch...");
				const batch = await getBatch(getApiClient(), batchId);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(batch);
					return;
				}
				quietOutput(batch.status);
				printBatch(batch);
			} catch (err) {
				handleError(err);
			}
		});

	batches
		.command("cancel <batchId>")
		.description("Cancel a batch: lines already running finish, the rest never run")
		.action(async (batchId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Cancel batch ${batchId}? Lines that have not run yet will not run (and are not charged); results so far are kept.`,
						false,
						{ field: "confirm_cancel_batch", flag: "--yes", context: { batchId } },
					);
					if (!ok) {
						log("Not cancelled.");
						return;
					}
				}
				const _spinner = startSpinner("Cancelling batch...");
				const batch = (await getApiClient().aiGateway.batchesCancel.mutate({ batchId })) as Batch;
				succeedSpinner(`Batch ${batch.status}.`);
				if (isJsonMode()) {
					outputData(batch);
					return;
				}
				quietOutput(batch.id);
			} catch (err) {
				handleError(err);
			}
		});

	batches
		.command("results <batchId>")
		.description("Save a batch's output file (and, with --errors, its error file)")
		.requiredOption("-o, --out <file>", "Where to save the output JSONL")
		.option("--errors <file>", "Also save the error JSONL here")
		.action(async (batchId: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching results...");
				const batch = await getBatch(client, batchId);
				if (!batch.output_file_id && !(options.errors && batch.error_file_id)) {
					throw new CliError(
						isBatchDone(batch)
							? `Batch ${batchId} has no output file${batch.error_file_id ? `; its lines all failed, save them with --errors <file>` : ""}.`
							: `Batch ${batchId} is still ${batch.status}; results are written when it finishes.`,
						undefined,
						undefined,
						{ batchId, status: batch.status },
					);
				}
				const saved: Array<{ kind: "output" | "errors"; path: string; bytes: number }> = [];
				if (batch.output_file_id) {
					saved.push({
						kind: "output",
						...(await downloadFileContent(client, batch.output_file_id, String(options.out))),
					});
				}
				if (options.errors && batch.error_file_id) {
					saved.push({
						kind: "errors",
						...(await downloadFileContent(client, batch.error_file_id, String(options.errors))),
					});
				}
				succeedSpinner();
				if (isJsonMode()) {
					outputData({ batchId, status: batch.status, files: saved });
					return;
				}
				for (const file of saved) {
					quietOutput(file.path);
					log(colors.success(`Wrote ${file.path} (${file.bytes} bytes, ${file.kind})`));
				}
				if (batch.error_file_id && !options.errors) {
					log(colors.dim(`Some lines failed. Save them with --errors <file>.`));
				}
			} catch (err) {
				handleError(err);
			}
		});
}
