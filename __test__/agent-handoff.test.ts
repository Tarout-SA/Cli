import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

		const result = await connectAgentFromHandoff(encode(), directory, {
			now: () => NOW,
			getConfig: () => config,
			setProfile,
			setCurrentProfile,
			resolveProfile: vi.fn().mockResolvedValue(PROFILE),
			exchangeCode,
		});

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

		await connectAgentFromHandoff(encode(), directory, {
			now: () => NOW,
			getConfig: () => config,
			setProfile: vi.fn(),
			setCurrentProfile: vi.fn(),
			resolveProfile: vi.fn().mockResolvedValue(PROFILE),
			exchangeCode,
		});

		expect(exchangeCode).toHaveBeenCalledOnce();
	});

	it("exchanges once and persists a new private profile when no match exists", async () => {
		const setProfile = vi.fn();
		const setCurrentProfile = vi.fn();
		const exchangeCode = vi.fn().mockResolvedValue(AUTH);

		const result = await connectAgentFromHandoff(encode(), directory, {
			now: () => NOW,
			getConfig: () => ({ currentProfile: "default", profiles: {} }),
			setProfile,
			setCurrentProfile,
			resolveProfile: vi.fn().mockRejectedValue(new Error("offline")),
			exchangeCode,
		});

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

		const result = await connectAgentFromHandoff(encode(), directory, {
			now: () => NOW,
			getConfig: () => ({
				currentProfile: "default",
				profiles: { default: unrelated },
			}),
			setProfile,
			setCurrentProfile,
			resolveProfile: vi.fn().mockRejectedValue(new Error("offline")),
			exchangeCode: vi.fn().mockResolvedValue(AUTH),
		});

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
		const exchangeCode = vi.fn().mockResolvedValue({
			...AUTH,
			organizationId: "org-other",
		});

		await expect(
			connectAgentFromHandoff(encode(), directory, {
				now: () => NOW,
				getConfig: () => ({ currentProfile: "default", profiles: {} }),
				setProfile,
				setCurrentProfile,
				resolveProfile: vi.fn(),
				exchangeCode,
			}),
		).rejects.toThrow(/different account/i);

		expect(setProfile).not.toHaveBeenCalled();
		expect(setCurrentProfile).not.toHaveBeenCalled();
	});
});
