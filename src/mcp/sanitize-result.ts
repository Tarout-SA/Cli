import { redactInlineImages } from "../utils/json.js";

const SECRET_PLACEHOLDER = "[redacted from MCP response]";

// Normalized (lower-cased, non-alphanumerics stripped) substrings that mark a
// key as credential-bearing. Substring matching is deliberate: it catches the
// compound keys the platform actually emits (coolifyToken, databasePassword,
// rootPassword, secretAccessKey, externalConnectionString, apiKey, api_key,
// accessToken, refreshToken, privateKey, connection_string, DATABASE_URL) with
// one list, and over-redaction is the safe failure mode for a secret filter.
const SENSITIVE_KEY_SUBSTRINGS = [
	"password",
	"secret",
	"token",
	"apikey",
	"privatekey",
	"connectionstring",
	"databaseurl",
];

// Curated MCP tools whose whole point is to surface connection credentials to
// the caller (see src/mcp/tools/db.ts and storage.ts). Their results skip
// sanitization so the agent still gets usable credentials. Every OTHER tool —
// including db_info/db_create, the raw `call` escape hatch, and db_sql query
// rows — is sanitized. Keep this list narrow: some ordinary platform responses
// can contain credential-bearing fields even when that is not the tool's goal.
export const CREDENTIAL_ALLOWLISTED_TOOLS = new Set([
	"db_credentials",
	"storage_credentials",
]);

// Matches the password segment of a credential URL (scheme://user:pass@host)
// so it can be redacted in-place while keeping the rest of the URL legible.
const CREDENTIAL_URL_PATTERN =
	/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^@\s/]+)(@)/gi;

function normalizeKey(key: string): string {
	return key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizeKey(key);
	return SENSITIVE_KEY_SUBSTRINGS.some((s) => normalized.includes(s));
}

function redactUrlPassword(value: string): string {
	return value.replace(
		CREDENTIAL_URL_PATTERN,
		(_match, prefix, _password, at) => `${prefix}${SECRET_PLACEHOLDER}${at}`,
	);
}

function sanitizeString(value: string): string {
	const withoutInlineImages = redactInlineImages(value);
	const trimmed = withoutInlineImages.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.stringify(
				sanitizeMcpCallResult(JSON.parse(withoutInlineImages)),
				null,
				2,
			);
		} catch {
			// Not valid JSON after all — fall through to plain-string redaction.
		}
	}
	return redactUrlPassword(withoutInlineImages);
}

/** Defense in depth for older hosted MCP endpoints which may still return an
 * inline screenshot or persisted infrastructure credential. The platform also
 * sanitizes these server-side. Recurses through nested objects AND arrays,
 * redacts credential-bearing keys, and strips the password out of any
 * connection-URL string value it encounters. */
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
				isSensitiveKey(key)
			) {
				return [key, SECRET_PLACEHOLDER];
			}
			return [key, sanitizeMcpCallResult(item)];
		}),
	) as T;
}

/**
 * Sanitizes a whole tool result (content text + structuredContent) unless the
 * tool is on the credential allowlist. This is the single chokepoint every MCP
 * tool result flows through, so the raw `call` escape hatch is covered too.
 */
export function sanitizeToolResult<T>(result: T, toolName: string): T {
	if (CREDENTIAL_ALLOWLISTED_TOOLS.has(toolName)) return result;
	return sanitizeMcpCallResult(result);
}
