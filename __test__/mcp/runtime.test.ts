import { describe, expect, it, vi } from "vitest";
import {
	AuthError,
	CliError,
	DeploymentFailedError,
} from "../../src/lib/errors";
import {
	errorResult,
	okResult,
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
