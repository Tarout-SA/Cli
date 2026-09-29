/**
 * @fileoverview `tarout exec -- <command...>`: run ONE command inside the
 * application's running container through the platform's `application.exec`
 * and print what came back. It is a single request, not a stream: the output
 * arrives when the command finishes (or hits --timeout), and the platform caps
 * each stream at its first 4,000 and last 8,000 characters.
 *
 * Owners and admins only. An operator-tier agent key gets the call parked for
 * human approval (NEEDS_APPROVAL), and an approved run's output is never
 * returned to the agent: the approval records only "executed" or "failed".
 *
 * The interactive console is a dashboard feature (a WebSocket that refuses API
 * keys), so `-i`/`-t` print where it is instead of trying to open it.
 * @module commands/exec
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getApiUrl, getProjectConfig, isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	handleError,
	InvalidArgumentError,
	rejectionReasonFromMessage,
	staleCredentialGuidance,
} from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	isQuietMode,
	outputData,
	outputError,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { startSpinner, stopSpinner } from "../utils/spinner.js";
import { resolveRunApp } from "./run.js";

/** The platform's limit on one command (`apiExecApplicationCommand`). */
export const EXEC_MAX_COMMAND_LENGTH = 4000;
/** What the platform uses when no timeout is sent. */
export const EXEC_DEFAULT_TIMEOUT_SECONDS = 60;
export const EXEC_MAX_TIMEOUT_SECONDS = 300;
/** Exit status for a command that hit --timeout, as `timeout(1)` reports it. */
export const EXEC_TIMEOUT_EXIT_CODE = 124;

/** What `application.exec` returns. */
export interface ExecResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	durationMs: number;
}

interface ExecOptions {
	app?: string;
	timeout?: string;
	interactive?: boolean;
	tty?: boolean;
}

// Characters that never need quoting for sh. `=` is left out on purpose: a
// bare `FOO=bar` first word would become a variable assignment instead of the
// command the caller named.
const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+:,./-]+$/;

// Reserved words only act as syntax in command position, so they are quoted
// when they are the first word: `tarout exec -- if x` runs a command named
// "if", exactly as `tarout run -- if x` would.
const SH_RESERVED_WORDS = new Set([
	"case",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"fi",
	"for",
	"if",
	"in",
	"then",
	"until",
	"while",
]);

/**
 * One argument as a POSIX sh word that expands back to exactly itself: left
 * bare when it is plainly safe, otherwise single-quoted, with each embedded
 * `'` written as `'"'"'` (close the quote, a double-quoted `'`, reopen).
 */
export function quoteShellArg(arg: string): string {
	if (SHELL_SAFE_WORD.test(arg)) return arg;
	return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The one command string the container's shell runs. A single argument is
 * sent verbatim, so `tarout exec -- "npm run migrate && echo ok"` is a shell
 * line. Several arguments are each quoted for sh, so the container sees
 * exactly the argv that was typed, spaces, quotes, `$` and backticks included.
 */
export function buildExecCommand(argv: readonly string[]): string {
	if (argv.length === 1) return argv[0] ?? "";
	return argv
		.map((arg, index) =>
			index === 0 && SH_RESERVED_WORDS.has(arg)
				? `'${arg}'`
				: quoteShellArg(arg),
		)
		.join(" ");
}

/** Refuse locally what the platform would refuse, with a clearer message. */
export function assertExecCommand(command: string): void {
	if (!command.trim()) {
		throw new InvalidArgumentError(
			'Pass the command to run after --, for example `tarout exec -- ls -la` or `tarout exec -- "npm run migrate && echo ok"`.',
		);
	}
	if (command.length > EXEC_MAX_COMMAND_LENGTH) {
		throw new InvalidArgumentError(
			`The command is ${command.length} characters; the platform accepts at most ${EXEC_MAX_COMMAND_LENGTH}. Put longer logic in a script inside the image and run that.`,
		);
	}
}

/** `--timeout`: whole seconds, 1 to 300. Undefined when the flag is absent. */
export function parseExecTimeout(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = String(value).trim();
	const seconds = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (
		!Number.isInteger(seconds) ||
		seconds < 1 ||
		seconds > EXEC_MAX_TIMEOUT_SECONDS
	) {
		throw new InvalidArgumentError(
			`--timeout must be a whole number of seconds from 1 to ${EXEC_MAX_TIMEOUT_SECONDS} (default ${EXEC_DEFAULT_TIMEOUT_SECONDS}).`,
		);
	}
	return seconds;
}

/**
 * The status `tarout exec` exits with in human mode: the remote exit code,
 * clamped to 0-255, or 124 when the command timed out (no exit code).
 */
export function execExitCode(
	result: Pick<ExecResult, "exitCode" | "timedOut">,
): number {
	if (result.timedOut) return EXEC_TIMEOUT_EXIT_CODE;
	if (typeof result.exitCode !== "number" || !Number.isFinite(result.exitCode)) {
		return ExitCode.GENERAL_ERROR;
	}
	return Math.min(Math.max(Math.trunc(result.exitCode), 0), 255);
}

/** The dashboard page that hosts an app's interactive console. */
export function appConsoleUrl(applicationId?: string): string {
	let base = "https://tarout.sa";
	try {
		base = getApiUrl();
	} catch {
		// A rejected TAROUT_API_URL must not hide the link; the default host is
		// still where the dashboard lives.
	}
	base = base.replace(/\/+$/, "");
	return applicationId
		? `${base}/dashboard/application/${encodeURIComponent(applicationId)}?tab=console`
		: `${base}/dashboard/applications`;
}

/**
 * Said with every NEEDS_APPROVAL from exec. The platform replays an approved
 * call without keeping its return value, and `runAppExecCommand` resolves
 * normally for a non-zero exit, so "executed" is not "exited 0".
 */
export const EXEC_AFTER_APPROVAL_NOTE =
	'Once a human approves it, the platform runs the command, but its output and exit code are not returned to you: the approval records only "executed" or "failed". "executed" means the command ran, not that it exited 0; "failed" means it could not run (for example, no running container). If you need the output, ask the user to run the command in the dashboard console (Application > Console).';

/** The server's message when `err` is a parked (needs_approval) refusal. */
function parkedApprovalMessage(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as {
		message?: unknown;
		data?: { reason?: unknown } | null;
		shape?: { data?: { reason?: unknown } | null } | null;
	};
	const message = typeof e.message === "string" ? e.message : "";
	const named = e.data?.reason ?? e.shape?.data?.reason;
	const reason =
		typeof named === "string" && named
			? named
			: rejectionReasonFromMessage(message);
	return reason === "needs_approval" ? message : undefined;
}

/**
 * The same FORBIDDEN envelope `handleError` prints for a parked action, plus
 * the exec-specific `afterApproval` note, and in human mode the concrete
 * `Next: tarout approvals wait <id>` line.
 */
function reportParkedExec(message: string): never {
	const guidance = staleCredentialGuidance(
		"FORBIDDEN",
		"needs_approval",
		message,
	);
	outputError(
		"FORBIDDEN",
		guidance ? `${message}: ${guidance.hint}` : message,
		{ ...(guidance?.details ?? {}), afterApproval: EXEC_AFTER_APPROVAL_NOTE },
	);
	if (!isJsonMode()) console.error(colors.dim(EXEC_AFTER_APPROVAL_NOTE));
	exit(ExitCode.PERMISSION_DENIED);
}

/** Best effort: the app id for the console link, never an error of its own. */
async function consoleAppId(appRef?: string): Promise<string | undefined> {
	try {
		if (!appRef) return getProjectConfig()?.applicationId || undefined;
		if (!isLoggedIn()) return undefined;
		return (await resolveRunApp(getApiClient(), appRef)).applicationId;
	} catch {
		return undefined;
	}
}

/** Write and wait for the flush: macOS pipes are async and exit() cuts them. */
function writeStream(stream: NodeJS.WriteStream, text: string): Promise<void> {
	if (!text) return Promise.resolve();
	return new Promise((resolve) => {
		stream.write(text, () => resolve());
	});
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return `${Math.max(0, Math.round(ms || 0))}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Human mode: the container's stdout to stdout and stderr to stderr as
 * returned, then the notices and a dim footer, all on stderr so stdout stays
 * exactly what the command printed.
 */
async function printExecResult(
	app: { name: string },
	result: ExecResult,
	timeoutSeconds: number,
): Promise<void> {
	await writeStream(process.stdout, result.stdout ?? "");
	await writeStream(process.stderr, result.stderr ?? "");

	const notes: string[] = [];
	if (result.timedOut) {
		notes.push(
			colors.warn(
				`Timed out after ${timeoutSeconds}s with no exit code. Raise --timeout (up to ${EXEC_MAX_TIMEOUT_SECONDS} seconds) for longer commands.`,
			),
		);
	}
	if (!isQuietMode()) {
		if (result.truncated) {
			notes.push(
				colors.warn(
					"Output was truncated: the platform keeps the first 4,000 and last 8,000 characters of each stream.",
				),
			);
		}
		const status = result.timedOut
			? "timed out"
			: `exit ${result.exitCode ?? "unknown"}`;
		notes.push(
			colors.dim(`${status} in ${formatDuration(result.durationMs)} (${app.name})`),
		);
	}
	if (!notes.length) return;

	const last = result.stderr || result.stdout || "";
	const lead = last && !last.endsWith("\n") ? "\n" : "";
	await writeStream(process.stderr, `${lead}${notes.join("\n")}\n`);
}

export function registerExecCommand(program: Command): void {
	program
		.command("exec")
		.description(
			"Run one command inside the app's running container and print its output",
		)
		.argument("[command...]", "The command and its arguments, after --")
		.option(
			"-a, --app <app>",
			"Application ID, name or slug (defaults to the linked app)",
		)
		.option(
			"--timeout <seconds>",
			`Seconds to wait for the command, 1 to ${EXEC_MAX_TIMEOUT_SECONDS} (default ${EXEC_DEFAULT_TIMEOUT_SECONDS})`,
		)
		.option(
			"-i, --interactive",
			"Not supported: the interactive console is in the dashboard",
		)
		.option("-t, --tty", "Not supported: the interactive console is in the dashboard")
		.addHelpText(
			"after",
			`
Put the command after --. One argument is sent as-is and runs as a shell line
in the container (sh), so pipes, && and $VARS work when you quote the whole
line locally. Several arguments are each quoted for sh, so the container sees
exactly the argv you typed, spaces and quotes included.

It is one request, not a stream: the output arrives when the command finishes,
and the platform keeps the first 4,000 and last 8,000 characters of each
stream.

Exit status: the command's own exit code (0-255), or 124 when it timed out.
With --json, tarout prints one { success, data } envelope whose data carries
exitCode, stdout, stderr, truncated, timedOut and durationMs, and exits 0
whenever the command ran, whatever its exit code. A non-zero exit under --json
means tarout or the platform failed (auth, not found, needs approval, no
running container).

Owners and admins only. An operator-tier agent key has the command parked for
a human to approve (NEEDS_APPROVAL); once approved it runs, but its output is
not returned. There is no interactive shell here: -i/-t print the dashboard
console link (Application > Console).

Examples:
  tarout exec -- ls -la "/app/my dir"
  tarout exec -- "npm run migrate && echo ok"
  tarout exec --app api --timeout 300 -- node scripts/backfill.js
  tarout exec --json -- cat /etc/os-release`,
		)
		.action(async (argv: string[], options: ExecOptions) => {
			let exitCode: number = ExitCode.SUCCESS;
			try {
				if (options.interactive || options.tty) {
					const consoleUrl = appConsoleUrl(await consoleAppId(options.app));
					throw new CliError(
						`tarout exec runs one command and returns its output; it cannot open an interactive shell. The interactive console is in the dashboard (Application > Console): ${consoleUrl}`,
						ExitCode.INVALID_ARGUMENTS,
						undefined,
						{ consoleUrl },
					);
				}

				const command = buildExecCommand(argv ?? []);
				assertExecCommand(command);
				const timeoutSeconds = parseExecTimeout(options.timeout);
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const app = await resolveRunApp(client, options.app);

				startSpinner(`Running in ${app.name}...`);
				let result: ExecResult;
				try {
					result = (await client.application.exec.mutate({
						applicationId: app.applicationId,
						command,
						...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
					})) as ExecResult;
				} finally {
					stopSpinner();
				}

				if (isJsonMode()) {
					outputData({
						applicationId: app.applicationId,
						name: app.name,
						command,
						...result,
						ok: result.exitCode === 0 && !result.timedOut,
					});
					return;
				}

				await printExecResult(
					app,
					result,
					timeoutSeconds ?? EXEC_DEFAULT_TIMEOUT_SECONDS,
				);
				exitCode = execExitCode(result);
			} catch (err) {
				const parked = parkedApprovalMessage(err);
				if (parked !== undefined) reportParkedExec(parked);
				handleError(err);
			}
			exit(exitCode);
		});
}
