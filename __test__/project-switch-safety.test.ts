import { describe, expect, it, vi } from "vitest";
import { verifyProjectCredentialScope } from "../src/commands/projects";

describe("project-scoped credential switching", () => {
	it("fails closed when the credential remains scoped to another project", async () => {
		const setActive = vi.fn();
		const client = {
			project: {
				credentialScope: {
					query: vi
						.fn()
						.mockResolvedValue({ accountScoped: false, projectId: "project-a" }),
				},
				setActive: { mutate: setActive },
			},
		};

		await expect(
			verifyProjectCredentialScope(client, {
				projectId: "project-b",
				name: "Project B",
				slug: "project-b",
			}),
		).rejects.toThrow("project-scoped credential");
		expect(setActive).not.toHaveBeenCalled();
	});

	it("accepts a target only when the server reports the same effective project", async () => {
		const client = {
			project: {
				credentialScope: {
					query: vi
						.fn()
						.mockResolvedValue({ accountScoped: false, projectId: "project-b" }),
				},
			},
		};

		await expect(
			verifyProjectCredentialScope(client, {
				projectId: "project-b",
				name: "Project B",
				slug: "project-b",
			}),
		).resolves.toMatchObject({ projectId: "project-b" });
	});
});
