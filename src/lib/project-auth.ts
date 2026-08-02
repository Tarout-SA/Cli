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

/**
 * Directory that unqualified credential lookups resolve from, when it should not
 * be `process.cwd()`.
 *
 * The CLI never needs this — it runs *in* the project. `tarout-mcp` does: an
 * editor may launch the MCP server from the editor's own working directory (or
 * `$HOME`), while each tool call names the project it should act on via its
 * `path` argument. Without this, every call would resolve credentials from
 * wherever the server happens to have been started and miss the project's
 * `.tarout/auth.json` entirely.
 */
let resolutionDir: string | null = null;

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
 * Point unqualified credential lookups at a directory other than `process.cwd()`.
 * Pass null to go back to the working directory.
 * @param {string | null} dir - Directory to resolve from.
 */
export function setCredentialResolutionDir(dir: string | null): void {
	resolutionDir = dir ? resolve(dir) : null;
}

/** The directory unqualified lookups currently resolve from. */
export function getCredentialResolutionDir(): string {
	return resolutionDir ?? process.cwd();
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
	let dir = resolve(startDir || getCredentialResolutionDir());
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

	const key = resolve(startDir || getCredentialResolutionDir());
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
 * Files whose presence means "this directory is a project". Deliberately broad
 * and language-agnostic: the cost of a false positive is one extra `.tarout/`
 * folder in a real project, while the cost of a false negative is a credential
 * silently landing machine-wide when the user expected it scoped.
 */
const PROJECT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"requirements.txt",
	"go.mod",
	"Cargo.toml",
	"composer.json",
	"Gemfile",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Dockerfile",
	"docker-compose.yml",
	"deno.json",
	"bun.lockb",
];

/**
 * Find the directory a project credential should belong to, walking UP from
 * `startDir`.
 *
 * An existing `.tarout/` wins outright — re-authenticating from a subdirectory
 * of a linked project must update that project's credential, not scatter a
 * second one further down the tree. Otherwise the shallowest ancestor carrying a
 * recognisable project marker is used.
 *
 * The walk stops before $HOME and the filesystem root, so neither can ever be
 * mistaken for a project.
 *
 * @param {string} [startDir] - Directory to search from (defaults to cwd).
 * @returns {string | null} Absolute project directory, or null when there is none.
 */
export function findProjectDir(startDir?: string): string | null {
	let dir = resolve(startDir || getCredentialResolutionDir());
	const home = resolve(homedir());
	const { root } = parse(dir);
	let markerMatch: string | null = null;

	for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
		if (dir === home || dir === root) break;
		// An existing .tarout/ is an explicit statement about where this project
		// lives — take it immediately, even if a marker matched deeper down.
		if (existsSync(getProjectAuthDir(dir))) return dir;
		if (!markerMatch && PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) {
			markerMatch = dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return markerMatch;
}

/** Where a newly-obtained credential will be stored. */
export interface CredentialPlacement {
	scope: "project" | "global";
	/** Directory that will own the credential, when scope is `project`. */
	projectDir?: string;
	/** Human-readable explanation, set only when `auto` fell back to global. */
	fallbackReason?: string;
}

/**
 * Decide where `login` / `token` should persist a credential.
 *
 * `auto` — the default — prefers this project's `.tarout/auth.json`, because a
 * credential handed to an agent is a credential for *one* project; storing it
 * machine-wide means connecting project B silently re-points project A at
 * another account. It degrades to the machine-wide profile when the working
 * directory is not a project at all (a bare `~/Downloads`, $HOME itself), so
 * running `tarout login` in a scratch shell does not litter the filesystem.
 *
 * `project` and `global` are the explicit overrides (`--local` / `--global`).
 *
 * @param {"project" | "global" | "auto"} requested - Caller's preference.
 * @param {string} [cwd] - Working directory (defaults to `process.cwd()`).
 * @returns {CredentialPlacement} The resolved destination.
 */
export function resolveCredentialPlacement(
	requested: "project" | "global" | "auto",
	cwd?: string,
): CredentialPlacement {
	if (requested === "global") return { scope: "global" };

	const startDir = resolve(cwd || getCredentialResolutionDir());

	if (requested === "project") {
		// Explicit --local: honour the working directory itself, and let
		// setProjectCredential throw if it is $HOME or the root.
		return { scope: "project", projectDir: findProjectDir(startDir) ?? startDir };
	}

	const projectDir = findProjectDir(startDir);
	if (!projectDir) {
		return {
			scope: "global",
			fallbackReason: `'${startDir}' does not look like a project (no .tarout, .git, or package manifest above it), so the credential was saved machine-wide. Run this from a project directory for a project-scoped credential.`,
		};
	}
	return { scope: "project", projectDir };
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
