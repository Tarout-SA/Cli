import inquirer from "inquirer";
import {
	type NeedsInputRequest,
	isJsonMode,
	isNonInteractiveMode,
	outputNeedsInput,
} from "../lib/output.js";
import { ExitCode, exit } from "./exit-codes.js";

/**
 * Lightweight descriptor passed alongside an interactive prompt so that
 * agents running in `--json` or `--non-interactive` mode get a structured
 * `needs_input` event instead of a TTY hang. The prompt primitive fills in
 * `kind`, `question`, `choices`, and `default` from its own arguments; the
 * call site only has to specify the stable `field` id and the `flag` the
 * agent should re-invoke with.
 */
export type PromptDescriptor = Pick<
	NeedsInputRequest,
	"field" | "flag" | "sensitive" | "context"
>;

function emitNeedsInputAndExit(
	descriptor: PromptDescriptor,
	rest: Omit<NeedsInputRequest, keyof PromptDescriptor>,
): never {
	outputNeedsInput({ ...descriptor, ...rest });
	exit(ExitCode.NEEDS_INPUT);
}

function shouldEmitNeedsInput(): boolean {
	return isJsonMode() || isNonInteractiveMode();
}

/**
 * Safety net for un-annotated prompt sites. When an agent invokes the CLI
 * with `--json` or `--non-interactive` and lands on a `confirm/select/input/
 * password` that was never given a descriptor, we don't have a `flag` to
 * tell the agent how to re-invoke — so falling through to inquirer would
 * hang on a closed stdin. Instead we emit a structured "this prompt isn't
 * agent-driveable yet" event and exit `NEEDS_INPUT` (6). The agent can
 * surface the question to its user as a one-off `--yes`/positional-arg
 * suggestion, or report the gap upstream.
 */
function emitUnannotatedPromptError(
	kind: "confirm" | "select" | "input" | "password",
	question: string,
): never {
	outputNeedsInput({
		field: "unannotated_prompt",
		kind,
		question,
		flag: "--yes",
		context: {
			hint: "This prompt site does not yet expose a CLI flag. Re-invoke with --yes (for confirms) or provide the value as a positional/flag argument, or file an issue to ask for explicit flag support for this command.",
		},
	});
	exit(ExitCode.NEEDS_INPUT);
}

export async function confirm(
	message: string,
	defaultValue = false,
	descriptor?: PromptDescriptor,
): Promise<boolean> {
	if (descriptor && shouldEmitNeedsInput()) {
		emitNeedsInputAndExit(descriptor, {
			kind: "confirm",
			question: message,
			default: defaultValue,
		});
	}
	if (!descriptor && shouldEmitNeedsInput()) {
		emitUnannotatedPromptError("confirm", message);
	}
	const { confirmed } = await inquirer.prompt([
		{
			type: "confirm",
			name: "confirmed",
			message,
			default: defaultValue,
		},
	]);
	return confirmed;
}

export async function input(
	message: string,
	defaultValue?: string,
	descriptor?: PromptDescriptor,
): Promise<string> {
	if (descriptor && shouldEmitNeedsInput()) {
		emitNeedsInputAndExit(descriptor, {
			kind: "input",
			question: message,
			default: defaultValue,
		});
	}
	if (!descriptor && shouldEmitNeedsInput()) {
		emitUnannotatedPromptError("input", message);
	}
	const { value } = await inquirer.prompt([
		{
			type: "input",
			name: "value",
			message,
			default: defaultValue,
		},
	]);
	return value;
}

export async function select<T extends string>(
	message: string,
	choices: Array<{ name: string; value: T }>,
	descriptor?: PromptDescriptor,
): Promise<T> {
	if (descriptor && shouldEmitNeedsInput()) {
		emitNeedsInputAndExit(descriptor, {
			kind: "select",
			question: message,
			choices: choices.map((c) => ({ label: c.name, value: c.value })),
		});
	}
	if (!descriptor && shouldEmitNeedsInput()) {
		emitUnannotatedPromptError("select", message);
	}
	const { value } = await inquirer.prompt([
		{
			type: "list",
			name: "value",
			message,
			choices,
		},
	]);
	return value;
}

export async function password(
	message: string,
	descriptor?: PromptDescriptor,
): Promise<string> {
	if (descriptor && shouldEmitNeedsInput()) {
		// Passwords are always sensitive — force the flag on regardless of
		// what the caller passed so a forgotten `sensitive` field can't leak
		// the value into agent logs.
		emitNeedsInputAndExit(
			{ ...descriptor, sensitive: true },
			{ kind: "password", question: message },
		);
	}
	if (!descriptor && shouldEmitNeedsInput()) {
		emitUnannotatedPromptError("password", message);
	}
	const { value } = await inquirer.prompt([
		{
			type: "password",
			name: "value",
			message,
			mask: "*",
		},
	]);
	return value;
}

/**
 * Either prompt the human user via inquirer (TTY mode) or emit a
 * structured needs_input event and exit (JSON / agent mode).
 *
 * Used at deploy-flow choice points so an external coding agent can read
 * the request from stdout, ask its human user in chat, then re-invoke
 * the CLI with the answer passed via `req.flag`. Exits with
 * ExitCode.NEEDS_INPUT in the JSON path; never returns.
 */
export async function promptOrEmit<T>(
	req: NeedsInputRequest,
	fallback: () => Promise<T>,
): Promise<T> {
	if (shouldEmitNeedsInput()) {
		outputNeedsInput(req);
		exit(ExitCode.NEEDS_INPUT);
	}
	return fallback();
}
