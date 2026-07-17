import { describe, expect, it, vi } from "vitest";
import {
	AuthError,
	CliError,
	DeploymentFailedError,
} from "../../src/lib/errors";
import {
	errorResult,
	guardServerHandlers,
	installExitGuard,
	okResult,
	ProcessExitAttemptedError,
	toEnvelope,
	withAuth,
} from "../../src/mcp/runtime";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: vi.fn(),
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));
vi.mock("../../src/lib/api", () => ({
	getApiClient: vi.fn(),
	resetApiClient: vi.fn(),
}));

import * as apiModule from "../../src/lib/api";
// The plan's brief used a TypeScript cast on the identifier — not valid ES import
// syntax. We keep the intent (grab the mocked references) via namespace imports
// plus vi.mocked() so the assertions below stay identical.
import * as configModule from "../../src/lib/config";

const isLoggedIn = vi.mocked(configModule.isLoggedIn);
const getApiClient = vi.mocked(apiModule.getApiClient);

describe("okResult", () => {
	it("serializes JSON and mirrors data on structuredContent", () => {
		const r = okResult({ x: 1 });
		expect(r.isError).toBeUndefined();
		expect(r.content[0].text).toBe(JSON.stringify({ x: 1 }, null, 2));
		expect(r.structuredContent).toEqual({ x: 1 });
	});

	it("stringifies raw strings verbatim", () => {
		const r = okResult("hi");
		expect(r.content[0].text).toBe('"hi"');
		expect(r.structuredContent).toEqual({ value: "hi" });
	});

	it("wraps primitives in { value } for structuredContent", () => {
		const r = okResult(42);
		expect(r.content[0].text).toBe("42");
		expect(r.structuredContent).toEqual({ value: 42 });
	});

	it("omits structuredContent for null/undefined", () => {
		expect(okResult(null).structuredContent).toBeUndefined();
		expect(okResult(undefined).structuredContent).toBeUndefined();
	});
});

describe("toEnvelope", () => {
	it("maps AuthError to AUTH_ERROR with login remediation", () => {
		const e = toEnvelope(new AuthError());
		expect(e.code).toBe("AUTH_ERROR");
		expect(e.remediation).toMatch(/tarout login/);
	});

	it("maps CliError to its own code", () => {
		// CliError.code is typed as number (an ExitCode), but toEnvelope forwards
		// whatever value lives on err.code and stringifies it. We deliberately pass a
		// string to exercise the mapping the plan specifies.
		// @ts-expect-error — intentionally passing a string code.
		const e = toEnvelope(new CliError("nope", "NOT_FOUND"));
		expect(e.code).toBe("NOT_FOUND");
		expect(e.error).toBe("nope");
	});

	it("maps DeploymentFailedError and preserves deploymentId", () => {
		const e = toEnvelope(new DeploymentFailedError("bad", "d1"));
		expect(e.code).toBe("DEPLOYMENT_FAILED");
		expect((e.details as { deploymentId?: string }).deploymentId).toBe("d1");
	});

	it("maps tRPC-shaped errors via data.code", () => {
		const err = Object.assign(new Error("no slot"), {
			data: { code: "FORBIDDEN" },
		});
		const e = toEnvelope(err);
		expect(e.code).toBe("FORBIDDEN");
		expect(e.error).toBe("no slot");
	});

	it("falls back to GENERAL_ERROR", () => {
		const e = toEnvelope(new Error("boom"));
		expect(e.code).toBe("GENERAL_ERROR");
		expect(e.error).toBe("boom");
	});

	it("maps a suppressed exit(NEEDS_INPUT) to a NEEDS_INPUT envelope", () => {
		const e = toEnvelope(new ProcessExitAttemptedError(6));
		expect(e.code).toBe("NEEDS_INPUT");
		expect((e.details as { attemptedExitCode?: number }).attemptedExitCode).toBe(
			6,
		);
	});

	it("maps a suppressed exit with another code to GENERAL_ERROR", () => {
		const e = toEnvelope(new ProcessExitAttemptedError(1));
		expect(e.code).toBe("GENERAL_ERROR");
		expect((e.details as { attemptedExitCode?: number }).attemptedExitCode).toBe(
			1,
		);
	});
});

describe("exit guard", () => {
	it("converts a process.exit() inside a wrapped handler into an envelope", async () => {
		installExitGuard();
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake McpServer for the wrap test.
		const registered: Record<string, (...a: any[]) => Promise<any>> = {};
		const fakeServer = {
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake McpServer for the wrap test.
			registerTool: (name: string, _cfg: any, handler: any) => {
				registered[name] = handler;
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: fake server stands in for McpServer.
		guardServerHandlers(fakeServer as any);
		fakeServer.registerTool("t", {}, async () => {
			process.exit(6);
		});

		const res = (await registered.t()) as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(res.isError).toBe(true);
		const body = JSON.parse(res.content[0].text) as { code: string };
		expect(body.code).toBe("NEEDS_INPUT");
	});

	it("survives an exit attempt: a later tool call on the same server still succeeds", async () => {
		installExitGuard();
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake McpServer for the wrap test.
		const registered: Record<string, (...a: any[]) => Promise<any>> = {};
		const fakeServer = {
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake McpServer for the wrap test.
			registerTool: (name: string, _cfg: any, handler: any) => {
				registered[name] = handler;
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: fake server stands in for McpServer.
		guardServerHandlers(fakeServer as any);
		fakeServer.registerTool("exiter", {}, async () => {
			process.exit(6);
		});
		fakeServer.registerTool("healthy", {}, async () => okResult({ ok: true }));

		// First call trips the exit guard and is converted into a NEEDS_INPUT
		// envelope instead of terminating the process.
		const first = (await registered.exiter()) as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(first.isError).toBe(true);
		expect((JSON.parse(first.content[0].text) as { code: string }).code).toBe(
			"NEEDS_INPUT",
		);

		// The server must survive: a subsequent tool call succeeds normally,
		// proving the guard restored the handler depth and did not leave the
		// server in a poisoned state.
		const second = (await registered.healthy()) as {
			isError?: boolean;
			content: Array<{ text: string }>;
		};
		expect(second.isError).toBeUndefined();
		expect(JSON.parse(second.content[0].text)).toEqual({ ok: true });
	});
});

describe("withAuth", () => {
	it("returns AUTH_ERROR envelope when not logged in", async () => {
		isLoggedIn.mockReturnValue(false);
		const r = await withAuth(async () => "unused");
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("AUTH_ERROR");
	});

	it("passes the tRPC client to the handler and wraps success", async () => {
		isLoggedIn.mockReturnValue(true);
		const fakeClient = { user: { get: { query: async () => ({ id: "u1" }) } } };
		getApiClient.mockReturnValue(fakeClient);
		const r = await withAuth(async (c) => await c.user.get.query());
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { id: string };
		expect(body.id).toBe("u1");
	});

	it("catches handler throws and maps them via toEnvelope", async () => {
		isLoggedIn.mockReturnValue(true);
		getApiClient.mockReturnValue({});
		const r = await withAuth(async () => {
			throw new AuthError();
		});
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content[0].text).code).toBe("AUTH_ERROR");
	});

	it("enriches a FORBIDDEN entitlement error with an actionable remedy", async () => {
		isLoggedIn.mockReturnValue(true);
		const client = {
			subscription: {
				getCatalog: { query: async () => ({ plans: [], addons: [] }) },
			},
			postgres: {
				create: {
					mutate: async () => {
						throw Object.assign(
							new Error("Plan limit reached for db.starter.slots: 1/1."),
							{ data: { code: "FORBIDDEN" } },
						);
					},
				},
			},
		};
		getApiClient.mockReturnValue(client);
		const r = await withAuth(async (c) => await c.postgres.create.mutate());
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			remediation?: string;
			details?: { entitlementKey?: string; remedy?: { command?: string } };
		};
		expect(body.code).toBe("FORBIDDEN");
		expect(body.remediation).toMatch(/billing_upgrade/);
		expect(body.details?.entitlementKey).toBe("db.starter.slots");
		expect(body.details?.remedy?.command).toContain("addon:buy");
	});
});

describe("errorResult", () => {
	it("stamps isError:true and JSON envelope", () => {
		const r = errorResult({ error: "x", code: "GENERAL_ERROR" });
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content[0].text)).toEqual({
			error: "x",
			code: "GENERAL_ERROR",
		});
	});
});
