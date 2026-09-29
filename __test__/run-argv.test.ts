import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runArgv, signalExitCode } from "../src/lib/process";

/**
 * `runArgv` against real child processes. The child is this same Node binary,
 * and it reports back through a file (stdio is inherited, so there is no pipe
 * to read). No real signal is ever sent to the test worker: forwarding is
 * exercised by calling the listener runArgv installed.
 */

const NODE = process.execPath;
let dir: string;
let out: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "run-argv-"));
	out = join(dir, "out.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const WRITE_ARGV_AND_ENV = `require("node:fs").writeFileSync(process.env.RUN_ARGV_OUT, JSON.stringify({ argv: process.argv.slice(1), secret: process.env.RUN_ARGV_SECRET ?? null }))`;

async function waitFor(path: string): Promise<void> {
	for (let i = 0; i < 200 && !existsSync(path); i++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

describe("runArgv", () => {
	it("passes every argument through verbatim, with no shell and no splitting", async () => {
		const args = [
			"two words",
			'say "hi"',
			"it's",
			"$HOME",
			"*",
			"",
			"a;b && c | d",
			"--json",
			"--",
		];
		const result = await runArgv(NODE, ["-e", WRITE_ARGV_AND_ENV, ...args], {
			env: { RUN_ARGV_OUT: out, RUN_ARGV_SECRET: "injected" },
			cwd: dir,
		});
		expect(result).toEqual({ exitCode: 0, signal: null });
		const seen = JSON.parse(readFileSync(out, "utf8"));
		expect(seen.argv).toEqual(args);
		expect(seen.secret).toBe("injected");
	});

	it("propagates the child's exit code unchanged", async () => {
		for (const code of [2, 3, 7, 12]) {
			const result = await runArgv(NODE, ["-e", `process.exit(${code})`]);
			expect(result).toEqual({ exitCode: code, signal: null });
		}
	});

	it("reports a signal death as 128 + the signal number", async () => {
		const result = await runArgv(NODE, [
			"-e",
			'process.kill(process.pid, "SIGTERM")',
		]);
		expect(result.signal).toBe("SIGTERM");
		expect(result.exitCode).toBe(143);
		expect(signalExitCode("SIGINT")).toBe(130);
		expect(signalExitCode(null)).toBe(1);
	});

	it("returns 127 with the error when the command does not exist", async () => {
		const result = await runArgv("tarout-definitely-not-a-command", ["x"]);
		expect(result.exitCode).toBe(127);
		expect(result.signal).toBeNull();
		expect(result.error?.code).toBe("ENOENT");
	});

	it("forwards SIGINT and SIGTERM to the child and removes its listeners afterwards", async () => {
		const ready = join(dir, "ready");
		const got = join(dir, "got");
		const beforeInt = process.listeners("SIGINT");
		const beforeTerm = process.listenerCount("SIGTERM");
		const script = [
			'const fs = require("node:fs");',
			`process.on("SIGINT", () => { fs.writeFileSync(${JSON.stringify(got)}, "SIGINT"); process.exit(42); });`,
			`fs.writeFileSync(${JSON.stringify(ready)}, "1");`,
			"setInterval(() => {}, 1000);",
		].join("\n");

		const running = runArgv(NODE, ["-e", script]);
		const added = process
			.listeners("SIGINT")
			.filter((listener) => !beforeInt.includes(listener));
		expect(added).toHaveLength(1);
		expect(process.listenerCount("SIGTERM")).toBe(beforeTerm + 1);

		await waitFor(ready);
		(added[0] as () => void)();
		const result = await running;

		expect(readFileSync(got, "utf8")).toBe("SIGINT");
		expect(result).toEqual({ exitCode: 42, signal: null });
		expect(process.listeners("SIGINT")).toEqual(beforeInt);
		expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
	});
});
