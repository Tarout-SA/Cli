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
 * (directory 0700, file 0600, kept out of git by the `.tarout/.gitignore` this
 * module writes unless the user opts in with `--commit-token`). Resolution
 * walks UP from the working directory, so running the CLI
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

import { spawnSync } from "node:child_process";
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
 * First line of every `.tarout/.gitignore` written before the file carried
 * sign-in instructions. A file that still starts with it is ours, so its header
 * can be upgraded in place without touching rules the user added below it.
 */
const LEGACY_GITIGNORE_HEADER = "# Ignore local tarout config";

/**
 * Header of `.tarout/.gitignore`. This file is the ONLY part of `.tarout/` that
 * reaches a fresh clone, so it is where a teammate learns why the folder is
 * empty and what to run. Keep it short and keep every command in it real.
 */
const GITIGNORE_HEADER = [
	"# Tarout CLI files for this project.",
	"#",
	"# Just cloned this repo? Your Tarout login (auth.json) is not in git unless",
	"# `!auth.json` appears at the bottom of this file, so sign in with",
	"#   tarout login",
	"# or run `tarout deploy`, which signs you in and asks which app to use.",
	"# In CI, set TAROUT_TOKEN to a key from https://tarout.sa/dashboard/agent/keys",
	"#",
	"# auth.json     your login token. Kept out of git by default; to commit it",
	"#               so everyone with the repo shares one login, run",
	"#               `tarout login --commit-token` (private repos only).",
	"# project.json  which app this folder deploys to. Per machine, not committed.",
	"# config.json   the deploy contract. Committed.",
].join("\n");

/** Ignore everything except this file and the committed deploy contract. */
const GITIGNORE_RULES = ["*", "!.gitignore", "!config.json"].join("\n");

/** The rule that un-ignores the credential, and the comment written above it. */
const COMMIT_TOKEN_RULE = "!auth.json";
const COMMIT_TOKEN_COMMENT =
	"# auth.json is committed on purpose (tarout login --commit-token). Undo: tarout login --no-commit-token";

function projectGitignorePath(baseDir: string): string {
	return join(getProjectAuthDir(baseDir), ".gitignore");
}

function writeGitignore(path: string, content: string): void {
	writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
	chmodIfSupported(path, 0o600);
}

/**
 * Write `.tarout/.gitignore` if absent, or bring an existing one up to date.
 *
 * The rules ignore everything in the directory (the credential and the machine
 * link) while keeping the ignore file itself and `config.json` tracked, so the
 * protection and the instructions both survive a fresh clone.
 *
 * An existing file is only amended, never rewritten: a legacy header is swapped
 * for the current one, and a missing `!config.json` is appended. Anything else
 * the user put there, including an opted-in `!auth.json`, is kept.
 *
 * @param {string} baseDir - The project directory.
 */
export function ensureProjectGitignore(baseDir: string): void {
	const dir = getProjectAuthDir(baseDir);
	if (!existsSync(dir)) return;
	const path = projectGitignorePath(baseDir);
	if (!existsSync(path)) {
		writeGitignore(path, `${GITIGNORE_HEADER}\n${GITIGNORE_RULES}\n`);
		return;
	}

	// Best-effort: a stale header or a missing rule must never fail the login or
	// link that triggered this.
	try {
		const current = readFileSync(path, "utf-8");
		let next = current;
		const lines = next.split("\n");
		if (lines[0]?.trim() === LEGACY_GITIGNORE_HEADER) {
			next = [GITIGNORE_HEADER, ...lines.slice(1)].join("\n");
		}
		if (!hasGitignoreLine(next, "!config.json")) {
			next = `${next.replace(/\n*$/, "\n")}!config.json\n`;
		}
		if (next !== current) writeGitignore(path, next);
	} catch {
		// Leave the file as it is.
	}
}

function hasGitignoreLine(content: string, line: string): boolean {
	return content.split("\n").some((entry) => entry.trim() === line);
}

/**
 * Whether this project's `.tarout/.gitignore` lets git commit `auth.json`.
 * @param {string} baseDir - The project directory.
 */
export function isProjectTokenCommitted(baseDir: string): boolean {
	try {
		return hasGitignoreLine(
			readFileSync(projectGitignorePath(baseDir), "utf-8"),
			COMMIT_TOKEN_RULE,
		);
	} catch {
		return false;
	}
}

/**
 * Opt this project's credential in to (or back out of) version control by
 * adding or removing `!auth.json` in `.tarout/.gitignore`. The default is
 * ignored; committing is an explicit choice because anyone who can read the
 * repository can then act as the account that owns the key.
 *
 * Only the ignore rule changes. Un-committing does not remove a copy git is
 * already tracking; see {@link probeCredentialInGit}.
 *
 * @param {string} baseDir - The project directory (must already have `.tarout/`).
 * @param {boolean} commit - True to commit the credential, false to ignore it.
 * @returns {boolean} True when the file changed, false when it already matched.
 */
export function setProjectTokenCommitted(
	baseDir: string,
	commit: boolean,
): boolean {
	ensureProjectGitignore(baseDir);
	const path = projectGitignorePath(baseDir);
	const current = readFileSync(path, "utf-8");
	if (hasGitignoreLine(current, COMMIT_TOKEN_RULE) === commit) return false;

	const next = commit
		? `${current.replace(/\n*$/, "\n")}${COMMIT_TOKEN_COMMENT}\n${COMMIT_TOKEN_RULE}\n`
		: current
				.split("\n")
				.filter((line) => {
					const trimmed = line.trim();
					return trimmed !== COMMIT_TOKEN_RULE && trimmed !== COMMIT_TOKEN_COMMENT;
				})
				.join("\n");
	writeGitignore(path, next);
	return true;
}

/** What git currently thinks of a project's `.tarout/auth.json`. */
export interface CredentialGitState {
	/** Git would skip the file on `git add` (null when git could not answer). */
	ignored: boolean | null;
	/** The file is already in the index (null when git could not answer). */
	tracked: boolean | null;
}

/**
 * Ask git (read-only) whether the credential is ignored and whether it is
 * already tracked. Used to catch the two ways the `.gitignore` rule alone
 * misleads: a parent `.gitignore` that hides `.tarout/` entirely, so `!auth.json`
 * never takes effect, and a copy that is still tracked after opting back out.
 *
 * Returns nulls outside a git work tree or when git is not installed.
 *
 * @param {string} baseDir - The project directory.
 */
export function probeCredentialInGit(baseDir: string): CredentialGitState {
	const target = join(PROJECT_DIR, AUTH_FILE);
	const run = (args: string[]): number | null => {
		const result = spawnSync("git", args, {
			cwd: baseDir,
			stdio: "ignore",
			timeout: 5_000,
		});
		return result.error ? null : result.status;
	};
	const tracked = run(["ls-files", "--error-unmatch", target]);
	const ignored = run(["check-ignore", "-q", "--no-index", target]);
	return {
		// check-ignore: 0 ignored, 1 not ignored, 128 not a repo / fatal.
		ignored: ignored === 0 ? true : ignored === 1 ? false : null,
		// ls-files --error-unmatch: 0 tracked, 1 not tracked, 128 not a repo.
		tracked: tracked === 0 ? true : tracked === 1 ? false : null,
	};
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
