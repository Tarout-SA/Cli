import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCredentialResolutionDir,
	getProjectCredential,
	resetProjectAuthCache,
	setCredentialResolutionDir,
	setProjectCredential,
} from "../../src/lib/project-auth";

/**
 * An MCP server is launched by the editor, so its `process.cwd()` is whatever
 * the editor felt like — often the editor's install dir or `$HOME`, not the
 * project. Every tool call carries the project it should act on as a `path`
 * argument instead.
 *
 * Credentials are project-scoped, resolved by walking up from a directory. So
 * without an explicit resolution directory, `tarout-mcp` would look for
 * `.tarout/auth.json` next to the editor and find nothing — reporting
 * AUTH_ERROR for a project that is perfectly well authenticated.
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

let projectA: string;
let projectB: string;
let elsewhere: string;
const cleanup: string[] = [];

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "tarout-mcp-scope-"));
	cleanup.push(root);
	projectA = join(root, "project-a");
	projectB = join(root, "project-b");
	elsewhere = join(root, "elsewhere");
	for (const dir of [projectA, projectB, elsewhere]) mkdirSync(dir);
	setProjectCredential(CREDENTIAL, projectA);
	setProjectCredential(
		{ ...CREDENTIAL, token: "tk_b", userEmail: "b@example.com" },
		projectB,
	);
	resetProjectAuthCache();
});

afterEach(() => {
	setCredentialResolutionDir(null);
	resetProjectAuthCache();
	for (const path of cleanup.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("credential resolution directory", () => {
	it("defaults to the working directory", () => {
		expect(getCredentialResolutionDir()).toBe(process.cwd());
	});

	it("resolves the named project's credential, not the process cwd's", () => {
		setCredentialResolutionDir(projectA);
		resetProjectAuthCache();

		const resolved = getProjectCredential();
		expect(resolved?.credential.token).toBe("tk_project_secret");
		expect(resolved?.projectDir).toBe(projectA);
	});

	// Two tool calls in one server process must not bleed into each other.
	it("switches cleanly between projects", () => {
		setCredentialResolutionDir(projectA);
		resetProjectAuthCache();
		expect(getProjectCredential()?.credential.userEmail).toBe(
			"agent@example.com",
		);

		setCredentialResolutionDir(projectB);
		resetProjectAuthCache();
		expect(getProjectCredential()?.credential.userEmail).toBe("b@example.com");
	});

	it("finds nothing for a directory with no credential above it", () => {
		setCredentialResolutionDir(elsewhere);
		resetProjectAuthCache();

		expect(getProjectCredential()).toBeNull();
	});

	it("clears back to the working directory", () => {
		setCredentialResolutionDir(projectA);
		setCredentialResolutionDir(null);

		expect(getCredentialResolutionDir()).toBe(process.cwd());
	});
});
