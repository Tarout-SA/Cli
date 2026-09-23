import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Production 2026-09-23: with only TAROUT_TOKEN set (the documented CI path),
// `storage create`, `apps create`, `db create` and `link` failed with "Not
// logged in" because they demanded a stored profile.
const state = vi.hoisted(() => ({
	stored: null as null | Record<string, string>,
	token: null as null | string,
	calls: 0,
}));

vi.mock("../src/lib/config.js", () => ({
	getApiUrl: () => "https://tarout.sa",
	getCurrentProfile: () => state.stored,
	getToken: () => state.token,
}));

vi.mock("@trpc/client", () => ({
	httpBatchLink: () => ({}),
	createTRPCProxyClient: () => ({
		user: {
			get: {
				query: async () => {
					state.calls++;
					return {
						organizationId: "org_env",
						userId: "user_env",
						user: { id: "user_env", email: "ci@example.com", name: "CI" },
					};
				},
			},
		},
		organization: { all: { query: async () => [{ id: "org_env", name: "Env Org" }] } },
		project: { getActive: { query: async () => ({ projectId: "prj_env", name: "Default", slug: "default" }) } },
	}),
}));

import { requireProfile, resetEnvProfileForTests } from "../src/lib/auth-profile.js";
import { AuthError } from "../src/lib/errors.js";

describe("requireProfile", () => {
	beforeEach(() => {
		state.stored = null;
		state.token = null;
		state.calls = 0;
		resetEnvProfileForTests();
	});
	afterEach(() => vi.clearAllMocks());

	it("returns the stored profile without calling the API", async () => {
		state.stored = { token: "stored", organizationId: "org_stored" };
		await expect(requireProfile()).resolves.toMatchObject({ organizationId: "org_stored" });
		expect(state.calls).toBe(0);
	});

	it("resolves a profile from a bare TAROUT_TOKEN, once per process", async () => {
		state.token = "tarout_ci_key";
		const first = await requireProfile();
		const second = await requireProfile();
		expect(first).toMatchObject({
			token: "tarout_ci_key",
			organizationId: "org_env",
			organizationName: "Env Org",
			projectId: "prj_env",
			userEmail: "ci@example.com",
		});
		expect(second).toBe(first);
		expect(state.calls).toBe(1);
	});

	it("still reports AuthError with no credential at all", async () => {
		await expect(requireProfile()).rejects.toBeInstanceOf(AuthError);
	});
});
