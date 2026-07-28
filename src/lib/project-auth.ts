/**
 * @fileoverview Project-scoped Tarout credentials — `.tarout/auth.json`.
 *
 * The global `conf` store (see {@link module:lib/config}) holds ONE machine-wide
 * credential, so connecting a second account replaces the first for every
 * directory on the machine. That is wrong for the agent workflow: a coding agent
 * is handed a key *for one project*, and running the dashboard's one-command
 * setup in project B must not silently re-point project A at a different
 * account.
 *
 * A project credential lives beside the existing link metadata in `.tarout/`
 * (directory 0700, file 0600, covered by the `.tarout/.gitignore` this module
 * writes). Resolution walks UP from the working directory, so running the CLI
 * from a subdirectory of the project still finds it, and stops at $HOME so a
 * stray `~/.tarout/auth.json` can never become an accidental machine-wide
 * default.
 *
 * Trust: the file is inside the repository tree, so it is attacker-supplied the
 * moment a repo is cloned from an untrusted source. It is therefore validated at
 * read time — a bad `apiUrl` is rejected here rather than "trusted by
 * construction" the way a locally-saved profile is, and a credential whose
 * account differs from the global profile announces itself (see
 * {@link describeProjectCredentialSwitch}) instead of silently redirecting a
 * deploy into someone else's organization.
 *
 * @module lib/project-auth
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { normalizeApiUrl } from "./api-url.js";
import type { Profile } from "./config.js";

/** Directory holding per-project Tarout state (shared with `project.json`). */
const PROJECT_DIR = ".tarout";
/** Filename of the project-scoped credential. */
const AUTH_FILE = "auth.json";
/** Safety stop for the upward walk; far beyond any real directory nesting. */
const MAX_WALK_DEPTH = 64;

/**
 * A credential bound to one project directory. Structurally a {@link Profile}
 * plus provenance — the extra fields are advisory only, never authorization.
 */
export interface ProjectCredential extends Profile {
	/** ISO timestamp of when this credential was written. */
	savedAt?: string;
	/** How the credential arrived (`agent-connect`, `login`, `token`). */
	source?: string;
}

/** A resolved project credential and the file it came from. */
export interface ResolvedProjectCredential {
	credential: ProjectCredential;
	/** Absolute path to the `.tarout/auth.json` that supplied it. */
	path: string;
	/** Absolute path of the project directory that owns it. */
	projectDir: string;
}

/**
 * Process-wide opt-out set by the global `--global-auth` flag. When true every
 * lookup behaves as though no project credential existed, which is the escape
 * hatch for "use my machine-wide login for this one command".
 */
let globalOnly = false;

/** Resolution cache keyed by the directory the search started from. */
const cache = new Map<string, ResolvedProjectCredential | null>();

/**
 * Force the machine-wide credential for the rest of this process.
 * @param {boolean} value - True to ignore project-scoped credentials.
 */
export function setGlobalAuthOnly(value: boolean): void {
	globalOnly = value;
	cache.clear();
}

/** Whether project-scoped credentials are currently being ignored. */
export function isGlobalAuthOnly(): boolean {
	return globalOnly;
}

/**
 * Drop the resolution cache. Needed after writing/removing a credential, and by
 * tests that move between fixture directories inside one process.
 */
export function resetProjectAuthCache(): void {
	cache.clear();
}

/** Path to a directory's `.tarout` folder. */
export function getProjectAuthDir(baseDir: string): string {
	return join(baseDir, PROJECT_DIR);
}

/** Path to a directory's `.tarout/auth.json`. */
export function getProjectAuthPath(baseDir: string): string {
	return join(getProjectAuthDir(baseDir), AUTH_FILE);
}

/**
 * Hosts a project credential may point at without an explicit opt-in. Mirrors
 * the allowlist in `lib/config.ts` — kept in sync deliberately rather than
 * shared, because this module must not import the config store (config imports
 * this one).
 * @param {string} value - Candidate API URL.
 * @returns {boolean} True when credentials may be sent to that host.
 */
function isTrustedApiHost(value: string): boolean {
	let host: string;
	try {
		host = new URL(value).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		host === "tarout.sa" ||
		host.endsWith(".tarout.sa") ||
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "[::1]"
	);
}

/** Whether the operator opted in to untrusted hosts (self-hosted deployments). */
function untrustedHostAllowed(): boolean {
	const value = (process.env.TAROUT_ALLOW_UNTRUSTED_HOST || "")
		.trim()
		.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
	return isNonEmptyString(value) ? value : undefined;
}

/**
 * Validate an on-disk credential document. Returns null for anything malformed
 * or pointed at an untrusted host — a planted file must fail closed rather than
 * redirect the CLI's credentials somewhere unexpected.
 * @param {unknown} parsed - The parsed JSON document.
 * @returns {ProjectCredential | null} The credential, or null when unusable.
 */
export function parseProjectCredential(
	parsed: unknown,
): ProjectCredential | null {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}
	const raw = parsed as Record<string, unknown>;
	if (!isNonEmptyString(raw.token) || !isNonEmptyString(raw.apiUrl)) {
		return null;
	}

	let apiUrl: string;
	try {
		apiUrl = normalizeApiUrl(raw.apiUrl);
	} catch {
		return null;
	}
	if (!isTrustedApiHost(apiUrl) && !untrustedHostAllowed()) {
		return null;
	}

	return {
		token: raw.token,
		apiUrl,
		organizationId: optionalString(raw.organizationId) ?? "",
		organizationName: optionalString(raw.organizationName) ?? "",
		userId: optionalString(raw.userId) ?? "",
		userEmail: optionalString(raw.userEmail) ?? "unknown",
		userName: optionalString(raw.userName),
		projectId: optionalString(raw.projectId),
		projectName: optionalString(raw.projectName),
		projectSlug: optionalString(raw.projectSlug),
		savedAt: optionalString(raw.savedAt),
		source: optionalString(raw.source),
	};
}

/**
 * True when a credential file is readable by group or others. Reported (not
 * enforced) so a mis-permissioned key is visible instead of silently shared.
 * @param {string} path - Path to the credential file.
 */
export function isWorldOrGroupReadable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o077) !== 0;
	} catch {
		return false;
	}
}

/**
 * Walk up from `startDir` looking for `.tarout/auth.json`, stopping before
 * $HOME and the filesystem root so a stray credential in either can never act
 * as a machine-wide default.
 * @param {string} [startDir] - Directory to start from (defaults to cwd).
 * @returns {string | null} Absolute path to the credential file, or null.
 */
export function findProjectAuthFile(startDir?: string): string | null {
	let dir = resolve(startDir || process.cwd());
	const home = resolve(homedir());
	const { root } = parse(dir);

	for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
		if (dir === home || dir === root) return null;
		const candidate = getProjectAuthPath(dir);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

/**
 * Resolve the project-scoped credential for a directory, if any.
 * @param {string} [startDir] - Directory to search from (defaults to cwd).
 * @returns {ResolvedProjectCredential | null} The credential, or null.
 */
export function getProjectCredential(
	startDir?: string,
): ResolvedProjectCredential | null {
	if (globalOnly) return null;

	const key = resolve(startDir || process.cwd());
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	let resolved: ResolvedProjectCredential | null = null;
	const path = findProjectAuthFile(key);
	if (path) {
		try {
			const credential = parseProjectCredential(
				JSON.parse(readFileSync(path, "utf-8")),
			);
			if (credential) {
				resolved = {
					credential,
					path,
					projectDir: dirname(dirname(path)),
				};
			}
		} catch {
			// Unreadable or malformed — fall through to the global credential
			// rather than hard-failing every command in the directory.
			resolved = null;
		}
	}

	cache.set(key, resolved);
	return resolved;
}

/** Whether a project-scoped credential applies to a directory. */
export function hasProjectCredential(startDir?: string): boolean {
	return getProjectCredential(startDir) !== null;
}

function chmodIfSupported(path: string, mode: number): void {
	try {
		chmodSync(path, mode);
	} catch {
		// Best-effort: some filesystems (and Windows) don't support chmod.
	}
}

/**
 * Refuse to place a credential where it would apply far too broadly. $HOME and
 * the filesystem root are never a project.
 * @param {string} baseDir - The directory that would own the credential.
 * @returns {string | undefined} An error message, or undefined when acceptable.
 */
export function unsafeCredentialDirectory(baseDir: string): string | undefined {
	const abs = resolve(baseDir);
	const home = resolve(homedir());
	const { root } = parse(abs);
	if (abs === root || abs === home) {
		return `Refusing to write a project credential to '${abs}': a home or root directory is not a project. Run this from the project directory, or use the machine-wide credential.`;
	}
	return undefined;
}

/**
 * Write (or replace) the project-scoped credential for a directory.
 * @param {ProjectCredential} credential - The credential to persist.
 * @param {string} baseDir - The project directory that will own it.
 * @returns {string} Absolute path to the written file.
 * @throws {Error} If `baseDir` is $HOME or a filesystem root.
 */
export function setProjectCredential(
	credential: ProjectCredential,
	baseDir: string,
): string {
	const unsafe = unsafeCredentialDirectory(baseDir);
	if (unsafe) throw new Error(unsafe);

	const dir = getProjectAuthDir(baseDir);
	const path = getProjectAuthPath(baseDir);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	chmodIfSupported(dir, 0o700);
	ensureProjectGitignore(baseDir);

	const document: ProjectCredential = {
		...credential,
		savedAt: credential.savedAt ?? new Date().toISOString(),
	};

	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 0o600,
	});
	chmodIfSupported(path, 0o600);

	cache.clear();
	return path;
}

/**
 * Write `.tarout/.gitignore` if absent. The pattern ignores everything in the
 * directory (including the credential) while keeping the ignore file itself
 * tracked, so the protection survives a fresh clone.
 * @param {string} baseDir - The project directory.
 */
export function ensureProjectGitignore(baseDir: string): void {
	const dir = getProjectAuthDir(baseDir);
	if (!existsSync(dir)) return;
	const gitignorePath = join(dir, ".gitignore");
	if (existsSync(gitignorePath)) return;
	writeFileSync(gitignorePath, "# Ignore local tarout config\n*\n!.gitignore\n", {
		encoding: "utf-8",
		mode: 0o600,
	});
	chmodIfSupported(gitignorePath, 0o600);
}

/**
 * Delete the project-scoped credential, leaving the rest of `.tarout` intact.
 * @param {string} [baseDir] - Project directory (defaults to the resolved one).
 * @returns {string | null} The removed path, or null when there was none.
 */
export function removeProjectCredential(baseDir?: string): string | null {
	const path = baseDir ? getProjectAuthPath(baseDir) : findProjectAuthFile();
	if (!path || !existsSync(path)) {
		cache.clear();
		return null;
	}
	try {
		rmSync(path, { force: true });
	} catch {
		cache.clear();
		return null;
	}
	cache.clear();
	return path;
}

/**
 * Describe an account switch caused by a project credential, for a one-line
 * notice. Returns undefined when there is nothing surprising to report — no
 * project credential, no global credential, or both name the same account.
 *
 * This is the mitigation for a `.tarout/auth.json` arriving inside a cloned
 * repository: the user is told which account a command is about to act on
 * instead of discovering it after a deploy landed in a stranger's org.
 *
 * @param {string | undefined} globalEmail - Email on the machine-wide profile.
 * @param {string} [startDir] - Directory to resolve from.
 * @returns {{ projectEmail: string; globalEmail: string; path: string } | undefined}
 */
export function describeProjectCredentialSwitch(
	globalEmail: string | undefined,
	startDir?: string,
):
	| { projectEmail: string; globalEmail: string; path: string }
	| undefined {
	const resolved = getProjectCredential(startDir);
	if (!resolved || !globalEmail) return undefined;
	const projectEmail = resolved.credential.userEmail;
	if (!projectEmail || projectEmail === globalEmail) return undefined;
	return { projectEmail, globalEmail, path: resolved.path };
}
