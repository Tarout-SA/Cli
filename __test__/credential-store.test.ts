import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Where a credential is written, and — more importantly — where a credential is
 * NOT written.
 *
 * The regression this file exists for: `tarout up` / `deploy` / `init`
 * re-resolve the active token on every run and persist the result. That used to
 * be an unconditional `setProfile("default", …)`, so running a deploy inside a
 * project-scoped directory copied that project's key into the machine-wide
 * store and made it current — silently signing every unrelated directory in as
 * this project's account. It reads as "my login changed by itself".
 */

const m = vi.hoisted(() => ({
	setProfile: vi.fn(),
	setCurrentProfile: vi.fn(),
	updateProfile: vi.fn(),
	getProjectCredential: vi.fn(() => null as unknown),
	setProjectCredential: vi.fn(() => "/tmp/project/.tarout/auth.json"),
}));

vi.mock("../src/lib/config.js", () => ({
	setProfile: m.setProfile,
	setCurrentProfile: m.setCurrentProfile,
	updateProfile: m.updateProfile,
}));

vi.mock("../src/lib/project-auth.js", () => ({
	getProjectCredential: m.getProjectCredential,
	setProjectCredential: m.setProjectCredential,
}));

const { persistProfile, refreshActiveProfile } = await import(
	"../src/lib/credential-store.js"
);

const PROFILE = {
	token: "tk_project_secret",
	apiUrl: "https://tarout.sa",
	userId: "user-1",
	userEmail: "agent@example.com",
	organizationId: "org-1",
	organizationName: "Acme",
	projectId: "project-1",
	projectName: "Coco",
	projectSlug: "coco",
};

beforeEach(() => {
	vi.clearAllMocks();
	m.getProjectCredential.mockReturnValue(null);
	m.setProjectCredential.mockReturnValue("/tmp/project/.tarout/auth.json");
});

describe("persistProfile", () => {
	it("writes to the project file and never to the machine-wide store", () => {
		const path = persistProfile(
			PROFILE,
			{ scope: "project", projectDir: "/tmp/project" },
			"login",
		);

		expect(path).toBe("/tmp/project/.tarout/auth.json");
		expect(m.setProjectCredential).toHaveBeenCalledWith(
			expect.objectContaining({ token: "tk_project_secret", source: "login" }),
			"/tmp/project",
		);
		expect(m.setProfile).not.toHaveBeenCalled();
		expect(m.setCurrentProfile).not.toHaveBeenCalled();
	});

	it("writes machine-wide when that is the resolved scope", () => {
		const path = persistProfile(PROFILE, { scope: "global" }, "login");

		expect(path).toBeUndefined();
		expect(m.setProfile).toHaveBeenCalledWith("default", PROFILE);
		expect(m.setCurrentProfile).toHaveBeenCalledWith("default");
		expect(m.setProjectCredential).not.toHaveBeenCalled();
	});

	it("falls back to machine-wide if a project scope arrives with no directory", () => {
		persistProfile(PROFILE, { scope: "project" }, "login");

		expect(m.setProjectCredential).not.toHaveBeenCalled();
		expect(m.setProfile).toHaveBeenCalledWith("default", PROFILE);
	});
});

describe("refreshActiveProfile", () => {
	it("does not touch the machine-wide store when a project credential is active", () => {
		m.getProjectCredential.mockReturnValue({
			credential: PROFILE,
			path: "/tmp/project/.tarout/auth.json",
			projectDir: "/tmp/project",
		});

		expect(refreshActiveProfile(PROFILE)).toBe("project");
		// updateProfile is the layer-aware writer; setProfile is the global one.
		expect(m.updateProfile).toHaveBeenCalledWith(PROFILE);
		expect(m.setProfile).not.toHaveBeenCalled();
		expect(m.setCurrentProfile).not.toHaveBeenCalled();
	});

	it("refreshes the machine-wide profile when that is what is in effect", () => {
		expect(refreshActiveProfile(PROFILE)).toBe("global");
		expect(m.updateProfile).toHaveBeenCalledWith(PROFILE);
	});
});
