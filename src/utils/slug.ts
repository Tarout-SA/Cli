/**
 * URL-safe application slug — the hardened variant from commands/deploy.ts.
 * Unlike a bare lowercase/dash pass, this guarantees the platform's
 * `appName` shape (`/^[a-z][a-z0-9-]*[a-z0-9]$/`): collapses dash runs and
 * prefixes `app-` when the result would start with a digit or be empty
 * (e.g. "123" → "app-123", "!!!" → "app-tarout-app").
 */
export function generateSlug(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");

	if (/^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug)) return slug;
	return `app-${slug || "tarout-app"}`.replace(/-+$/g, "");
}
