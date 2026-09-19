import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeProjectCredentialSwitch,
	ensureProjectGitignore,
	findProjectAuthFile,
	getProjectCredential,
	isProjectTokenCommitted,
	isWorldOrGroupReadable,
	probeCredentialInGit,
	setProjectTokenCommitted,
	parseProjectCredential,
	findProjectDir,
	removeProjectCredential,
	resetProjectAuthCache,
	resolveCredentialPlacement,
	setGlobalAuthOnly,
	setProjectCredential,
	unsafeCredentialDirectory,
} from "../src/lib/project-auth";

/**
 * Project-scoped credentials (`.tarout/auth.json`).
 *
 * The file sits INSIDE the repository, which is what makes it useful (it travels
 * with the checkout, an agent handed a key for one project cannot re-point
 * another) and also what makes it dangerous (it arrives with a clone). These
 * tests pin both halves: the precedence that makes it work, and the fail-closed
 * validation that keeps a planted file from redirecting credentials.
 */

const CREDENTIAL = {
	token: "tk_project_secret",
	apiUrl: "https://tarout.sa",
	userId: "user-1",
	userEmail: "agent@example.com",
	organizationId: "org-1",
	organizationName: "Acme",
	projectId: "project-1",
	projectName: "Coco",
	projectSlug: "coco",
};

let root: string;
const cleanup: string[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tarout-project-auth-"));
	cleanup.push(root);
	setGlobalAuthOnly(false);
	resetProjectAuthCache();
});

afterEach(() => {
	setGlobalAuthOnly(false);
	resetProjectAuthCache();
	for (const path of cleanup.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("project credential storage", () => {
	it("writes the key 0600 inside a 0700 directory with a .gitignore", () => {
		const path = setProjectCredential(CREDENTIAL, root);

		expect(path).toBe(join(root, ".tarout", "auth.json"));
		// The key is a live credential in the working tree: it must not be
		// readable by other users on a shared machine.
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, ".tarout")).mode & 0o777).toBe(0o700);
		// Ignore-everything-but-itself, so the protection survives a fresh clone.
		const gitignore = join(root, ".tarout", ".gitignore");
		expect(existsSync(gitignore)).toBe(true);
		expect(isWorldOrGroupReadable(path)).toBe(false);
	});

	it("round-trips through the resolver", () => {
		setProjectCredential(CREDENTIAL, root);

		const resolved = getProjectCredential(root);
		expect(resolved?.credential.token).toBe(CREDENTIAL.token);
		expect(resolved?.credential.userEmail).toBe("agent@example.com");
		expect(resolved?.projectDir).toBe(root);
		expect(resolved?.credential.savedAt).toBeTruthy();
	});

	it("removes only auth.json, leaving the rest of .tarout intact", () => {
		setProjectCredential(CREDENTIAL, root);
		const link = join(root, ".tarout", "project.json");
		writeFileSync(link, JSON.stringify({ applicationId: "app-1" }));

		const removed = removeProjectCredential(root);

		expect(removed).toBe(join(root, ".tarout", "auth.json"));
		expect(existsSync(join(root, ".tarout", "auth.json"))).toBe(false);
		expect(existsSync(link)).toBe(true);
		expect(getProjectCredential(root)).toBeNull();
	});

	// A credential here would apply to every directory on the machine — the exact
	// opposite of project binding.
	it("refuses to write to $HOME or a filesystem root", () => {
		expect(unsafeCredentialDirectory(homedir())).toMatch(/not a project/i);
		expect(unsafeCredentialDirectory(parse(root).root)).toMatch(/not a project/i);
		expect(unsafeCredentialDirectory(root)).toBeUndefined();
		expect(() => setProjectCredential(CREDENTIAL, homedir())).toThrow(
			/not a project/i,
		);
	});
});

describe("project credential discovery", () => {
	it("finds the credential from a nested working directory", () => {
		setProjectCredential(CREDENTIAL, root);
		const nested = join(root, "packages", "api", "src");
		mkdirSync(nested, { recursive: true });

		expect(findProjectAuthFile(nested)).toBe(join(root, ".tarout", "auth.json"));
		expect(getProjectCredential(nested)?.projectDir).toBe(root);
	});

	it("returns nothing when no project credential exists above the directory", () => {
		const nested = join(root, "app");
		mkdirSync(nested, { recursive: true });

		expect(findProjectAuthFile(nested)).toBeNull();
		expect(getProjectCredential(nested)).toBeNull();
	});

	it("is suppressed by --global-auth", () => {
		setProjectCredential(CREDENTIAL, root);
		expect(getProjectCredential(root)).not.toBeNull();

		setGlobalAuthOnly(true);
		expect(getProjectCredential(root)).toBeNull();
	});
});

describe("project credential validation", () => {
	it("accepts a well-formed credential and normalizes its apiUrl", () => {
		const parsed = parseProjectCredential({
			...CREDENTIAL,
			apiUrl: "https://tarout.sa/",
		});
		expect(parsed?.apiUrl).toBe("https://tarout.sa");
	});

	// A planted file must fail closed rather than point the CLI's credentials at
	// an attacker-controlled host.
	it("rejects a credential aimed at an untrusted host", () => {
		expect(
			parseProjectCredential({ ...CREDENTIAL, apiUrl: "https://evil.example" }),
		).toBeNull();
		expect(
			parseProjectCredential({ ...CREDENTIAL, apiUrl: "http://tarout.sa" }),
		).toBeNull();
	});

	it("rejects documents with no usable token", () => {
		expect(parseProjectCredential({ ...CREDENTIAL, token: "" })).toBeNull();
		expect(parseProjectCredential({ apiUrl: "https://tarout.sa" })).toBeNull();
		expect(parseProjectCredential(null)).toBeNull();
		expect(parseProjectCredential([CREDENTIAL])).toBeNull();
	});

	it("ignores an unreadable or corrupt file instead of breaking every command", () => {
		mkdirSync(join(root, ".tarout"), { recursive: true });
		writeFileSync(join(root, ".tarout", "auth.json"), "{ not json");

		expect(getProjectCredential(root)).toBeNull();
	});

	it("ignores a file pointed at an untrusted host on disk", () => {
		mkdirSync(join(root, ".tarout"), { recursive: true });
		writeFileSync(
			join(root, ".tarout", "auth.json"),
			JSON.stringify({ ...CREDENTIAL, apiUrl: "https://evil.example" }),
		);

		expect(getProjectCredential(root)).toBeNull();
	});
});

describe("account-switch notice", () => {
	it("reports the switch when the project credential names another account", () => {
		setProjectCredential(CREDENTIAL, root);

		const change = describeProjectCredentialSwitch("owner@example.com", root);
		expect(change?.projectEmail).toBe("agent@example.com");
		expect(change?.globalEmail).toBe("owner@example.com");
	});

	it("stays silent when the accounts match or there is nothing to contrast", () => {
		setProjectCredential(CREDENTIAL, root);

		expect(
			describeProjectCredentialSwitch("agent@example.com", root),
		).toBeUndefined();
		expect(describeProjectCredentialSwitch(undefined, root)).toBeUndefined();
	});
});

/**
 * Where a freshly-obtained credential lands. `auto` is what every login path
 * now passes, so these cases are the shipped default behaviour of
 * `tarout login`, `tarout token`, and `deploy --token`.
 */
describe("credential placement", () => {
	it("prefers the project when a marker file is present", () => {
		writeFileSync(join(root, "package.json"), "{}\n");

		const placement = resolveCredentialPlacement("auto", root);

		expect(placement.scope).toBe("project");
		expect(placement.projectDir).toBe(root);
		expect(placement.fallbackReason).toBeUndefined();
	});

	it("resolves from a subdirectory up to the project root", () => {
		writeFileSync(join(root, "go.mod"), "module x\n");
		const nested = join(root, "src", "deep");
		mkdirSync(nested, { recursive: true });

		expect(resolveCredentialPlacement("auto", nested).projectDir).toBe(root);
	});

	// Re-authenticating from anywhere inside a linked project must update that
	// project's credential, not scatter a second one further down the tree.
	it("an existing .tarout wins over a deeper marker", () => {
		setProjectCredential(CREDENTIAL, root);
		const nested = join(root, "packages", "api");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "package.json"), "{}\n");

		expect(resolveCredentialPlacement("auto", nested).projectDir).toBe(root);
	});

	// Running `tarout login` in a scratch shell must not litter the filesystem
	// with a .tarout folder that then shadows nothing useful.
	it("falls back to machine-wide outside a project, with a reason", () => {
		const bare = join(root, "not-a-project");
		mkdirSync(bare);

		const placement = resolveCredentialPlacement("auto", bare);

		expect(placement.scope).toBe("global");
		expect(placement.projectDir).toBeUndefined();
		expect(placement.fallbackReason).toMatch(/does not look like a project/);
	});

	it("never treats $HOME or the filesystem root as a project", () => {
		const home = homedir();
		expect(resolveCredentialPlacement("auto", home).scope).toBe("global");
		expect(resolveCredentialPlacement("auto", parse(home).root).scope).toBe(
			"global",
		);
	});

	it("honours the explicit overrides", () => {
		writeFileSync(join(root, "package.json"), "{}\n");

		expect(resolveCredentialPlacement("global", root).scope).toBe("global");
		expect(resolveCredentialPlacement("project", root)).toEqual({
			scope: "project",
			projectDir: root,
		});
	});

	it("findProjectDir returns null when nothing marks a project", () => {
		const bare = join(root, "empty");
		mkdirSync(bare);
		expect(findProjectDir(bare)).toBeNull();
	});
});

/**
 * `.tarout/.gitignore` is the only file of `.tarout/` that reaches a fresh
 * clone, so it has to (a) keep the credential out of git by default, (b) tell
 * the person who cloned the repo how to sign in, and (c) let the owner opt the
 * credential in to git on purpose.
 */
describe(".tarout/.gitignore", () => {
	const gitignoreOf = (dir: string) =>
		readFileSync(join(dir, ".tarout", ".gitignore"), "utf-8");

	/** Ask real git whether a path under `dir` is ignored. */
	function gitIgnores(dir: string, path: string): boolean {
		return (
			spawnSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: dir })
				.status === 0
		);
	}

	function initRepo(dir: string): void {
		const result = spawnSync("git", ["init", "-q"], { cwd: dir });
		if (result.status !== 0) throw new Error("git init failed");
	}

	it("tells a fresh clone how to sign in, and keeps config.json committed", () => {
		setProjectCredential(CREDENTIAL, root);

		const content = gitignoreOf(root);
		expect(content).toContain("tarout login");
		expect(content).toContain("tarout deploy");
		expect(content).toContain("TAROUT_TOKEN");
		expect(content).toContain("tarout login --commit-token");
		expect(content).toMatch(/^\*$/m);
		expect(content).toMatch(/^!\.gitignore$/m);
		expect(content).toMatch(/^!config\.json$/m);
		expect(isProjectTokenCommitted(root)).toBe(false);
	});

	it("really keeps auth.json and project.json out of git by default", () => {
		initRepo(root);
		setProjectCredential(CREDENTIAL, root);

		expect(gitIgnores(root, ".tarout/auth.json")).toBe(true);
		expect(gitIgnores(root, ".tarout/project.json")).toBe(true);
		expect(gitIgnores(root, ".tarout/config.json")).toBe(false);
		expect(gitIgnores(root, ".tarout/.gitignore")).toBe(false);
		expect(probeCredentialInGit(root)).toEqual({ ignored: true, tracked: false });
	});

	it("--commit-token un-ignores only auth.json, and undoing it restores the file", () => {
		initRepo(root);
		setProjectCredential(CREDENTIAL, root);
		const original = gitignoreOf(root);

		expect(setProjectTokenCommitted(root, true)).toBe(true);
		expect(isProjectTokenCommitted(root)).toBe(true);
		expect(gitIgnores(root, ".tarout/auth.json")).toBe(false);
		expect(gitIgnores(root, ".tarout/project.json")).toBe(true);
		// Idempotent: a second opt-in does not stack rules.
		expect(setProjectTokenCommitted(root, true)).toBe(false);
		expect(gitignoreOf(root).match(/^!auth\.json$/gm)).toHaveLength(1);

		expect(setProjectTokenCommitted(root, false)).toBe(true);
		expect(isProjectTokenCommitted(root)).toBe(false);
		expect(gitIgnores(root, ".tarout/auth.json")).toBe(true);
		expect(gitignoreOf(root)).toBe(original);
		expect(setProjectTokenCommitted(root, false)).toBe(false);
	});

	it("keeps the opt-in when a later login rewrites the credential", () => {
		setProjectCredential(CREDENTIAL, root);
		setProjectTokenCommitted(root, true);

		setProjectCredential({ ...CREDENTIAL, token: "tk_rotated" }, root);

		expect(isProjectTokenCommitted(root)).toBe(true);
	});

	it("reports a parent .gitignore that still hides the credential", () => {
		initRepo(root);
		writeFileSync(join(root, ".gitignore"), ".tarout/\n");
		setProjectCredential(CREDENTIAL, root);
		setProjectTokenCommitted(root, true);

		expect(probeCredentialInGit(root).ignored).toBe(true);
	});

	it("answers null outside a git work tree instead of guessing", () => {
		setProjectCredential(CREDENTIAL, root);
		const state = probeCredentialInGit(root);
		// tmpdir is not inside a repository on any machine this suite runs on;
		// if it ever is, git answers for that repository instead.
		if (spawnSync("git", ["rev-parse"], { cwd: root }).status !== 0) {
			expect(state).toEqual({ ignored: null, tracked: null });
		}
	});

	it("upgrades the legacy login header in place and adds !config.json", () => {
		mkdirSync(join(root, ".tarout"));
		writeFileSync(
			join(root, ".tarout", ".gitignore"),
			"# Ignore local tarout config\n*\n!.gitignore\n",
		);

		ensureProjectGitignore(root);

		const content = gitignoreOf(root);
		expect(content).not.toContain("# Ignore local tarout config");
		expect(content).toContain("tarout login");
		expect(content).toMatch(/^!config\.json$/m);
		// Idempotent.
		ensureProjectGitignore(root);
		expect(gitignoreOf(root)).toBe(content);
	});

	it("upgrades the legacy link header and keeps lines the user added", () => {
		mkdirSync(join(root, ".tarout"));
		writeFileSync(
			join(root, ".tarout", ".gitignore"),
			"# Ignore local tarout config\n*\n!.gitignore\n!config.json\n!auth.json\n",
		);

		ensureProjectGitignore(root);

		const content = gitignoreOf(root);
		expect(content).toContain("tarout login");
		expect(content.match(/^!config\.json$/gm)).toHaveLength(1);
		expect(isProjectTokenCommitted(root)).toBe(true);
	});

	it("never rewrites a .gitignore the user wrote themselves", () => {
		mkdirSync(join(root, ".tarout"));
		const custom = "# ours\n*\n!.gitignore\n!config.json\n";
		writeFileSync(join(root, ".tarout", ".gitignore"), custom);

		setProjectCredential(CREDENTIAL, root);

		expect(gitignoreOf(root)).toBe(custom);
	});
});
