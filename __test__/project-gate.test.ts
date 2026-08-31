import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
	commandRequiresAuth,
	commandRequiresProject,
} from "../src/lib/command-gates.js";

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
			["upgrade"],
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

describe("commandRequiresAuth", () => {
	it("never turns `whoami` into a sign-in", () => {
		// The agent guides make `tarout whoami --json` the first command of every
		// session, so it has to REPORT the auth state, not change it. While it was
		// gated, a logged-out probe opened a browser and blocked there, and an
		// agent holding a pasted API key was pulled into a browser sign-in before
		// it could store the key it already had.
		const { root, leaf } = tree();
		expect(commandRequiresAuth(leaf(["whoami"]), root)).toBe(false);
	});

	it("exempts the auth flow, the self-authing deploys, and agent scaffolding", () => {
		const { root, leaf } = tree();
		for (const path of [
			["login"],
			["register"],
			["token"],
			["logout"],
			["up"],
			["deploy"],
			["init"],
			["upgrade"],
			["agent", "connect"],
			["agent", "init"],
		]) {
			expect(commandRequiresAuth(leaf(path), root)).toBe(false);
		}
		expect(commandRequiresAuth(root, root)).toBe(false);
		expect(commandRequiresAuth(undefined, root)).toBe(false);
	});

	it("gates every command that actually calls the API", () => {
		const { root, leaf } = tree();
		expect(commandRequiresAuth(leaf(["apps", "list"]), root)).toBe(true);
		expect(commandRequiresAuth(leaf(["db", "list"]), root)).toBe(true);
		expect(commandRequiresAuth(leaf(["call"]), root)).toBe(true);
	});
});
