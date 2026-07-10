/**
 * MCP tool runtime — shared auth guard, error → JSON envelope mapping, and
 * result helpers used by every tool handler.
 *
 * Handlers NEVER call process.exit(), handleError(), or any CLI output helper
 * that writes to stdout (outputJsonLine / promptOrEmit / emitNeedsUpgrade).
 * They return one of the two shapes below via okResult()/errorResult().
 */
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	BuildFailedError,
	CliError,
	DeploymentFailedError,
	DeploymentTimeoutError,
	NotFoundError,
} from "../lib/errors.js";

export interface Envelope {
	error: string;
	code: string;
	remediation?: string;
	details?: unknown;
}

export interface ToolText {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	structuredContent?: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
export type TrpcClient = any;

export function okResult(data: unknown): ToolText {
	const text =
		typeof data === "string"
			? JSON.stringify(data)
			: JSON.stringify(data, null, 2);
	return {
		content: [{ type: "text", text }],
		structuredContent: data === undefined ? null : (data as unknown),
	};
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
		return errorResult(toEnvelope(err, procedurePath));
	}
}
