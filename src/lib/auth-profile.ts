import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { normalizeApiUrl } from "./api-url.js";
import {
	getApiUrl,
	getCurrentProfile,
	getToken,
	type Profile,
} from "./config.js";
import { AuthError } from "./errors.js";
import { platformFetch } from "./password-gate.js";

type ApiClient = any;

export function createCredentialClient(
	apiUrl: string,
	token: string,
): ApiClient {
	const normalizedApiUrl = normalizeApiUrl(apiUrl);
	return createTRPCProxyClient({
		transformer: superjson,
		links: [
			httpBatchLink({
				url: `${normalizedApiUrl}/api/trpc`,
				headers: () => ({ "x-api-key": token }),
				fetch: platformFetch,
			}),
		],
	});
}

function pickUser(memberOrUser: any) {
	return memberOrUser?.user ?? memberOrUser;
}

async function queryOrNull<T>(query: () => Promise<T>): Promise<T | null> {
	try {
		return await query();
	} catch {
		return null;
	}
}

export async function resolveProfileFromCredential(params: {
	apiUrl: string;
	token: string;
	fallback?: Partial<Profile> | null;
}): Promise<Profile> {
	const apiUrl = normalizeApiUrl(params.apiUrl);
	const client = createCredentialClient(apiUrl, params.token);

	const member = await client.user.get.query();
	if (!member) {
		throw new Error(
			"The credential is valid, but it is not scoped to an organization.",
		);
	}

	const user = pickUser(member);
	const organizations = await client.organization.all.query();
	// Scope is org -> project -> resources. There is no environment layer:
	// the platform dropped the `environment` table in migration
	// 20260722150000_environment_removal_phase_b, so there is nothing to fetch.
	const project = (await queryOrNull(() =>
		client.project.getActive.query(),
	)) as any;

	const organizationId =
		member.organizationId ||
		params.fallback?.organizationId ||
		organizations?.[0]?.id;
	const organization =
		organizations?.find((org: any) => org.id === organizationId) ||
		organizations?.[0];

	if (!organizationId || !organization) {
		throw new Error("The credential is valid, but no organization was found.");
	}

	return {
		token: params.token,
		apiUrl,
		userId: user?.id || member.userId || params.fallback?.userId || "",
		userEmail:
			user?.email || member.email || params.fallback?.userEmail || "unknown",
		userName: user?.name || member.name || params.fallback?.userName,
		organizationId,
		organizationName:
			organization.name || params.fallback?.organizationName || "Unknown",
		projectId: project?.projectId || params.fallback?.projectId,
		projectName: project?.name || params.fallback?.projectName,
		projectSlug: project?.slug || params.fallback?.projectSlug,
	};
}

export function isCredentialError(error: unknown): boolean {
	const err = error as any;
	const code = err?.data?.code || err?.shape?.data?.code || err?.code;
	const message = error instanceof Error ? error.message : String(error);
	return (
		code === "UNAUTHORIZED" ||
		code === "FORBIDDEN" ||
		/unauthorized|forbidden|invalid api key|invalid token|not authenticated|not logged in/i.test(
			message,
		)
	);
}

let envProfile: Promise<Profile> | null = null;

/**
 * The profile a command acts as. A stored profile (project or machine-wide)
 * wins. A bare `TAROUT_TOKEN`, the documented CI path, has no stored profile,
 * so resolve one from the API once per process, the same way `up` and
 * `deploy` do. Requiring a stored profile made `apps create`, `db create`,
 * `storage create` and `link` report "Not logged in" to a valid CI token.
 */
export async function requireProfile(): Promise<Profile> {
	const stored = getCurrentProfile();
	if (stored) return stored;
	const token = getToken();
	if (!token) throw new AuthError();
	envProfile ??= resolveProfileFromCredential({ apiUrl: getApiUrl(), token });
	return envProfile;
}

/** Test seam: forget the profile resolved from `TAROUT_TOKEN`. */
export function resetEnvProfileForTests(): void {
	envProfile = null;
}
