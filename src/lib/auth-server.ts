import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { normalizeApiUrl } from "./api-url.js";
import { platformFetch } from "./password-gate.js";

export interface AuthCallbackData {
	token: string;
	userId: string;
	userEmail: string;
	userName?: string;
	organizationId: string;
	organizationName: string;
	projectId: string;
	projectName: string;
	projectSlug?: string;
	/** Compatibility hints from older platform releases; not auth scopes. */
	environmentId?: string;
	environmentName?: string;
}

export type ExchangeAuthorizationCode = (
	code: string,
	codeVerifier: string,
) => Promise<AuthCallbackData>;

export interface StartAuthServerOptions {
	state?: string;
	codeVerifier?: string;
	exchangeCode: ExchangeAuthorizationCode;
	timeoutMs?: number;
}

export interface StartCliBrowserAuthOptions
	extends Omit<StartAuthServerOptions, "exchangeCode"> {
	action?: "login" | "register";
	exchangeCode?: ExchangeAuthorizationCode;
}

function createAuthState(): string {
	return randomBytes(32).toString("base64url");
}

export function createPkceVerifier(): string {
	return randomBytes(32).toString("base64url");
}

export function createPkceChallenge(codeVerifier: string): string {
	return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

function parseAuthCallbackData(value: unknown): AuthCallbackData {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			"Tarout returned an invalid response to the authorization-code exchange.",
		);
	}

	const record = value as Record<string, unknown>;
	const required = [
		"token",
		"userId",
		"userEmail",
		"organizationId",
		"organizationName",
		"projectId",
		"projectName",
	] as const;
	const optional = [
		"userName",
		"projectSlug",
		"environmentId",
		"environmentName",
	] as const;
	const valid =
		required.every(
			(key) => typeof record[key] === "string" && record[key].length > 0,
		) &&
		optional.every(
			(key) => record[key] === undefined || typeof record[key] === "string",
		);
	if (!valid) {
		throw new Error(
			"Tarout returned an invalid response to the authorization-code exchange.",
		);
	}

	return record as unknown as AuthCallbackData;
}

export async function exchangeCliAuthorizationCode(
	apiUrl: string,
	code: string,
	codeVerifier: string,
	options: { timeoutMs?: number } = {},
): Promise<AuthCallbackData> {
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(code) ||
		!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)
	) {
		throw new Error("Invalid authorization request.");
	}
	const normalizedApiUrl = normalizeApiUrl(apiUrl);
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 15_000,
	);
	timeout.unref?.();

	try {
		const endpoint = `${normalizedApiUrl}/api/cli/exchange`;
		const response = await platformFetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code, codeVerifier }),
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`Tarout rejected the authorization-code exchange (HTTP ${response.status}).`,
			);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error(
				"Tarout returned an invalid response to the authorization-code exchange.",
			);
		}
		return parseAuthCallbackData(body);
	} finally {
		clearTimeout(timeout);
	}
}

export async function startCliBrowserAuth(
	apiUrl: string,
	options: StartCliBrowserAuthOptions = {},
): Promise<
	Awaited<ReturnType<typeof startAuthServer>> & {
		authUrl: string;
		callbackUrl: string;
	}
> {
	const normalizedApiUrl = normalizeApiUrl(apiUrl);
	const authServer = await startAuthServer({
		state: options.state,
		codeVerifier: options.codeVerifier,
		timeoutMs: options.timeoutMs,
		exchangeCode:
			options.exchangeCode ??
			((code, codeVerifier) =>
				exchangeCliAuthorizationCode(normalizedApiUrl, code, codeVerifier)),
	});
	const callbackUrl = new URL(
		`http://127.0.0.1:${authServer.port}/callback`,
	);
	callbackUrl.searchParams.set("state", authServer.state);
	callbackUrl.searchParams.set("protocol", "2");
	callbackUrl.searchParams.set("code_challenge", authServer.codeChallenge);
	callbackUrl.searchParams.set("code_challenge_method", "S256");

	const authUrl = new URL(`${normalizedApiUrl}/cli-authorize`);
	if (options.action === "register") {
		authUrl.searchParams.set("action", "register");
	}
	authUrl.searchParams.set("callback", callbackUrl.toString());

	return {
		...authServer,
		authUrl: authUrl.toString(),
		callbackUrl: callbackUrl.toString(),
	};
}

function safeEqual(a: string, b: string): boolean {
	const aBuffer = Buffer.from(a);
	const bBuffer = Buffer.from(b);
	if (aBuffer.length !== bBuffer.length) return false;
	return timingSafeEqual(aBuffer, bBuffer);
}

function escapeHtml(value: unknown): string {
	return String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function startAuthServer(options: StartAuthServerOptions): Promise<{
	port: number;
	state: string;
	codeChallenge: string;
	waitForCallback: () => Promise<AuthCallbackData>;
	close: () => void;
}> {
	return new Promise((resolve) => {
		const app = express();
		const expectedState = options.state ?? createAuthState();
		const codeVerifier = options.codeVerifier ?? createPkceVerifier();
		if (!/^[A-Za-z0-9_-]{32,128}$/.test(expectedState)) {
			throw new Error("Invalid authentication state.");
		}
		if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
			throw new Error("Invalid PKCE verifier.");
		}
		const codeChallenge = createPkceChallenge(codeVerifier);
		// biome-ignore lint/style/useConst: server is declared before assignment due to closure scope requirements
		let server: Server;
		let callbackResolver: (data: AuthCallbackData) => void;
		let callbackRejecter: (error: Error) => void;

		const callbackPromise = new Promise<AuthCallbackData>((res, rej) => {
			callbackResolver = res;
			callbackRejecter = rej;
		});

		let callbackStarted = false;

		app.get("/callback", async (req, res) => {
			const { code, error, state } = req.query;

			if (
				!state ||
				Array.isArray(state) ||
				!safeEqual(String(state), expectedState)
			) {
				res.status(400).send("Invalid authentication state");
				return;
			}

			if (error) {
				res.send(`
	          <!DOCTYPE html>
          <html>
            <head>
              <title>Tarout</title>
              <style>
                body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
                .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #dc2626; margin-bottom: 16px; }
                p { color: #666; }
              </style>
            </head>
	            <body>
	              <div class="container">
	                <h1>Authentication Failed</h1>
	                <p>${escapeHtml(error)}</p>
	                <p>You can close this window and try again.</p>
	              </div>
	            </body>
          </html>
        `);
				callbackRejecter(new Error(String(error)));
				return;
			}

			if (!code || Array.isArray(code)) {
				res.status(400).send("Missing required authorization code");
				return;
			}
			if (!/^[A-Za-z0-9_-]{43}$/.test(String(code))) {
				res.status(400).send("Invalid authorization code");
				return;
			}

			if (callbackStarted) {
				res.status(409).send("Authentication callback already received");
				return;
			}
			callbackStarted = true;

			let authData: AuthCallbackData;
			try {
				authData = await options.exchangeCode(String(code), codeVerifier);
			} catch (error) {
				res
					.status(502)
					.send("Authentication exchange failed. Return to the terminal to retry.");
				callbackRejecter(
					error instanceof Error
						? error
						: new Error("Authentication exchange failed"),
				);
				return;
			}

			res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Tarout</title>
            <style>
              body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
              .container { text-align: center; padding: 40px; background: white; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
              h1 { color: #16a34a; margin-bottom: 16px; }
              p { color: #666; }
              .checkmark { font-size: 64px; margin-bottom: 16px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="checkmark">✓</div>
              <h1>Authenticated!</h1>
              <p>You can close this window and return to the terminal.</p>
            </div>
          </body>
        </html>
      `);

			callbackResolver(authData);
		});

		// Timeout after 5 minutes
		const timeout = setTimeout(
			() => {
				callbackRejecter(
					new Error("Authentication timed out. Please try again."),
				);
				server.close();
			},
			options.timeoutMs ?? 5 * 60 * 1000,
		);
		timeout.unref?.();

		const close = () => {
			clearTimeout(timeout);
			server.close();
		};

		// Find an available port
		server = app.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;

			resolve({
				port,
				state: expectedState,
				codeChallenge,
				waitForCallback: () => callbackPromise,
				close,
			});
		});
	});
}
