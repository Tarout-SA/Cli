import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	connectAgentFromHandoff,
	decodeAgentHandoff,
	type AgentHandoffPayload,
} from "../src/lib/agent-handoff";
import type { Config, Profile } from "../src/lib/config";

const PROFILE: Profile = {
	token: "cli_existing_secret",
	apiUrl: "https://tarout.sa",
	userId: "user-1",
	userEmail: "owner@example.com",
	userName: "Owner",
	organizationId: "org-1",
	organizationName: "Tarout Labs",
	projectId: "project-1",
	projectName: "Launch",
	projectSlug: "launch",
	environmentId: "",
	environmentName: "production",
};

const AUTH = {
	token: "cli_new_secret",
	userId: PROFILE.userId,
	userEmail: PROFILE.userEmail,
	userName: PROFILE.userName,
	organizationId: PROFILE.organizationId,
	organizationName: PROFILE.organizationName,
	projectId: "project-1",
	projectName: "Launch",
	projectSlug: PROFILE.projectSlug,
};

const NOW = 1_000;

function encode(
	overrides: Partial<AgentHandoffPayload> = {},
): string {
	const payload: AgentHandoffPayload = {
		version: 1,
		code: "c".repeat(43),
		codeVerifier: "v".repeat(43),
		apiUrl: "https://tarout.sa",
		expiresAt: NOW + 300_000,
		expected: {
			userId: PROFILE.userId,
			organizationId: PROFILE.organizationId,
			projectId: "project-1",
		},
		...overrides,
	};
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "tarout-agent-handoff-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("dashboard agent handoff", () => {
	it("rejects expired, malformed, and non-Tarout handoffs", () => {
		expect(() => decodeAgentHandoff("not-a-handoff", NOW)).toThrow(
			/command is invalid/i,
		);
		expect(() =>
			decodeAgentHandoff(encode({ expiresAt: NOW }), NOW),
		).toThrow(/expired/i);
		expect(() =>
			decodeAgentHandoff(
				encode({ apiUrl: "https://example.com" }),
				NOW,
			),
		).toThrow(/invalid/i);
	});

	it("reuses a verified matching CLI profile without minting another key", async () => {
		const exchangeCode = vi.fn();
		const setProfile = vi.fn();
		const setCurrentProfile = vi.fn();
		const config: Config = {
			currentProfile: "work",
			profiles: { work: PROFILE },
		};

		const result = await connectAgentFromHandoff(
			encode(),
			directory,
			{ scope: "global" },
			{
				now: () => NOW,
				getConfig: () => config,
				setProfile,
				setCurrentProfile,
				resolveProfile: vi.fn().mockResolvedValue(PROFILE),
				exchangeCode,
			},
		);

		expect(result.reusedExistingCredential).toBe(true);
		expect(result.profileName).toBe("work");
		expect(result).not.toHaveProperty("token");
		expect(exchangeCode).not.toHaveBeenCalled();
		expect(setProfile).toHaveBeenCalledWith("work", PROFILE);
		expect(setCurrentProfile).toHaveBeenCalledWith("work");
	});

	it("does not reuse a matching identity from a different Tarout environment", async () => {
		const exchangeCode = vi.fn().mockResolvedValue(AUTH);
		const config: Config = {
			currentProfile: "staging",
			profiles: {
				staging: {
					...PROFILE,
					apiUrl: "https://staging.tarout.sa",
				},
			},
		};

		await connectAgentFromHandoff(
			encode(),
			directory,
			{ scope: "global" },
			{
				now: () => NOW,
				getConfig: () => config,
				setProfile: vi.fn(),
				setCurrentProfile: vi.fn(),
				resolveProfile: vi.fn().mockResolvedValue(PROFILE),
				exchangeCode,
			},
		);

		expect(exchangeCode).toHaveBeenCalledOnce();
	});

	it("exchanges once and persists a new private profile when no match exists", async () => {
		const setProfile = vi.fn();
		const setCurrentProfile = vi.fn();
		const exchangeCode = vi.fn().mockResolvedValue(AUTH);

		const result = await connectAgentFromHandoff(
			encode(),
			directory,
			{ scope: "global" },
			{
				now: () => NOW,
				getConfig: () => ({ currentProfile: "default", profiles: {} }),
				setProfile,
				setCurrentProfile,
				resolveProfile: vi.fn().mockRejectedValue(new Error("offline")),
				exchangeCode,
			},
		);

		expect(exchangeCode).toHaveBeenCalledOnce();
		expect(setProfile).toHaveBeenCalledWith(
			"default",
			expect.objectContaining({
				token: AUTH.token,
				userId: PROFILE.userId,
				organizationId: PROFILE.organizationId,
			}),
		);
		expect(setCurrentProfile).toHaveBeenCalledWith("default");
		expect(result.reusedExistingCredential).toBe(false);
		expect(JSON.stringify(result)).not.toContain(AUTH.token);
	});

	it("does not overwrite an unrelated existing default profile", async () => {
		const setProfile = vi.fn();
		const setCurrentProfile = vi.fn();
		const unrelated = {
			...PROFILE,
			userId: "user-other",
			organizationId: "org-other",
			projectId: "project-other",
		};

		const result = await connectAgentFromHandoff(
			encode(),
			directory,
			{ scope: "global" },
			{
				now: () => NOW,
				getConfig: () => ({
					currentProfile: "default",
					profiles: { default: unrelated },
				}),
				setProfile,
				setCurrentProfile,
				resolveProfile: vi.fn().mockRejectedValue(new Error("offline")),
				exchangeCode: vi.fn().mockResolvedValue(AUTH),
			},
		);

		expect(setProfile).toHaveBeenCalledWith(
			"dashboard",
			expect.objectContaining({ token: AUTH.token }),
		);
		expect(setCurrentProfile).toHaveBeenCalledWith("dashboard");
		expect(result.profileName).toBe("dashboard");
	});

	it("never persists a credential returned for a different account", async () => {
		const setProfile = vi.fn();
		const setCurrentProfile = vi.fn();
		const setProjectCredential = vi.fn();
		const exchangeCode = vi.fn().mockResolvedValue({
			...AUTH,
			organizationId: "org-other",
		});

		await expect(
			connectAgentFromHandoff(
				encode(),
				directory,
				{},
				{
					now: () => NOW,
					getConfig: () => ({ currentProfile: "default", profiles: {} }),
					setProfile,
					setCurrentProfile,
					setProjectCredential,
					resolveProfile: vi.fn(),
					exchangeCode,
				},
			),
		).rejects.toThrow(/different account/i);

		expect(setProfile).not.toHaveBeenCalled();
		expect(setCurrentProfile).not.toHaveBeenCalled();
		expect(setProjectCredential).not.toHaveBeenCalled();
	});
});

/**
 * Project binding is the DEFAULT for the dashboard's one-command setup. The
 * handoff is issued for one project, so storing it machine-wide meant running
 * setup for project B silently re-pointed project A at another account — the
 * exact failure this scope exists to prevent.
 */
describe("agent handoff credential scope", () => {
	it("writes the key to the project by default and leaves the global store untouched", async () => {
		const setProfile = vi.fn();
		const setCurrentProfile = vi.fn();
		const setProjectCredential = vi
			.fn()
			.mockReturnValue(join(directory, ".tarout", "auth.json"));

		const result = await connectAgentFromHandoff(
			encode(),
			directory,
			{},
			{
				now: () => NOW,
				getConfig: () => ({ currentProfile: "default", profiles: {} }),
				setProfile,
				setCurrentProfile,
				setProjectCredential,
				resolveProfile: vi.fn().mockRejectedValue(new Error("offline")),
				exchangeCode: vi.fn().mockResolvedValue(AUTH),
			},
		);

		expect(result.scope).toBe("project");
		expect(result.credentialPath).toContain(".tarout");
		expect(setProjectCredential).toHaveBeenCalledWith(
			expect.objectContaining({ token: AUTH.token }),
			directory,
		);
		expect(setProfile).not.toHaveBeenCalled();
		expect(setCurrentProfile).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain(AUTH.token);
	});

	it("binds a reused machine-wide credential to the project too", async () => {
		const setProfile = vi.fn();
		const setProjectCredential = vi.fn().mockReturnValue("/tmp/x/.tarout/auth.json");

		const result = await connectAgentFromHandoff(
			encode(),
			directory,
			{},
			{
				now: () => NOW,
				getConfig: () => ({ currentProfile: "work", profiles: { work: PROFILE } }),
				setProfile,
				setCurrentProfile: vi.fn(),
				setProjectCredential,
				resolveProfile: vi.fn().mockResolvedValue(PROFILE),
				exchangeCode: vi.fn(),
			},
		);

		expect(result.reusedExistingCredential).toBe(true);
		expect(result.scope).toBe("project");
		expect(setProjectCredential).toHaveBeenCalledWith(PROFILE, directory);
		expect(setProfile).not.toHaveBeenCalled();
	});

	it("refuses $HOME instead of quietly connecting the whole machine", async () => {
		// This used to fall back to the global store and print the reason. That
		// inverts the guarantee the command exists for - connecting project B must
		// not re-point project A - and it does so on the one path where the user
		// clearly believed they were binding a single project. It now errors, and
		// the handoff is left unspent so the corrected run can still use it.
		const setProfile = vi.fn();
		const setProjectCredential = vi.fn();
		const exchangeCode = vi.fn().mockResolvedValue(AUTH);

		await expect(
			connectAgentFromHandoff(
				encode(),
				homedir(),
				{ scope: "project" },
				{
					now: () => NOW,
					getConfig: () => ({ currentProfile: "default", profiles: {} }),
					setProfile,
					setCurrentProfile: vi.fn(),
					setProjectCredential,
					resolveProfile: vi.fn().mockRejectedValue(new Error("offline")),
					exchangeCode,
					writeIdentity: vi
						.fn()
						.mockReturnValue({ path: "AI.md", action: "created" }),
				},
			),
		).rejects.toThrow(/--global/);

		expect(setProjectCredential).not.toHaveBeenCalled();
		expect(setProfile).not.toHaveBeenCalled();
		expect(exchangeCode).not.toHaveBeenCalled();
	});

	it("still writes machine-wide when --global asks for it", async () => {
		const setProfile = vi.fn();
		const setProjectCredential = vi.fn();

		const result = await connectAgentFromHandoff(
			encode(),
			homedir(),
			{ scope: "global" },
			{
				now: () => NOW,
				getConfig: () => ({ currentProfile: "default", profiles: {} }),
				setProfile,
				setCurrentProfile: vi.fn(),
				setProjectCredential,
				resolveProfile: vi.fn().mockRejectedValue(new Error("offline")),
				exchangeCode: vi.fn().mockResolvedValue(AUTH),
				writeIdentity: vi
					.fn()
					.mockReturnValue({ path: "AI.md", action: "created" }),
			},
		);

		expect(result.scope).toBe("global");
		expect(setProjectCredential).not.toHaveBeenCalled();
		expect(setProfile).toHaveBeenCalled();
	});
});

/**
 * Compact handoff (`t1.…`). The dashboard command was ~475 chars because the v1
 * form JSON-encodes the payload then base64s the whole document — the key names
 * and base64 inflation dominate, not the values. The positional form carries the
 * SAME fields in ~58% fewer characters. The v1 blob must keep decoding so a
 * command copied from an older dashboard still works.
 */
describe("compact handoff", () => {
	const CODE = "oY8eODyt-8YM4dPkTssd4L_rcPqg0iwSgr01NJ6hJqQ";
	const VERIFIER = "R-HJXb-9Mroe9Vmg7DlRkVKz2Ljjui4VJDD3PUr_5gk";
	const EXP = 1785046456258;
	const compact = (extra = "") =>
		`t1.${CODE}.${VERIFIER}.E3kstlwkvTjoWlxtsFxzSxf1JIlGKXlC.DWN9zqTa6T8mZjn9MxFtl._qEA1WLhgHOw3mEzhEvpW.${EXP.toString(36)}${extra}`;

	it("decodes every field the v1 payload carried", () => {
		const payload = decodeAgentHandoff(compact(), EXP - 1000);
		expect(payload).toEqual({
			version: 1,
			code: CODE,
			codeVerifier: VERIFIER,
			apiUrl: "https://tarout.sa",
			expiresAt: EXP,
			expected: {
				userId: "E3kstlwkvTjoWlxtsFxzSxf1JIlGKXlC",
				organizationId: "DWN9zqTa6T8mZjn9MxFtl",
				projectId: "_qEA1WLhgHOw3mEzhEvpW",
			},
		});
	});

	it("is materially shorter than the v1 blob", () => {
		const v1 = Buffer.from(
			JSON.stringify({
				version: 1,
				code: CODE,
				codeVerifier: VERIFIER,
				apiUrl: "https://tarout.sa",
				expiresAt: EXP,
				expected: {
					userId: "E3kstlwkvTjoWlxtsFxzSxf1JIlGKXlC",
					organizationId: "DWN9zqTa6T8mZjn9MxFtl",
					projectId: "_qEA1WLhgHOw3mEzhEvpW",
				},
			}),
			"utf8",
		).toString("base64url");
		expect(compact().length).toBeLessThan(v1.length * 0.5);
	});

	it("carries a non-default apiUrl in the optional 8th segment", () => {
		const staging = Buffer.from("https://staging.tarout.sa", "utf8").toString(
			"base64url",
		);
		expect(
			decodeAgentHandoff(compact(`.${staging}`), EXP - 1000).apiUrl,
		).toBe("https://staging.tarout.sa");
	});

	it("rejects an untrusted apiUrl", () => {
		const evil = Buffer.from("https://evil.example", "utf8").toString(
			"base64url",
		);
		expect(() => decodeAgentHandoff(compact(`.${evil}`), EXP - 1000)).toThrow();
	});

	it("rejects a malformed segment count and reports expiry", () => {
		expect(() => decodeAgentHandoff("t1.a.b", EXP - 1000)).toThrow();
		expect(() => decodeAgentHandoff(compact(), EXP + 1000)).toThrow(/expired/i);
	});
});

describe("v2 handoff", () => {
	const CODE = "oY8eODyt-8YM4dPkTssd4L";

	it("carries only the code", () => {
		expect(decodeAgentHandoff(`t2.${CODE}`, NOW)).toEqual({
			version: 2,
			code: CODE,
			apiUrl: "https://tarout.sa",
		});
	});

	it("is a fraction of the v1 string a human has to copy", () => {
		// 25 characters against 176. If this grows back, something the server
		// already knows has been re-added to the payload.
		expect(`t2.${CODE}`.length).toBeLessThanOrEqual(30);
	});

	it("carries a non-default apiUrl in the optional 2nd segment", () => {
		const staging = Buffer.from("https://staging.tarout.sa", "utf8").toString(
			"base64url",
		);
		expect(decodeAgentHandoff(`t2.${CODE}.${staging}`, NOW).apiUrl).toBe(
			"https://staging.tarout.sa",
		);
	});

	it("rejects an untrusted apiUrl, a wrong-width code, and extra segments", () => {
		const evil = Buffer.from("https://evil.example", "utf8").toString(
			"base64url",
		);
		expect(() => decodeAgentHandoff(`t2.${CODE}.${evil}`, NOW)).toThrow();
		// A v1-width code in a v2 envelope is not a v2 code.
		expect(() => decodeAgentHandoff(`t2.${"c".repeat(43)}`, NOW)).toThrow();
		expect(() => decodeAgentHandoff(`t2.${CODE}.a.b`, NOW)).toThrow();
	});

	it("exchanges rather than reusing a saved profile it cannot verify", async () => {
		// v1 could match a stored credential against the ids in the handoff and
		// skip the exchange. v2 carries no ids, so there is nothing to match on -
		// and guessing that the local profile is the intended account would be the
		// unsafe direction. It exchanges instead; the code was single-use anyway.
		const exchangeCode = vi.fn().mockResolvedValue(AUTH);
		const config: Config = {
			currentProfile: "work",
			profiles: { work: PROFILE },
		};

		const result = await connectAgentFromHandoff(
			`t2.${CODE}`,
			directory,
			{ scope: "global" },
			{
				now: () => NOW,
				getConfig: () => config,
				setProfile: vi.fn(),
				setCurrentProfile: vi.fn(),
				resolveProfile: vi.fn().mockResolvedValue(PROFILE),
				exchangeCode,
			},
		);

		expect(result.reusedExistingCredential).toBe(false);
		expect(exchangeCode).toHaveBeenCalledWith(
			"https://tarout.sa",
			CODE,
			undefined,
		);
	});
});
