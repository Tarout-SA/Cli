import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeDeploySource,
	findRepoAccess,
	readLocalGitState,
	unshippedWorkWarnings,
	waitForRepoAccess,
} from "../src/lib/github-source";

const REPO = { owner: "acme", repository: "site" };

function clientWith(
	providers: () => unknown,
	repos: Record<string, string[]>,
): never {
	return {
		github: {
			githubProviders: { query: async () => providers() },
			getGithubRepositories: {
				query: async ({ githubId }: { githubId: string }) => {
					const list = repos[githubId];
					if (!list) throw new Error("unreadable");
					return list.map((full_name) => ({ full_name }));
				},
			},
		},
	} as never;
}

describe("findRepoAccess", () => {
	it("reports the connection count even when none can read the repo", async () => {
		const client = clientWith(() => [{ githubId: "gh_1" }], {
			gh_1: ["acme/other"],
		});
		expect(await findRepoAccess(client, REPO)).toEqual({ providers: 1 });
	});

	it("matches owner/name case-insensitively and returns GitHub's spelling", async () => {
		const client = clientWith(() => [{ githubId: "gh_1" }], {
			gh_1: ["ACME/Site"],
		});
		expect((await findRepoAccess(client, REPO)).access).toEqual({
			githubId: "gh_1",
			owner: "ACME",
			repository: "Site",
		});
	});

	it("skips a connection whose repositories cannot be listed", async () => {
		const client = clientWith(
			() => [{ githubId: "broken" }, { githubId: "gh_2" }],
			{ gh_2: ["acme/site"] },
		);
		expect((await findRepoAccess(client, REPO)).access?.githubId).toBe("gh_2");
	});
});

describe("waitForRepoAccess", () => {
	function clock() {
		let t = 0;
		return {
			now: () => t,
			sleep: async (ms: number) => {
				t += ms;
			},
		};
	}

	it("opens the setup page once and returns as soon as the repo is readable", async () => {
		let polls = 0;
		const client = clientWith(
			() => {
				polls++;
				return polls >= 3 ? [{ githubId: "gh_1" }] : [];
			},
			{ gh_1: ["acme/site"] },
		);
		const opened: string[] = [];
		const { now, sleep } = clock();

		const access = await waitForRepoAccess(client, REPO, {
			timeoutMs: 60_000,
			pollIntervalMs: 1000,
			openUrl: async (url) => {
				opened.push(url);
				return true;
			},
			now,
			sleep,
		});

		expect(access?.githubId).toBe("gh_1");
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatch(/\/dashboard\/settings\/git-providers$/);
		expect(polls).toBe(3);
	});

	it("keeps waiting while a connection exists but cannot read the repo yet", async () => {
		let polls = 0;
		const repos: Record<string, string[]> = { gh_1: ["acme/other"] };
		const client = clientWith(() => {
			polls++;
			// The person adds the repo to the installation on the third poll.
			if (polls === 3) repos.gh_1 = ["acme/other", "acme/site"];
			return [{ githubId: "gh_1" }];
		}, repos);
		const { now, sleep } = clock();

		const access = await waitForRepoAccess(client, REPO, {
			timeoutMs: 60_000,
			pollIntervalMs: 1000,
			openUrl: async () => true,
			now,
			sleep,
		});

		expect(access?.githubId).toBe("gh_1");
		expect(polls).toBe(3);
	});

	it("gives up at the deadline and survives dropped polls", async () => {
		const client = clientWith(() => {
			throw new Error("network");
		}, {});
		const { now, sleep } = clock();

		const access = await waitForRepoAccess(client, REPO, {
			timeoutMs: 5000,
			pollIntervalMs: 1000,
			openUrl: async () => true,
			now,
			sleep,
		});

		expect(access).toBeUndefined();
	});

	it("does not open a browser with noOpen", async () => {
		const client = clientWith(() => [{ githubId: "gh_1" }], {
			gh_1: ["acme/site"],
		});
		let opened = false;

		await waitForRepoAccess(client, REPO, {
			timeoutMs: 5000,
			noOpen: true,
			openUrl: async () => {
				opened = true;
				return true;
			},
		});

		expect(opened).toBe(false);
	});
});

describe("describeDeploySource", () => {
	it("says pushes deploy for a GitHub app with a repository", () => {
		expect(
			describeDeploySource({
				applicationId: "app_1",
				sourceType: "github",
				owner: "acme",
				repository: "site",
				branch: "main",
				autoDeploy: true,
			}),
		).toEqual({
			type: "github",
			repository: "acme/site",
			branch: "main",
			pushToDeploy: true,
		});
	});

	it("names the connect command for an uploaded app whose folder is on GitHub", () => {
		// The Bserah shape: sourceType drop, folder tracking a GitHub repo.
		expect(
			describeDeploySource(
				{ applicationId: "app_1", sourceType: "drop", repository: null },
				REPO,
			),
		).toEqual({
			type: "drop",
			repository: null,
			branch: null,
			pushToDeploy: false,
			githubRemote: "acme/site",
			next: "tarout providers github connect --wait --app app_1",
		});
	});

	it("does not count a GitHub app with no repository, or with auto-deploy off", () => {
		expect(
			describeDeploySource({ sourceType: "github", repository: null })
				.pushToDeploy,
		).toBe(false);
		expect(
			describeDeploySource({
				sourceType: "github",
				owner: "acme",
				repository: "site",
				autoDeploy: false,
			}).pushToDeploy,
		).toBe(false);
	});

	it("leaves out the hint when the folder has no GitHub remote", () => {
		const summary = describeDeploySource({ sourceType: "drop" });
		expect(summary.next).toBeUndefined();
		expect(summary.githubRemote).toBeUndefined();
	});
});

describe("readLocalGitState + unshippedWorkWarnings", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	function git(cwd: string, ...args: string[]) {
		execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	}

	/** A clone whose `main` has been pushed to a bare origin. */
	function pushedClone(): string {
		const root = mkdtempSync(join(tmpdir(), "tarout-gitstate-"));
		dirs.push(root);
		const origin = join(root, "origin.git");
		const work = join(root, "work");
		git(root, "init", "-q", "--bare", "-b", "main", origin);
		git(root, "init", "-q", "-b", "main", work);
		git(work, "config", "user.email", "t@example.com");
		git(work, "config", "user.name", "t");
		git(work, "config", "commit.gpgsign", "false");
		writeFileSync(join(work, "a.txt"), "a");
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "a");
		git(work, "remote", "add", "origin", origin);
		git(work, "push", "-q", "origin", "main");
		return work;
	}

	it("reports nothing for a clean, pushed branch", async () => {
		const work = pushedClone();
		const state = await readLocalGitState(work, "main", "main");
		expect(state).toEqual({
			remote: "origin",
			ahead: 0,
			uncommitted: 0,
			otherBranch: undefined,
			branchNotOnRemote: false,
		});
		expect(unshippedWorkWarnings(state, "main")).toEqual([]);
	});

	it("counts unpushed commits and uncommitted edits", async () => {
		const work = pushedClone();
		writeFileSync(join(work, "b.txt"), "b");
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "b");
		writeFileSync(join(work, "c.txt"), "c");

		const state = await readLocalGitState(work, "main", "main");
		expect(state?.ahead).toBe(1);
		expect(state?.uncommitted).toBe(1);
		const warnings = unshippedWorkWarnings(state, "main");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("1 local commit is not pushed to origin/main");
		expect(warnings[1]).toContain("1 uncommitted change is not in this deploy");
	});

	it("flags a branch the remote has never seen, and a different checkout", async () => {
		const work = pushedClone();
		const state = await readLocalGitState(work, "release", "main");
		expect(state?.branchNotOnRemote).toBe(true);
		expect(state?.otherBranch).toBe("main");
		const warnings = unshippedWorkWarnings(state, "release");
		expect(warnings.join("\n")).toContain("Branch release was not found on origin");
		expect(warnings.join("\n")).toContain("the app builds release");
	});

	it("compares against the remote that points at the repo, whatever it is called", async () => {
		const work = pushedClone();
		// Same history under a remote named `github` whose URL is the repo.
		git(work, "remote", "rename", "origin", "github");
		git(work, "remote", "set-url", "github", "git@github.com:acme/site.git");
		writeFileSync(join(work, "b.txt"), "b");
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", "b");

		const state = await readLocalGitState(work, "main", "main", REPO);
		expect(state?.remote).toBe("github");
		expect(state?.branchNotOnRemote).toBe(false);
		expect(state?.ahead).toBe(1);
		expect(unshippedWorkWarnings(state, "main")[0]).toContain(
			"not pushed to github/main",
		);
	});

	it("returns undefined outside a git repository", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tarout-nogit-"));
		dirs.push(dir);
		expect(await readLocalGitState(dir, "main", "main")).toBeUndefined();
		expect(unshippedWorkWarnings(undefined, "main")).toEqual([]);
	});
});
