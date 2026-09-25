import { beforeEach, describe, expect, it } from "vitest";
import { tryConnectGitHubSource } from "../src/commands/deploy";
import { setGlobalOptions } from "../src/lib/output";

/**
 * `tarout deploy` prefers binding a GitHub remote over uploading a zip, so the
 * app redeploys on every push instead of only when someone reruns the CLI.
 *
 * Two rules matter. A miss must return false so the caller still uploads: a
 * failed connect never fails the deploy. And nothing binds until a GitHub
 * connection is proven to read the repo, because `saveGithubProvider` checks
 * no access and clears the uploaded source, so a blind bind leaves an app
 * whose every build fails at clone.
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
	repoLookups: string[];
	saved: Record<string, unknown>[];
}

function makeClient(
	providerList: unknown,
	opts: {
		saveThrows?: boolean;
		providersThrow?: boolean;
		/** Repos each connection can read, keyed by githubId. */
		repos?: Record<string, string[]>;
	} = {},
): { client: never; calls: Calls } {
	const calls: Calls = { providers: 0, repoLookups: [], saved: [] };
	const client = {
		github: {
			githubProviders: {
				query: async () => {
					calls.providers++;
					if (opts.providersThrow) throw new Error("network");
					return providerList;
				},
			},
			getGithubRepositories: {
				query: async ({ githubId }: { githubId: string }) => {
					calls.repoLookups.push(githubId);
					const list = opts.repos?.[githubId];
					if (!list) throw new Error("installation unreadable");
					return list.map((full_name) => ({ full_name }));
				},
			},
		},
		application: {
			saveGithubProvider: {
				mutate: async (input: Record<string, unknown>) => {
					calls.saved.push(input);
					if (opts.saveThrows) throw new Error("server error");
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
	it("binds the repo when the one GitHub connection can read it", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }], {
			repos: { gh_1: ["acme/site"] },
		});

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

	it("binds with GitHub's spelling of the repo, not the remote's", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }], {
			repos: { gh_1: ["Acme/Site"] },
		});

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(true);
		// The push webhook matches on GitHub's owner/name.
		expect(calls.saved[0]).toMatchObject({ owner: "Acme", repository: "Site" });
	});

	it("accepts the `providers` envelope shape as well as a bare array", async () => {
		const { client, calls } = makeClient(
			{ providers: [{ id: "gh_2" }] },
			{ repos: { gh_2: ["acme/site"] } },
		);

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(true);
		expect(calls.saved[0]).toMatchObject({ githubId: "gh_2" });
	});

	it("declines without a mutation when no GitHub connection exists", async () => {
		const { client, calls } = makeClient([]);

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(false);
		// Must not write a blank githubId: that produces an app that looks
		// connected but whose push webhook can never match.
		expect(calls.saved).toHaveLength(0);
	});

	it("declines when the only connection cannot read the repo", async () => {
		const { client, calls } = makeClient([{ githubId: "gh_1" }], {
			repos: { gh_1: ["acme/other"] },
		});

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(false);
		// The old code bound here, wiping the upload and failing every build.
		expect(calls.saved).toHaveLength(0);
	});

	it("picks the connection that can read the repo when there are several", async () => {
		const { client, calls } = makeClient(
			[{ githubId: "gh_1" }, { githubId: "gh_2" }],
			{ repos: { gh_1: ["acme/other"], gh_2: ["acme/site"] } },
		);

		expect(
			await tryConnectGitHubSource(client, APP, inspection(GITHUB_GIT)),
		).toBe(true);
		expect(calls.saved[0]).toMatchObject({ githubId: "gh_2" });
	});

	it("declines when none of several connections can read the repo", async () => {
		const { client, calls } = makeClient(
			[{ githubId: "gh_1" }, { githubId: "gh_2" }],
			{ repos: { gh_1: ["acme/other"] } },
		);

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
			repos: { gh_1: ["acme/site"] },
		});

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

	describe("offering to connect GitHub", () => {
		it("never waits on a browser for an agent or script", async () => {
			const { client } = makeClient([]);
			let waited = false;

			const connected = await tryConnectGitHubSource(
				client,
				APP,
				inspection(GITHUB_GIT),
				{
					offerInstall: true,
					interactive: false,
					wait: async () => {
						waited = true;
						return undefined;
					},
				},
			);

			expect(connected).toBe(false);
			expect(waited).toBe(false);
		});

		it("binds with the access the browser flow produced", async () => {
			const { client, calls } = makeClient([]);

			// `interactive: true` skips the TTY checks; the confirm is stubbed.
			const { confirmDefaultYes } = await stubConfirm(true);
			try {
				const connected = await tryConnectGitHubSource(
					client,
					APP,
					inspection(GITHUB_GIT),
					{
						offerInstall: true,
						interactive: true,
						wait: async () => ({
							githubId: "gh_new",
							owner: "acme",
							repository: "site",
						}),
					},
				);

				expect(connected).toBe(true);
				expect(calls.saved[0]).toMatchObject({
					githubId: "gh_new",
					owner: "acme",
					repository: "site",
					branch: "main",
				});
			} finally {
				confirmDefaultYes.mockRestore();
			}
		});

		it("uploads when the person declines", async () => {
			const { client, calls } = makeClient([]);
			let waited = false;

			const { confirmDefaultYes } = await stubConfirm(false);
			try {
				const connected = await tryConnectGitHubSource(
					client,
					APP,
					inspection(GITHUB_GIT),
					{
						offerInstall: true,
						interactive: true,
						wait: async () => {
							waited = true;
							return undefined;
						},
					},
				);

				expect(connected).toBe(false);
				expect(waited).toBe(false);
				expect(calls.saved).toHaveLength(0);
			} finally {
				confirmDefaultYes.mockRestore();
			}
		});
	});
});

async function stubConfirm(answer: boolean) {
	const { vi } = await import("vitest");
	const inquirer = (await import("inquirer")).default;
	const confirmDefaultYes = vi
		.spyOn(inquirer, "prompt")
		.mockResolvedValue({ confirmed: answer } as never);
	return { confirmDefaultYes };
}
