import { describe, expect, it } from "vitest";
import { parseGitHubRemote } from "../src/commands/deploy";

/**
 * `parseGitHubRemote` feeds `saveGithubProvider`, so a wrong parse binds an app
 * to the wrong repository. The remote URL is read straight out of `.git/config`,
 * which means every spelling git itself accepts has to round-trip.
 */
describe("parseGitHubRemote", () => {
	it("parses HTTPS remotes with and without the .git suffix", () => {
		expect(parseGitHubRemote("https://github.com/tarout-sa/cli.git")).toEqual({
			owner: "tarout-sa",
			repository: "cli",
		});
		expect(parseGitHubRemote("https://github.com/tarout-sa/cli")).toEqual({
			owner: "tarout-sa",
			repository: "cli",
		});
	});

	it("parses SSH remotes in scp and ssh:// form", () => {
		expect(parseGitHubRemote("git@github.com:tarout-sa/cli.git")).toEqual({
			owner: "tarout-sa",
			repository: "cli",
		});
		expect(
			parseGitHubRemote("ssh://git@github.com/tarout-sa/cli.git"),
		).toEqual({ owner: "tarout-sa", repository: "cli" });
	});

	it("tolerates a trailing slash and mixed case host", () => {
		expect(parseGitHubRemote("https://GitHub.com/tarout-sa/cli/")).toEqual({
			owner: "tarout-sa",
			repository: "cli",
		});
	});

	it("keeps dots and dashes inside the repository name", () => {
		expect(parseGitHubRemote("https://github.com/acme/my.app-v2.git")).toEqual({
			owner: "acme",
			repository: "my.app-v2",
		});
	});

	it("returns undefined for non-GitHub or missing remotes", () => {
		expect(parseGitHubRemote(undefined)).toBeUndefined();
		expect(parseGitHubRemote("")).toBeUndefined();
		expect(
			parseGitHubRemote("https://gitlab.com/tarout-sa/cli.git"),
		).toBeUndefined();
		expect(
			parseGitHubRemote("git@bitbucket.org:tarout-sa/cli.git"),
		).toBeUndefined();
		// A bare host with no owner/repo must not produce a half-filled binding.
		expect(parseGitHubRemote("https://github.com/")).toBeUndefined();
		expect(parseGitHubRemote("https://github.com/onlyowner")).toBeUndefined();
	});
});
