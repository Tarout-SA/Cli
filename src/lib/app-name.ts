/**
 * Normalize a human-typed name into an `appName` slug the platform accepts.
 *
 * The server enforces `^[a-z](?!.*--)([a-z0-9-]*[a-z0-9])?$`: lowercase, first
 * character a letter, no consecutive hyphens, last character alphanumeric.
 * Naive slugifiers pass through two inputs the API then rejects with
 * "App name must start with a letter...": names beginning with a digit
 * ("2048 game") and names with no ASCII alphanumerics at all (Arabic, emoji),
 * which slug down to an empty string. Every appName derivation in the CLI and
 * the MCP server goes through this helper so those cases become valid slugs
 * instead of a create-time validation error.
 */
export function toAppNameSlug(
	name: string | undefined,
	fallback = "app",
): string {
	const base = (name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!base) return fallback;

	const withLetterStart = /^[a-z]/.test(base) ? base : `${fallback}-${base}`;
	const capped = withLetterStart.slice(0, 63).replace(/-+$/g, "");

	return capped || fallback;
}
