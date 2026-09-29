/**
 * @fileoverview Build explain, shared by `tarout build --explain` and the
 * stdio MCP tool `app_explain_build`. Wraps the platform's
 * `application.explainBuild`, and `application.explainBuildResult` to poll an
 * answer the platform could not finish within its own wait.
 *
 * The platform explains the app's CONFIGURED source on Tarout: the tracked Git
 * branch, the last uploaded archive, an uploaded Dockerfile or a prebuilt
 * image. It never sees uncommitted or unpushed local files, and nothing is
 * built, deployed or changed. Build environment variables come back as names
 * only, never values.
 *
 * `explainBuild` is limited to 10 calls a minute per user
 * (TOO_MANY_REQUESTS); polling `explainBuildResult` is not.
 * @module lib/build-explain
 */

import { ExitCode } from "../utils/exit-codes.js";
import {
	CliError,
	InvalidArgumentError,
	isMissingProcedureError,
} from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export type BuildExplainStatus = "ok" | "failed" | "pending";

export interface BuildExplainSource {
	type: string;
	repository: string | null;
	branch: string | null;
	commitSha?: string;
}

export interface BuildExplainPackage {
	name: string;
	version: string | null;
	source: string | null;
}

export interface BuildExplainStep {
	name: string;
	commands: string[];
}

export interface BuildExplainPlan {
	/** Languages and frameworks detected in the source. */
	providers: string[];
	/** Toolchain packages and the versions the build resolves them to. */
	packages: BuildExplainPackage[];
	/** Build steps in order, with the shell commands each one runs. */
	steps: BuildExplainStep[];
	startCommand: string | null;
	port: number | null;
	/** NAMES of the environment variables the build receives. Never values. */
	buildEnv: string[];
}

/** What `application.explainBuild` and `application.explainBuildResult` return. */
export interface BuildExplainResult {
	status: BuildExplainStatus;
	jobId?: string;
	detectedKind: string | null;
	buildType: string;
	summary: string | null;
	plan: BuildExplainPlan | null;
	warnings: string[];
	errors: string[];
	source: BuildExplainSource;
}

/** One sentence both surfaces use to say what is (and is not) explained. */
export const EXPLAIN_SOURCE_NOTE =
	"Explains the app's configured source on Tarout (the tracked Git branch, or the last uploaded archive), not uncommitted or unpushed local files. Nothing is built or deployed.";

/** How long to keep polling a pending answer, in seconds. */
export const DEFAULT_EXPLAIN_WAIT_SECONDS = 120;
/** The worker gives up on one inspection after 120s, so 10 minutes is plenty. */
export const MAX_EXPLAIN_WAIT_SECONDS = 600;
export const EXPLAIN_POLL_INTERVAL_MS = 2000;

/** The platform's `BUILD_EXPLAIN` user rate limit. */
export const EXPLAIN_RATE_LIMIT_PER_MINUTE = 10;

export const EXPLAIN_RATE_LIMIT_MESSAGE = `Too many build explanations right now: Tarout allows ${EXPLAIN_RATE_LIMIT_PER_MINUTE} a minute per user. Wait a minute, then ask again.`;

export const EXPLAIN_UNSUPPORTED_MESSAGE =
	"This Tarout server does not support build explain yet (application.explainBuild is missing; it ships in a newer platform release). `tarout deploy` still runs the same checks when it builds.";

/**
 * `--wait` / `waitSeconds`: whole seconds, 0 to 600. 0 returns a pending
 * answer at once instead of polling it. Undefined means the default.
 */
export function parseExplainWait(value: unknown, flag = "--wait"): number {
	if (value === undefined || value === null) return DEFAULT_EXPLAIN_WAIT_SECONDS;
	const raw = String(value).trim();
	const seconds = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (
		!Number.isInteger(seconds) ||
		seconds < 0 ||
		seconds > MAX_EXPLAIN_WAIT_SECONDS
	) {
		throw new InvalidArgumentError(
			`${flag} must be a whole number of seconds from 0 to ${MAX_EXPLAIN_WAIT_SECONDS} (default ${DEFAULT_EXPLAIN_WAIT_SECONDS}).`,
		);
	}
	return seconds;
}

/** The tRPC code of a failed call, from either client error shape. */
function trpcCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as {
		code?: unknown;
		data?: { code?: unknown } | null;
		shape?: { data?: { code?: unknown } | null } | null;
	};
	const code = e.data?.code ?? e.shape?.data?.code ?? e.code;
	return typeof code === "string" ? code : undefined;
}

/** True when the platform refused the call for its per-user rate limit. */
export function isExplainRateLimitError(err: unknown): boolean {
	return trpcCode(err) === "TOO_MANY_REQUESTS";
}

/** Structured context for a rate-limit refusal, the same on both surfaces. */
export function explainRateLimitDetails(): {
	limitPerMinute: number;
	retryAfterSeconds: number;
} {
	return {
		limitPerMinute: EXPLAIN_RATE_LIMIT_PER_MINUTE,
		retryAfterSeconds: 60,
	};
}

export interface ExplainBuildOptions {
	/** How long to keep polling a pending answer, counted from the first call. */
	waitMs: number;
	intervalMs?: number;
	/** Test seam. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Called once, the first time the answer comes back pending. */
	onPending?: (result: BuildExplainResult) => void;
}

export interface ExplainBuildOutcome {
	result: BuildExplainResult;
	/** True when the answer was still pending when the wait ran out. */
	timedOut: boolean;
}

/** Rethrows `err`, as a readable NOT_FOUND when the server predates `procedure`. */
function rethrowExplainError(err: unknown, procedure: string): never {
	if (isMissingProcedureError(err)) {
		throw new CliError(
			EXPLAIN_UNSUPPORTED_MESSAGE,
			ExitCode.NOT_FOUND,
			undefined,
			{ procedure, reason: "procedure_unavailable" },
		);
	}
	throw err;
}

/**
 * Asks the platform what a deploy would build, then polls a pending answer
 * until it settles or `waitMs` (measured from before the first call, which
 * itself waits up to ~25s on the server) runs out. A pending answer without a
 * jobId cannot be polled and returns as timed out. API errors propagate; a
 * server without the procedure fails with NOT_FOUND and a readable message.
 */
export async function explainBuild(
	client: TrpcClient,
	applicationId: string,
	options: ExplainBuildOptions,
): Promise<ExplainBuildOutcome> {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const intervalMs = options.intervalMs ?? EXPLAIN_POLL_INTERVAL_MS;
	const deadline = now() + options.waitMs;

	let result: BuildExplainResult;
	try {
		result = (await client.application.explainBuild.query({
			applicationId,
		})) as BuildExplainResult;
	} catch (err) {
		rethrowExplainError(err, "application.explainBuild");
	}

	let reportedPending = false;
	while (result?.status === "pending") {
		if (!reportedPending) {
			reportedPending = true;
			options.onPending?.(result);
		}
		const jobId = result.jobId;
		const remaining = deadline - now();
		if (!jobId || remaining <= 0) return { result, timedOut: true };
		await sleep(Math.min(intervalMs, remaining));
		try {
			result = (await client.application.explainBuildResult.query({
				applicationId,
				jobId,
			})) as BuildExplainResult;
		} catch (err) {
			rethrowExplainError(err, "application.explainBuildResult");
		}
	}
	return { result, timedOut: false };
}
