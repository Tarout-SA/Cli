import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { commandRequiresProject } from "../src/lib/command-gates.js";

function tree(): { root: Command; leaf: (path: string[]) => Command } {
	const root = new Command();
	const made = new Map<string, Command>();
	const leaf = (path: string[]) => {
		let parent: Command = root;
		let key = "";
		for (const name of path) {
			key = key ? `${key} ${name}` : name;
			let next = made.get(key);
			if (!next) {
				next = parent.command(name);
				made.set(key, next);
			}
			parent = next;
		}
		return parent;
	};
	return { root, leaf };
}

describe("commandRequiresProject", () => {
	it("gates resource commands", () => {
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["db", "list"]), root)).toBe(true);
		expect(commandRequiresProject(leaf(["storage", "list"]), root)).toBe(true);
		expect(commandRequiresProject(leaf(["apps", "list"]), root)).toBe(true);
	});

	it("gates the deploy commands, which act on a project", () => {
		// These are exempt from the AUTH gate because they self-authenticate, but
		// they still deploy INTO a project, so they must not be exempt here.
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["deploy"]), root)).toBe(true);
		expect(commandRequiresProject(leaf(["up"]), root)).toBe(true);
	});

	it("exempts project, org, billing, and auth commands", () => {
		const { root, leaf } = tree();
		for (const path of [
			["projects", "list"],
			["orgs", "list"],
			["billing", "status"],
			["login"],
			["logout"],
			["whoami"],
		]) {
			expect(commandRequiresProject(leaf(path), root)).toBe(false);
		}
	});

	it("exempts a nested command whose parent is exempt", () => {
		// The leaf alone is not enough: `projects use` and `billing upgrade` must
		// both be exempt, so every ancestor name is checked.
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["projects", "use"]), root)).toBe(false);
		expect(commandRequiresProject(leaf(["billing", "upgrade"]), root)).toBe(
			false,
		);
	});

	it("exempts the agent namespace and the bare root", () => {
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["agent", "init"]), root)).toBe(false);
		expect(commandRequiresProject(root, root)).toBe(false);
		expect(commandRequiresProject(undefined, root)).toBe(false);
	});
});
