/**
 * @fileoverview Predicates deciding which commands the root preAction hook
 * gates. Kept out of `src/index.ts` because that module parses argv at import
 * time, so a test importing it would run the CLI against the test runner's own
 * arguments.
 * @module lib/command-gates
 */

import type { Command } from "commander";

/**
 * Commands that must run WITHOUT first forcing a sign-in. Everything else gets
 * the auto-auth recovery in the preAction hook so a logged-out invocation opens
 * the browser (or offers the arrow menu) instead of dead-ending on an AuthError.
 *
 * - `login`/`register`/`token`/`logout`: the auth flow itself.
 * - `up`/`deploy`/`init`: self-manage auth (browser auto-open + `--token`) via
 *   `ensureAuthenticatedForDeploy`; pre-authing here would double-handle it.
 * - `upgrade`: updates the local CLI package and never calls the Tarout API.
 * - the whole `agent` namespace: project scaffolding that works signed-out.
 * - `whoami`: it is the *question*, not a command that needs an answer. The
 *   agent docs make it the first command of every session precisely because it
 *   distinguishes "not signed in" from every other failure; auto-authenticating
 *   here made asking the question change the answer — a logged-out probe opened
 *   a browser and blocked, and an agent holding a pasted API key got dragged
 *   into a browser sign-in before it could store the key it already had. It now
 *   reports `AUTH_ERROR` (exit 3) instead, like `gh auth status` or
 *   `vercel whoami`.
 */
export const AUTH_EXEMPT_LEAF = new Set([
	"login",
	"register",
	"token",
	"logout",
	"up",
	"deploy",
	"init",
	"whoami",
	"upgrade",
]);

/**
 * Whether the about-to-run command should be gated behind authentication.
 * Walks the command ancestry so nested commands (and the `agent` namespace at
 * any depth) are classified correctly, and never gates the bare root program.
 *
 * Only the LEAF is checked against the exempt set (unlike
 * `commandRequiresProject`): `agent connect` is exempt through the namespace
 * check, while a hypothetical `db login` should still authenticate.
 */
export function commandRequiresAuth(
	actionCommand: Command | undefined,
	root: Command,
): boolean {
	if (!actionCommand || actionCommand === root) return false;
	const names: string[] = [];
	for (
		let cur: Command | null | undefined = actionCommand;
		cur && cur !== root;
		cur = cur.parent
	) {
		names.push(cur.name());
	}
	if (names.includes("agent")) return false;
	const leaf = names[0];
	return Boolean(leaf) && !AUTH_EXEMPT_LEAF.has(leaf);
}

/**
 * Commands that run without an active project. Everything else resolves one in
 * the preAction hook, so a resource command never acts on an unexpected
 * project. These are organization-level surfaces, or they manage the selection
 * itself and would deadlock if they needed a project to choose one.
 * `upgrade` is local package maintenance and needs neither account nor project.
 */
export const PROJECT_EXEMPT_LEAF = new Set([
	"login",
	"register",
	"token",
	"logout",
	"whoami",
	"upgrade",
	"projects",
	"orgs",
	"billing",
]);

/**
 * Whether the about-to-run command needs an active project.
 *
 * Unlike `commandRequiresAuth`, this checks *every* ancestor name against the
 * exempt set, not just the leaf — `projects use` and `billing upgrade` must be
 * exempt through their parent. A missing entry fails safe: the server answers
 * "No project selected" instead of acting on the wrong project.
 */
export function commandRequiresProject(
	actionCommand: Command | undefined,
	root: Command,
): boolean {
	if (!actionCommand || actionCommand === root) return false;
	const names: string[] = [];
	for (
		let cur: Command | null | undefined = actionCommand;
		cur && cur !== root;
		cur = cur.parent
	) {
		names.push(cur.name());
	}
	if (names.includes("agent")) return false;
	for (const name of names) {
		if (PROJECT_EXEMPT_LEAF.has(name)) return false;
	}
	return names.length > 0;
}
