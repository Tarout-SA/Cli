/**
 * MCP tool runtime — shared auth guard, error → JSON envelope mapping, and
 * result helpers used by every tool handler.
 *
 * Handlers NEVER call process.exit(), handleError(), or any CLI output helper
 * that writes to stdout (outputJsonLine / promptOrEmit / emitNeedsUpgrade).
 * They return one of the two shapes below via okResult()/errorResult().
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getApiClient, resetApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	getCredentialResolutionDir,
	resetProjectAuthCache,
	setCredentialResolutionDir,
} from "../lib/project-auth.js";
import {
	AuthError,
	BuildFailedError,
	CliError,
	DeploymentFailedError,
	DeploymentTimeoutError,
	NotFoundError,
} from "../lib/errors.js";
import { resolveEntitlementRemedy } from "../lib/entitlement-remedy.js";
import { ExitCode } from "../utils/exit-codes.js";
import { sanitizeToolResult } from "./sanitize-result.js";

export interface Envelope {
	error: string;
	code: string;
	remediation?: string;
	details?: unknown;
}

export interface ToolText {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
	[key: string]: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
export type TrpcClient = any;

/**
 * Thrown by the exit guard when a tool handler (transitively) reaches a
 * `process.exit()` call — e.g. promptOrEmit → exit(NEEDS_INPUT). Catchable, so a
 * single un-annotated prompt site can no longer kill the whole stdio server.
 */
export class ProcessExitAttemptedError extends Error {
	constructor(public readonly exitCode: number) {
		super(
			`A tool handler attempted process.exit(${exitCode}); the MCP server suppressed it.`,
		);
		this.name = "ProcessExitAttemptedError";
	}
}

// Reference count of tool handlers currently executing. process.exit is only
// intercepted while this is > 0, so a genuine server-shutdown exit (startup
// failure, transport close) still terminates the process. Race-safe for
// concurrent handlers because the guard is a single patch gated on the count.
let activeHandlerDepth = 0;
let originalProcessExit: ((code?: number) => never) | undefined;

/**
 * Patch process.exit ONCE so that, while any tool handler is running, an exit
 * attempt throws {@link ProcessExitAttemptedError} instead of terminating the
 * process. Outside a handler (count 0) exits pass through untouched.
 */
export function installExitGuard(): void {
	if (originalProcessExit) return;
	originalProcessExit = process.exit.bind(process);
	process.exit = ((code?: number): never => {
		if (activeHandlerDepth > 0) {
			throw new ProcessExitAttemptedError(typeof code === "number" ? code : 0);
		}
		return (originalProcessExit as (code?: number) => never)(code);
	}) as typeof process.exit;
}

/**
 * Wraps a single tool handler so that (1) the exit guard is armed for its
 * duration, (2) a suppressed exit is converted into a clean error envelope, and
 * (3) the result is sanitized (unless the tool is credential-allowlisted).
 */
function wrapToolHandler(
	name: string,
	// biome-ignore lint/suspicious/noExplicitAny: SDK handler args are broad/untyped.
	handler: (...args: any[]) => Promise<unknown>,
	// biome-ignore lint/suspicious/noExplicitAny: SDK handler args are broad/untyped.
): (...args: any[]) => Promise<unknown> {
	// biome-ignore lint/suspicious/noExplicitAny: SDK handler args are broad/untyped.
	return async (...args: any[]) => {
		activeHandlerDepth += 1;
		try {
			const result = await handler(...args);
			return sanitizeToolResult(result, name);
		} catch (err) {
			if (err instanceof ProcessExitAttemptedError) {
				return sanitizeToolResult(errorResult(toEnvelope(err)), name);
			}
			throw err;
		} finally {
			activeHandlerDepth -= 1;
		}
	};
}

/**
 * Monkey-patches `server.registerTool` so every tool handler is wrapped by
 * {@link wrapToolHandler}. Must run before any registerTools() call so all
 * handlers are covered. The exit guard itself is installed separately via
 * {@link installExitGuard} (a global side effect scoped to the stdio server).
 */
export function guardServerHandlers(server: McpServer): void {
	const original = server.registerTool.bind(server);
	// biome-ignore lint/suspicious/noExplicitAny: SDK registerTool is overloaded; we wrap the trailing handler.
	(server as unknown as { registerTool: (...a: any[]) => unknown }).registerTool =
		// biome-ignore lint/suspicious/noExplicitAny: SDK registerTool is overloaded; we wrap the trailing handler.
		(...regArgs: any[]) => {
			const name = typeof regArgs[0] === "string" ? regArgs[0] : "unknown";
			const last = regArgs.length - 1;
			if (typeof regArgs[last] === "function") {
				regArgs[last] = wrapToolHandler(name, regArgs[last]);
			}
			// biome-ignore lint/suspicious/noExplicitAny: forwarding the original overloaded call.
			return (original as (...a: any[]) => unknown)(...regArgs);
		};
}

export function okResult(data: unknown): ToolText {
	const text =
		typeof data === "string" ? JSON.stringify(data) : JSON.stringify(data, null, 2);
	const result: ToolText = {
		content: [{ type: "text", text }],
	};
	if (data !== null && data !== undefined) {
		result.structuredContent =
			typeof data === "object" && !Array.isArray(data)
				? (data as Record<string, unknown>)
				: { value: data };
	}
	return result;
}

export function errorResult(env: Envelope): ToolText {
	return {
		content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
		isError: true,
	};
}

const AUTH_REMEDIATION =
	"Run `tarout login --token <api-key>` from the project directory on the machine running this MCP server. That writes ./.tarout/auth.json; start the MCP server from that same directory so it resolves the credential.";

export function toEnvelope(err: unknown, procedurePath?: string): Envelope {
	if (err instanceof ProcessExitAttemptedError) {
		if (err.exitCode === ExitCode.NEEDS_INPUT) {
			return {
				error:
					"This tool needs additional interactive input that isn't available over MCP. Supply the missing value as an explicit tool argument and retry.",
				code: "NEEDS_INPUT",
				details: { attemptedExitCode: err.exitCode },
			};
		}
		return {
			error: err.message,
			code: "GENERAL_ERROR",
			details: { attemptedExitCode: err.exitCode },
		};
	}
	if (err instanceof AuthError) {
		return {
			error: err.message,
			code: "AUTH_ERROR",
			remediation: AUTH_REMEDIATION,
		};
	}
	if (err instanceof DeploymentFailedError) {
		return {
			error: err.message,
			code: "DEPLOYMENT_FAILED",
			details: {
				deploymentId: err.deploymentId,
				errorAnalysis: err.errorAnalysis,
			},
		};
	}
	if (err instanceof BuildFailedError) {
		return {
			error: err.message,
			code: "BUILD_FAILED",
			details: { deploymentId: err.deploymentId },
		};
	}
	if (err instanceof DeploymentTimeoutError) {
		return {
			error: err.message,
			code: "DEPLOYMENT_TIMEOUT",
			details: { deploymentId: err.deploymentId },
		};
	}
	if (err instanceof NotFoundError) {
		return { error: err.message, code: "NOT_FOUND" };
	}
	if (err instanceof CliError) {
		// CliError.code is a numeric ExitCode; the envelope carries string codes so
		// downstream consumers can key off the same identifier the tRPC/agent side
		// already uses. See errors.ts::getErrorCode for the parallel mapping.
		return { error: err.message, code: String(err.code), details: err.details };
	}
	// tRPC client errors carry a `.data.code` from the server (FORBIDDEN, ...).
	if (
		err &&
		typeof err === "object" &&
		"data" in err &&
		err.data &&
		typeof (err as { data: { code?: unknown } }).data.code === "string"
	) {
		const e = err as { message?: string; data: { code: string } };
		return {
			error: e.message ?? "tRPC error",
			code: e.data.code,
			details: procedurePath ? { procedure: procedurePath } : undefined,
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return { error: message, code: "GENERAL_ERROR" };
}

/**
 * Run a tool body against an authenticated client.
 *
 * `cwd` matters more than it looks. Credentials are project-scoped
 * (`.tarout/auth.json`, resolved by walking up from a directory), but an MCP
 * server is launched by the editor and may be running from the editor's own
 * working directory or `$HOME` — while the tool call names the project it should
 * act on. Tools that take a `path` argument pass it here so the credential is
 * resolved from the project being operated on, not from wherever the server
 * happened to start. The override is restored afterwards so one tool call can
 * never leak its directory into the next.
 */
export async function withAuth(
	fn: (client: TrpcClient) => Promise<unknown>,
	procedurePath?: string,
	options: { cwd?: string } = {},
): Promise<ToolText> {
	const previousDir = options.cwd ? getCredentialResolutionDir() : null;
	if (options.cwd) {
		setCredentialResolutionDir(options.cwd);
		resetProjectAuthCache();
		// The client caches the token it was built with, so it has to be rebuilt
		// against whatever credential this directory resolves to.
		resetApiClient();
	}
	try {
		if (!isLoggedIn()) {
			return errorResult({
				error: "Not authenticated.",
				code: "AUTH_ERROR",
				remediation: AUTH_REMEDIATION,
			});
		}
		try {
			const client = getApiClient();
			const result = await fn(client);
			return okResult(result);
		} catch (err) {
			const env = toEnvelope(err, procedurePath);
			if (env.code === "FORBIDDEN") {
				await enrichForbiddenEnvelope(env, err);
			}
			return errorResult(env);
		}
	} finally {
		if (options.cwd) {
			setCredentialResolutionDir(previousDir);
			resetProjectAuthCache();
			resetApiClient();
		}
	}
}

/**
 * Parses the failed entitlement key from a server-side `assertEntitlement`
 * message of the form `Plan limit reached for <key>: <used>/<limit>.` (mirrors
 * commands/deploy.ts::extractEntitlementKeyFromError without importing that
 * heavy module into the runtime hot path).
 */
function entitlementKeyFromError(err: unknown): string | undefined {
	const msg = err instanceof Error ? err.message : "";
	return msg.match(/Plan limit reached for ([\w.]+)/i)?.[1];
}

/**
 * Best-effort: turn a bare FORBIDDEN entitlement rejection into an actionable
 * remedy (the exact `billing_upgrade`/addon command), the way tools/deploy.ts
 * does. Wrapped so a catalog-fetch or resolver failure never masks the original
 * error — on any failure the envelope is left as the plain FORBIDDEN it was.
 */
async function enrichForbiddenEnvelope(
	env: Envelope,
	err: unknown,
): Promise<void> {
	try {
		const client = getApiClient();
		// biome-ignore lint/suspicious/noExplicitAny: catalog shape narrows in resolveEntitlementRemedy.
		const catalog: any = await client.subscription.getCatalog
			.query()
			.catch(() => ({ plans: [], addons: [] }));
		const failedKey = entitlementKeyFromError(err);
		const remedy = resolveEntitlementRemedy(failedKey, catalog, {});
		env.remediation =
			"Upgrade or add an addon: call `billing_upgrade` with the remedy in `details`.";
		const prior =
			env.details && typeof env.details === "object" ? env.details : {};
		env.details = { ...prior, remedy, entitlementKey: failedKey };
	} catch {
		// best-effort enrichment; keep the original FORBIDDEN envelope intact.
	}
}
