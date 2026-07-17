import { describe, expect, it } from "vitest";
import {
	createPkceChallenge,
	startAuthServer,
	startCliBrowserAuth,
} from "../../src/lib/auth-server";

function callbackUrl(port: number, params: Record<string, string>) {
	const url = new URL(`http://127.0.0.1:${port}/callback`);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

const AUTH_STATE = "s".repeat(43);
const EXCHANGED_PROFILE = {
	token: "cli_good",
	userId: "user_1",
	userEmail: "user@example.com",
	organizationId: "org_1",
	organizationName: "Org",
	projectId: "project_1",
	projectName: "Project One",
};

describe("CLI auth callback server", () => {
	it("requires the expected state before exchanging a one-time code", async () => {
		const authorizationCode = "c".repeat(43);
		const exchanges: Array<{ code: string; verifier: string }> = [];
		const server = await startAuthServer({
			state: AUTH_STATE,
			codeVerifier: "v".repeat(43),
			exchangeCode: async (code, verifier) => {
				exchanges.push({ code, verifier });
				return EXCHANGED_PROFILE;
			},
		});
		try {
			const rejected = await fetch(
				callbackUrl(server.port, {
					state: "wrong_state",
					code: authorizationCode,
				}),
			);

			expect(rejected.status).toBe(400);
			expect(exchanges).toEqual([]);

			const wait = server.waitForCallback();
			const accepted = await fetch(
				callbackUrl(server.port, {
					state: AUTH_STATE,
					code: authorizationCode,
				}),
			);

			expect(accepted.status).toBe(200);
			expect(exchanges).toEqual([
				{ code: authorizationCode, verifier: "v".repeat(43) },
			]);
			await expect(wait).resolves.toMatchObject({
				token: "cli_good",
				userEmail: "user@example.com",
				projectId: "project_1",
				projectName: "Project One",
			});
		} finally {
			server.close();
		}
	});

	it("rejects malformed authorization codes before the exchange", async () => {
		const exchanges: string[] = [];
		const server = await startAuthServer({
			state: AUTH_STATE,
			codeVerifier: "v".repeat(43),
			exchangeCode: async (code) => {
				exchanges.push(code);
				return EXCHANGED_PROFILE;
			},
		});
		try {
			const wait = server.waitForCallback();
			const rejected = await fetch(
				callbackUrl(server.port, {
					state: AUTH_STATE,
					code: "not-a-valid-code",
				}),
			);
			expect(rejected.status).toBe(400);
			expect(exchanges).toEqual([]);

			await fetch(
				callbackUrl(server.port, {
					state: AUTH_STATE,
					code: "c".repeat(43),
				}),
			);
			await expect(wait).resolves.toMatchObject(EXCHANGED_PROFILE);
		} finally {
			server.close();
		}
	});

	it("never accepts a long-lived token in the browser callback URL", async () => {
		let exchanges = 0;
		const server = await startAuthServer({
			state: AUTH_STATE,
			codeVerifier: "v".repeat(43),
			exchangeCode: async () => {
				exchanges += 1;
				return EXCHANGED_PROFILE;
			},
		});
		try {
			const wait = server.waitForCallback();
			const response = await fetch(
				callbackUrl(server.port, {
					state: AUTH_STATE,
					token: "long_lived_secret_must_not_be_accepted",
					userEmail: "user@example.com",
					organizationId: "org_1",
					projectId: "project_1",
				}),
			);

			expect(response.status).toBe(400);
			expect(await response.text()).toContain("code");
			expect(exchanges).toBe(0);

			await fetch(
				callbackUrl(server.port, {
					state: AUTH_STATE,
					code: "c".repeat(43),
				}),
			);
			await expect(wait).resolves.toMatchObject(EXCHANGED_PROFILE);
		} finally {
			server.close();
		}
	});

	it("escapes callback error text in the browser response", async () => {
		const server = await startAuthServer({
			state: AUTH_STATE,
			codeVerifier: "v".repeat(43),
			exchangeCode: async () => EXCHANGED_PROFILE,
		});
		try {
			const wait = server.waitForCallback().catch((error) => error);
			const response = await fetch(
				callbackUrl(server.port, {
					state: AUTH_STATE,
					error: '<script>alert("xss")</script>',
				}),
			);
			const text = await response.text();

			expect(response.status).toBe(200);
			expect(text).not.toContain("<script>");
			expect(text).toContain("&lt;script&gt;");
			await expect(wait).resolves.toBeInstanceOf(Error);
		} finally {
			server.close();
		}
	});

	it("exchanges at most once when callbacks arrive concurrently", async () => {
		let releaseExchange: (() => void) | undefined;
		const exchangeGate = new Promise<void>((resolve) => {
			releaseExchange = resolve;
		});
		let markExchangeStarted: (() => void) | undefined;
		const exchangeStarted = new Promise<void>((resolve) => {
			markExchangeStarted = resolve;
		});
		let exchanges = 0;
		const server = await startAuthServer({
			state: AUTH_STATE,
			codeVerifier: "v".repeat(43),
			exchangeCode: async () => {
				exchanges += 1;
				markExchangeStarted?.();
				await exchangeGate;
				return EXCHANGED_PROFILE;
			},
		});
		try {
			const url = callbackUrl(server.port, {
				state: AUTH_STATE,
				code: "c".repeat(43),
			});
			const first = fetch(url);
			await exchangeStarted;
			const replay = await fetch(url);
			expect(replay.status).toBe(409);
			expect(exchanges).toBe(1);
			releaseExchange?.();
			expect((await first).status).toBe(200);
			await expect(server.waitForCallback()).resolves.toMatchObject(
				EXCHANGED_PROFILE,
			);
		} finally {
			releaseExchange?.();
			server.close();
		}
	});
});

describe("CLI browser authorization URL", () => {
	it("binds protocol v2, state, and the S256 challenge to the loopback callback", async () => {
		const state = "s".repeat(43);
		const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const session = await startCliBrowserAuth("https://tarout.sa", {
			state,
			codeVerifier,
			exchangeCode: async () => EXCHANGED_PROFILE,
		});
		try {
			const authorizationUrl = new URL(session.authUrl);
			const callback = new URL(
				authorizationUrl.searchParams.get("callback") ?? "",
			);

			expect(authorizationUrl.origin).toBe("https://tarout.sa");
			expect(authorizationUrl.pathname).toBe("/cli-authorize");
			expect([...authorizationUrl.searchParams.keys()]).toEqual(["callback"]);
			expect(callback.origin).toBe(`http://127.0.0.1:${session.port}`);
			expect(callback.pathname).toBe("/callback");
			expect(Object.fromEntries(callback.searchParams)).toEqual({
				state,
				protocol: "2",
				code_challenge: createPkceChallenge(codeVerifier),
				code_challenge_method: "S256",
			});
			expect(callback.search).not.toContain(codeVerifier);
			expect(callback.searchParams.has("token")).toBe(false);
		} finally {
			session.close();
		}
	});

	it("uses the RFC 7636 S256 challenge and refuses malformed PKCE input", async () => {
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		expect(createPkceChallenge(verifier)).toBe(
			"E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		);
		await expect(
			startCliBrowserAuth("https://tarout.sa", {
				state: "short",
				codeVerifier: verifier,
			}),
		).rejects.toThrow(/invalid authentication state/i);
		await expect(
			startCliBrowserAuth("https://tarout.sa", {
				state: AUTH_STATE,
				codeVerifier: "short",
			}),
		).rejects.toThrow(/invalid PKCE verifier/i);
	});

	it("refuses unsafe API URLs before creating the loopback callback", async () => {
		for (const apiUrl of [
			"file:///tmp/tarout",
			"http://evil.example",
			"https://user:password@tarout.sa",
			"https://tarout.sa/?callback=https://evil.example",
		]) {
			await expect(startCliBrowserAuth(apiUrl)).rejects.toThrow(
				/invalid API URL/i,
			);
		}
	});

	it("uses the same v2 callback for account registration", async () => {
		const session = await startCliBrowserAuth("https://tarout.sa", {
			action: "register",
			exchangeCode: async () => EXCHANGED_PROFILE,
		});
		try {
			const authorizationUrl = new URL(session.authUrl);
			expect(authorizationUrl.searchParams.get("action")).toBe("register");
			const callback = new URL(
				authorizationUrl.searchParams.get("callback") ?? "",
			);
			expect(callback.searchParams.get("protocol")).toBe("2");
			expect(callback.searchParams.get("code_challenge_method")).toBe("S256");
			expect(callback.searchParams.has("token")).toBe(false);
		} finally {
			session.close();
		}
	});
});
