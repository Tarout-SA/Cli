import { TRPCClientError } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
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

	it("preserves the server's data.reason in details", () => {
		const err = Object.assign(new Error("refused"), {
			data: { code: "FORBIDDEN", reason: "member_read_only" },
		});
		const e = toEnvelope(err, "application.create");
		expect(e.details).toEqual({
			procedure: "application.create",
			reason: "member_read_only",
		});
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

describe("withAuth FORBIDDEN classification", () => {
	type Body = {
		code: string;
		error: string;
		remediation?: string;
		details?: {
			reason?: string;
			approvalId?: string;
			procedure?: string;
			remedy?: { command?: string };
			entitlementKey?: string;
		};
	};

	// A fake client whose one mutation throws `err`, with the catalog query
	// spied so a test can prove the billing enrichment never ran.
	function clientThrowing(err: unknown) {
		const getCatalog = vi.fn(async () => ({ plans: [], addons: [] }));
		const client = {
			subscription: { getCatalog: { query: getCatalog } },
			application: {
				delete: {
					mutate: async () => {
						throw err;
					},
				},
			},
		};
		return { client, getCatalog };
	}

	async function run(err: unknown): Promise<{
		body: Body;
		getCatalog: ReturnType<typeof vi.fn>;
	}> {
		isLoggedIn.mockReturnValue(true);
		const { client, getCatalog } = clientThrowing(err);
		getApiClient.mockReturnValue(client);
		const r = await withAuth(
			async (c) => await c.application.delete.mutate(),
			"application.delete",
		);
		expect(r.isError).toBe(true);
		return { body: JSON.parse(r.content[0].text) as Body, getCatalog };
	}

	// What the server's errorFormatter sends over HTTP, parsed by the real
	// tRPC client: `data.reason` sits next to `data.code`.
	function trpcClientError(
		message: string,
		reason: string | null,
	): TRPCClientError<AnyRouter> {
		return new TRPCClientError<AnyRouter>(message, {
			result: {
				error: {
					message,
					code: -32003,
					data: { code: "FORBIDDEN", httpStatus: 403, reason },
				},
			},
		});
	}

	const APPROVAL_MESSAGE =
		'NEEDS_APPROVAL:pa_123abc: The destructive action "application.delete" requires human approval for this API key. An approval request (id: pa_123abc) is now waiting in the Tarout dashboard under Agent > Approvals.';

	function expectNoBilling(body: Body) {
		expect(body.remediation ?? "").not.toMatch(/billing_upgrade|upgrade|addon/i);
		expect(body.details?.remedy).toBeUndefined();
		expect(body.details?.entitlementKey).toBeUndefined();
	}

	it("maps needs_approval from data.reason to NEEDS_APPROVAL with the approval id", async () => {
		const { body, getCatalog } = await run(
			trpcClientError(APPROVAL_MESSAGE, "needs_approval"),
		);
		expect(body.code).toBe("NEEDS_APPROVAL");
		expect(body.details?.reason).toBe("needs_approval");
		expect(body.details?.approvalId).toBe("pa_123abc");
		expect(body.details?.procedure).toBe("application.delete");
		expect(body.remediation).toMatch(/approvals\.get/);
		expect(body.remediation).toContain('"pa_123abc"');
		expect(body.remediation).toMatch(/Agent > Approvals/);
		expect(body.remediation).toMatch(/do NOT retry/i);
		expect(body.remediation).toMatch(/do not try to approve it yourself/i);
		expectNoBilling(body);
		expect(getCatalog).not.toHaveBeenCalled();
	});

	it("maps needs_approval from the message prefix alone (no data.reason)", async () => {
		const { body, getCatalog } = await run(
			Object.assign(new Error(APPROVAL_MESSAGE), {
				data: { code: "FORBIDDEN" },
			}),
		);
		expect(body.code).toBe("NEEDS_APPROVAL");
		expect(body.details?.reason).toBe("needs_approval");
		expect(body.details?.approvalId).toBe("pa_123abc");
		expectNoBilling(body);
		expect(getCatalog).not.toHaveBeenCalled();
	});

	it("reads data.reason from shape.data when data carries only the code", async () => {
		const { body } = await run(
			Object.assign(new Error("Refused."), {
				data: { code: "FORBIDDEN" },
				shape: { data: { code: "FORBIDDEN", reason: "needs_approval" } },
			}),
		);
		expect(body.code).toBe("NEEDS_APPROVAL");
		// No prefix to parse: the remediation still names the poll, with a placeholder.
		expect(body.details?.approvalId).toBeUndefined();
		expect(body.remediation).toMatch(/approvals\.get/);
		expectNoBilling(body);
	});

	it.each([
		[
			"insufficient_tier",
			'AGENT_READ_ONLY: This API key is read-only, so the mutation "application.delete" was refused.',
			/access tier/i,
		],
		[
			"area_not_allowed",
			'AGENT_SCOPE: This API key is not allowed to use the "apps" area, so "application.delete" was refused.',
			/limited to certain areas or projects/i,
		],
		[
			"member_read_only",
			'Your account has view-only access to this organization, so "application.delete" was refused.',
			/read-only \(view-only\) member.*owner or admin/i,
		],
		[
			"needs_interactive_session",
			"This account action requires an interactive signed-in session - an API key cannot change its own access.",
			/signed-in human session in the Tarout dashboard/i,
		],
	])("gives %s its own remediation, not billing", async (reason, message, expected) => {
		const { body, getCatalog } = await run(trpcClientError(message, reason));
		expect(body.code).toBe("FORBIDDEN");
		expect(body.details?.reason).toBe(reason);
		expect(body.remediation).toMatch(expected);
		expectNoBilling(body);
		expect(getCatalog).not.toHaveBeenCalled();
	});

	it.each([
		["AGENT_READ_ONLY", "insufficient_tier", /access tier/i],
		["AGENT_SCOPE", "area_not_allowed", /limited to certain areas/i],
	])("infers the reason from a bare %s: prefix", async (prefix, reason, expected) => {
		const { body, getCatalog } = await run(
			Object.assign(new Error(`${prefix}: This API key was refused.`), {
				data: { code: "FORBIDDEN" },
			}),
		);
		expect(body.code).toBe("FORBIDDEN");
		expect(body.details?.reason).toBe(reason);
		expect(body.remediation).toMatch(expected);
		expectNoBilling(body);
		expect(getCatalog).not.toHaveBeenCalled();
	});

	it("treats an AGENT_GUARDRAIL: refusal as a guardrail, not a plan limit", async () => {
		const { body, getCatalog } = await run(
			Object.assign(
				new Error(
					"AGENT_GUARDRAIL: This API key already has 20 approvals waiting - ask the user to resolve them before requesting more destructive actions.",
				),
				{ data: { code: "FORBIDDEN", reason: null } },
			),
		);
		expect(body.code).toBe("FORBIDDEN");
		expect(body.remediation).toMatch(/guardrail/i);
		expectNoBilling(body);
		expect(getCatalog).not.toHaveBeenCalled();
	});

	it("gives an unexplained FORBIDDEN a permission remediation, not billing", async () => {
		const { body, getCatalog } = await run(
			trpcClientError(
				"Direct provider credentials are disabled for managed storage. Create a scoped Tarout storage access key instead.",
				null,
			),
		);
		expect(body.code).toBe("FORBIDDEN");
		expect(body.details?.reason).toBeUndefined();
		expect(body.remediation).toMatch(/permission refusal/i);
		expectNoBilling(body);
		expect(getCatalog).not.toHaveBeenCalled();
	});

	it("still routes a Plan limit refusal (reason null) to billing_upgrade", async () => {
		const { body, getCatalog } = await run(
			trpcClientError("Plan limit reached for db.starter.slots: 1/1.", null),
		);
		expect(body.code).toBe("FORBIDDEN");
		expect(body.remediation).toMatch(/billing_upgrade/);
		expect(body.details?.entitlementKey).toBe("db.starter.slots");
		expect(body.details?.remedy?.command).toContain("addon:buy");
		expect(getCatalog).toHaveBeenCalledTimes(1);
	});

	it("maps NEEDS_APPROVAL in toEnvelope itself, for callers outside withAuth", () => {
		// tools/deploy.ts calls toEnvelope directly on its catch path.
		const e = toEnvelope(trpcClientError(APPROVAL_MESSAGE, "needs_approval"));
		expect(e.code).toBe("NEEDS_APPROVAL");
		expect((e.details as { approvalId?: string }).approvalId).toBe("pa_123abc");
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
