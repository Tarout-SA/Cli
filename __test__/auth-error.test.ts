import { afterEach, describe, expect, it, vi } from "vitest";

// errors.ts reads config.isLoggedIn to tell "stored-but-rejected" (stale) from
// "never logged in". Mock it so both branches are deterministic.
const h = vi.hoisted(() => ({
	isLoggedIn: vi.fn(),
	getAuthScope: vi.fn(),
}));
vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: h.isLoggedIn,
	getAuthScope: h.getAuthScope,
}));

import {
	AGENT_LOGIN_HINT,
	AuthError,
	STALE_CREDENTIAL_HINT,
	staleCredentialGuidance,
} from "../src/lib/errors";
import { ExitCode } from "../src/utils/exit-codes";

describe("AuthError", () => {
	it("is exit 3 and carries agent-facing login guidance for the --json envelope", () => {
		const err = new AuthError();
		expect(err.code).toBe(ExitCode.AUTH_ERROR);
		// The structured `details` is what an agent reads to know it should run
		// `tarout login` ITSELF (browser, hands-free) rather than hand it to the user.
		expect(err.details).toMatchObject({
			nextCommand: "tarout login",
			hint: AGENT_LOGIN_HINT,
		});
		expect(err.message).toMatch(/tarout login/);
	});

	it("guidance tells the agent to run login directly, not delegate", () => {
		expect(AGENT_LOGIN_HINT).toMatch(/run `tarout login` directly/i);
		expect(AGENT_LOGIN_HINT).toMatch(/do not ask the user/i);
		expect(AGENT_LOGIN_HINT).toMatch(/--token/); // headless fallback still named
	});
});

describe("staleCredentialGuidance", () => {
	afterEach(() => {
		h.isLoggedIn.mockReset();
		h.getAuthScope.mockReset();
	});

	it("returns re-auth guidance for a server UNAUTHORIZED while a token is stored", () => {
		h.isLoggedIn.mockReturnValue(true);
		h.getAuthScope.mockReturnValue({
			scope: "project",
			path: "/work/qultm/.tarout/auth.json",
			userEmail: "owner@example.com",
		});
		const guidance = staleCredentialGuidance("UNAUTHORIZED");
		expect(guidance).not.toBeNull();
		expect(guidance?.hint).toContain(STALE_CREDENTIAL_HINT);
		// Mirrors the no-token AuthError so an agent gets the same structured cue.
		expect(guidance?.details).toMatchObject({
			hint: AGENT_LOGIN_HINT,
			nextCommand: "tarout login",
			credential: {
				scope: "project",
				path: "/work/qultm/.tarout/auth.json",
				userEmail: "owner@example.com",
			},
		});
		// The failing command may already be `whoami`, and the CLI cannot infer the
		// credential type from a stored profile. Do not recurse or claim that a
		// browser-issued CLI credential has the lifetime of an Agent key.
		expect(STALE_CREDENTIAL_HINT).not.toMatch(/whoami/i);
		expect(STALE_CREDENTIAL_HINT).not.toMatch(/agent keys do not expire/i);
		expect(guidance?.hint).toContain("project");
		expect(guidance?.hint).toContain("/work/qultm/.tarout/auth.json");
		// Must not assert a cause it cannot know. A rejection has server-side
		// explanations the CLI cannot see, and a confident wrong diagnosis sends
		// an agent chasing a problem that isn't there.
		expect(STALE_CREDENTIAL_HINT).not.toMatch(/revoked or paused/i);
		// The anti-fallback instruction is the point: project-scoped creds in the
		// cwd outrank the global login, so "try another credential" is how a
		// failed auth becomes a deploy into someone else's organization.
		expect(STALE_CREDENTIAL_HINT).toMatch(/do not switch to a different credential/i);
		expect(STALE_CREDENTIAL_HINT).toMatch(/wrong organization/i);
	});

	it("stays silent when nothing is stored (the AuthError path owns that case)", () => {
		h.isLoggedIn.mockReturnValue(false);
		h.getAuthScope.mockReturnValue({ scope: "none" });
		expect(staleCredentialGuidance("UNAUTHORIZED")).toBeNull();
	});

	it("does not fire for non-auth error codes even with a stored token", () => {
		h.isLoggedIn.mockReturnValue(true);
		h.getAuthScope.mockReturnValue({ scope: "global" });
		expect(staleCredentialGuidance("FORBIDDEN")).toBeNull();
		expect(staleCredentialGuidance("NOT_FOUND")).toBeNull();
	});
});
