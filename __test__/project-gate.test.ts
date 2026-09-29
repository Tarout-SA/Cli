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

	it("exempts project, org, billing, approvals, and auth commands", () => {
		const { root, leaf } = tree();
		for (const path of [
			["projects", "list"],
			["orgs", "list"],
			["billing", "status"],
			// Organization-level: an agent waiting on a parked action must not
			// hit a project picker first.
			["approvals", "wait"],
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
		expect(commandRequiresAuth(leaf(["run"]), root)).toBe(true);
	});

	it("gates nested commands that only share a name with an exempt one", () => {
		// `billing upgrade` is a checkout, not the CLI self-update, and
		// `domains register` buys a domain, not an account: they must sign in
		// first instead of dead-ending on "Not logged in".
		const { root, leaf } = tree();
		for (const path of [
			["billing", "upgrade"],
			["storage", "upgrade"],
			["servers", "upgrade"],
			["domains", "register"],
			["keys", "deploy"],
			["template", "deploy"],
		]) {
			expect(commandRequiresAuth(leaf(path), root)).toBe(true);
		}
	});
});

describe("agent manifest", () => {
	it("takes both gates although the rest of the agent namespace is exempt", () => {
		// It reads the account (project.manifest), so a logged-out call must sign
		// in first and `--project` must resolve before the action runs.
		const { root, leaf } = tree();
		expect(commandRequiresAuth(leaf(["agent", "manifest"]), root)).toBe(true);
		expect(commandRequiresProject(leaf(["agent", "manifest"]), root)).toBe(
			true,
		);
		for (const name of ["init", "setup", "connect"]) {
			expect(commandRequiresAuth(leaf(["agent", name]), root)).toBe(false);
			expect(commandRequiresProject(leaf(["agent", name]), root)).toBe(false);
		}
	});

	it("gates agent sessions and events on sign-in only, not on a project", () => {
		// Both read organization-wide data (user.listApiKeys and
		// dashboard.getAgentActivity), so a project picker must not stand in the
		// way. The carve-out is scoped to the agent namespace: another command
		// called `events` still needs a project.
		const { root, leaf } = tree();
		for (const name of ["sessions", "events"]) {
			expect(commandRequiresAuth(leaf(["agent", name]), root)).toBe(true);
			expect(commandRequiresProject(leaf(["agent", name]), root)).toBe(false);
		}
		expect(commandRequiresProject(leaf(["apps", "events"]), root)).toBe(true);
		expect(commandRequiresProject(leaf(["events"]), root)).toBe(true);
	});

	it("gates `tarout run`, which reads the linked app's environment", () => {
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["run"]), root)).toBe(true);
	});
});

describe("template", () => {
	it("reads the catalog without a project but deploys into one", () => {
		// The catalog is the same for every project, so a picker must not stand
		// in front of `list`/`info`. `deploy` creates the app in the active
		// project and keeps the gate.
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["template", "list"]), root)).toBe(
			false,
		);
		expect(commandRequiresProject(leaf(["template", "info"]), root)).toBe(
			false,
		);
		expect(commandRequiresProject(leaf(["template", "deploy"]), root)).toBe(
			true,
		);
	});

	it("takes the sign-in gate on every subcommand", () => {
		// `template deploy` shares its leaf with the self-authing top-level
		// `deploy`, which the leaf-only exempt check would otherwise match: a
		// logged-out run then dead-ended on "Not logged in" with no browser.
		const { root, leaf } = tree();
		for (const name of ["list", "info", "deploy"]) {
			expect(commandRequiresAuth(leaf(["template", name]), root)).toBe(true);
		}
		expect(commandRequiresAuth(leaf(["deploy"]), root)).toBe(false);
	});

	it("scopes the carve-out to the top-level template namespace", () => {
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["apps", "info"]), root)).toBe(true);
		expect(commandRequiresProject(leaf(["list"]), root)).toBe(true);
		expect(
			commandRequiresProject(leaf(["firewall", "template", "list"]), root),
		).toBe(true);
	});
});
