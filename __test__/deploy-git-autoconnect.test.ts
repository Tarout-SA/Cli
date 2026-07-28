import { beforeEach, describe, expect, it } from "vitest";
import { tryConnectGitHubSource } from "../src/commands/deploy";
import { setGlobalOptions } from "../src/lib/output";

/**
 * `tarout deploy` prefers binding a GitHub remote over uploading a zip, so the
 * app redeploys on every push instead of only when someone reruns the CLI.
 *
 * The rule that matters: this is an OPPORTUNISTIC upgrade. Every miss must
 * return false so the caller still uploads — a failed connect must never fail
 * the deploy, and must never leave the app half-bound.
 */

const APP = { applicationId: "app_1", name: "my-app" } as never;

function inspection(git: Record<string, unknown>): never {
	return { git } as never;
}

const GITHUB_GIT = {
	hasGit: true,
	provider: "GitHub",
	remoteUrl: "git@github.com:acme/site.git",
	githubRepo: { owner: "acme", repository: "site" },
	branch: "main",
};

interface Calls {
	providers: number;
	saved: Record<string, unknown>[];
}

function makeClient(
	providerList: unknown,
	opts: { saveThrows?: boolean; providersThrow?: boolean } = {},
): { client: never; calls: Calls } {
	const calls: Calls = { providers: 0, saved: [] };
	const client = {
		github: {
			githubProviders: {
				query: async () => {
					calls.providers++;
					if (opts.providersThrow) throw new Error("network");
					return providerList;
				},
			},
		},
		application: {
			saveGithubProvider: {
				mutate: async (input: Record<string, unknown>) => {
					calls.saved.push(input);
					if (opts.saveThrows) throw new Error("repo not in installation");
					return true;
				},
			},
		},
	};
	return { client: client as never, calls };
}

beforeEach(() => {
	// Quiet keeps the hint/spinner output off the test log.
	setGlobalOptions({ quiet: true });
});

describe("tryConnectGitHubSource", () => {
	it("binds the repo and reports success when exactly one GitHub App is installed", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }]);

		const connected = await tryConnectGitHubSource(
			client,
			APP,
			inspection(GITHUB_GIT),
		);

		expect(connected).toBe(true);
		expect(calls.saved).toHaveLength(1);
		expect(calls.saved[0]).toMatchObject({
			applicationId: "app_1",
			owner: "acme",
			repository: "site",
			branch: "main",
			githubId: "gh_1",
			buildPath: "/",
		});
	});

	it("accepts the `providers` envelope shape as well as a bare array", async () => {
		const { client, calls } = makeClient({ providers: [{ id: "gh_2" }] });

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(true);
		expect(calls.saved[0]).toMatchObject({ githubId: "gh_2" });
	});

	it("declines without a mutation when no GitHub App is installed", async () => {
		const { client, calls } = makeClient([]);

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(false);
		// Must not write a blank githubId — that produces an app that looks
		// connected but whose push webhook can never match.
		expect(calls.saved).toHaveLength(0);
	});

	it("declines when several GitHub Apps are installed rather than guessing", async () => {
		const { client, calls } = makeClient([
			{ githubId: "gh_1" },
			{ githubId: "gh_2" },
		]);

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(false);
		expect(calls.saved).toHaveLength(0);
	});

	it("declines for a non-GitHub remote without calling the API at all", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }]);

		const connected = await tryConnectGitHubSource(
			client,
			APP,
			inspection({
				hasGit: true,
				provider: "GitLab",
				remoteUrl: "git@gitlab.com:acme/site.git",
				githubRepo: undefined,
				branch: "main",
			}),
		);

		expect(connected).toBe(false);
		expect(calls.providers).toBe(0);
	});

	it("declines on a detached HEAD rather than binding to no branch", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }]);

		const connected = await tryConnectGitHubSource(
			client,
			APP,
			inspection({ ...GITHUB_GIT, branch: undefined }),
		);

		expect(connected).toBe(false);
		expect(calls.providers).toBe(0);
	});

	it("declines when there is no git repo at all", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }]);

		expect(
			await tryConnectGitHubSource(client, APP, inspection({ hasGit: false })),
		).toBe(false);
		expect(calls.providers).toBe(0);
	});

	it("falls back to upload when the connect mutation fails", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }], {
			saveThrows: true,
		});

		// A repo outside the App installation, or a branch not yet pushed, must
		// degrade to an upload rather than aborting the deploy.
		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(false);
		expect(calls.saved).toHaveLength(1);
	});

	it("falls back to upload when the providers query fails", async () => {
		const { client, calls } = makeClient([], { providersThrow: true });

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(false);
		expect(calls.saved).toHaveLength(0);
	});
});
