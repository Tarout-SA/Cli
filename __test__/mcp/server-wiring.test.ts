/**
 * End-to-end wiring proof for the credential sanitizer.
 *
 * The unit tests in mcp-sanitize-result.test.ts prove `sanitizeToolResult`
 * redacts credentials, and runtime.test.ts proves `guardServerHandlers` wraps
 * handlers — but NOTHING proved the real server factory (`createMcpServer`,
 * which stdio.ts uses verbatim) actually wires the two together. Without this
 * test, deleting `guardServerHandlers(server)` from server.ts, or the
 * `sanitizeToolResult(...)` call from runtime.ts's wrapper, would leave every
 * other MCP test green while the escape-hatch `call` tool leaks secrets.
 *
 * So: build the REAL server, invoke the REAL registered non-allowlisted `call`
 * tool with a mocked client response full of credentials, and assert the
 * returned content is redacted. This test FAILS if the sanitizer is unwired.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

// The `call` escape hatch resolves the procedure against the surface manifest
// before dispatching. Stub the manifest so resolution is deterministic and no
// real cache file / network is touched — the sanitizer wiring is what's under
// test, not manifest loading. (Factory is hoisted, so the manifest is inlined.)
vi.mock("../../src/lib/surface-manifest", () => {
	const manifest = [
		{ path: "application.one", type: "query", router: "application" },
	];
	return {
		loadManifest: vi.fn().mockResolvedValue(manifest),
		fetchManifestFresh: vi.fn().mockResolvedValue(manifest),
	};
});

// The mocked platform response deliberately carries secrets: a `password`
// field and a `connectionString` (both credential-bearing keys) plus a safe
// `name` that must survive redaction.
const fakeClient = {
	application: {
		one: {
			query: vi.fn().mockResolvedValue({
				password: "hunter2",
				connectionString: "postgres://u:pw@h/db",
				name: "safe-app",
			}),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { createMcpServer } from "../../src/mcp/server";

beforeEach(() => {
	fakeClient.application.one.query.mockClear();
});

describe("server wiring — sanitizer covers the real factory", () => {
	it("redacts credentials returned by the non-allowlisted `call` tool", async () => {
		// Build the server exactly as stdio.ts does. createMcpServer() runs
		// guardServerHandlers(server) before registering any tool, so the handler
		// stored below is the WRAPPED one (exit guard + sanitizer).
		const server = createMcpServer();
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish (SDK internal).
		const reg = (server as any)._registeredTools.call;
		expect(reg).toBeDefined();

		const result = (await reg.handler({
			procedure: "application.one",
			input: {},
		})) as { isError?: boolean; content: Array<{ text: string }> };

		// Sanity: the underlying procedure really was dispatched.
		expect(fakeClient.application.one.query).toHaveBeenCalled();

		const serialized = JSON.stringify(result);
		// The whole point: the secrets must NOT survive to the caller.
		expect(serialized).not.toContain("hunter2");
		expect(serialized).not.toContain("postgres://u:pw@h/db");
		expect(serialized).toContain("[redacted from MCP response]");
		// Non-sensitive fields are preserved so the response stays useful.
		expect(serialized).toContain("safe-app");
	});
});
