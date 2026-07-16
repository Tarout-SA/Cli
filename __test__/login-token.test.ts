import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout login --token <key>` and `tarout token <key>` share one headless path:
 * resolve the API key to a full profile, persist it as the `default` profile,
 * and (under --json) emit a success payload. No browser, no callback server.
 * This is the credential-login seam the dashboard's "Connect your CLI" flow
 * relies on, so it must persist on success and refuse cleanly on a bad token.
 */

// vi.mock is hoisted above imports, so the factories can only reference values
// created in vi.hoisted (which runs first) — not plain top-level consts (TDZ).
const m = vi.hoisted(() => ({
	setProfile: vi.fn(),
	setCurrentProfile: vi.fn(),
	isLoggedIn: vi.fn(() => false),
	getCurrentProfile: vi.fn(() => null),
	getToken: vi.fn(() => "tk_123"),
	getApiUrl: vi.fn(() => "https://tarout.sa"),
	resolveProfileFromCredential: vi.fn(),
}));
const {
	setProfile,
	setCurrentProfile,
	isLoggedIn,
	getCurrentProfile,
	resolveProfileFromCredential,
} = m;

vi.mock("../src/lib/config.js", () => ({
	setProfile: m.setProfile,
	setCurrentProfile: m.setCurrentProfile,
	isLoggedIn: m.isLoggedIn,
	getCurrentProfile: m.getCurrentProfile,
	getToken: m.getToken,
	getApiUrl: m.getApiUrl,
	clearConfig: vi.fn(),
}));

vi.mock("../src/lib/auth-profile.js", () => ({
	resolveProfileFromCredential: m.resolveProfileFromCredential,
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
}));

import {
	authenticateWithToken,
	buildProjectKeyMetadata,
	resolveVerifiedCurrentProfile,
} from "../src/commands/auth";
import { setGlobalOptions } from "../src/lib/output";

const RESOLVED = {
	token: "tk_123",
	apiUrl: "https://tarout.sa",
	userId: "user-1",
	userEmail: "owner@example.com",
	userName: "Owner",
	organizationId: "org-1",
	organizationName: "Acme",
	projectId: "project-1",
	projectName: "Project One",
	projectSlug: "project-one",
	environmentId: "env-1",
	environmentName: "production",
};

let logs: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logs = [];
	spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
		if (typeof m === "string") logs.push(m);
	});
	vi.clearAllMocks();
	isLoggedIn.mockReturnValue(false);
	getCurrentProfile.mockReturnValue(null);
	setGlobalOptions({ json: true, nonInteractive: true });
});

afterEach(() => {
	spy.mockRestore();
	setGlobalOptions({ json: false, nonInteractive: false });
});

describe("authenticateWithToken", () => {
	it("persists the resolved profile as the default profile on success", async () => {
		resolveProfileFromCredential.mockResolvedValueOnce(RESOLVED);

		await authenticateWithToken("tk_123", "https://tarout.sa");

		expect(resolveProfileFromCredential).toHaveBeenCalledWith({
			token: "tk_123",
			apiUrl: "https://tarout.sa",
		});
		expect(setProfile).toHaveBeenCalledWith("default", RESOLVED);
		expect(setCurrentProfile).toHaveBeenCalledWith("default");

		const events = logs
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean) as Array<Record<string, any>>;
		// outputData wraps the payload as { success: true, data: <payload> }.
		const success = events.find((e) => e.success === true);
		expect(success?.data?.user?.email).toBe("owner@example.com");
		expect(success?.data?.project).toEqual({
			id: "project-1",
			name: "Project One",
			slug: "project-one",
		});
		expect(success?.data).not.toHaveProperty("environment");
	});

	it("reports the replaced identity when overwriting an existing session", async () => {
		isLoggedIn.mockReturnValue(true);
		getCurrentProfile.mockReturnValue({
			...RESOLVED,
			userEmail: "previous@example.com",
		} as never);
		resolveProfileFromCredential.mockResolvedValueOnce(RESOLVED);

		await authenticateWithToken("tk_123", "https://tarout.sa");

		const events = logs
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean) as Array<Record<string, any>>;
		const success = events.find((e) => e.success === true);
		expect(success?.data?.replacedProfile?.userEmail).toBe(
			"previous@example.com",
		);
	});

	it("does not persist anything when the token is invalid", async () => {
		resolveProfileFromCredential.mockRejectedValueOnce(
			new Error("The credential is valid, but it is not scoped to an organization."),
		);

		await expect(
			authenticateWithToken("bad-token", "https://tarout.sa"),
		).rejects.toThrow("not scoped to an organization");

		expect(setProfile).not.toHaveBeenCalled();
		expect(setCurrentProfile).not.toHaveBeenCalled();
	});
});

describe("buildProjectKeyMetadata", () => {
	it("scopes new CLI keys to the project without an environment boundary", () => {
		expect(
			buildProjectKeyMetadata({
				organizationId: "org-1",
				projectId: "project-1",
			}),
		).toEqual({
			organizationId: "org-1",
			projectId: "project-1",
		});
	});
});

describe("resolveVerifiedCurrentProfile", () => {
	it("validates the current token remotely instead of trusting saved metadata", async () => {
		const stale = { ...RESOLVED, projectId: "deleted-project" };
		getCurrentProfile.mockReturnValue(stale as never);
		resolveProfileFromCredential.mockResolvedValueOnce(RESOLVED);

		await expect(resolveVerifiedCurrentProfile()).resolves.toEqual(RESOLVED);
		expect(resolveProfileFromCredential).toHaveBeenCalledWith({
			token: "tk_123",
			apiUrl: "https://tarout.sa",
			fallback: stale,
		});
	});

	it("supports a bare TAROUT_TOKEN without a saved profile", async () => {
		getCurrentProfile.mockReturnValue(null);
		resolveProfileFromCredential.mockResolvedValueOnce(RESOLVED);

		await expect(resolveVerifiedCurrentProfile()).resolves.toEqual(RESOLVED);
		expect(resolveProfileFromCredential).toHaveBeenCalledWith({
			token: "tk_123",
			apiUrl: "https://tarout.sa",
			fallback: null,
		});
	});
});
