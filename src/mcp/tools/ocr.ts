/**
 * Curated MCP tool for Tarout OCR.
 *
 * - ocr_process: aiGateway.ocrProcess. Takes a local `path` (read on this
 *   machine, so the agent never has to base64 a file itself) or a public
 *   `url`, and returns per-page Markdown. Billed per successful page to the
 *   organization's wallet through an AI Gateway key.
 *
 * Annotations: mutating (it spends wallet credit), not destructive.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CliError } from "../../lib/errors.js";
import { buildOcrDocument, type OcrResult } from "../../lib/ocr.js";
import { withAuth } from "../runtime.js";

export function registerOcrTools(server: McpServer): void {
	server.registerTool(
		"ocr_process",
		{
			title: "Read a document with Tarout OCR",
			description:
				"Wraps aiGateway.ocrProcess. Reads a PDF, scan or photo (Arabic and English) into per-page Markdown, plain text and tables. Pass exactly one of `path` (a local file, up to 10 MB) or `url` (public). Billed per successful page to the organization's wallet through `keyId` (default: the newest enabled AI Gateway key). Arabic-Indic digits are kept as printed unless latinDigits is true.",
			inputSchema: {
				path: z.string().optional().describe("Local file path (PDF, PNG, JPEG, WebP, TIFF, GIF, AVIF)."),
				url: z.string().url().optional().describe("Public http(s) URL of the document."),
				pages: z
					.array(z.number().int().min(0))
					.optional()
					.describe("0-based page indexes to read; default every page (at most 100)."),
				keyId: z.string().optional().describe("AI Gateway key id to bill."),
				latinDigits: z.boolean().optional().describe("Convert Arabic-Indic digits to 0-9."),
			},
		},
		async ({ path, url, pages, keyId, latinDigits }) =>
			withAuth(async (client) => {
				if (Boolean(path) === Boolean(url)) {
					throw new CliError("Pass exactly one of path or url.");
				}
				const document = await buildOcrDocument(String(path ?? url));
				const result = (await client.aiGateway.ocrProcess.mutate({
					...(keyId ? { keyId } : {}),
					request: {
						model: "tarout-ocr",
						document,
						...(pages?.length ? { pages } : {}),
						...(latinDigits ? { normalize: { digits: "latin" } } : {}),
					},
				})) as OcrResult;
				return {
					id: result.id,
					usage: result.usage_info,
					pages: result.pages.map((page) => ({
						index: page.index,
						status: page.status,
						markdown: page.markdown,
						...(page.truncated ? { truncated: true } : {}),
						...(page.error ? { error: page.error.message } : {}),
					})),
				};
			}),
	);
}
