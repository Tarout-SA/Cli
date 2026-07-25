/**
 * Single-command dashboard → CLI handoff.
 *
 * The dashboard payload carries a five-minute, one-use authorization code and
 * its PKCE verifier. It never contains the durable API key. If a verified local
 * CLI profile already matches the requested account/project, that profile is
 * reused and the server exchange is left unused to expire.
 */

import type { AuthCallbackData } from "./auth-server.js";
import { exchangeCliAuthorizationCode } from "./auth-server.js";
import { resolveProfileFromCredential } from "./auth-profile.js";
import {
	type Config,
	getConfig,
	type Profile,
	setCurrentProfile,
	setProfile,
} from "./config.js";
import { InvalidArgumentError } from "./errors.js";
import { normalizeApiUrl } from "./api-url.js";
import { writeAgentIdentityFile } from "./agent-identity.js";
import type { FileAction } from "./agent-scaffold.js";

const HANDOFF_PATTERN = /^[A-Za-z0-9_-]{80,4096}$/;
const AUTHORIZATION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export interface AgentHandoffPayload {
	version: 1;
	code: string;
	codeVerifier: string;
	apiUrl: string;
	expiresAt: number;
	expected: {
		userId: string;
		organizationId: string;
		projectId: string;
	};
}

export interface AgentConnectResult {
	reusedExistingCredential: boolean;
	profileName: string;
	identityFile: {
		path: "AI.md";
		action: FileAction;
	};
	identity: {
		userEmail: string;
		organizationName: string;
		projectName?: string;
		apiUrl: string;
	};
}

interface AgentConnectDependencies {
	now: () => number;
	getConfig: () => Config;
	setCurrentProfile: (name: string) => void;
	setProfile: (name: string, profile: Profile) => void;
	resolveProfile: typeof resolveProfileFromCredential;
	exchangeCode: (
		apiUrl: string,
		code: string,
		codeVerifier: string,
	) => Promise<AuthCallbackData>;
	writeIdentity: typeof writeAgentIdentityFile;
}

const defaultDependencies: AgentConnectDependencies = {
	now: Date.now,
	getConfig,
	setCurrentProfile,
	setProfile,
	resolveProfile: resolveProfileFromCredential,
	exchangeCode: exchangeCliAuthorizationCode,
	writeIdentity: writeAgentIdentityFile,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 191 &&
		![...value].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127;
		})
	);
}

function isTrustedHandoffUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}

	const host = url.hostname.toLowerCase();
	const trustedHost =
		host === "tarout.sa" ||
		host.endsWith(".tarout.sa") ||
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "[::1]";
	return trustedHost && !url.username && !url.password;
}

export function decodeAgentHandoff(
	encoded: string,
	now = Date.now(),
): AgentHandoffPayload {
	if (!HANDOFF_PATTERN.test(encoded)) {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}

	if (!isRecord(parsed) || !isRecord(parsed.expected)) {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}

	const payload = parsed as unknown as AgentHandoffPayload;
	if (
		payload.version !== 1 ||
		!AUTHORIZATION_PATTERN.test(payload.code) ||
		!VERIFIER_PATTERN.test(payload.codeVerifier) ||
		typeof payload.apiUrl !== "string" ||
		!isTrustedHandoffUrl(payload.apiUrl) ||
		typeof payload.expiresAt !== "number" ||
		!Number.isFinite(payload.expiresAt) ||
		!isIdentifier(payload.expected.userId) ||
		!isIdentifier(payload.expected.organizationId) ||
		!isIdentifier(payload.expected.projectId)
	) {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}

	if (payload.expiresAt <= now) {
		throw new InvalidArgumentError(
			"This one-time Tarout command has expired. Refresh the Agent dashboard and copy the new command.",
		);
	}

	return {
		...payload,
		apiUrl: normalizeApiUrl(payload.apiUrl),
	};
}

function profileMatches(
	profile: Pick<Profile, "userId" | "organizationId" | "projectId">,
	expected: AgentHandoffPayload["expected"],
): boolean {
	return (
		profile.userId === expected.userId &&
		profile.organizationId === expected.organizationId &&
		profile.projectId === expected.projectId
	);
}

function profileFromExchange(
	auth: AuthCallbackData,
	apiUrl: string,
): Profile {
	return {
		token: auth.token,
		apiUrl,
		userId: auth.userId,
		userEmail: auth.userEmail,
		userName: auth.userName,
		organizationId: auth.organizationId,
		organizationName: auth.organizationName,
		projectId: auth.projectId,
		projectName: auth.projectName,
		projectSlug: auth.projectSlug,
		environmentId: auth.environmentId || "",
		environmentName: auth.environmentName || "production",
	};
}

function safeResult(
	profile: Profile,
	profileName: string,
	reusedExistingCredential: boolean,
	identityFile: ReturnType<typeof writeAgentIdentityFile>,
): AgentConnectResult {
	return {
		reusedExistingCredential,
		profileName,
		identityFile,
		identity: {
			userEmail: profile.userEmail,
			organizationName: profile.organizationName,
			projectName: profile.projectName,
			apiUrl: profile.apiUrl,
		},
	};
}

function availableProfileName(config: Config): string {
	for (const candidate of ["default", "dashboard"]) {
		if (!config.profiles[candidate]) return candidate;
	}
	for (let suffix = 2; suffix < 10_000; suffix += 1) {
		const candidate = `dashboard-${suffix}`;
		if (!config.profiles[candidate]) return candidate;
	}
	throw new Error("No available Tarout CLI profile name was found.");
}

export async function connectAgentFromHandoff(
	encoded: string,
	cwd: string,
	dependencyOverrides: Partial<AgentConnectDependencies> = {},
): Promise<AgentConnectResult> {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	const payload = decodeAgentHandoff(encoded, dependencies.now());
	const config = dependencies.getConfig();
	let staleMatchingProfileName: string | undefined;

	// Reuse any matching saved profile, not only the currently selected one.
	for (const [profileName, candidate] of Object.entries(config.profiles)) {
		if (!profileMatches(candidate, payload.expected)) continue;
		try {
			if (normalizeApiUrl(candidate.apiUrl) !== payload.apiUrl) continue;
			const verified = await dependencies.resolveProfile({
				apiUrl: candidate.apiUrl,
				token: candidate.token,
				fallback: candidate,
			});
			if (!profileMatches(verified, payload.expected)) continue;
			if (normalizeApiUrl(verified.apiUrl) !== payload.apiUrl) continue;

			dependencies.setProfile(profileName, verified);
			dependencies.setCurrentProfile(profileName);
			const identityFile = dependencies.writeIdentity(cwd, verified, {
				profileName,
			});
			return safeResult(verified, profileName, true, identityFile);
		} catch {
			// The saved key is stale or revoked. Consume the one-time handoff
			// below and replace it with a fresh server-minted credential.
			staleMatchingProfileName ??= profileName;
		}
	}

	const auth = await dependencies.exchangeCode(
		payload.apiUrl,
		payload.code,
		payload.codeVerifier,
	);
	const fallback = profileFromExchange(auth, payload.apiUrl);
	if (!profileMatches(fallback, payload.expected)) {
		throw new Error(
			"Tarout returned a different account than the one in this handoff.",
		);
	}

	const profile = await dependencies
		.resolveProfile({
			apiUrl: payload.apiUrl,
			token: auth.token,
			fallback,
		})
		.catch(() => fallback);
	if (!profileMatches(profile, payload.expected)) {
		throw new Error(
			"Tarout returned a different account than the one in this handoff.",
		);
	}

	const profileName =
		staleMatchingProfileName ?? availableProfileName(config);
	dependencies.setProfile(profileName, profile);
	dependencies.setCurrentProfile(profileName);
	const identityFile = dependencies.writeIdentity(cwd, profile, {
		profileName,
	});
	return safeResult(profile, profileName, false, identityFile);
}
