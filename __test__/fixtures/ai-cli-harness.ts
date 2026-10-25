/**
 * Runs a registered command tree in-process for the AI command specs and
 * captures what it prints: console.log / console.error lines, raw
 * process.stdout / process.stderr writes, and exit codes (process.exit is
 * turned into a thrown `__EXIT_<code>`). The spec file still owns its
 * vi.mock calls (api, config, spinner, prompts).
 */
import { Command } from "commander";
import { afterEach, beforeEach, vi } from "vitest";
import { pollTiming } from "../../src/lib/ai-poll";
import { setGlobalOptions } from "../../src/lib/output";

export const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
const ANSI = /\x1b\[[0-9;]*m/g;

export function cliHarness(register: (program: Command) => void) {
	const state = {
		stdout: [] as string[],
		stderr: [] as string[],
		exitCodes: [] as number[],
		sleeps: [] as number[],
	};

	beforeEach(() => {
		state.stdout = [];
		state.stderr = [];
		state.exitCodes = [];
		state.sleeps = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			state.stdout.push(a.map(String).join(" ").replace(ANSI, ""));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			state.stderr.push(a.map(String).join(" ").replace(ANSI, ""));
		});
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			state.stdout.push(String(chunk).replace(ANSI, ""));
			return true;
		}) as never);
		vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
			state.stderr.push(String(chunk).replace(ANSI, ""));
			return true;
		}) as never);
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			state.exitCodes.push(code ?? 0);
			throw new Error(`__EXIT_${code ?? 0}`);
		}) as never);
		// Polls never really wait in specs.
		vi.spyOn(pollTiming, "sleep").mockImplementation(async (ms: number) => {
			state.sleeps.push(ms);
		});
	});

	afterEach(() => {
		setGlobalOptions(RESET);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function run(argv: string[], opts: Partial<typeof RESET> = {}): Promise<void> {
		setGlobalOptions({ ...RESET, noColor: true, ...opts });
		const program = new Command();
		program.exitOverride();
		register(program);
		try {
			await program.parseAsync(["node", "tarout", ...argv]);
		} catch (err) {
			const code = (err as { code?: unknown }).code;
			if (typeof code === "string" && code.startsWith("commander.")) {
				state.exitCodes.push((err as { exitCode?: number }).exitCode ?? 1);
				return;
			}
			if (/__EXIT_/.test(String(err))) return;
			throw err;
		}
	}

	return {
		state,
		run,
		out: () => state.stdout.join("\n"),
		err: () => state.stderr.join("\n"),
	};
}
