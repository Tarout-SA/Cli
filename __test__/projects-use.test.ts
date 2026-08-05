import { describe, expect, it } from "vitest";
import { verifyProjectCredentialScope } from "../src/commands/projects.js";

const target = { projectId: "p_new", name: "New", slug: "new" };

function clientReturning(scope: {
	accountScoped: boolean;
	projectId: string | null;
}) {
	return { project: { credentialScope: { query: async () => scope } } };
}

describe("verifyProjectCredentialScope", () => {
	it("allows switching when the credential is account-scoped", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: true, projectId: "p_old" }),
				target,
			),
		).resolves.toEqual(target);
	});

	it("allows switching when an account key has nothing selected yet", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: true, projectId: null }),
				target,
			),
		).resolves.toEqual(target);
	});

	it("still blocks a pinned legacy credential", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: false, projectId: "p_old" }),
				target,
			),
		).rejects.toThrow(/tarout login/);
	});

	it("passes through when the pinned project already matches", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: false, projectId: "p_new" }),
				target,
			),
		).resolves.toEqual(target);
	});
});
