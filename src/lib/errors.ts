/**
 * @fileoverview Error handling utilities for the CLI.
 * Provides custom error classes and centralized error handling with
 * proper exit codes and user-friendly messages.
 * @module lib/errors
 */

import { ExitCode, exit } from "../utils/exit-codes.js";
import { jsonError, outputJson } from "../utils/json.js";
import { isLoggedIn } from "./config.js";
import { error, isJsonMode } from "./output.js";

/**
 * Error categories for deployment failures
 */
export type DeploymentErrorCategory =
	| "npm_install"
	| "yarn_install"
	| "pnpm_install"
	| "bun_install"
	| "docker_build"
	| "typescript"
	| "build_script"
	| "memory_limit"
	| "timeout"
	| "permission"
	| "network"
	| "database_tls"
	| "unknown";

/**
 * Structured error analysis result
 */
export interface DeploymentErrorAnalysis {
	/** The general type of error */
	type: "build_error" | "deploy_error" | "runtime_error" | "unknown";
	/** Specific error category */
	category: DeploymentErrorCategory;
	/** Possible causes for the error */
	possibleCauses: string[];
	/** Suggested fixes for the error */
	suggestedFixes: string[];
	/** Relevant log lines that indicate the error */
	relevantLogLines: string[];
}

/**
 * Base CLI error class with exit code and optional suggestions.
 * @extends Error
 */
export class CliError extends Error {
	constructor(
		message: string,
		public code: number = ExitCode.GENERAL_ERROR,
		public suggestions?: string[],
		/** Structured, agent-facing context surfaced in the `--json` envelope. */
		public details?: unknown,
	) {
		super(message);
		this.name = "CliError";
	}
}

/**
 * Agent-facing guidance attached to every AUTH_ERROR. An agent driving the CLI
 * can run `tarout login` ITSELF — it opens a browser on the user's machine and
 * blocks on the local callback until sign-in completes — so the agent should run
 * it directly and tell the user to finish in the browser, NOT hand the command
 * back for the user to type. The token path is only for genuinely headless hosts.
 */
export const AGENT_LOGIN_HINT =
	"Run `tarout login` directly to authenticate — it opens a browser on this machine and waits for the user to sign in, then your command works. Do not ask the user to run it for you, and don't treat it as interactive. On a headless/CI host with no browser, use `tarout login --token <key>` (create one at https://tarout.sa/dashboard/agent/keys).";

/**
 * Guidance for the case where a credential IS stored locally but the SERVER
 * rejected it (expired 30-day CLI key, revoked from the dashboard, or a wiped
 * account). The no-token AuthError already covers "never logged in"; without
 * this, a stale token surfaces as a bare "UNAUTHORIZED" with no way forward.
 */
export const STALE_CREDENTIAL_HINT =
	"session expired or revoked — run `tarout login` to re-authenticate.";

/**
 * When a server UNAUTHORIZED lands while a credential IS stored locally, return
 * the re-auth guidance (mirroring the no-token AuthError's structured details)
 * so an agent/user knows the fix is `tarout login`, not that the request shape
 * was wrong. Returns null for any other code, or when nothing is stored (the
 * AuthError path already handles "not logged in").
 */
export function staleCredentialGuidance(code: string): {
	hint: string;
	details: { hint: string; nextCommand: string };
} | null {
	if (code !== "UNAUTHORIZED" || !isLoggedIn()) return null;
	return {
		hint: STALE_CREDENTIAL_HINT,
		details: { hint: AGENT_LOGIN_HINT, nextCommand: "tarout login" },
	};
}

/**
 * Error thrown when the user is not authenticated.
 * Exit code: 3 (AUTH_ERROR)
 */
export class AuthError extends CliError {
	constructor(message = "Not logged in. Run `tarout login` to authenticate.") {
		super(message, ExitCode.AUTH_ERROR, undefined, {
			hint: AGENT_LOGIN_HINT,
			nextCommand: "tarout login",
		});
	}
}

/**
 * Error thrown when a requested resource is not found.
 * Exit code: 4 (NOT_FOUND)
 */
export class NotFoundError extends CliError {
	constructor(resource: string, id: string, suggestions?: string[]) {
		super(`${resource} "${id}" not found`, ExitCode.NOT_FOUND, suggestions);
	}
}

/**
 * Error thrown when the user lacks permission for an action.
 * Exit code: 5 (PERMISSION_DENIED)
 */
export class PermissionError extends CliError {
	constructor(message = "Permission denied") {
		super(message, ExitCode.PERMISSION_DENIED);
	}
}

/**
 * Error thrown for invalid command arguments.
 * Exit code: 2 (INVALID_ARGUMENTS)
 */
export class InvalidArgumentError extends CliError {
	constructor(message: string) {
		super(message, ExitCode.INVALID_ARGUMENTS);
	}
}

/**
 * Error thrown when a deployment fails.
 * Exit code: 10 (DEPLOYMENT_FAILED)
 */
export class DeploymentFailedError extends CliError {
	constructor(
		message: string,
		public deploymentId?: string,
		public errorAnalysis?: DeploymentErrorAnalysis,
	) {
		super(message, ExitCode.DEPLOYMENT_FAILED);
	}
}

/**
 * Error thrown when a deployment times out.
 * Exit code: 11 (DEPLOYMENT_TIMEOUT)
 */
export class DeploymentTimeoutError extends CliError {
	constructor(
		message = "Deployment timed out",
		public deploymentId?: string,
	) {
		super(message, ExitCode.DEPLOYMENT_TIMEOUT);
	}
}

/**
 * Error thrown when a build fails.
 * Exit code: 12 (BUILD_FAILED)
 */
export class BuildFailedError extends CliError {
	constructor(
		message: string,
		public deploymentId?: string,
		public errorAnalysis?: DeploymentErrorAnalysis,
	) {
		super(message, ExitCode.BUILD_FAILED);
	}
}

/**
 * Centralized error handler for all CLI commands.
 * Formats errors appropriately for JSON or human-readable output,
 * then exits with the appropriate code.
 * @param {unknown} err - The error to handle
 * @returns {never} This function always exits the process
 */
export function handleError(err: unknown): never {
	if (err instanceof CliError) {
		if (isJsonMode()) {
			outputJson(
				jsonError(
					getErrorCode(err.code),
					err.message,
					err.suggestions,
					err.details,
				),
			);
		} else {
			error(err.message, err.suggestions);
		}
		exit(err.code);
	}

	// Handle tRPC errors. The tRPC v10 client wraps server TRPCError
	// instances in TRPCClientError where the structured code lives on
	// `.data.code` (httpStatus, path, etc. also nested). Accept both shapes
	// so callers see "FORBIDDEN" or "BAD_REQUEST" instead of UNKNOWN_ERROR.
	if (err && typeof err === "object") {
		const e = err as {
			code?: string;
			message?: string;
			data?: { code?: string };
		};
		const code = e.code ?? e.data?.code;
		if (code) {
			const exitCode = mapTrpcErrorCode(code);
			const rawMessage = e.message ?? "Request failed";
			// A rejected stored credential (vs. no credential) gets an actionable
			// re-auth hint; exit code stays AUTH_ERROR (3) via mapTrpcErrorCode.
			const stale = staleCredentialGuidance(code);
			const message = stale ? `${rawMessage} — ${stale.hint}` : rawMessage;
			if (isJsonMode()) {
				outputJson(jsonError(code, message, undefined, stale?.details));
			} else {
				error(message);
			}
			exit(exitCode);
		}
	}

	// Generic error
	const message = err instanceof Error ? err.message : String(err);
	if (isJsonMode()) {
		outputJson(jsonError("UNKNOWN_ERROR", message));
	} else {
		error(message);
	}
	exit(ExitCode.GENERAL_ERROR);
}

function getErrorCode(exitCode: number): string {
	const codes: Record<number, string> = {
		[ExitCode.SUCCESS]: "SUCCESS",
		[ExitCode.GENERAL_ERROR]: "ERROR",
		[ExitCode.INVALID_ARGUMENTS]: "INVALID_ARGUMENTS",
		[ExitCode.AUTH_ERROR]: "AUTH_ERROR",
		[ExitCode.NOT_FOUND]: "NOT_FOUND",
		[ExitCode.PERMISSION_DENIED]: "PERMISSION_DENIED",
		[ExitCode.DEPLOYMENT_FAILED]: "DEPLOYMENT_FAILED",
		[ExitCode.DEPLOYMENT_TIMEOUT]: "DEPLOYMENT_TIMEOUT",
		[ExitCode.BUILD_FAILED]: "BUILD_FAILED",
	};
	return codes[exitCode] || "ERROR";
}

function mapTrpcErrorCode(code: string): number {
	const mapping: Record<string, number> = {
		UNAUTHORIZED: ExitCode.AUTH_ERROR,
		FORBIDDEN: ExitCode.PERMISSION_DENIED,
		NOT_FOUND: ExitCode.NOT_FOUND,
		BAD_REQUEST: ExitCode.INVALID_ARGUMENTS,
		PARSE_ERROR: ExitCode.INVALID_ARGUMENTS,
		// A capability the platform has (deliberately) not enabled — e.g. root
		// domain connects before Apex Proxying. Invalid input, not a crash.
		PRECONDITION_FAILED: ExitCode.INVALID_ARGUMENTS,
	};
	return mapping[code] || ExitCode.GENERAL_ERROR;
}

/**
 * Finds similar strings to a target using fuzzy matching (Dice coefficient).
 * Useful for providing "did you mean?" suggestions when a resource isn't found.
 * @param {string} target - The string to match against
 * @param {string[]} candidates - Array of possible matches
 * @param {number} [maxResults=3] - Maximum number of suggestions to return
 * @returns {string[]} Array of similar strings, sorted by similarity
 * @example
 * findSimilar("my-ap", ["my-app", "your-app", "test"]) // ["my-app"]
 */
export function findSimilar(
	target: string,
	candidates: string[],
	maxResults = 3,
): string[] {
	const targetLower = target.toLowerCase();

	return candidates
		.map((candidate) => ({
			candidate,
			score: similarity(targetLower, candidate.toLowerCase()),
		}))
		.filter(({ score }) => score > 0.3)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxResults)
		.map(({ candidate }) => candidate);
}

// Simple similarity score (Dice coefficient)
function similarity(s1: string, s2: string): number {
	if (s1 === s2) return 1;
	if (s1.length < 2 || s2.length < 2) return 0;

	const bigrams1 = new Set<string>();
	for (let i = 0; i < s1.length - 1; i++) {
		bigrams1.add(s1.slice(i, i + 2));
	}

	let intersection = 0;
	for (let i = 0; i < s2.length - 1; i++) {
		if (bigrams1.has(s2.slice(i, i + 2))) {
			intersection++;
		}
	}

	return (2 * intersection) / (s1.length - 1 + s2.length - 1);
}

/** Error pattern definition */
interface ErrorPattern {
	/** Regex patterns to match against log lines */
	patterns: RegExp[];
	/** Error category */
	category: DeploymentErrorCategory;
	/** Error type */
	type: "build_error" | "deploy_error" | "runtime_error";
	/** Possible causes */
	possibleCauses: string[];
	/** Suggested fixes */
	suggestedFixes: string[];
}

/** Predefined error patterns for deployment analysis */
const ERROR_PATTERNS: ErrorPattern[] = [
	{
		patterns: [
			/npm ERR!/i,
			/npm error/i,
			/ERESOLVE/i,
			/Could not resolve dependency/i,
			/peer dep missing/i,
		],
		category: "npm_install",
		type: "build_error",
		possibleCauses: [
			"Package version conflicts",
			"Missing peer dependencies",
			"Invalid package.json",
			"Network issues during npm install",
			"Private package without authentication",
		],
		suggestedFixes: [
			"Run `npm install` locally to reproduce the issue",
			"Check for conflicting package versions in package.json",
			"Try deleting package-lock.json and node_modules, then reinstall",
			"Add missing peer dependencies explicitly",
			"Check if private packages are properly authenticated",
		],
	},
	{
		patterns: [
			/yarn error/i,
			/YN\d{4}/i,
			/error An unexpected error occurred/i,
		],
		category: "yarn_install",
		type: "build_error",
		possibleCauses: [
			"Package version conflicts",
			"Corrupted yarn.lock file",
			"Network issues during install",
			"Incompatible yarn version",
		],
		suggestedFixes: [
			"Run `yarn install` locally to reproduce the issue",
			"Delete yarn.lock and node_modules, then reinstall",
			"Check for conflicting resolutions in package.json",
			"Ensure yarn version matches the project requirements",
		],
	},
	{
		patterns: [/pnpm ERR/i, /ERR_PNPM/i],
		category: "pnpm_install",
		type: "build_error",
		possibleCauses: [
			"Package version conflicts",
			"Incompatible pnpm version",
			"Corrupted pnpm-lock.yaml",
		],
		suggestedFixes: [
			"Run `pnpm install` locally to reproduce the issue",
			"Delete pnpm-lock.yaml and node_modules, then reinstall",
			"Check pnpm version compatibility",
		],
	},
	{
		patterns: [/bun install/i, /error: .* failed to resolve/i],
		category: "bun_install",
		type: "build_error",
		possibleCauses: [
			"Package resolution failure",
			"Incompatible bun version",
			"Missing dependencies",
		],
		suggestedFixes: [
			"Run `bun install` locally to reproduce the issue",
			"Delete bun.lockb and node_modules, then reinstall",
			"Check bun version compatibility",
		],
	},
	{
		patterns: [
			/error TS\d+/i,
			/TypeScript error/i,
			/tsc.*error/i,
			/Type .* is not assignable to/i,
			/Cannot find module/i,
			/Property .* does not exist/i,
		],
		category: "typescript",
		type: "build_error",
		possibleCauses: [
			"TypeScript compilation errors in source code",
			"Missing type definitions",
			"Incompatible TypeScript version",
			"Strict mode type errors",
		],
		suggestedFixes: [
			"Run `npx tsc --noEmit` locally to see all type errors",
			"Fix the TypeScript errors in the indicated files",
			"Install missing @types/* packages",
			"Check tsconfig.json for strict mode settings",
		],
	},
	{
		patterns: [
			/COPY failed/i,
			/RUN.*failed/i,
			/failed to build/i,
			/Error building image/i,
			/Dockerfile/i,
		],
		category: "docker_build",
		type: "build_error",
		possibleCauses: [
			"Invalid Dockerfile syntax",
			"Missing files in build context",
			"Failed RUN commands",
			"Base image not found",
		],
		suggestedFixes: [
			"Test Docker build locally with `docker build .`",
			"Check that all required files are in the build context",
			"Verify Dockerfile syntax and commands",
			"Ensure base image exists and is accessible",
		],
	},
	{
		patterns: [
			/build.*failed/i,
			/Build failed/i,
			/exit code 1/i,
			/Command failed/i,
			/Script.*failed/i,
		],
		category: "build_script",
		type: "build_error",
		possibleCauses: [
			"Build script error in package.json",
			"Missing build dependencies",
			"Environment variable issues",
			"Build command not found",
		],
		suggestedFixes: [
			"Run `npm run build` locally to reproduce the error",
			"Check package.json build script for errors",
			"Ensure all required environment variables are set",
			"Verify build dependencies are installed",
		],
	},
	{
		patterns: [
			/out of memory/i,
			/JavaScript heap out of memory/i,
			/FATAL ERROR: .* allocation failed/i,
			/OOMKilled/i,
		],
		category: "memory_limit",
		type: "build_error",
		possibleCauses: [
			"Build process requires more memory than allocated",
			"Memory leak in build process",
			"Large dependency tree",
		],
		suggestedFixes: [
			"Increase memory allocation for the build",
			"Optimize build process to use less memory",
			"Consider splitting large bundles",
			"Add NODE_OPTIONS=--max_old_space_size=4096",
		],
	},
	{
		patterns: [/timed? ?out/i, /deadline exceeded/i, /timeout/i],
		category: "timeout",
		type: "build_error",
		possibleCauses: [
			"Build process took too long",
			"Network timeout during dependency install",
			"Slow external service calls",
		],
		suggestedFixes: [
			"Optimize build process for faster execution",
			"Check for slow network requests during build",
			"Consider caching dependencies",
			"Increase build timeout if possible",
		],
	},
	{
		patterns: [/permission denied/i, /EACCES/i, /EPERM/i],
		category: "permission",
		type: "build_error",
		possibleCauses: [
			"File permission issues",
			"Attempting to write to read-only locations",
			"Docker user permission mismatch",
		],
		suggestedFixes: [
			"Check file permissions in the project",
			"Ensure Dockerfile uses correct user",
			"Avoid writing to restricted directories",
		],
	},
	{
		// Managed-Postgres TLS mismatch. Must come BEFORE the broad `network`
		// pattern (a TLS refusal can also surface an ECONNREFUSED) so the precise
		// remedy wins. The managed pooler negotiates TLS; node-postgres / drizzle
		// / knex / the Prisma driver-adapter default to a plaintext connection and
		// get rejected, while Prisma-native / libpq (sslmode=prefer) succeed —
		// which is why migrations pass but the runtime adapter crashes.
		patterns: [
			/no pg_hba\.conf entry/i,
			/no encryption/i,
			/SSL\s*(?:connection\s*)?(?:is\s*)?required/i,
			/server does not support SSL/i,
			/pg_hba/i,
			/sslmode/i,
			/self[-\s]signed certificate/i,
		],
		category: "database_tls",
		type: "runtime_error",
		possibleCauses: [
			"The managed PostgreSQL endpoint negotiates TLS, but the app's Postgres client connected without it",
			"node-postgres / drizzle / knex / the Prisma driver-adapter default to a plaintext (no-TLS) connection",
			"DATABASE_URL carries no sslmode and the client library does not read PGSSLMODE from the environment",
		],
		suggestedFixes: [
			"node-postgres / pg Pool: construct it with `ssl: { rejectUnauthorized: false }` (or set PGSSLMODE=require)",
			"Prisma driver-adapter (@prisma/adapter-pg): enable ssl on the Pool you pass to PrismaPg",
			"Prisma native engine / psql: append `?sslmode=require` to the connection string",
			"Redeploy once the client enables TLS — the managed database already offers it",
		],
	},
	{
		patterns: [
			/ENOTFOUND/i,
			/ECONNREFUSED/i,
			/network error/i,
			/fetch failed/i,
			/getaddrinfo/i,
		],
		category: "network",
		type: "build_error",
		possibleCauses: [
			"Network connectivity issues",
			"DNS resolution failure",
			"Registry unavailable",
			"Firewall blocking connections",
		],
		suggestedFixes: [
			"Check if the package registry is accessible",
			"Verify network configuration",
			"Try again later if registry is temporarily down",
			"Check for any proxy configuration issues",
		],
	},
];

/**
 * Analyzes deployment logs to identify the cause of failure.
 * Scans log lines for known error patterns and returns structured analysis.
 *
 * @param logs - Array of log lines from the deployment
 * @param errorMessage - Optional error message from the deployment record
 * @returns Structured error analysis with causes and suggested fixes
 *
 * @example
 * const logs = ["npm ERR! Missing: react@18.0.0", "npm ERR! peer dep missing"];
 * const analysis = analyzeDeploymentError(logs);
 * console.log(analysis.category); // "npm_install"
 * console.log(analysis.suggestedFixes); // ["Run npm install locally..."]
 */
export function analyzeDeploymentError(
	logs: string[],
	errorMessage?: string | null,
): DeploymentErrorAnalysis {
	const relevantLogLines: string[] = [];
	let matchedPattern: ErrorPattern | null = null;
	let maxMatches = 0;

	// Include error message in analysis if provided
	const allLines = errorMessage ? [...logs, errorMessage] : logs;

	// Find the pattern with the most matches
	for (const pattern of ERROR_PATTERNS) {
		let matches = 0;
		const matchedLines: string[] = [];

		for (const line of allLines) {
			for (const regex of pattern.patterns) {
				if (regex.test(line)) {
					matches++;
					if (!matchedLines.includes(line)) {
						matchedLines.push(line);
					}
					break;
				}
			}
		}

		if (matches > maxMatches) {
			maxMatches = matches;
			matchedPattern = pattern;
			relevantLogLines.length = 0;
			relevantLogLines.push(...matchedLines.slice(0, 10)); // Keep top 10 relevant lines
		}
	}

	// Also collect any lines containing common error indicators
	const errorIndicators = [/error/i, /failed/i, /fatal/i, /exception/i];
	for (const line of allLines) {
		if (
			relevantLogLines.length < 15 &&
			!relevantLogLines.includes(line) &&
			errorIndicators.some((indicator) => indicator.test(line))
		) {
			relevantLogLines.push(line);
		}
	}

	if (matchedPattern) {
		return {
			type: matchedPattern.type,
			category: matchedPattern.category,
			possibleCauses: matchedPattern.possibleCauses,
			suggestedFixes: matchedPattern.suggestedFixes,
			relevantLogLines,
		};
	}

	// Return unknown analysis if no pattern matched
	return {
		type: "unknown",
		category: "unknown",
		possibleCauses: [
			"Unable to automatically determine the cause",
			"Check the log output for specific error messages",
		],
		suggestedFixes: [
			"Review the deployment logs for error messages",
			"Try running the build locally to reproduce the issue",
			"Check environment variables and configuration",
			"Contact support if the issue persists",
		],
		relevantLogLines,
	};
}
