/**
 * MCP tool runtime — shared auth guard, error → JSON envelope mapping, and
 * result helpers used by every tool handler.
 *
 * Handlers NEVER call process.exit(), handleError(), or any CLI output helper
 * that writes to stdout (outputJsonLine / promptOrEmit / emitNeedsUpgrade).
 * They return one of the two shapes below via okResult()/errorResult().
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	extractEntitlementKeyFromError,
	isEntitlementError,
} from "../commands/deploy.js";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	BuildFailedError,
	CliError,
	DeploymentFailedError,
	DeploymentTimeoutError,
	getErrorCode,
	NotFoundError,
	staleCredentialGuidance,
} from "../lib/errors.js";
import { resolveEntitlementRemedy } from "../lib/entitlement-remedy.js";
import { ExitCode } from "../utils/exit-codes.js";
import { stringifyJson } from "../utils/json.js";
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
	// JSON.stringify(undefined) is undefined, which would put a non-string in a
	// text content item and fail CallToolResult validation client-side.
	if (data === null || data === undefined) {
		return { content: [{ type: "text", text: "null" }] };
	}
	// Serialize via the bigint-aware replacer: the tRPC client's superjson
	// transformer revives bigint (PostgreSQL statistics) which raw
	// JSON.stringify rejects, and revived Date instances would be flattened to
	// {} by the sanitizer's plain-object walk. Re-parsing the serialized form
	// gives structuredContent the same plain-JSON view (bigint → string,
	// Date → ISO string) instead of live class instances.
	const text =
		typeof data === "string" ? JSON.stringify(data) : stringifyJson(data, 2);
	const plain: unknown = typeof data === "string" ? data : JSON.parse(text);
	const result: ToolText = {
		content: [{ type: "text", text }],
	};
	result.structuredContent =
		plain !== null && typeof plain === "object" && !Array.isArray(plain)
			? (plain as Record<string, unknown>)
			: { value: plain };
	return result;
}

export function errorResult(env: Envelope): ToolText {
	return {
		content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
		isError: true,
	};
}

const AUTH_REMEDIATION =
	"Run `tarout login` on the machine running this MCP server, or set the TAROUT_TOKEN env var to an API key.";

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
		// The suppressed helper printed its real message to stderr, where no MCP
		// client reads — the semantic ExitCode (AUTH_ERROR, NOT_FOUND, ...) is the
		// only signal left, so surface it instead of a flat GENERAL_ERROR.
		const mapped = getErrorCode(err.exitCode);
		return {
			error: err.message,
			code:
				mapped === "ERROR" || mapped === "SUCCESS" ? "GENERAL_ERROR" : mapped,
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
		// CliError.code is a numeric ExitCode; the envelope carries the same
		// string codes the CLI's JSON mode emits (errors.ts::getErrorCode).
		const code =
			typeof err.code === "number" ? getErrorCode(err.code) : String(err.code);
		return {
			error: err.message,
			code: code === "ERROR" ? "GENERAL_ERROR" : code,
			details: err.details,
		};
	}
	// tRPC client errors carry a `.data.code` from the server (FORBIDDEN, ...);
	// local throw sites may attach a top-level string `code` (and optionally a
	// `remediation`) to a plain Error. Accept both shapes, mirroring
	// errors.ts::handleError.
	if (err && typeof err === "object") {
		const e = err as {
			code?: unknown;
			message?: string;
			remediation?: unknown;
			data?: { code?: unknown };
		};
		const code =
			typeof e.code === "string"
				? e.code
				: typeof e.data?.code === "string"
					? e.data.code
					: undefined;
		if (code) {
			const env: Envelope = {
				error: e.message ?? "Request failed",
				code,
				details: procedurePath ? { procedure: procedurePath } : undefined,
			};
			if (typeof e.remediation === "string") env.remediation = e.remediation;
			// A stored-but-rejected credential gets the same re-auth guidance the
			// CLI's handleError attaches, instead of a bare UNAUTHORIZED.
			const stale = staleCredentialGuidance(code);
			if (stale) {
				env.error = `${env.error} — ${stale.hint}`;
				env.remediation ??= stale.details.hint;
				env.details = { ...(env.details ?? {}), ...stale.details };
			}
			return env;
		}
	}
	const message = err instanceof Error ? err.message : String(err);
	return { error: message, code: "GENERAL_ERROR" };
}

export async function withAuth(
	fn: (client: TrpcClient) => Promise<unknown>,
	procedurePath?: string,
): Promise<ToolText> {
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
}

/**
 * Best-effort: turn a FORBIDDEN *entitlement* rejection into an actionable
 * remedy (the exact `billing_upgrade`/addon command), the way tools/deploy.ts
 * does. Gated on isEntitlementError so a plain RBAC permission denial is never
 * answered with "buy an upgrade" (and pays no catalog round-trip). Wrapped so a
 * catalog-fetch or resolver failure never masks the original error — on any
 * failure the envelope is left as the plain FORBIDDEN it was.
 */
async function enrichForbiddenEnvelope(
	env: Envelope,
	err: unknown,
): Promise<void> {
	try {
		if (!isEntitlementError(err)) return;
		const failedKey = extractEntitlementKeyFromError(err);
		const client = getApiClient();
		// biome-ignore lint/suspicious/noExplicitAny: catalog shape narrows in resolveEntitlementRemedy.
		const catalog: any = await client.subscription.getCatalog
			.query()
			.catch(() => ({ plans: [], addons: [] }));
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
