import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout exec`: the argv-to-shell-line rule (checked against a real `sh -s`,
 * which is how the platform feeds the command to the container), the payload
 * sent to application.exec, exit-code propagation, the --json envelope, the
 * -i/-t refusal and the NEEDS_APPROVAL path.
 */

const APPROVAL_MESSAGE =
	'NEEDS_APPROVAL:pa_123abc: The destructive action "application.exec" requires human approval for this API key. An approval request (id: pa_123abc) is now waiting in the Tarout dashboard under Agent > Approvals.';

const m = vi.hoisted(() => ({
	linked: null as null | { applicationId: string; name: string },
	execResult: {
		exitCode: 0,
		stdout: "",
		stderr: "",
		truncated: false,
		timedOut: false,
		durationMs: 12,
	} as Record<string, unknown>,
	execError: null as unknown,
	execCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getApiUrl: () => "https://tarout.test",
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	isProjectLinked: () => m.linked !== null,
	getProjectConfig: () =>
		m.linked ? { ...m.linked, organizationId: "org_1", linkedAt: "x" } : null,
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		application: {
			allByOrganization: {
				query: async () => [
					{ applicationId: "app_1", name: "web", appName: "web-x1" },
					{ applicationId: "app_2", name: "api", appName: "api-y2" },
				],
			},
			exec: {
				mutate: async (input: Record<string, unknown>) => {
					m.execCalls.push(input);
					if (m.execError) throw m.execError;
					return m.execResult;
				},
			},
		},
	}),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import {
	buildExecCommand,
	EXEC_AFTER_APPROVAL_NOTE,
	execExitCode,
	quoteShellArg,
} from "../src/commands/exec";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: true,
	yes: false,
	nonInteractive: false,
};

let exitCodes: number[];
let rawOut: string[];
let rawErr: string[];
let logs: string[];
let errors: string[];

/** A stream.write stand-in that records the chunk and runs the callback. */
function recordWrite(into: string[]) {
	return ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
		into.push(String(chunk));
		const done = typeof encodingOrCb === "function" ? encodingOrCb : cb;
		if (typeof done === "function") (done as () => void)();
		return true;
	}) as never;
}

beforeEach(() => {
	m.linked = { applicationId: "app_1", name: "web" };
	m.execResult = {
		exitCode: 0,
		stdout: "",
		stderr: "",
		truncated: false,
		timedOut: false,
		durationMs: 12,
	};
	m.execError = null;
	m.execCalls = [];
	exitCodes = [];
	rawOut = [];
	rawErr = [];
	logs = [];
	errors = [];
	setGlobalOptions(RESET);
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	vi.spyOn(process.stdout, "write").mockImplementation(recordWrite(rawOut));
	vi.spyOn(process.stderr, "write").mockImplementation(recordWrite(rawErr));
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		logs.push(a.map(String).join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errors.push(a.map(String).join(" "));
	});
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

async function exec(...args: string[]): Promise<void> {
	const { registerExecCommand } = await import("../src/commands/exec");
	const program = new Command();
	program.option("--json");
	registerExecCommand(program);
	try {
		await program.parseAsync(["node", "tarout", "exec", ...args]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

function jsonOutput(): Record<string, unknown> {
	expect(logs).toHaveLength(1);
	return JSON.parse(logs[0] ?? "") as Record<string, unknown>;
}

/** Run a shell line the way the platform does (`sh -s` reading it on stdin). */
function runInSh(line: string): string {
	const result = spawnSync("sh", ["-s"], { input: line, encoding: "utf8" });
	expect(result.status).toBe(0);
	return result.stdout;
}

describe("exec argv quoting", () => {
	it("leaves plainly safe words bare and single-quotes everything else", () => {
		expect(quoteShellArg("ls")).toBe("ls");
		expect(quoteShellArg("-la")).toBe("-la");
		expect(quoteShellArg("/app/src/index.js")).toBe("/app/src/index.js");
		expect(quoteShellArg("/app/my dir")).toBe("'/app/my dir'");
		expect(quoteShellArg("")).toBe("''");
		expect(quoteShellArg("$HOME")).toBe("'$HOME'");
		expect(quoteShellArg("`id`")).toBe("'`id`'");
		expect(quoteShellArg('say "hi"')).toBe(`'say "hi"'`);
		expect(quoteShellArg("it's")).toBe(`'it'"'"'s'`);
		expect(quoteShellArg("*.log")).toBe("'*.log'");
		expect(quoteShellArg("~")).toBe("'~'");
		expect(quoteShellArg("--flag=value")).toBe("'--flag=value'");
	});

	it("sends a single argument verbatim, as a shell line", () => {
		expect(buildExecCommand(["npm run migrate && echo ok"])).toBe(
			"npm run migrate && echo ok",
		);
		expect(buildExecCommand(["echo $HOME | wc -c"])).toBe("echo $HOME | wc -c");
	});

	it("quotes each of several arguments", () => {
		expect(buildExecCommand(["ls", "-la", "/app/my dir"])).toBe(
			"ls -la '/app/my dir'",
		);
		expect(buildExecCommand(["echo", "a;b", "c&&d"])).toBe("echo 'a;b' 'c&&d'");
	});

	it("keeps a leading reserved word or assignment a command name", () => {
		expect(buildExecCommand(["if", "x"])).toBe("'if' x");
		expect(buildExecCommand(["FOO=bar", "env"])).toBe("'FOO=bar' env");
		// Only the first word is in command position.
		expect(buildExecCommand(["echo", "if"])).toBe("echo if");
	});

	it("round-trips every argument exactly through sh -s", () => {
		const args = [
			"plain",
			"two words",
			"",
			"it's",
			'"double"',
			"$HOME",
			"${PATH}",
			"`id`",
			"$(whoami)",
			"a;b|c&d",
			"*",
			"~",
			"back\\slash",
			"new\nline",
			"'''",
			"--flag=value",
			"!",
			"#hash",
		];
		const line = buildExecCommand(["printf", "%s\\0", ...args]);
		expect(runInSh(line).split("\0").slice(0, -1)).toEqual(args);
	});

	it("maps the remote result to the exit status", () => {
		expect(execExitCode({ exitCode: 0, timedOut: false })).toBe(0);
		expect(execExitCode({ exitCode: 3, timedOut: false })).toBe(3);
		expect(execExitCode({ exitCode: 300, timedOut: false })).toBe(255);
		expect(execExitCode({ exitCode: -1, timedOut: false })).toBe(0);
		expect(execExitCode({ exitCode: null, timedOut: true })).toBe(124);
		expect(execExitCode({ exitCode: null, timedOut: false })).toBe(1);
	});
});

describe("tarout exec", () => {
	it("sends the quoted argv to application.exec for the linked app", async () => {
		m.execResult = { ...m.execResult, stdout: "total 0\n" };
		await exec("--", "ls", "-la", "/app/my dir");
		expect(m.execCalls).toEqual([
			{ applicationId: "app_1", command: "ls -la '/app/my dir'" },
		]);
		expect(rawOut.join("")).toBe("total 0\n");
		expect(exitCodes).toEqual([0]);
	});

	it("sends one argument verbatim and forwards --timeout", async () => {
		await exec("--timeout", "120", "--", "npm run migrate && echo ok");
		expect(m.execCalls).toEqual([
			{
				applicationId: "app_1",
				command: "npm run migrate && echo ok",
				timeoutSeconds: 120,
			},
		]);
	});

	it("resolves --app by name and keeps options after -- in the command", async () => {
		await exec("--app", "api", "--", "node", "x.js", "--json", "--app", "y");
		expect(m.execCalls).toEqual([
			{ applicationId: "app_2", command: "node x.js --json --app y" },
		]);
	});

	it("prints stdout and stderr as returned and exits with the remote code", async () => {
		m.execResult = {
			exitCode: 3,
			stdout: "partial",
			stderr: "boom\n",
			truncated: true,
			timedOut: false,
			durationMs: 1500,
		};
		await exec("--", "false");
		expect(rawOut.join("")).toBe("partial");
		const err = rawErr.join("");
		expect(err.startsWith("boom\n")).toBe(true);
		expect(err).toContain("Output was truncated");
		expect(err).toContain("exit 3 in 1.5s (web)");
		expect(exitCodes).toEqual([3]);
	});

	it("exits 124 when the command timed out", async () => {
		m.execResult = {
			exitCode: null,
			stdout: "",
			stderr: "",
			truncated: false,
			timedOut: true,
			durationMs: 60_000,
		};
		await exec("--", "sleep", "999");
		expect(rawErr.join("")).toContain("Timed out after 60s");
		expect(exitCodes).toEqual([124]);
	});

	it("keeps quiet mode to the command's own output", async () => {
		setGlobalOptions({ ...RESET, quiet: true });
		m.execResult = { ...m.execResult, stdout: "ok\n", truncated: true };
		await exec("--", "echo", "ok");
		expect(rawOut.join("")).toBe("ok\n");
		expect(rawErr.join("")).toBe("");
		expect(exitCodes).toEqual([0]);
	});

	it("prints one success envelope under --json and exits 0 even for a non-zero exit", async () => {
		setGlobalOptions({ ...RESET, json: true });
		m.execResult = {
			exitCode: 2,
			stdout: "out",
			stderr: "err",
			truncated: false,
			timedOut: false,
			durationMs: 40,
		};
		await exec("--", "ls", "/nope");
		const body = jsonOutput();
		expect(body).toEqual({
			success: true,
			data: {
				applicationId: "app_1",
				name: "web",
				command: "ls /nope",
				exitCode: 2,
				stdout: "out",
				stderr: "err",
				truncated: false,
				timedOut: false,
				durationMs: 40,
				ok: false,
			},
		});
		expect(rawOut).toEqual([]);
		// The action returns without exiting, so the process ends with 0.
		expect(exitCodes).toEqual([]);
	});

	it("refuses -it with the dashboard console link and never calls exec", async () => {
		await exec("-it");
		expect(m.execCalls).toEqual([]);
		expect(exitCodes).toEqual([2]);
		const text = errors.join("\n");
		expect(text).toContain("Application > Console");
		expect(text).toContain(
			"https://tarout.test/dashboard/application/app_1?tab=console",
		);
	});

	it("reports the -i refusal as INVALID_ARGUMENTS with consoleUrl under --json", async () => {
		setGlobalOptions({ ...RESET, json: true });
		m.linked = null;
		await exec("--interactive", "--app", "api", "--", "bash");
		expect(m.execCalls).toEqual([]);
		expect(exitCodes).toEqual([2]);
		const body = jsonOutput() as {
			success: boolean;
			error: { code: string; details: { consoleUrl: string } };
		};
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("INVALID_ARGUMENTS");
		expect(body.error.details.consoleUrl).toBe(
			"https://tarout.test/dashboard/application/app_2?tab=console",
		);
	});

	it("rejects a missing command, a bad --timeout and an over-long command locally", async () => {
		await exec();
		await exec("--timeout", "0", "--", "ls");
		await exec("--timeout", "301", "--", "ls");
		await exec("--timeout", "1.5", "--", "ls");
		await exec("--", "x".repeat(4001));
		expect(m.execCalls).toEqual([]);
		expect(exitCodes).toEqual([2, 2, 2, 2, 2]);
	});

	it("says what to do when nothing is linked and no --app is given", async () => {
		m.linked = null;
		await exec("--", "ls");
		expect(m.execCalls).toEqual([]);
		expect(exitCodes).toEqual([2]);
		expect(errors.join("\n")).toContain("tarout link");
	});

	it("prints the parked approval, the wait command and the output caveat", async () => {
		m.execError = Object.assign(new Error(APPROVAL_MESSAGE), {
			data: { code: "FORBIDDEN", reason: "needs_approval" },
		});
		await exec("--", "env");
		expect(exitCodes).toEqual([5]);
		const text = errors.join("\n");
		expect(text).toContain("NEEDS_APPROVAL:pa_123abc");
		expect(text).toContain("Next: tarout approvals wait pa_123abc");
		expect(text).toContain(EXEC_AFTER_APPROVAL_NOTE);
	});

	it("puts the approval id, wait command and caveat in the --json envelope", async () => {
		setGlobalOptions({ ...RESET, json: true });
		// No data.reason: the message prefix alone identifies a parked action.
		m.execError = Object.assign(new Error(APPROVAL_MESSAGE), {
			data: { code: "FORBIDDEN" },
		});
		await exec("--", "env");
		expect(exitCodes).toEqual([5]);
		const body = jsonOutput() as {
			success: boolean;
			error: { code: string; details: Record<string, unknown> };
		};
		expect(body.success).toBe(false);
		expect(body.error.code).toBe("FORBIDDEN");
		expect(body.error.details).toMatchObject({
			reason: "needs_approval",
			approvalId: "pa_123abc",
			nextCommand: "tarout approvals wait pa_123abc",
			afterApproval: EXEC_AFTER_APPROVAL_NOTE,
		});
	});

	it("maps a missing container (PRECONDITION_FAILED) to INVALID_ARGUMENTS", async () => {
		m.execError = Object.assign(
			new Error(
				"No running container was found for this application. Start or redeploy it, then try again.",
			),
			{ data: { code: "PRECONDITION_FAILED" } },
		);
		await exec("--", "ls");
		expect(exitCodes).toEqual([2]);
		expect(errors.join("\n")).toContain("No running container");
	});
});
