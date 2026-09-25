import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openInBrowser } from "./browser.js";
import { getApiUrl } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * Helpers for putting an app on push-to-deploy from its GitHub repository.
 *
 * The rule they serve: a project with a GitHub remote deploys from GitHub. An
 * uploaded folder only ever changes when someone reruns the CLI, so an app
 * that silently stays on upload ships stale code the moment work is pushed
 * instead of deployed.
 */

export interface GitHubRepoRef {
	owner: string;
	repository: string;
}

type ProviderRow = { githubId?: string; id?: string };

type RepoRow = {
	full_name?: string;
	name?: string;
	owner?: { login?: string } | null;
};

/** Tarout's GitHub connection flow: the dashboard's Git providers page. */
export function gitHubSetupUrl(): string {
	return `${getApiUrl().replace(/\/+$/, "")}/dashboard/settings/git-providers`;
}

/** `github.githubProviders` answers with a bare array or a `providers` envelope. */
export function readGitHubProviders(response: unknown): ProviderRow[] {
	if (Array.isArray(response)) return response as ProviderRow[];
	const wrapped = (response as { providers?: unknown } | null)?.providers;
	return Array.isArray(wrapped) ? (wrapped as ProviderRow[]) : [];
}

export interface RepoAccess {
	githubId: string;
	/** GitHub's own spelling of the repo, which the push webhook matches on. */
	owner: string;
	repository: string;
}

export interface RepoAccessLookup {
	/** How many GitHub connections the org has. */
	providers: number;
	/** The connection that can read the repo, when one can. */
	access?: RepoAccess;
}

/**
 * Find the org's GitHub connection that can actually read `repo`.
 *
 * `saveGithubProvider` does not check repository access, and it clears the
 * app's uploaded source when it binds. Binding a repo the installation cannot
 * read therefore leaves an app whose every build fails at clone, so access is
 * proven here, against GitHub's own repository list, before anything binds.
 * Checking every connection also settles which one to use when the org has
 * several, instead of refusing to choose.
 */
export async function findRepoAccess(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	repo: GitHubRepoRef,
): Promise<RepoAccessLookup> {
	const providers = readGitHubProviders(
		await client.github.githubProviders.query(),
	);
	const wanted = `${repo.owner}/${repo.repository}`.toLowerCase();

	for (const provider of providers) {
		const githubId = provider.githubId ?? provider.id;
		if (!githubId) continue;
		let repos: RepoRow[];
		try {
			const response = await client.github.getGithubRepositories.query({
				githubId,
			});
			repos = Array.isArray(response) ? (response as RepoRow[]) : [];
		} catch {
			// A connection we cannot list is one we cannot prove access through.
			continue;
		}
		const match = repos.find((r) => {
			const fullName =
				r.full_name ?? (r.owner?.login && r.name ? `${r.owner.login}/${r.name}` : "");
			return fullName.toLowerCase() === wanted;
		});
		if (!match) continue;
		const [owner, repository] = (
			match.full_name ?? `${match.owner?.login}/${match.name}`
		).split("/");
		if (!owner || !repository) continue;
		return {
			providers: providers.length,
			access: { githubId, owner, repository },
		};
	}

	return { providers: providers.length };
}

export interface WaitForRepoAccessOptions {
	timeoutMs: number;
	pollIntervalMs?: number;
	/** Skip the browser launch (the page is already open, or `--no-open`). */
	noOpen?: boolean;
	/** Test seams. */
	openUrl?: (url: string) => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Called once, after the page is opened and before polling starts. */
	onWaiting?: (info: { url: string; opened: boolean }) => void;
}

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Open Tarout's GitHub setup page and wait until a connection that can read
 * `repo` exists, or the timeout passes.
 *
 * Installing a GitHub App is an authorization on github.com, so a person has
 * to click through it; like login and checkout, the CLI opens the page and
 * polls rather than asking anyone to come back and rerun something. Polls for
 * REPO ACCESS, not just a connection: an installation that was limited to
 * other repositories is not done yet.
 */
export async function waitForRepoAccess(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	repo: GitHubRepoRef,
	opts: WaitForRepoAccessOptions,
): Promise<RepoAccess | undefined> {
	const url = gitHubSetupUrl();
	const openUrl =
		opts.openUrl ??
		((target: string) =>
			openInBrowser(target, {
				hint: "Connect GitHub on this page (if the browser didn't open, visit it):",
			}));
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const interval = opts.pollIntervalMs ?? 5000;

	const opened = opts.noOpen ? false : await openUrl(url);
	opts.onWaiting?.({ url, opened });

	const deadline = now() + opts.timeoutMs;
	while (now() < deadline) {
		try {
			const { access } = await findRepoAccess(client, repo);
			if (access) return access;
		} catch {
			// A dropped poll is not an answer; keep waiting until the deadline.
		}
		await sleep(interval);
	}
	return undefined;
}

export interface LocalGitState {
	/** The local name of the remote that points at the repo (usually origin). */
	remote: string;
	/** Commits on HEAD that `<remote>/<branch>` does not have. */
	ahead: number;
	/** Modified, staged, or untracked paths in the working tree. */
	uncommitted: number;
	/** The checked-out branch, when it differs from the one the app builds. */
	otherBranch?: string;
	/** True when `<remote>/<branch>` is missing locally (never pushed or fetched). */
	branchNotOnRemote: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
		timeout: 10_000,
	});
	return stdout;
}

/**
 * The local name of the remote whose URL is `repo` on github.com. A clone may
 * call it `github` or `upstream` rather than `origin`; guessing `origin` would
 * report every branch as never pushed.
 */
async function remoteNameFor(
	cwd: string,
	repo: GitHubRepoRef | undefined,
): Promise<string> {
	if (!repo) return "origin";
	const wanted = `${repo.owner}/${repo.repository}`.toLowerCase();
	const lines = (await git(cwd, ["remote", "-v"])).split("\n");
	for (const line of lines) {
		const [name, url] = line.split(/\s+/);
		const match = url?.match(
			/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
		);
		if (name && match && `${match[1]}/${match[2]}`.toLowerCase() === wanted) {
			return name;
		}
	}
	return "origin";
}

/**
 * What a Git-sourced build of `branch` would leave out of this working copy.
 *
 * A GitHub-sourced deploy clones the pushed branch, so local commits and edits
 * are not in it. Compared against the local remote-tracking ref without a
 * fetch: cheap and offline, and only ever errs toward under-reporting. Returns
 * undefined when git itself cannot answer.
 */
export async function readLocalGitState(
	cwd: string,
	branch: string,
	checkedOut: string | undefined,
	repo?: GitHubRepoRef,
): Promise<LocalGitState | undefined> {
	try {
		const status = await git(cwd, ["status", "--porcelain"]);
		const uncommitted = status.split("\n").filter((l) => l.trim()).length;
		const remote = await remoteNameFor(cwd, repo);
		let ahead = 0;
		let branchNotOnRemote = false;
		try {
			ahead = Number.parseInt(
				(
					await git(cwd, ["rev-list", "--count", `${remote}/${branch}..HEAD`])
				).trim(),
				10,
			);
			if (!Number.isFinite(ahead)) ahead = 0;
		} catch {
			branchNotOnRemote = true;
		}
		return {
			remote,
			ahead,
			uncommitted,
			otherBranch: checkedOut && checkedOut !== branch ? checkedOut : undefined,
			branchNotOnRemote,
		};
	} catch {
		return undefined;
	}
}

/** Plain-language warnings for a Git-sourced deploy of `branch`. */
export function unshippedWorkWarnings(
	state: LocalGitState | undefined,
	branch: string,
): string[] {
	if (!state) return [];
	const warnings: string[] = [];
	if (state.branchNotOnRemote) {
		warnings.push(
			`Branch ${branch} was not found on ${state.remote} in this clone, so this deploy builds whatever GitHub has for it. Push it first if it is new.`,
		);
	}
	if (state.otherBranch) {
		warnings.push(
			`This folder is on ${state.otherBranch}, but the app builds ${branch}. Work on ${state.otherBranch} is not in this deploy.`,
		);
	}
	if (state.ahead > 0) {
		warnings.push(
			`${state.ahead} local commit${state.ahead === 1 ? " is" : "s are"} not pushed to ${state.remote}/${branch}, so ${state.ahead === 1 ? "it is" : "they are"} not in this deploy. Push to ship ${state.ahead === 1 ? "it" : "them"}.`,
		);
	}
	if (state.uncommitted > 0) {
		warnings.push(
			`${state.uncommitted} uncommitted change${state.uncommitted === 1 ? " is" : "s are"} not in this deploy. Commit and push to ship ${state.uncommitted === 1 ? "it" : "them"}.`,
		);
	}
	return warnings;
}

/** The subset of `application.one` that says where builds come from. */
export interface AppSourceFields {
	applicationId?: string;
	sourceType?: string | null;
	owner?: string | null;
	repository?: string | null;
	branch?: string | null;
	autoDeploy?: boolean | null;
}

export interface DeploySourceSummary {
	type: string | null;
	repository: string | null;
	branch: string | null;
	/** True only when a push to `branch` redeploys the app by itself. */
	pushToDeploy: boolean;
	/** Set when this folder tracks a GitHub repo the app is not deploying from. */
	githubRemote?: string;
	/** The one command that puts the app on push-to-deploy. */
	next?: string;
}

/**
 * Where the app's builds come from, for the final deploy result. Stated in the
 * envelope because agents read `data`, and a side event saying the same thing
 * is exactly what got skipped when an app sat on upload for weeks.
 */
export function describeDeploySource(
	app: AppSourceFields,
	localRemote?: GitHubRepoRef,
): DeploySourceSummary {
	const type = app.sourceType ?? null;
	const repository =
		type === "github" && app.owner && app.repository
			? `${app.owner}/${app.repository}`
			: null;
	// Only GitHub registers a push webhook; GitLab and custom Git pull the
	// latest commit but need a `tarout deploy` to do it.
	const pushToDeploy = Boolean(repository) && app.autoDeploy !== false;
	const summary: DeploySourceSummary = {
		type,
		repository,
		branch: repository ? (app.branch ?? null) : null,
		pushToDeploy,
	};
	if (!pushToDeploy && localRemote) {
		summary.githubRemote = `${localRemote.owner}/${localRemote.repository}`;
		summary.next = `tarout providers github connect --wait --app ${app.applicationId ?? "<app>"}`;
	}
	return summary;
}
