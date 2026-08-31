import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { exchangeCliAuthorizationCode } from "../../src/lib/auth-server";

const PROFILE = {
	token: "cli_test_token",
	userId: "user_1",
	userEmail: "user@example.com",
	organizationId: "org_1",
	organizationName: "Example Org",
	projectId: "project_1",
	projectName: "Example Project",
};
const AUTHORIZATION_CODE = "c".repeat(43);

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
});

async function listen(
	handler: (request: IncomingMessage, body: string) => void,
): Promise<string> {
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			handler(request, body);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(PROFILE));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	return `http://127.0.0.1:${address.port}`;
}

async function listenRaw(
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	return `http://127.0.0.1:${address.port}`;
}

describe("CLI authorization-code exchange", () => {
	it("accepts the account-scoped response returned by the v2 exchange API", async () => {
		const accountProfile = {
			token: "cli_account_token",
			userId: "user_1",
			userEmail: "user@example.com",
			userName: "Example User",
			organizationId: "org_1",
			organizationName: "Example Org",
		};
		const apiUrl = await listenRaw((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(accountProfile));
		});

		await expect(
			exchangeCliAuthorizationCode(apiUrl, "c".repeat(22)),
		).resolves.toEqual(accountProfile);
	});

	it("sends the one-time code and PKCE verifier in a POST body", async () => {
		let captured:
			| { method?: string; url?: string; contentType?: string; body: string }
			| undefined;
		const apiUrl = await listen((request, body) => {
			captured = {
				method: request.method,
				url: request.url,
				contentType: request.headers["content-type"],
				body,
			};
		});

		await expect(
			exchangeCliAuthorizationCode(
				apiUrl,
				AUTHORIZATION_CODE,
				"v".repeat(43),
			),
		).resolves.toEqual(PROFILE);

		expect(captured).toEqual({
			method: "POST",
			url: "/api/cli/exchange",
			contentType: "application/json",
			body: JSON.stringify({
				code: AUTHORIZATION_CODE,
				codeVerifier: "v".repeat(43),
			}),
		});
	});

	it("refuses redirects so credentials cannot be forwarded to another host", async () => {
		let redirectedRequests = 0;
		const redirectTarget = await listenRaw((_request, response) => {
			redirectedRequests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(PROFILE));
		});
		const apiUrl = await listenRaw((_request, response) => {
			response.writeHead(307, { location: `${redirectTarget}/collect` });
			response.end();
		});

		const code = AUTHORIZATION_CODE;
		const verifier = "s".repeat(43);
		let error: unknown;
		try {
			await exchangeCliAuthorizationCode(apiUrl, code, verifier);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(code);
		expect(String(error)).not.toContain(verifier);
		expect(redirectedRequests).toBe(0);
	});

	it("bounds a stalled exchange instead of waiting indefinitely", async () => {
		const apiUrl = await listenRaw(() => {
			// Deliberately never respond; the CLI must abort its own request.
		});

		const startedAt = Date.now();
		await expect(
			exchangeCliAuthorizationCode(apiUrl, AUTHORIZATION_CODE, "v".repeat(43), {
				timeoutMs: 25,
			}),
		).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it("rejects malformed exchange responses instead of persisting partial credentials", async () => {
		const returnedToken = "must_not_appear_in_the_error";
		const apiUrl = await listenRaw((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ token: returnedToken, userId: "user_1" }));
		});

		let error: unknown;
		try {
			await exchangeCliAuthorizationCode(
				apiUrl,
				AUTHORIZATION_CODE,
				"v".repeat(43),
			);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toMatch(/invalid response/i);
		expect(String(error)).not.toContain(returnedToken);
	});

	it("rejects malformed codes and verifiers before making a request", async () => {
		let requests = 0;
		const apiUrl = await listenRaw((_request, response) => {
			requests += 1;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(PROFILE));
		});

		await expect(
			exchangeCliAuthorizationCode(apiUrl, "too-short", "v".repeat(43)),
		).rejects.toThrow(/invalid authorization request/i);
		await expect(
			exchangeCliAuthorizationCode(apiUrl, "c".repeat(43), "too-short"),
		).rejects.toThrow(/invalid authorization request/i);
		expect(requests).toBe(0);
	});

	it("only sends the exchange to an HTTP(S) API URL without embedded credentials", async () => {
		for (const apiUrl of [
			"file:///tmp/tarout",
			"http://evil.example",
			"https://user:password@tarout.sa",
			"https://tarout.sa/?redirect=https://evil.example",
		]) {
			await expect(
				exchangeCliAuthorizationCode(
					apiUrl,
					AUTHORIZATION_CODE,
					"v".repeat(43),
				),
			).rejects.toThrow(/invalid API URL/i);
		}
	});
});
