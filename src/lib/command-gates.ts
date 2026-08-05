/**
 * @fileoverview Predicates deciding which commands the root preAction hook
 * gates. Kept out of `src/index.ts` because that module parses argv at import
 * time, so a test importing it would run the CLI against the test runner's own
 * arguments.
 * @module lib/command-gates
 */

import type { Command } from "commander";

/**
 * Commands that run without an active project. Everything else resolves one in
 * the preAction hook, so a resource command never acts on an unexpected
 * project. These are organization-level surfaces, or they manage the selection
 * itself and would deadlock if they needed a project to choose one.
 */
export const PROJECT_EXEMPT_LEAF = new Set([
	"login",
	"register",
	"token",
	"logout",
	"whoami",
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
