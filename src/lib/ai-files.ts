/**
 * Moving bytes for the AI Gateway commands and MCP tools.
 *
 * tRPC bodies are capped at 4 MB, so a file never travels through tRPC:
 * `aiGateway.filesCreateUpload` returns a signed PUT URL bound to the exact
 * byte length and content type, the bytes go straight to storage, and
 * `aiGateway.filesCompleteUpload` checks the object and makes the file usable.
 * Generated media (speech, images, video) and file contents come back as
 * short-lived signed URLs, downloaded with `downloadToFile`.
 *
 * A signed URL is a bearer credential for as long as it works, so it is never
 * put in an error message.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { CliError, InvalidArgumentError } from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/** Purposes a caller may upload (`batch_output` files are written by the Batch API). */
export const AI_FILE_UPLOAD_PURPOSES = ["user_data", "assistants", "batch"] as const;
export type AiFileUploadPurpose = (typeof AI_FILE_UPLOAD_PURPOSES)[number];

/** The OpenAI `file` object the platform answers. */
export interface AiFileObject {
	id: string;
	object: "file";
	bytes: number;
	created_at: number;
	expires_at: number | null;
	filename: string;
	purpose: string;
	status: string;
	status_details: string | null;
}

interface SignedUpload {
	file_id: string;
	upload_url: string;
	method?: string;
	required_headers?: Record<string, string>;
	expires_at?: number;
}

const AI_FILE_ID = /^file-[0-9A-Za-z]{24}$/;

/** A platform file id (`file-` and 24 letters or digits). */
export function isAiFileId(value: string): boolean {
	return AI_FILE_ID.test(value);
}

export function parseUploadPurpose(value: unknown): AiFileUploadPurpose {
	const purpose = String(value ?? "").trim();
	if ((AI_FILE_UPLOAD_PURPOSES as readonly string[]).includes(purpose)) {
		return purpose as AiFileUploadPurpose;
	}
	throw new InvalidArgumentError(
		`Unknown --purpose "${value}". Use ${AI_FILE_UPLOAD_PURPOSES.join(", ")}.`,
	);
}

const CONTENT_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".markdown": "text/markdown",
	".csv": "text/csv",
	".tsv": "text/tab-separated-values",
	".html": "text/html",
	".htm": "text/html",
	".xml": "application/xml",
	".json": "application/json",
	".jsonl": "application/jsonl",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".avif": "image/avif",
	".mp3": "audio/mpeg",
	".mpga": "audio/mpeg",
	".mpeg": "audio/mpeg",
	".m4a": "audio/mp4",
	".mp4": "audio/mp4",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/opus",
	".flac": "audio/flac",
	".webm": "audio/webm",
};

/** The MIME type a file is uploaded with, from its extension. */
export function contentTypeFor(path: string): string {
	return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface UploadAiFileOptions {
	/** Delete the file this long after upload (3600 to 2592000 seconds). */
	expiresAfterSeconds?: number;
	/** Stored name; default the path's base name. */
	filename?: string;
}

/**
 * Upload a local file: create the upload, PUT the bytes to the signed URL with
 * the headers it was signed with, then complete it. Answers the processed
 * file object. The body is a Buffer so the request carries a Content-Length,
 * which the signature binds (a streamed body would go out chunked).
 */
export async function uploadAiFile(
	client: TrpcClient,
	path: string,
	purpose: AiFileUploadPurpose,
	options: UploadAiFileOptions = {},
): Promise<AiFileObject> {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) throw new CliError(`File not found: ${path}`);
	if (info.size === 0) throw new InvalidArgumentError(`${path} is empty.`);
	const body = await readFile(path);
	const filename = options.filename ?? basename(path);
	const upload = (await client.aiGateway.filesCreateUpload.mutate({
		filename,
		bytes: body.byteLength,
		contentType: contentTypeFor(path),
		purpose,
		...(options.expiresAfterSeconds !== undefined
			? { expiresAfterSeconds: options.expiresAfterSeconds }
			: {}),
	})) as SignedUpload;
	const put = await fetch(upload.upload_url, {
		method: upload.method ?? "PUT",
		headers: upload.required_headers ?? {},
		body,
	});
	// The signed PUT is create-only: 412 means an earlier PUT of this upload
	// already stored the bytes, so completing it (which checks the size) is
	// the right next step, not a retry.
	if (!put.ok && put.status !== 412) {
		await put.body?.cancel().catch(() => undefined);
		throw new CliError(
			`Uploading ${filename} failed (HTTP ${put.status}). Nothing was stored; retry the upload.`,
		);
	}
	return (await client.aiGateway.filesCompleteUpload.mutate({
		fileId: upload.file_id,
	})) as AiFileObject;
}

/**
 * Stream a signed URL to `path` (its folder is created). Written to
 * `<path>.part` first and renamed, so a failed download leaves no half file.
 * Answers the bytes written.
 */
export async function downloadToFile(url: string, path: string): Promise<number> {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		await response.body?.cancel().catch(() => undefined);
		throw new CliError(
			`Download failed (HTTP ${response.status}). The link may have expired; run the command again for a fresh one.`,
		);
	}
	await mkdir(dirname(path), { recursive: true });
	const partial = `${path}.part`;
	try {
		await pipeline(
			Readable.fromWeb(response.body as unknown as NodeReadableStream),
			createWriteStream(partial),
		);
		await rename(partial, path);
	} catch (err) {
		await rm(partial, { force: true });
		throw err;
	}
	return (await stat(path)).size;
}
