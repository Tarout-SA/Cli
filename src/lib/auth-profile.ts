import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { Profile } from "./config.js";
import { normalizeApiUrl } from "./api-url.js";
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

function pickEnvironmentName(environment: any, fallback?: string) {
	return (
		environment?.displayName ||
		environment?.name ||
		environment?.slug ||
		fallback ||
		"production"
	);
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
	const [activeProject, activeEnvironment] = await Promise.all([
		queryOrNull(() => client.project.getActive.query()),
		queryOrNull(() => client.environment.getActive.query()),
	]);
	const project = activeProject as any;
	const environment = activeEnvironment as any;

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
		environmentId:
			environment?.environmentId || params.fallback?.environmentId || "",
		environmentName: pickEnvironmentName(
			environment,
			params.fallback?.environmentName,
		),
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
