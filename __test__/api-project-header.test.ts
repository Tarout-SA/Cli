import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/config.js", () => ({
	getApiUrl: () => "https://api.example.com",
	getToken: () => "tok_123",
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ projectId: "proj_profile" }),
}));

const sentHeaders = vi.hoisted(() => [] as Record<string, string>[]);

vi.mock("../src/lib/password-gate.js", () => ({
	platformFetch: async (_url: unknown, opts: { headers?: HeadersInit }) => {
		sentHeaders.push({ ...((opts?.headers ?? {}) as Record<string, string>) });
		throw new Error("stop after headers were built");
	},
}));

import {
	buildRequestHeaders,
	createApiClient,
	getRequestProjectId,
	setRequestProjectId,
} from "../src/lib/api.js";

describe("x-tarout-project header", () => {
	beforeEach(() => {
		setRequestProjectId(null);
	});

	it("falls back to the profile project", () => {
		expect(buildRequestHeaders()["x-tarout-project"]).toBe("proj_profile");
	});

	it("prefers an explicitly set project over the profile", () => {
		setRequestProjectId("proj_override");
		expect(buildRequestHeaders()["x-tarout-project"]).toBe("proj_override");
	});

	it("always sends the api key", () => {
		expect(buildRequestHeaders()["x-api-key"]).toBe("tok_123");
	});

	it("reports the resolved project id", () => {
		expect(getRequestProjectId()).toBe("proj_profile");
		setRequestProjectId("proj_override");
		expect(getRequestProjectId()).toBe("proj_override");
	});

	it("actually sends the header on a real client request", async () => {
		// buildRequestHeaders() being correct is worthless if it is not wired into
		// the tRPC link. Without this, reverting `headers:` to the old token-only
		// closure would silently stop sending the project and no test would fail.
		sentHeaders.length = 0;
		setRequestProjectId("proj_wired");

		const client = createApiClient();
		await client.user.get.query().catch(() => undefined);

		expect(sentHeaders[0]?.["x-tarout-project"]).toBe("proj_wired");
		expect(sentHeaders[0]?.["x-api-key"]).toBe("tok_123");
	});
});
