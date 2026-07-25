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
	// Mints a new S3 access key and returns its ONE-TIME secret — the whole
	// point of the tool. Without this the sanitizer masks the `secret` field and
	// the caller can never recover it (the platform never shows it again).
	"storage_access_key_create",
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

// Matches a dotenv-style `KEY=VALUE` line (optionally `export KEY=…`). A full
// secret export (e.g. envVariable.export/getAsString) arrives as ONE string
// value under a non-sensitive key ("content"/"text"), so the per-key object
// redaction never sees these keys — this recovers that protection line-by-line
// by masking the RHS of any line whose key name looks credential-bearing.
const DOTENV_LINE_PATTERN =
	/^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_.]*)([ \t]*=[ \t]*)(.+)$/gm;

function redactDotenvSecrets(value: string): string {
	return value.replace(
		DOTENV_LINE_PATTERN,
		(match, prefix, key, eq) =>
			isSensitiveKey(key) ? `${prefix}${key}${eq}${SECRET_PLACEHOLDER}` : match,
	);
}

// Well-known credential value shapes that identify a secret by its OWN format,
// regardless of any surrounding key name (Stripe/Moyasar, OpenAI, GitHub,
// GitLab, Slack, AWS, Google, SendGrid, and Tarout's own keys). The prefixes
// are distinctive enough that matching them does not touch ordinary prose or
// identifiers.
const TOKEN_VALUE_PATTERNS: RegExp[] = [
	// Stripe / Moyasar publishable, secret & restricted keys, and webhook secrets
	/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
	/\bwhsec_[A-Za-z0-9]{16,}/g,
	// OpenAI-style keys (incl. project keys)
	/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
	// GitHub personal / OAuth / app / refresh tokens and fine-grained PATs
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{22,}/g,
	// GitLab personal access tokens
	/\bglpat-[A-Za-z0-9_-]{20,}/g,
	// Slack bot/user/app/refresh tokens
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
	// AWS access key IDs
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	// Google API keys
	/\bAIza[A-Za-z0-9_-]{35}\b/g,
	// SendGrid API keys
	/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
	// Tarout Email API key: `te_` + base64url(24 random bytes) = 35 chars — too
	// short for the high-entropy catch below, and matched no vendor shape.
	/\bte_[A-Za-z0-9_-]{30,}/g,
	// Tarout platform API keys (better-auth): the issued prefix followed by 64
	// characters drawn from a-z/A-Z ONLY. With no digit they slip past the
	// high-entropy catch below, so match the two prefixes the platform issues
	// (`agent` for agent/onboarding keys, `cli` for `tarout login`). The exact
	// 64-char body keeps this off ordinary long identifiers.
	/\b(?:agent|cli)[A-Za-z]{64}\b/g,
	// Tarout-issued opaque tokens. The alphanumeric-only body stops at the first
	// underscore, so readable `tarout_*` identifiers (env keys, cookie names,
	// shell helpers) are untouched.
	/\btarout_[A-Za-z0-9]{24,}\b/g,
];

function redactTokenValues(value: string): string {
	return TOKEN_VALUE_PATTERNS.reduce(
		(acc, pattern) => acc.replace(pattern, SECRET_PLACEHOLDER),
		value,
	);
}

// Last-resort catch for a prefix-less, key-less credential: a long, high-entropy
// run that mixes upper, lower AND digits (the shape of a random API key/bearer
// token). Thresholds are deliberately strict so ordinary identifiers survive —
// UUIDs, single-case git SHAs / container hashes and slugs lack the case+digit
// mix, and short values never reach the length bar.
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{40,}/g;

function shannonEntropy(s: string): number {
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const count of counts.values()) {
		const p = count / s.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

function looksLikeSecretToken(token: string): boolean {
	if (!/[a-z]/.test(token)) return false;
	if (!/[A-Z]/.test(token)) return false;
	if (!/[0-9]/.test(token)) return false;
	return shannonEntropy(token) >= 3.5;
}

function redactHighEntropyTokens(value: string): string {
	return value.replace(HIGH_ENTROPY_CANDIDATE, (token) =>
		looksLikeSecretToken(token) ? SECRET_PLACEHOLDER : token,
	);
}

// Value-based redaction for a free-form (non-JSON) string. Layered so key-name
// redaction is no longer the only line of defense: URL passwords, dotenv secret
// lines, vendor token shapes, then generic high-entropy tokens.
function redactSecretValues(value: string): string {
	let out = redactUrlPassword(value);
	out = redactDotenvSecrets(out);
	out = redactTokenValues(out);
	out = redactHighEntropyTokens(out);
	return out;
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
	return redactSecretValues(withoutInlineImages);
}

/** Defense in depth for older hosted MCP endpoints which may still return an
 * inline screenshot or persisted infrastructure credential. The platform also
 * sanitizes these server-side. Recurses through nested objects AND arrays,
 * redacts credential-bearing keys, and applies value-based redaction to string
 * values (URL passwords, dotenv secret lines, known token shapes and generic
 * high-entropy tokens) so raw secrets embedded in free-form output — e.g. a
 * dotenv blob from the `call` escape hatch — do not reach the agent. */
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
