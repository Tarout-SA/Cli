/**
 * Shared guard for every "archive this directory and upload it" flow.
 *
 * `tarout up`, `tarout deploy` and the MCP `deploy` tool all zip a WHOLE
 * directory and ship it to the platform, and the archive excludes only build
 * artifacts + .env. `tarout up` also writes `Bash(tarout:*)` into the agent
 * allowlist, so a prompt-injected agent can run `tarout up ~` with no
 * permission prompt and exfiltrate ~/.ssh, ~/.aws, ~/.npmrc.
 *
 * This module is the ONE implementation of that check: it used to live inside
 * the MCP deploy tool only, which is exactly how the CLI entry points ended up
 * unprotected. Kept dependency-free (node:os / node:path) so importing it never
 * pulls CLI output helpers into the MCP import graph; callers decide whether to
 * throw or return an error envelope.
 */

import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";

/**
 * Directory names that hold credentials/secrets and are never a deployable app.
 */
const SENSITIVE_DIR_NAMES = new Set([
	".ssh",
	".aws",
	".gnupg",
	".gcloud",
	".kube",
	".docker",
	".azure",
	".config",
]);

/**
 * Returns an error message if `dir` is not a safe directory to archive+upload
 * (filesystem root, the user's home dir, or anything living under a known
 * secret/credential directory), or undefined when the path is acceptable.
 * Normal project directories pass unchanged.
 */
export function unsafeDeployDirectory(dir: string): string | undefined {
	const abs = resolve(dir);
	const home = resolve(homedir());
	const { root } = parse(abs);
	if (abs === root || abs === home) {
		return `Refusing to deploy '${abs}': archiving a filesystem root or home directory would upload credentials and unrelated files. Point deploy at a specific project directory.`;
	}
	const hit = abs.split(sep).find((s) => SENSITIVE_DIR_NAMES.has(s));
	if (hit) {
		return `Refusing to deploy '${abs}': it is inside a sensitive directory ('${hit}'). Point deploy at a project directory outside credential/config folders.`;
	}
	return undefined;
}
