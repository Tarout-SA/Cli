/**
 * Structured JSON output for AI-friendly CLI
 */

export interface JsonSuccessResponse<T> {
	success: true;
	data: T;
	meta?: {
		total?: number;
		page?: number;
	};
}

export interface JsonErrorResponse {
	success: false;
	error: {
		code: string;
		message: string;
		suggestions?: string[];
		details?: unknown;
	};
}

export type JsonResponse<T> = JsonSuccessResponse<T> | JsonErrorResponse;

export function jsonSuccess<T>(
	data: T,
	meta?: JsonSuccessResponse<T>["meta"],
): JsonSuccessResponse<T> {
	return {
		success: true,
		data,
		...(meta && { meta }),
	};
}

export function jsonError(
	code: string,
	message: string,
	suggestions?: string[],
	details?: unknown,
): JsonErrorResponse {
	return {
		success: false,
		error: {
			code,
			message,
			...(suggestions && { suggestions }),
			...(details !== undefined && { details }),
		},
	};
}

/**
 * Print the JSON envelope as a single newline-terminated line. Agents
 * stream stdout line-by-line and read each line as a complete JSON
 * value (matching the `outputJsonLine` shape used for streaming events),
 * so the final envelope must be one line too — pretty-printing it would
 * break line-buffered parsers reading `needs_input` / `checkout_status`
 * events from the same stream.
 */
export function outputJson<T>(response: JsonResponse<T>): void {
	console.log(JSON.stringify(response));
}
