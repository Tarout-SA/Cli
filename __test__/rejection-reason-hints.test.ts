import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getAuthScope: () => ({
		scope: "global",
		userEmail: "owner@example.com",
	}),
}));

const {
	STALE_CREDENTIAL_HINT,
	rejectionReasonFromMessage,
	staleCredentialGuidance,
} = await import("../src/lib/errors");

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
		expect(guidance?.hint).toContain(STALE_CREDENTIAL_HINT);
		expect(guidance?.details.credential).toEqual({
			scope: "global",
			userEmail: "owner@example.com",
		});
	});

	it("never claims a cause it wasn't told", () => {
		const hint = staleCredentialGuidance("UNAUTHORIZED")?.hint ?? "";
		expect(hint).not.toMatch(/revoked/i);
		expect(hint).not.toMatch(/paused/i);
		expect(hint).not.toMatch(/different Tarout host/i);
	});

	it("does not assume the rejected credential is a non-expiring agent key", () => {
		const hint = staleCredentialGuidance("UNAUTHORIZED")?.hint ?? "";
		expect(hint).not.toMatch(/do not expire/i);
		expect(hint).toMatch(/credential type/i);
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

	it("points a parked approval at the wait, not at `tarout login`", () => {
		// Logging in again approves nothing; the next step is `approvals wait`.
		const guidance = staleCredentialGuidance(
			"FORBIDDEN",
			"needs_approval",
			'NEEDS_APPROVAL:pa_123abc: The destructive action "application.delete" requires human approval for this API key.',
		);
		expect(guidance?.details.nextCommand).toBe("tarout approvals wait pa_123abc");
		expect(guidance?.hint).toMatch(/tarout approvals wait/);
		expect(guidance?.details.approvalId).toBe("pa_123abc");
		expect(guidance?.details.reason).toBe("needs_approval");
		expect(guidance?.details.hint).not.toMatch(/tarout login/);
		expect(guidance?.details.hint).toMatch(/Agent > Approvals/);
		expect(guidance?.hint).not.toMatch(/tarout login/);
	});

	it("still names the wait when the approval id cannot be parsed", () => {
		const guidance = staleCredentialGuidance("FORBIDDEN", "needs_approval");
		expect(guidance?.details.nextCommand).toBe(
			"tarout approvals wait <approvalId>",
		);
		expect(guidance?.details.approvalId).toBeUndefined();
	});

	it("never pastes an id that could carry shell syntax into nextCommand", () => {
		// Agents run nextCommand verbatim.
		const guidance = staleCredentialGuidance(
			"FORBIDDEN",
			"needs_approval",
			"NEEDS_APPROVAL:pa_1;rm$(x): refused.",
		);
		expect(guidance?.details.nextCommand).toBe(
			"tarout approvals wait <approvalId>",
		);
	});

	it("tells a read-only member that an owner or admin must act", () => {
		const guidance = staleCredentialGuidance("FORBIDDEN", "member_read_only");
		expect(guidance?.hint).toMatch(/read-only/i);
		expect(guidance?.hint).toMatch(/owner or admin/i);
		expect(guidance?.details.reason).toBe("member_read_only");
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
		expect(guidance?.hint).toContain(STALE_CREDENTIAL_HINT);
	});

	it("returns nothing for an unrelated error with no reason", () => {
		expect(staleCredentialGuidance("NOT_FOUND")).toBeNull();
	});

	it.each([
		"insufficient_tier",
		"area_not_allowed",
		"member_read_only",
		"needs_interactive_session",
		"no_project",
		"key_frozen",
		"not_org_member",
		"account_suspended",
	])("does not send %s to `tarout login`", (reason) => {
		// Signing in again fixes none of these; it only sends the agent hunting
		// for another credential.
		const guidance = staleCredentialGuidance("FORBIDDEN", reason);
		expect(guidance?.details.nextCommand).toBeUndefined();
		expect(guidance?.details.hint).toMatch(/will not help/i);
		expect(guidance?.details.reason).toBe(reason);
	});

	it.each(["key_revoked", "key_expired"])(
		"still points %s at `tarout login`",
		(reason) => {
			const guidance = staleCredentialGuidance("UNAUTHORIZED", reason);
			expect(guidance?.details.nextCommand).toBe("tarout login");
		},
	);
});

describe("rejectionReasonFromMessage", () => {
	it("reads the reason from the guardrail message prefix", () => {
		expect(
			rejectionReasonFromMessage("NEEDS_APPROVAL:pa_1: parked for approval"),
		).toBe("needs_approval");
		expect(rejectionReasonFromMessage("AGENT_READ_ONLY: read only key")).toBe(
			"insufficient_tier",
		);
		expect(rejectionReasonFromMessage("AGENT_SCOPE: outside areas")).toBe(
			"area_not_allowed",
		);
	});

	it("names nothing for other messages", () => {
		expect(rejectionReasonFromMessage("Plan limit reached for apps")).toBe(
			undefined,
		);
		expect(rejectionReasonFromMessage(undefined)).toBe(undefined);
	});
});
