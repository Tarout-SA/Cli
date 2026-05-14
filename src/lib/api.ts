/**
 * @fileoverview API client module for communicating with the Tarout platform.
 * Uses tRPC with superjson transformer for type-safe HTTP requests.
 * @module lib/api
 */

import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { getApiUrl, getToken, isLoggedIn } from "./config.js";
import { AuthError } from "./errors.js";

// The API client uses 'any' type since we can't easily import types
// from the parent platform package. This is fine for a CLI that
// communicates via HTTP - errors will be caught at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TaroutApiClient = any;

/** Singleton API client instance */
let client: TaroutApiClient | null = null;

/**
 * Creates a new tRPC API client configured with the user's authentication token.
 * @returns {TaroutApiClient} A configured tRPC proxy client
 * @throws {AuthError} If the user is not logged in
 * @example
 * const client = createApiClient();
 * const apps = await client.application.all.query();
 */
export function createApiClient(): TaroutApiClient {
	if (!isLoggedIn()) {
		throw new AuthError();
	}

	const token = getToken();
	const apiUrl = getApiUrl();

	return createTRPCProxyClient({
		transformer: superjson,
		links: [
			httpBatchLink({
				url: `${apiUrl}/api/trpc`,
				headers: () => (token ? { "x-api-key": token } : {}),
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
