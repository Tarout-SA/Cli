import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeProjectCredentialSwitch,
	findProjectAuthFile,
	getProjectCredential,
	isWorldOrGroupReadable,
	parseProjectCredential,
	removeProjectCredential,
	resetProjectAuthCache,
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
