import { AuthError } from "./errors.js";

const gateCookies = new Map<string, string>();

type FetchInput = string | URL | Request;

function requestUrl(input: FetchInput): URL {
	if (input instanceof URL) return input;
	if (typeof input === "string") return new URL(input);
	return new URL(input.url);
}

function requestHeaders(input: FetchInput, init?: RequestInit): Headers {
	const headers = new Headers(
		input instanceof Request ? input.headers : undefined,
	);
	if (init?.headers) {
		new Headers(init.headers).forEach((value, key) => {
			headers.set(key, value);
		});
	}
	return headers;
}

function isPasswordGateResponse(body: string): boolean {
	return /site is password-protected/i.test(body);
}

function sitePassword(): string | undefined {
	return process.env.TAROUT_SITE_PASSWORD || process.env.SITE_PASSWORD;
}

async function unlockPasswordGate(origin: string): Promise<string> {
	const password = sitePassword();
	if (!password) {
		throw new AuthError(
			"Tarout is currently password-protected. Set TAROUT_SITE_PASSWORD and try again.",
		);
	}

	const response = await fetch(`${origin}/api/password-gate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password }),
	});

	if (!response.ok) {
		throw new AuthError(
			"Tarout site password was rejected. Check TAROUT_SITE_PASSWORD and try again.",
		);
	}

	const setCookie = response.headers.get("set-cookie");
	const cookie = setCookie
		?.split(",")
		.find((part) => part.trim().startsWith("__tarout_site_gate="))
		?.trim()
		.split(";")[0];

	if (!cookie) {
		throw new AuthError("Tarout did not return a site-gate session cookie.");
	}

	gateCookies.set(origin, cookie);
	return cookie;
}

export async function platformFetch(
	input: FetchInput,
	init?: RequestInit,
): Promise<Response> {
	const url = requestUrl(input);
	const headers = requestHeaders(input, init);
	const existingCookie = gateCookies.get(url.origin);
	if (existingCookie && !headers.has("cookie")) {
		headers.set("cookie", existingCookie);
	}

	const response = await fetch(input, { redirect: "error", ...init, headers });
	if (response.status !== 401) return response;

	const body = await response
		.clone()
		.text()
		.catch(() => "");
	if (!isPasswordGateResponse(body)) return response;

	const cookie = await unlockPasswordGate(url.origin);
	headers.set("cookie", cookie);
	return fetch(input, { redirect: "error", ...init, headers });
}
