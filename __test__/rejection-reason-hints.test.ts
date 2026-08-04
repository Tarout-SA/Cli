import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
}));

const { STALE_CREDENTIAL_HINT, staleCredentialGuidance } = await import(
	"../src/lib/errors"
);

/**
 * The CLI must never GUESS why a credential was refused.
 *
 * An earlier version asserted that a rejected key had been "revoked or paused,
 * or belongs to a different Tarout host". In the incident that prompted its
 * removal, all of that was wrong — the key was live, and the organization
 * simply had no project. The agent, told definitively that its key was bad,
 * went looking for one that worked and found `.tarout/auth.json` from an
 * unrelated project, which outranks the global login. A rejected key became a
 * deploy into someone else's organization.
 *
 * So: specific guidance ONLY when the server names the reason; the neutral
 * hint otherwise.
 */

describe("staleCredentialGuidance", () => {
	it("stays neutral when the server names no reason", () => {
		const guidance = staleCredentialGuidance("UNAUTHORIZED");
		expect(guidance?.hint).toBe(STALE_CREDENTIAL_HINT);
	});

	it("never claims a cause it wasn't told", () => {
		const hint = staleCredentialGuidance("UNAUTHORIZED")?.hint ?? "";
		expect(hint).not.toMatch(/revoked/i);
		expect(hint).not.toMatch(/paused/i);
		expect(hint).not.toMatch(/different Tarout host/i);
	});

	it("still refuses to blame expiry, which agent keys do not have", () => {
		const hint = staleCredentialGuidance("UNAUTHORIZED")?.hint ?? "";
		expect(hint).toMatch(/do not expire/i);
	});

	it("names the cause when the server does", () => {
		const guidance = staleCredentialGuidance("UNAUTHORIZED", "key_revoked");
		expect(guidance?.hint).toMatch(/revoked/i);
		expect(guidance?.details.reason).toBe("key_revoked");
	});

	it("tells the agent to stop rather than retry a parked approval", () => {
		// needs_approval is not a failure — retrying just re-parks it.
		const guidance = staleCredentialGuidance("FORBIDDEN", "needs_approval");
		expect(guidance?.hint).toMatch(/waiting for human approval/i);
		expect(guidance?.hint).toMatch(/has not failed/i);
	});

	it("keeps the do-not-switch-credentials warning on a revoked key", () => {
		// This is the sentence that prevents the wrong-organization deploy.
		const guidance = staleCredentialGuidance("UNAUTHORIZED", "key_revoked");
		expect(guidance?.hint).toMatch(/do NOT fall back/i);
	});

	it("says the key is fine when the real problem is a missing project", () => {
		// The exact case that produced a wrong "revoked" hint.
		const guidance = staleCredentialGuidance("UNAUTHORIZED", "no_project");
		expect(guidance?.hint).toMatch(/no project/i);
		expect(guidance?.hint).toMatch(/do not replace it/i);
	});

	it("does not invent guidance for a reason it does not recognise", () => {
		// A newer server sending an unknown reason must degrade to neutral, not
		// to a confident wrong answer.
		const guidance = staleCredentialGuidance(
			"UNAUTHORIZED",
			"some_future_reason",
		);
		expect(guidance?.hint).toBe(STALE_CREDENTIAL_HINT);
	});

	it("returns nothing for an unrelated error with no reason", () => {
		expect(staleCredentialGuidance("NOT_FOUND")).toBeNull();
	});
});
