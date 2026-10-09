import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliError } from "../src/lib/errors.js";
import {
	buildOcrDocument,
	joinOcrPages,
	type OcrResult,
	parsePageList,
} from "../src/lib/ocr.js";

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "tarout-ocr-test-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("parsePageList", () => {
	it("turns 1-based ranges into sorted, unique 0-based indexes", () => {
		expect(parsePageList("1-3,5")).toEqual([0, 1, 2, 4]);
		expect(parsePageList("5, 2, 2")).toEqual([1, 4]);
	});

	it("rejects malformed ranges", () => {
		expect(() => parsePageList("0")).toThrow(CliError);
		expect(() => parsePageList("3-1")).toThrow(CliError);
		expect(() => parsePageList("a-b")).toThrow(CliError);
		expect(() => parsePageList(" , ")).toThrow(CliError);
	});
});

describe("buildOcrDocument", () => {
	it("passes URLs through as document_url", async () => {
		expect(await buildOcrDocument("https://example.com/a.pdf")).toEqual({
			type: "document_url",
			document_url: "https://example.com/a.pdf",
		});
	});

	it("reads local PDFs as document_url and images as image_url data URLs", async () => {
		const pdf = join(dir, "doc.pdf");
		const png = join(dir, "scan.PNG");
		await writeFile(pdf, "%PDF-1.4\n");
		await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		expect(await buildOcrDocument(pdf)).toEqual({
			type: "document_url",
			document_url: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n").toString("base64")}`,
		});
		expect(await buildOcrDocument(png)).toMatchObject({ type: "image_url" });
	});

	it("refuses missing files and unknown types", async () => {
		await expect(buildOcrDocument(join(dir, "missing.pdf"))).rejects.toThrow(/not found/);
		await expect(buildOcrDocument(join(dir, "notes.docx"))).rejects.toThrow(/Unsupported/);
	});
});

describe("joinOcrPages", () => {
	it("joins successful pages in page order", () => {
		const result = {
			pages: [
				{ index: 1, status: "ok", markdown: "# Two", text: "Two" },
				{ index: 2, status: "failed", markdown: "", text: "" },
				{ index: 0, status: "ok", markdown: "# One", text: "One" },
			],
		} as unknown as OcrResult;
		expect(joinOcrPages(result, "markdown")).toBe("# One\n\n---\n\n# Two");
		expect(joinOcrPages(result, "text")).toBe("One\n\nTwo");
	});
});
