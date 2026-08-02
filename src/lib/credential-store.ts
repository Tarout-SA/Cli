/**
 * @fileoverview One place that answers "where does a freshly-obtained
 * credential get written?".
 *
 * Before this module, three code paths answered it independently: `tarout
 * login` always wrote machine-wide, `tarout login --token --local` wrote
 * project-scoped, and the deploy path wrote machine-wide *even when a project
 * credential was the one in effect* — silently copying a project's key into the
 * machine-wide store and re-pointing every other directory at it.
 *
 * Everything now funnels through {@link persistProfile}, so the placement rules
 * in {@link resolveCredentialPlacement} apply uniformly.
 *
 * Layered above `config` and `project-auth` (config imports project-auth, and
 * neither imports this) so there is no cycle.
 *
 * @module lib/credential-store
 */

import {
	type Profile,
	setCurrentProfile,
	setProfile,
	updateProfile,
} from "./config.js";
import {
	type CredentialPlacement,
	getProjectCredential,
	setProjectCredential,
} from "./project-auth.js";

/**
 * Write a verified profile to its resolved destination.
 *
 * @param {Profile} profile - The verified profile to store.
 * @param {CredentialPlacement} placement - Resolved destination.
 * @param {string} source - Provenance recorded on a project credential.
 * @returns {string | undefined} The path written, when scope is `project`.
 */
export function persistProfile(
	profile: Profile,
	placement: CredentialPlacement,
	source: string,
): string | undefined {
	if (placement.scope === "project" && placement.projectDir) {
		return setProjectCredential({ ...profile, source }, placement.projectDir);
	}
	setProfile("default", profile);
	setCurrentProfile("default");
	return undefined;
}

/**
 * Refresh the credential already in effect with newly-resolved metadata
 * (organization and project names, ids) without changing which layer owns it.
 *
 * This is the fix for the deploy-path leak: `tarout up` / `deploy` / `init`
 * re-resolve the active token on every run, and the old code persisted the
 * result with `setProfile("default", …)`. Inside a project-scoped directory the
 * token being refreshed is the *project's*, so that call copied it into the
 * machine-wide store and made it current — overwriting the user's global login
 * and re-pointing every unrelated directory at this project's account.
 *
 * @param {Profile} profile - Freshly resolved profile for the active token.
 * @returns {"project" | "global"} Which layer was refreshed.
 */
export function refreshActiveProfile(profile: Profile): "project" | "global" {
	const scope = getProjectCredential() ? "project" : "global";
	updateProfile(profile);
	return scope;
}
