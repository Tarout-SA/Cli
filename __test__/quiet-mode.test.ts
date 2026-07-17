import chalk from "chalk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	colors,
	getStatusBadge,
	setGlobalOptions,
	table,
	warn,
} from "../src/lib/output";
import { startSpinner } from "../src/utils/spinner";

/**
 * Quiet mode (`-q`) must stay machine-lean without per-command work: warnings
 * are silenced (errors still surface), tables degrade to plain tab-separated
 * rows, and spinners are no-ops — exactly like `--json`. JSON mode behavior is
 * asserted separately to prove it stays byte-identical.
 */

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

// The raw ANSI escape byte (0x1B) that chalk prefixes every SGR sequence with.
const ESC = String.fromCharCode(27);

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

describe("warn()", () => {
	it("is silent in quiet mode", () => {
		const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		setGlobalOptions({ ...RESET, quiet: true });

		warn("heads up");

		expect(outSpy).not.toHaveBeenCalled();
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("is silent in json mode", () => {
		const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		setGlobalOptions({ ...RESET, json: true });

		warn("heads up");

		expect(outSpy).not.toHaveBeenCalled();
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("routes to stderr (never stdout) in human mode", () => {
		const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		setGlobalOptions({ ...RESET, noColor: true });

		warn("heads up");

		expect(outSpy).not.toHaveBeenCalled();
		expect(errSpy).toHaveBeenCalledTimes(1);
		expect(errSpy.mock.calls[0]?.[0]).toContain("heads up");
	});
});

describe("table()", () => {
	it("prints plain tab-separated rows with no header/borders in quiet mode", () => {
		const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		setGlobalOptions({ ...RESET, quiet: true });

		table(
			["Name", "Status"],
			[
				["app-one", "running"],
				["app-two", "stopped"],
			],
		);

		expect(outSpy).toHaveBeenCalledTimes(2);
		expect(outSpy.mock.calls[0]?.[0]).toBe("app-one\trunning");
		expect(outSpy.mock.calls[1]?.[0]).toBe("app-two\tstopped");
		// No header row is emitted.
		for (const call of outSpy.mock.calls) {
			expect(call[0]).not.toContain("Name");
		}
	});

	it("strips ANSI color codes from cells in quiet mode so rows stay cut-able", () => {
		const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		// Force chalk to actually emit color codes even though the test runner's
		// stdout isn't a TTY — otherwise the human cells would carry nothing to
		// strip and the assertion would be vacuous.
		const prevLevel = chalk.level;
		chalk.level = 1;
		// noColor:false so the color helpers pass through to chalk.
		setGlobalOptions({ ...RESET, quiet: true, noColor: false });

		try {
			const cyanCell = colors.cyan("app-1234");
			const badgeCell = getStatusBadge("running");
			// Sanity: the human cells really do carry escape sequences.
			expect(cyanCell).toContain(ESC);
			expect(badgeCell).toContain(ESC);

			table(["ID", "STATUS"], [[cyanCell, badgeCell]]);

			expect(outSpy).toHaveBeenCalledTimes(1);
			const rendered = String(outSpy.mock.calls[0]?.[0]);
			// Exact plain output proves every ANSI escape was stripped, and the
			// tab separator is preserved so `cut -f1` yields the full id.
			expect(rendered).toBe("app-1234\t● running");
			expect(rendered).not.toContain(ESC);
			expect(rendered.split("\t")[0]).toBe("app-1234");
		} finally {
			chalk.level = prevLevel;
		}
	});

	it("emits nothing in json mode", () => {
		const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		setGlobalOptions({ ...RESET, json: true });

		table(["Name"], [["app-one"]]);

		expect(outSpy).not.toHaveBeenCalled();
	});

	it("renders a bordered table in human mode", () => {
		const outSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		setGlobalOptions({ ...RESET, noColor: true });

		table(["Name"], [["app-one"]]);

		expect(outSpy).toHaveBeenCalledTimes(1);
		const rendered = String(outSpy.mock.calls[0]?.[0]);
		expect(rendered).toContain("Name");
		expect(rendered).toContain("app-one");
	});
});

describe("spinner", () => {
	it("is a no-op in quiet mode", () => {
		setGlobalOptions({ ...RESET, quiet: true });
		expect(startSpinner("working...")).toBeNull();
	});

	it("is a no-op in json mode", () => {
		setGlobalOptions({ ...RESET, json: true });
		expect(startSpinner("working...")).toBeNull();
	});
});
