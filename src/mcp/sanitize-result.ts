import { redactInlineImages } from "../utils/json.js";

const SECRET_PLACEHOLDER = "[redacted from MCP response]";
const SENSITIVE_RESULT_KEYS = new Set([
	"coolifytoken",
	"databasepassword",
	"externalconnectionstring",
	"rootpassword",
	"secretaccesskey",
]);

function normalizeKey(key: string): string {
	return key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function sanitizeString(value: string): string {
	const withoutInlineImages = redactInlineImages(value);
	const trimmed = withoutInlineImages.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return withoutInlineImages;
	}

	try {
		return JSON.stringify(
			sanitizeMcpCallResult(JSON.parse(withoutInlineImages)),
			null,
			2,
		);
	} catch {
		return withoutInlineImages;
	}
}

/** Defense in depth for older hosted MCP endpoints which may still return an
 * inline screenshot or persisted infrastructure credential. The platform also
 * sanitizes these server-side. */
export function sanitizeMcpCallResult<T>(value: T): T {
	if (typeof value === "string") return sanitizeString(value) as T;
	if (Array.isArray(value)) return value.map(sanitizeMcpCallResult) as T;
	if (!value || typeof value !== "object") return value;

	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => {
			if (
				item !== null &&
				item !== undefined &&
				item !== "" &&
				SENSITIVE_RESULT_KEYS.has(normalizeKey(key))
			) {
				return [key, SECRET_PLACEHOLDER];
			}
			return [key, sanitizeMcpCallResult(item)];
		}),
	) as T;
}
