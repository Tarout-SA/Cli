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
import {
	setProjectCredential,
	unsafeCredentialDirectory,
} from "./project-auth.js";
import { InvalidArgumentError } from "./errors.js";
import { normalizeApiUrl } from "./api-url.js";
import { writeAgentIdentityFile } from "./agent-identity.js";
import type { FileAction } from "./agent-scaffold.js";

const HANDOFF_PATTERN = /^[A-Za-z0-9_-]{80,4096}$/;
const AUTHORIZATION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** v2 codes are 16 bytes, not 32. */
const V2_AUTHORIZATION_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

export interface AgentHandoffPayload {
	version: 1 | 2;
	code: string;
	/** v1 only. v2 dropped PKCE - see `decodeV2Handoff`. */
	codeVerifier?: string;
	apiUrl: string;
	/** v1 only: v2 lets the server be the authority on expiry. */
	expiresAt?: number;
	/** v1 only: the account this handoff was minted for. */
	expected?: {
		userId: string;
		organizationId: string;
		projectId: string;
	};
}

/** Where `agent connect` should persist the credential it obtains. */
export type AgentConnectScope = "project" | "global";

export interface AgentConnectResult {
	reusedExistingCredential: boolean;
	profileName: string;
	/** Which credential layer the key was written to. */
	scope: AgentConnectScope;
	/** Absolute path of the project credential, when scope is `project`. */
	credentialPath?: string;
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
	setProjectCredential: (profile: Profile, baseDir: string) => string;
	resolveProfile: typeof resolveProfileFromCredential;
	exchangeCode: (
		apiUrl: string,
		code: string,
		codeVerifier?: string,
	) => Promise<AuthCallbackData>;
	writeIdentity: typeof writeAgentIdentityFile;
}

const defaultDependencies: AgentConnectDependencies = {
	now: Date.now,
	getConfig,
	setCurrentProfile,
	setProfile,
	setProjectCredential: (profile, baseDir) =>
		setProjectCredential({ ...profile, source: "agent-connect" }, baseDir),
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

/**
 * Compact handoff: `t1.<code>.<verifier>.<userId>.<orgId>.<projectId>.<expB36>`
 * with an optional 8th segment carrying a non-default apiUrl (base64url).
 *
 * Same information as the v1 JSON form, ~60% shorter on the wire: the JSON keys
 * and the base64 inflation of the whole document are the bulk of the old
 * payload, not the values. Kept positional (not JSON) so there is nothing to
 * inflate. `decodeAgentHandoff` still accepts the v1 blob, so a command copied
 * from an older dashboard keeps working.
 */
const COMPACT_PREFIX = "t1.";

function decodeCompactHandoff(
	encoded: string,
	now: number,
): AgentHandoffPayload {
	const parts = encoded.slice(COMPACT_PREFIX.length).split(".");
	if (parts.length !== 6 && parts.length !== 7) {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}
	const [code, codeVerifier, userId, organizationId, projectId, exp, apiUrlB64] =
		parts as [string, string, string, string, string, string, string?];

	const expiresAt = Number.parseInt(exp, 36);
	let apiUrl = "https://tarout.sa";
	if (apiUrlB64) {
		try {
			apiUrl = Buffer.from(apiUrlB64, "base64url").toString("utf8");
		} catch {
			throw new InvalidArgumentError("The Tarout agent command is invalid.");
		}
	}

	if (
		!AUTHORIZATION_PATTERN.test(code) ||
		!VERIFIER_PATTERN.test(codeVerifier) ||
		!isIdentifier(userId) ||
		!isIdentifier(organizationId) ||
		!isIdentifier(projectId) ||
		!Number.isFinite(expiresAt) ||
		!isTrustedHandoffUrl(apiUrl)
	) {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}
	if (expiresAt <= now) {
		throw new InvalidArgumentError(
			"This one-time Tarout command has expired. Refresh the Agent dashboard and copy the new command.",
		);
	}

	return {
		version: 1,
		code,
		codeVerifier,
		apiUrl: normalizeApiUrl(apiUrl),
		expiresAt,
		expected: { userId, organizationId, projectId },
	};
}

/**
 * Current handoff: `t2.<code>` with an optional 2nd segment carrying a
 * non-default apiUrl (base64url). 25 characters against v1's 176.
 *
 * The PKCE verifier is gone: it travelled in the same string as the code, so it
 * bound nothing an attacker holding that string did not already have (the
 * server keeps the code hashed at rest either way). The account ids are gone:
 * they were a client-side assertion the exchange response already makes. And
 * the embedded expiry is gone: the server owns the five-minute TTL and answers
 * 410, which `exchangeCliAuthorizationCode` turns into the same "expired,
 * refresh the dashboard" message this used to raise locally.
 *
 * One consequence worth knowing: with no account ids there is nothing to match
 * a saved profile against before exchanging, so a v2 connect always consumes
 * its code and mints a credential rather than reusing an equivalent one. That
 * costs one short-lived key on a repeat setup and keeps the string short.
 */
const V2_PREFIX = "t2.";

function decodeV2Handoff(encoded: string): AgentHandoffPayload {
	const parts = encoded.slice(V2_PREFIX.length).split(".");
	if (parts.length !== 1 && parts.length !== 2) {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}
	const [code, apiUrlB64] = parts as [string, string?];

	let apiUrl = "https://tarout.sa";
	if (apiUrlB64) {
		try {
			apiUrl = Buffer.from(apiUrlB64, "base64url").toString("utf8");
		} catch {
			throw new InvalidArgumentError("The Tarout agent command is invalid.");
		}
	}

	if (!V2_AUTHORIZATION_PATTERN.test(code) || !isTrustedHandoffUrl(apiUrl)) {
		throw new InvalidArgumentError("The Tarout agent command is invalid.");
	}

	return { version: 2, code, apiUrl: normalizeApiUrl(apiUrl) };
}

export function decodeAgentHandoff(
	encoded: string,
	now = Date.now(),
): AgentHandoffPayload {
	if (encoded.startsWith(V2_PREFIX)) {
		return decodeV2Handoff(encoded);
	}
	if (encoded.startsWith(COMPACT_PREFIX)) {
		return decodeCompactHandoff(encoded, now);
	}
	// A `t<n>.` envelope this build does not know is a NEWER dashboard talking to
	// an OLDER CLI, not a corrupt paste. Saying "invalid" sends the user hunting
	// for a bad copy; the fix is an upgrade. (`agent connect` forces an update
	// check first, so reaching this means the upgrade itself did not happen.)
	if (/^t\d+\./.test(encoded)) {
		throw new InvalidArgumentError(
			"This Tarout handoff needs a newer CLI. Run `npm install -g @tarout/cli@latest`, then copy a fresh command from the Agent dashboard.",
		);
	}

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
	// The v1 blob must still carry every v1 field: these became optional on the
	// shared type for v2's sake, not because a v1 payload may omit them.
	const expected = payload.expected;
	if (
		payload.version !== 1 ||
		!AUTHORIZATION_PATTERN.test(payload.code) ||
		typeof payload.codeVerifier !== "string" ||
		!VERIFIER_PATTERN.test(payload.codeVerifier) ||
		typeof payload.apiUrl !== "string" ||
		!isTrustedHandoffUrl(payload.apiUrl) ||
		typeof payload.expiresAt !== "number" ||
		!Number.isFinite(payload.expiresAt) ||
		!expected ||
		!isIdentifier(expected.userId) ||
		!isIdentifier(expected.organizationId) ||
		!isIdentifier(expected.projectId)
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

/**
 * Whether a profile is the account this handoff names.
 *
 * A v2 handoff names no account, so there is nothing to contradict and this is
 * vacuously true. That is not a weakened check: the identity in a v1 handoff
 * was written by the same server that answers the exchange, over the same TLS
 * connection, so comparing them only ever caught a server-side mixup — never an
 * attacker. Callers must not read `true` here as "verified"; see how the reuse
 * loop guards on `expected` being present before trusting it.
 */
function profileMatches(
	profile: Pick<Profile, "userId" | "organizationId" | "projectId">,
	expected: AgentHandoffPayload["expected"],
): boolean {
	if (!expected) return true;
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
	};
}

function safeResult(
	profile: Profile,
	profileName: string,
	reusedExistingCredential: boolean,
	identityFile: ReturnType<typeof writeAgentIdentityFile>,
	scope: AgentConnectScope,
	credentialPath?: string,
): AgentConnectResult {
	return {
		reusedExistingCredential,
		profileName,
		scope,
		credentialPath,
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

/**
 * Exchange a dashboard handoff for a credential and store it.
 *
 * Defaults to **project scope**: the key lands in `<cwd>/.tarout/auth.json` and
 * the machine-wide profile is left untouched. That is the whole point of a
 * per-project handoff — running the dashboard's one-command setup for project B
 * must not re-point project A at a different account, which is exactly what a
 * single global profile did. `scope: "global"` restores the old machine-wide
 * behaviour, and a `cwd` that is not a project ($HOME, a filesystem root) falls
 * back to global rather than planting a credential that would apply everywhere.
 *
 * @param {string} encoded - The single-use dashboard handoff payload.
 * @param {string} cwd - The project directory to bind the credential to.
 * @param {object} [options] - `scope` selects the credential layer.
 * @param {Partial<AgentConnectDependencies>} [dependencyOverrides] - Test seams.
 */
export async function connectAgentFromHandoff(
	encoded: string,
	cwd: string,
	options: { scope?: AgentConnectScope } = {},
	dependencyOverrides: Partial<AgentConnectDependencies> = {},
): Promise<AgentConnectResult> {
	const dependencies = { ...defaultDependencies, ...dependencyOverrides };
	const payload = decodeAgentHandoff(encoded, dependencies.now());
	const config = dependencies.getConfig();
	let staleMatchingProfileName: string | undefined;

	// A credential in $HOME or / would apply to every directory on the machine —
	// the opposite of project binding — so refuse rather than quietly widening
	// the blast radius of a key the user believes is scoped to one project.
	//
	// This used to fall back to the global store and print why. But the fallback
	// silently inverts the guarantee this command exists to provide: the whole
	// point of `agent connect` is that connecting project B cannot re-point
	// project A, and a global write does exactly that. Someone who runs it in the
	// wrong terminal deserves an error they can act on, not a machine-wide
	// credential and a line of explanation they will scroll past. `--global` is
	// still there for the cases that genuinely want it.
	const requestedScope = options.scope ?? "project";
	if (requestedScope === "project") {
		const unsafe = unsafeCredentialDirectory(cwd);
		if (unsafe) {
			throw new InvalidArgumentError(
				`${unsafe}\n` +
					"  • Run this from the project directory you want to connect, or\n" +
					"  • pass --global to store it machine-wide on purpose.",
			);
		}
	}
	const scope: AgentConnectScope = requestedScope;

	/**
	 * Persist to the layer this run is bound to. Project scope deliberately
	 * never writes the global store: connecting here must not change which
	 * account other directories use.
	 */
	const persist = (profile: Profile, profileName: string): string | undefined => {
		if (scope === "project") {
			return dependencies.setProjectCredential(profile, cwd);
		}
		dependencies.setProfile(profileName, profile);
		dependencies.setCurrentProfile(profileName);
		return undefined;
	};

	// Reuse any matching saved profile, not only the currently selected one.
	//
	// Only a v1 handoff can take this path: reuse means deciding, *before*
	// exchanging, that a stored credential is already the account being asked
	// for, and that decision needs the account ids v2 deliberately dropped.
	// Without them a match is unprovable, so v2 exchanges its code instead of
	// guessing — the safe direction, and the code is single-use anyway.
	for (const [profileName, candidate] of payload.expected
		? Object.entries(config.profiles)
		: []) {
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

			const credentialPath = persist(verified, profileName);
			const identityFile = dependencies.writeIdentity(cwd, verified, {
				profileName,
				scope,
				credentialPath,
			});
			return safeResult(
				verified,
				profileName,
				true,
				identityFile,
				scope,
				credentialPath,
			);
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
	const credentialPath = persist(profile, profileName);
	const identityFile = dependencies.writeIdentity(cwd, profile, {
		profileName,
		scope,
		credentialPath,
	});
	return safeResult(
		profile,
		profileName,
		false,
		identityFile,
		scope,
		credentialPath,
	);
}
