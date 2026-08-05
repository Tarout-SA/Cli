/**
 * @fileoverview API client module for communicating with the Tarout platform.
 * Uses tRPC with superjson transformer for type-safe HTTP requests.
 * @module lib/api
 */

import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { normalizeApiUrl } from "./api-url.js";
import {
	getApiUrl,
	getCurrentProfile,
	getToken,
	isLoggedIn,
} from "./config.js";
import { AuthError } from "./errors.js";
import { platformFetch } from "./password-gate.js";

// The API client uses 'any' type since we can't easily import types
// from the parent platform package. This is fine for a CLI that
// communicates via HTTP - errors will be caught at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TaroutApiClient = any;

/** Singleton API client instance */
let client: TaroutApiClient | null = null;

/**
 * Active project for this invocation, set from `--project` or the interactive
 * picker before any project-scoped request. Login is account-scoped, so the
 * server learns the project only from the `x-tarout-project` header.
 */
let requestProjectId: string | null = null;

export function setRequestProjectId(projectId: string | null): void {
	requestProjectId = projectId;
}

/**
 * The project this process acts on: the explicit override first, else whichever
 * profile layer resolved the credential (a directory-local `.tarout/auth.json`
 * keeps its own active project).
 */
export function getRequestProjectId(): string | null {
	return requestProjectId ?? getCurrentProfile()?.projectId ?? null;
}

export function buildRequestHeaders(): Record<string, string> {
	const headers: Record<string, string> = {};
	const token = getToken();
	if (token) headers["x-api-key"] = token;
	const projectId = getRequestProjectId();
	if (projectId) headers["x-tarout-project"] = projectId;
	return headers;
}

/**
 * Creates a new tRPC API client configured with the user's authentication token.
 * @returns {TaroutApiClient} A configured tRPC proxy client
 * @throws {AuthError} If the user is not logged in
 * @example
 * const client = createApiClient();
 * const apps = await client.application.allByOrganization.query();
 */
export function createApiClient(): TaroutApiClient {
	if (!isLoggedIn()) {
		throw new AuthError();
	}

	const apiUrl = normalizeApiUrl(getApiUrl());

	return createTRPCProxyClient({
		transformer: superjson,
		links: [
			httpBatchLink({
				url: `${apiUrl}/api/trpc`,
				// Resolved per request, not captured at client construction: the
				// picker and `--project` run after the singleton already exists.
				headers: () => buildRequestHeaders(),
				fetch: platformFetch,
			}),
		],
	});
}

/**
 * Gets the singleton API client, creating it if necessary.
 * Reuses the same client instance across multiple calls for efficiency.
 * @returns {TaroutApiClient} The tRPC API client
 * @throws {AuthError} If the user is not logged in
 * @example
 * const client = getApiClient();
 * const user = await client.user.get.query();
 */
export function getApiClient(): TaroutApiClient {
	if (!client) {
		client = createApiClient();
	}
	return client;
}

/**
 * Resets the API client singleton, forcing a new client to be created on next use.
 * Useful after logout or when switching profiles.
 * @example
 * resetApiClient();
 */
export function resetApiClient(): void {
	client = null;
}
