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
	getGlobalProfile: vi.fn(
		() =>
			({ token: "tk_123", apiUrl: "https://tarout.sa", userEmail: "owner@example.com" }) as any,
	),
	getAuthScope: vi.fn(() => ({ scope: "global" as const })),
	getToken: vi.fn(() => "tk_123"),
	getApiUrl: vi.fn(() => "https://tarout.sa"),
	resolveProfileFromCredential: vi.fn(),
	createCredentialClient: vi.fn(),
	getConfig: vi.fn(() => ({ currentProfile: "default", profiles: {} })),
	deleteProfile: vi.fn(),
	listProfiles: vi.fn(() => [] as string[]),
	clearConfig: vi.fn(),
	revokeCurrentCliKey: vi.fn(),
	getApiClient: vi.fn(),
	// Project-scoped credentials are exercised in project-auth.test.ts; here the
	// directory is deliberately unauthenticated so `logout` takes the global path.
	getProjectCredential: vi.fn(() => null),
	setProjectCredential: vi.fn(() => "/tmp/project/.tarout/auth.json"),
	removeProjectCredential: vi.fn(() => "/tmp/project/.tarout/auth.json"),
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
	getGlobalProfile: m.getGlobalProfile,
	getAuthScope: m.getAuthScope,
	getToken: m.getToken,
	getApiUrl: m.getApiUrl,
	getConfig: m.getConfig,
	deleteProfile: m.deleteProfile,
	listProfiles: m.listProfiles,
	clearConfig: m.clearConfig,
}));

vi.mock("../src/lib/project-auth.js", () => ({
	getProjectCredential: m.getProjectCredential,
	setProjectCredential: m.setProjectCredential,
	removeProjectCredential: m.removeProjectCredential,
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: m.getApiClient,
}));

vi.mock("../src/lib/auth-profile.js", () => ({
	resolveProfileFromCredential: m.resolveProfileFromCredential,
	createCredentialClient: m.createCredentialClient,
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
}));

import {
	authenticateWithToken,
	buildProjectKeyMetadata,
	performLogout,
	resolveVerifiedCurrentProfile,
	warnIfUntrustedHost,
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

	it("never sends a token over plaintext outside loopback", async () => {
		await expect(
			authenticateWithToken("must-not-be-sent", "http://evil.example"),
		).rejects.toThrow(/HTTPS is required/i);
		expect(resolveProfileFromCredential).not.toHaveBeenCalled();
		expect(setProfile).not.toHaveBeenCalled();
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

function jsonEvents() {
	return logs
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean) as Array<Record<string, any>>;
}

describe("performLogout", () => {
	beforeEach(() => {
		isLoggedIn.mockReturnValue(true);
		getCurrentProfile.mockReturnValue({
			...RESOLVED,
			userEmail: "owner@example.com",
		} as never);
		m.getConfig.mockReturnValue({ currentProfile: "default", profiles: {} });
		m.getGlobalProfile.mockReturnValue({
			...RESOLVED,
			userEmail: "owner@example.com",
		} as never);
		m.getProjectCredential.mockReturnValue(null);
		// The revoke is issued through a client built explicitly from the GLOBAL
		// credential, so that `logout --global` can never revoke whichever key a
		// project-scoped credential happens to be supplying.
		m.createCredentialClient.mockReturnValue({
			user: { revokeCurrentCliKey: { mutate: m.revokeCurrentCliKey } },
		});
	});

	it("revokes the server-side key, then drops local state (last profile → full reset)", async () => {
		m.revokeCurrentCliKey.mockResolvedValueOnce({ revoked: true });
		m.listProfiles.mockReturnValue([]);

		await performLogout();

		expect(m.revokeCurrentCliKey).toHaveBeenCalledTimes(1);
		expect(m.deleteProfile).toHaveBeenCalledWith("default");
		expect(m.clearConfig).toHaveBeenCalledTimes(1);
		const success = jsonEvents().find((e) => e.success === true);
		expect(success?.data?.revoked).toBe(true);
		// Fully logged out — nothing was promoted, so switchedTo is explicitly null.
		expect(success?.data).toHaveProperty("switchedTo", null);
	});

	it("still clears local credentials when the revoke call fails (offline / old server)", async () => {
		m.createCredentialClient.mockImplementation(() => {
			throw new Error("network down");
		});
		m.listProfiles.mockReturnValue([]);

		await performLogout();

		// Best-effort revoke: a failure must NOT block the local logout.
		expect(m.deleteProfile).toHaveBeenCalledWith("default");
		expect(m.clearConfig).toHaveBeenCalledTimes(1);
		const success = jsonEvents().find((e) => e.success === true);
		expect(success?.success).toBe(true);
		expect(success?.data?.revoked).toBe(false);
	});

	it("deletes ONLY the current profile, leaving other profiles intact", async () => {
		m.revokeCurrentCliKey.mockResolvedValueOnce({ revoked: true });
		// After deleting "default", a "work" profile remains.
		m.listProfiles.mockReturnValue(["work"]);

		await performLogout();

		expect(m.deleteProfile).toHaveBeenCalledWith("default");
		expect(m.clearConfig).not.toHaveBeenCalled();
		expect(setCurrentProfile).toHaveBeenCalledWith("work");
		// The identity switch must be announced, not silent: the JSON envelope
		// names the profile now active (and its email, from the promoted profile).
		const success = jsonEvents().find((e) => e.success === true);
		expect(success?.data?.switchedTo?.profile).toBe("work");
		expect(success?.data?.switchedTo?.userEmail).toBe("owner@example.com");
	});

	it("announces the newly-active profile in human mode after a silent switch", async () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		m.revokeCurrentCliKey.mockResolvedValueOnce({ revoked: true });
		m.listProfiles.mockReturnValue(["work"]);

		await performLogout();

		// Human-readable output must state which profile/email is now in effect so
		// the user isn't left unknowingly operating as a different identity.
		const line = logs.find((l) => /Now using profile 'work'/.test(l));
		expect(line, "expected a 'now using' announcement").toBeTruthy();
		expect(line).toMatch(/owner@example\.com/);
	});

	it("is a no-op when already logged out", async () => {
		isLoggedIn.mockReturnValue(false);
		m.getGlobalProfile.mockReturnValue(null);

		await performLogout();

		expect(m.revokeCurrentCliKey).not.toHaveBeenCalled();
		expect(m.deleteProfile).not.toHaveBeenCalled();
		expect(m.clearConfig).not.toHaveBeenCalled();
	});

	// An unqualified `logout` has to sign out the credential that is actually in
	// effect. Falling through to the global path here would revoke the PROJECT's
	// key (it is the one the API client holds) while deleting an unrelated global
	// profile, leaving the directory authenticated with a dead key.
	it("removes the project credential instead of the global one when a project is active", async () => {
		m.getProjectCredential.mockReturnValue({
			credential: { ...RESOLVED, userEmail: "agent@example.com" },
			path: "/tmp/project/.tarout/auth.json",
			projectDir: "/tmp/project",
		} as never);

		await performLogout();

		expect(m.removeProjectCredential).toHaveBeenCalledWith("/tmp/project");
		expect(m.deleteProfile).not.toHaveBeenCalled();
		expect(m.clearConfig).not.toHaveBeenCalled();
		// Never revoke server-side here: the same key may still be the machine-wide
		// credential or bound to another checkout of the project.
		expect(m.revokeCurrentCliKey).not.toHaveBeenCalled();

		const success = jsonEvents().find((e) => e.success === true);
		expect(success?.data?.scope).toBe("project");
	});

	it("--global signs out the machine-wide login even with a project credential present", async () => {
		m.getProjectCredential.mockReturnValue({
			credential: { ...RESOLVED, userEmail: "agent@example.com" },
			path: "/tmp/project/.tarout/auth.json",
			projectDir: "/tmp/project",
		} as never);
		m.revokeCurrentCliKey.mockResolvedValueOnce({ revoked: true });
		m.listProfiles.mockReturnValue([]);

		await performLogout({ scope: "global" });

		expect(m.removeProjectCredential).not.toHaveBeenCalled();
		expect(m.deleteProfile).toHaveBeenCalledWith("default");
		expect(m.revokeCurrentCliKey).toHaveBeenCalledTimes(1);
	});
});

describe("authenticateWithToken --local", () => {
	it("writes the key to the project and leaves the machine-wide profile alone", async () => {
		resolveProfileFromCredential.mockResolvedValueOnce(RESOLVED);

		await authenticateWithToken("tk_123", "https://tarout.sa", {
			scope: "project",
			cwd: "/tmp/project",
		});

		expect(m.setProjectCredential).toHaveBeenCalledWith(
			expect.objectContaining({ token: "tk_123" }),
			"/tmp/project",
		);
		expect(setProfile).not.toHaveBeenCalled();
		expect(setCurrentProfile).not.toHaveBeenCalled();

		const success = jsonEvents().find((e) => e.success === true);
		expect(success?.data?.scope).toBe("project");
	});

	// The machine-wide login is untouched by a project-scoped key, so claiming it
	// was "replaced" would be false.
	it("does not report a replaced session when scoped to the project", async () => {
		isLoggedIn.mockReturnValue(true);
		getCurrentProfile.mockReturnValue({
			...RESOLVED,
			userEmail: "someone-else@example.com",
		} as never);
		resolveProfileFromCredential.mockResolvedValueOnce(RESOLVED);

		await authenticateWithToken("tk_123", "https://tarout.sa", {
			scope: "project",
			cwd: "/tmp/project",
		});

		const success = jsonEvents().find((e) => e.success === true);
		expect(success?.data?.replacedProfile).toBeUndefined();
	});
});

describe("warnIfUntrustedHost", () => {
	let errSpy: ReturnType<typeof vi.spyOn>;
	let errLines: string[];

	beforeEach(() => {
		errLines = [];
		errSpy = vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
			if (typeof msg === "string") errLines.push(msg);
		});
	});

	afterEach(() => {
		errSpy.mockRestore();
	});

	it("stays silent for Tarout hosts and loopback", () => {
		for (const url of [
			"https://tarout.sa",
			"https://staging.tarout.sa",
			"http://localhost:8000",
			"http://127.0.0.1:8000",
		]) {
			warnIfUntrustedHost(url);
		}
		expect(errLines).toEqual([]);
		expect(logs).toEqual([]);
	});

	it("emits a structured stderr warning for a non-Tarout host in json mode", () => {
		setGlobalOptions({ json: true, nonInteractive: true });
		warnIfUntrustedHost("https://evil.example.com");

		// Never on stdout — that stream carries the single result envelope.
		expect(logs.some((l) => l.includes("untrusted_host_warning"))).toBe(false);
		const evt = errLines
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((e) => e?.event === "untrusted_host_warning");
		expect(evt?.host).toBe("evil.example.com");
		expect(typeof evt?.message).toBe("string");
	});

	it("warns on stderr in human mode for a non-Tarout host", () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		warnIfUntrustedHost("https://evil.example.com");
		expect(errLines.join("\n")).toMatch(/evil\.example\.com/);
	});
});
