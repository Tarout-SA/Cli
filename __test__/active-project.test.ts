import { beforeEach, describe, expect, it, vi } from "vitest";

const updateProfile = vi.fn();
const setRequestProjectId = vi.fn();
const select = vi.fn();
let profile: { projectId?: string } | null = null;
let projects: Array<{ projectId: string; name: string; slug: string }> = [];

vi.mock("../src/lib/config.js", () => ({
	getCurrentProfile: () => profile,
	updateProfile: (u: unknown) => updateProfile(u),
}));
vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		project: { all: { query: async () => projects } },
	}),
	setRequestProjectId: (id: string | null) => setRequestProjectId(id),
}));
vi.mock("../src/utils/prompts.js", () => ({
	select: (...args: unknown[]) => select(...args),
}));

import {
	findProject,
	resolveActiveProject,
} from "../src/lib/active-project.js";

describe("findProject", () => {
	const all = [{ projectId: "p1", name: "Alpha", slug: "alpha" }];

	it("matches by id, slug, and case-insensitive name", () => {
		expect(findProject(all, "p1")?.projectId).toBe("p1");
		expect(findProject(all, "alpha")?.projectId).toBe("p1");
		expect(findProject(all, "ALPHA")?.projectId).toBe("p1");
		expect(findProject(all, "nope")).toBeUndefined();
	});
});

describe("resolveActiveProject", () => {
	beforeEach(() => {
		updateProfile.mockClear();
		setRequestProjectId.mockClear();
		select.mockReset();
		profile = null;
		projects = [];
	});

	it("prefers the --project flag over the saved profile", async () => {
		profile = { projectId: "p_saved" };
		projects = [
			{ projectId: "p_saved", name: "Saved", slug: "saved" },
			{ projectId: "p_flag", name: "Flag", slug: "flag" },
		];

		await expect(resolveActiveProject({ projectFlag: "flag" })).resolves.toBe(
			"p_flag",
		);
		expect(setRequestProjectId).toHaveBeenCalledWith("p_flag");
		expect(select).not.toHaveBeenCalled();
	});

	it("uses the saved profile project without prompting", async () => {
		profile = { projectId: "p_saved" };
		await expect(resolveActiveProject()).resolves.toBe("p_saved");
		expect(select).not.toHaveBeenCalled();
	});

	it("auto-selects when the org has exactly one project", async () => {
		projects = [{ projectId: "p_only", name: "Only", slug: "only" }];
		await expect(resolveActiveProject()).resolves.toBe("p_only");
		expect(select).not.toHaveBeenCalled();
		expect(updateProfile).toHaveBeenCalledWith({
			projectId: "p_only",
			projectName: "Only",
			projectSlug: "only",
		});
	});

	it("prompts when several projects exist and saves the choice", async () => {
		projects = [
			{ projectId: "p1", name: "Alpha", slug: "alpha" },
			{ projectId: "p2", name: "Beta", slug: "beta" },
		];
		select.mockResolvedValue("p2");

		await expect(resolveActiveProject()).resolves.toBe("p2");
		expect(updateProfile).toHaveBeenCalledWith({
			projectId: "p2",
			projectName: "Beta",
			projectSlug: "beta",
		});
		expect(setRequestProjectId).toHaveBeenCalledWith("p2");
	});

	it("passes a prompt descriptor so --json and CI get needs_input, not a hang", async () => {
		projects = [
			{ projectId: "p1", name: "Alpha", slug: "alpha" },
			{ projectId: "p2", name: "Beta", slug: "beta" },
		];
		select.mockResolvedValue("p1");

		await resolveActiveProject();

		expect(select).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Array),
			expect.objectContaining({ field: "project", flag: "--project" }),
		);
	});

	it("returns null when the org has no projects at all", async () => {
		await expect(resolveActiveProject()).resolves.toBeNull();
		expect(select).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("throws a helpful error when the flag names an unknown project", async () => {
		projects = [{ projectId: "p1", name: "Alpha", slug: "alpha" }];
		await expect(resolveActiveProject({ projectFlag: "ghost" })).rejects.toThrow(
			/ghost/,
		);
	});
});
