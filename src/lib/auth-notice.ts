/**
 * @fileoverview One-line notice when a project-scoped credential redirects a
 * command to a different account than the machine-wide login.
 *
 * `.tarout/auth.json` lives inside the repository, so it arrives with a clone.
 * Silently preferring it would mean `tarout up` in a freshly cloned project
 * could upload the working directory into a stranger's organization with no
 * visible sign. Announcing the switch is cheap and turns a silent redirect into
 * an obvious one; it is deliberately NOT a prompt, because the overwhelmingly
 * common case is the user's own project and blocking there would be noise.
 *
 * Emitted on stderr (structured under `--json`) so it never pollutes the stdout
 * envelope that agents parse.
 *
 * @module lib/auth-notice
 */

import { getGlobalProfile } from "./config.js";
import { colors, isJsonMode, isQuietMode, warn } from "./output.js";
import { describeProjectCredentialSwitch } from "./project-auth.js";
import { stringifyJson } from "../utils/json.js";

let announced = false;

/**
 * Announce, at most once per process, that a project credential is in effect for
 * a different account than the machine-wide login. No-ops when the accounts
 * match, when there is no project credential, or when there is no global login
 * to contrast it with.
 */
export function announceProjectCredential(): void {
	if (announced) return;
	announced = true;

	const globalProfile = getGlobalProfile();
	const change = describeProjectCredentialSwitch(globalProfile?.userEmail);
	if (!change) return;

	if (isJsonMode()) {
		if (isQuietMode()) return;
		console.error(
			stringifyJson({
				type: "event",
				event: "project_credential_active",
				userEmail: change.projectEmail,
				globalUserEmail: change.globalEmail,
				credentialPath: change.path,
			}),
		);
		return;
	}

	warn(
		`Using this project's credential (${change.projectEmail}), not your machine-wide login (${change.globalEmail}).`,
	);
	console.error(
		colors.dim(`  ${change.path} — pass --global-auth to use the machine-wide login.`),
	);
}

/** Test seam: forget that the notice was already emitted. */
export function resetAuthNotice(): void {
	announced = false;
}
