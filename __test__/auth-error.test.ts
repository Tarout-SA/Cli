import { afterEach, describe, expect, it, vi } from "vitest";

// errors.ts reads config.isLoggedIn to tell "stored-but-rejected" (stale) from
// "never logged in". Mock it so both branches are deterministic.
const h = vi.hoisted(() => ({ isLoggedIn: vi.fn() }));
vi.mock("../src/lib/config.js", () => ({ isLoggedIn: h.isLoggedIn }));

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
	});

	it("returns re-auth guidance for a server UNAUTHORIZED while a token is stored", () => {
		h.isLoggedIn.mockReturnValue(true);
		const guidance = staleCredentialGuidance("UNAUTHORIZED");
		expect(guidance).not.toBeNull();
		expect(guidance?.hint).toBe(STALE_CREDENTIAL_HINT);
		// Mirrors the no-token AuthError so an agent gets the same structured cue.
		expect(guidance?.details).toEqual({
			hint: AGENT_LOGIN_HINT,
			nextCommand: "tarout login",
		});
		expect(STALE_CREDENTIAL_HINT).toMatch(/tarout login/);
	});

	it("stays silent when nothing is stored (the AuthError path owns that case)", () => {
		h.isLoggedIn.mockReturnValue(false);
		expect(staleCredentialGuidance("UNAUTHORIZED")).toBeNull();
	});

	it("does not fire for non-auth error codes even with a stored token", () => {
		h.isLoggedIn.mockReturnValue(true);
		expect(staleCredentialGuidance("FORBIDDEN")).toBeNull();
		expect(staleCredentialGuidance("NOT_FOUND")).toBeNull();
	});
});
