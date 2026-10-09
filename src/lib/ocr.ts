/**
 * Shared by `tarout ai ocr` and the `ocr_process` MCP tool: turn a local path
 * or a public URL into the `document` field of a Tarout OCR request, and parse
 * human page lists ("1-3,5", 1-based) into the API's 0-based indexes.
 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { CliError } from "./errors.js";

export const OCR_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".tif": "image/tiff",
	".tiff": "image/tiff",
	".gif": "image/gif",
	".avif": "image/avif",
};

export type OcrDocument =
	| { type: "document_url"; document_url: string }
	| { type: "image_url"; image_url: string };

export interface OcrPage {
	index: number;
	status: "ok" | "failed";
	markdown: string;
	text: string;
	tables: Array<{ format: string; rows: string[][] }>;
	truncated: boolean;
	error?: { code: string; message: string };
}

export interface OcrResult {
	id: string;
	model: string;
	pages: OcrPage[];
	usage_info: {
		pages_processed: number;
		pages_failed: number;
		doc_size_bytes: number;
		billed_halalas: number;
	};
	latency_ms: number;
}

export async function buildOcrDocument(source: string): Promise<OcrDocument> {
	if (/^https?:\/\//i.test(source)) {
		return { type: "document_url", document_url: source };
	}
	const mime = MIME_BY_EXTENSION[extname(source).toLowerCase()];
	if (!mime) {
		throw new CliError(
			`Unsupported file type: ${source}. Use a PDF, PNG, JPEG, WebP, TIFF, GIF or AVIF file.`,
		);
	}
	const info = await stat(source).catch(() => null);
	if (!info?.isFile()) throw new CliError(`File not found: ${source}`);
	if (info.size > OCR_MAX_DOCUMENT_BYTES) {
		throw new CliError(
			`${source} is larger than 10 MB. Split it, or pass a public URL with a smaller page range (--pages).`,
		);
	}
	const dataUrl = `data:${mime};base64,${(await readFile(source)).toString("base64")}`;
	return mime === "application/pdf"
		? { type: "document_url", document_url: dataUrl }
		: { type: "image_url", image_url: dataUrl };
}

/** "1-3,5" (1-based, inclusive) to [0, 1, 2, 4]. */
export function parsePageList(spec: string): number[] {
	const pages = new Set<number>();
	for (const part of spec.split(",").map((item) => item.trim()).filter(Boolean)) {
		const range = /^(\d+)(?:-(\d+))?$/.exec(part);
		if (!range) throw new CliError(`Invalid page range "${part}". Use e.g. 1-3,5.`);
		const start = Number(range[1]);
		const end = Number(range[2] ?? range[1]);
		if (start < 1 || end < start) throw new CliError(`Invalid page range "${part}".`);
		for (let page = start; page <= end; page++) pages.add(page - 1);
	}
	if (pages.size === 0) throw new CliError("No pages given.");
	return [...pages].sort((a, b) => a - b);
}

export function joinOcrPages(result: OcrResult, field: "markdown" | "text"): string {
	return result.pages
		.filter((page) => page.status === "ok")
		.sort((a, b) => a.index - b.index)
		.map((page) => page[field])
		.join(field === "markdown" ? "\n\n---\n\n" : "\n\n");
}
