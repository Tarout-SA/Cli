import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout call` client-side failures must map to precise exit codes so an agent
 * can branch on them: an unknown/non-exposed procedure exits NOT_FOUND (4), and
 * malformed --input JSON exits INVALID_ARGUMENTS (2) — never the catch-all
 * GENERAL_ERROR (1).
 */

const m = vi.hoisted(() => ({
	manifest: [] as Array<{ path: string; type: string }>,
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getApiUrl: () => "https://tarout.sa",
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({}),
}));

vi.mock("../src/lib/surface-manifest.js", () => ({
	loadManifest: async () => m.manifest,
	fetchManifestFresh: async () => m.manifest,
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerCallCommand } from "../src/commands/call";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	setGlobalOptions(RESET);
	exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	m.manifest = [];
});

async function runCall(argv: string[]): Promise<number> {
	const program = new Command();
	program.exitOverride();
	registerCallCommand(program);
	try {
		await program.parseAsync(["node", "tarout", "call", ...argv]);
	} catch (err) {
		const match = /__EXIT_(\d+)/.exec(String(err));
		if (match) return Number(match[1]);
		throw err;
	}
	throw new Error("expected the command to exit");
}

describe("tarout call — exit codes", () => {
	it("exits NOT_FOUND (4) for an unknown procedure", async () => {
		m.manifest = [];
		expect(await runCall(["nope.missing"])).toBe(4);
	});

	it("exits INVALID_ARGUMENTS (2) for malformed --input JSON", async () => {
		m.manifest = [{ path: "application.all", type: "query" }];
		expect(await runCall(["application.all", "--input", "{bad json"])).toBe(2);
	});
});
