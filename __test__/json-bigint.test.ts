import { afterEach, describe, expect, it, vi } from "vitest";
import { outputData, outputJsonLine, setGlobalOptions } from "../src/lib/output";

describe("machine-readable JSON serialization", () => {
	afterEach(() => {
		setGlobalOptions({ json: false, quiet: false });
		vi.restoreAllMocks();
	});

	it("normalizes BigInt values in final success envelopes", () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			if (typeof line === "string") lines.push(line);
		});
		setGlobalOptions({ json: true });

		expect(() => outputData({ connections: 3n })).not.toThrow();
		expect(JSON.parse(lines[0]!)).toEqual({
			success: true,
			data: { connections: "3" },
		});
	});

	it("normalizes BigInt values in streaming event lines", () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			if (typeof line === "string") lines.push(line);
		});

		expect(() => outputJsonLine({ sequence: 9n })).not.toThrow();
		expect(JSON.parse(lines[0]!)).toEqual({ sequence: "9" });
	});

	it("omits inline screenshots from machine-readable output", () => {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
			if (typeof line === "string") lines.push(line);
		});
		setGlobalOptions({ json: true });

		outputData({ screenshot: "data:image/png;base64,aGVsbG8=" });
		expect(JSON.parse(lines[0]!).data.screenshot).toBe(
			"[inline image omitted from machine-readable response]",
		);
	});
});
