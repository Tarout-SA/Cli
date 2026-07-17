export function normalizeApiUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid API URL.");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Invalid API URL.");
	}
	const host = url.hostname.toLowerCase();
	const isLoopback =
		host === "localhost" || host === "127.0.0.1" || host === "[::1]";
	if (url.protocol === "http:" && !isLoopback) {
		throw new Error("Invalid API URL. HTTPS is required outside loopback.");
	}
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${path === "/" ? "" : path}`;
}
