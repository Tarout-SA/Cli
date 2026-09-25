import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { openInBrowser } from "../lib/browser.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
import {
	findRepoAccess,
	type GitHubRepoRef,
	gitHubSetupUrl,
	readGitHubProviders,
	waitForRepoAccess,
} from "../lib/github-source.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import {
	type AppSummary,
	bindGitHubRepo,
	findApp,
	inspectCurrentProject,
	parseGitHubRemote,
} from "./deploy.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerProvidersCommands(program: Command) {
	const providers = program
		.command("providers")
		.description("Manage Git providers (GitHub, GitLab)");

	// ── List all providers ──────────────────────────────────────────────────────
	providers
		.command("list")
		.alias("ls")
		.description("List all connected Git providers")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching providers...");
				const all = await client.gitProvider.allProviders.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(all);
					return;
				}

				// gitProvider.allProviders returns an OBJECT keyed by provider type:
				// { github: [...], gitlab: [...], bitbucket: [...], gitea: [...] }.
				// Each entry nests the git_provider record (name/id) plus a
				// provider-specific id (githubId/gitlabId/bitbucketId/giteaId).
				const grouped = (all as any) || {};
				const rows: string[][] = [];
				const pushRows = (type: string, entries: any[], idKey: string) => {
					for (const entry of entries || []) {
						const gp = entry.git_provider || entry.gitProvider || {};
						rows.push([
							colors.cyan(type),
							gp.name || "-",
							colors.dim(entry[idKey] || gp.gitProviderId || "-"),
						]);
					}
				};
				pushRows("github", grouped.github, "githubId");
				pushRows("gitlab", grouped.gitlab, "gitlabId");
				pushRows("bitbucket", grouped.bitbucket, "bitbucketId");
				pushRows("gitea", grouped.gitea, "giteaId");

				if (rows.length === 0) {
					log("");
					log("No Git providers connected.");
					log("");
					log(
						`Connect one with: ${colors.dim("tarout providers github connect")}`,
					);
					return;
				}

				log("");
				table(["TYPE", "NAME", "ID"], rows);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── List with full details ───────────────────────────────────────────────
	providers
		.command("list-all")
		.description("List all Git providers with full connection details")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching providers...");
				const all = await client.gitProvider.getAll.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(all);
					return;
				}
				const list = Array.isArray(all) ? all : [];
				if (list.length === 0) {
					log("\nNo Git providers connected.\n");
					return;
				}
				log("");
				table(
					["TYPE", "NAME", "ID", "CREATED"],
					list.map((p: any) => [
						colors.cyan(p.providerType || p.type || "-"),
						p.name || "-",
						colors.dim(p.gitProviderId || p.id || "-"),
						p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Remove a provider ──────────────────────────────────────────────────────
	providers
		.command("remove <provider-id>")
		.alias("rm")
		.description("Remove a connected Git provider")
		.action(async (gitProviderId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Remove provider "${gitProviderId}"?`,
						false,
						{
							field: "confirm_remove_provider",
							flag: "--yes",
							context: { gitProviderId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Removing provider...");
				await client.gitProvider.remove.mutate({ gitProviderId });
				succeedSpinner("Provider removed.");
				if (isJsonMode()) outputData({ removed: true, gitProviderId });
				else quietOutput(gitProviderId);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ══ GitHub sub-group ═════════════════════════════════════════════════════════
	const github = providers
		.command("github")
		.description("Manage GitHub providers");

	github
		.command("connect")
		.description(
			"Connect GitHub so pushes deploy: opens Tarout's GitHub setup page, and with --app binds this folder's repo",
		)
		.option(
			"--wait",
			"Wait until GitHub is connected (with --app or --repo: until it can read that repo)",
		)
		.option(
			"--app <app>",
			"Put this app on push-to-deploy from this folder's GitHub repo (implies --wait)",
		)
		.option(
			"--repo <owner/repo>",
			"Repository to wait for or bind (defaults to this folder's GitHub remote)",
		)
		.option(
			"--branch <branch>",
			"Branch to bind with --app (defaults to the checked-out branch)",
		)
		.option(
			"--timeout <seconds>",
			"How long --wait waits for the browser step",
			"480",
		)
		.option("--no-open", "Print the setup URL instead of opening the browser")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				await connectGitHub(options);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	github
		.command("list")
		.alias("ls")
		.description("List GitHub providers")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching GitHub providers...");
				const list = await client.github.githubProviders.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(list);
					return;
				}

				const items = Array.isArray(list) ? list : [];
				if (items.length === 0) {
					log("");
					log("No GitHub providers found.");
					return;
				}

				log("");
				table(
					["NAME", "ID", "GITHUB ID"],
					items.map((p: any) => [
						p.name || "-",
						colors.dim(p.githubId || "-"),
						p.gitProviderId || "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	github
		.command("info <github-id>")
		.description("Show a GitHub provider")
		.action(async (githubId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching provider...");
				const data = await client.github.one.query({ githubId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const p = data as any;
				quietOutput(p.githubId || githubId);
				log("");
				log(colors.bold(p.name || githubId));
				log(`  ID:            ${colors.dim(p.githubId || "-")}`);
				log(`  Provider ID:   ${colors.dim(p.gitProviderId || "-")}`);
				log(`  App ID:        ${p.gitHubAppId || "-"}`);
				log(`  Install ID:    ${p.gitHubInstallationId || "-"}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	github
		.command("repos <github-id>")
		.description("List repositories for a GitHub provider")
		.action(async (githubId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching repositories...");
				const repos = await client.github.getGithubRepositories.query({
					githubId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(repos);
					return;
				}
				const list = Array.isArray(repos) ? repos : [];
				if (list.length === 0) {
					log("No repositories found.");
					return;
				}
				log("");
				table(
					["FULL NAME", "PRIVATE", "DEFAULT BRANCH"],
					list.map((r: any) => [
						colors.cyan(r.full_name || r.name || "-"),
						r.private ? "yes" : "no",
						r.default_branch || "-",
					]),
				);
				log("");
				log(colors.dim(`${list.length} repo${list.length === 1 ? "" : "s"}`));
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	github
		.command("branches <github-id> <owner> <repo>")
		.description("List branches for a GitHub repository")
		.action(async (githubId: string, owner: string, repo: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching branches...");
				const branches = await client.github.getGithubBranches.query({
					githubId,
					owner,
					repo,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(branches);
					return;
				}
				const list = Array.isArray(branches) ? branches : [];
				for (const b of list) quietOutput(b.name || b);
				log("");
				list.forEach((b: any) => log(`  ${b.name || b}`));
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	github
		.command("test <github-id>")
		.description("Test a GitHub provider connection")
		.action(async (githubId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Testing connection...");
				const result = await client.github.testConnection.mutate({ githubId });
				succeedSpinner("Connection successful.");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	github
		.command("update <github-id>")
		.description("Update a GitHub provider name")
		.option("-n, --name <name>", "New name")
		.option("--app-name <appName>", "GitHub App name (defaults to current)")
		.action(
			async (
				githubId: string,
				options: { name?: string; appName?: string },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const name =
						options.name ||
						(await input("New name for this provider:", undefined, {
							field: "provider_name",
							flag: "--name",
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Updating provider...");
					// Fetch to get gitProviderId + current githubAppName (both required by
					// apiUpdateGithub). githubAppName can be overridden with --app-name.
					const data = (await client.github.one.query({ githubId })) as any;
					await client.github.update.mutate({
						githubId,
						gitProviderId: data.gitProviderId,
						name,
						githubAppName: options.appName || data.githubAppName,
					});
					succeedSpinner("Provider updated.");
					if (isJsonMode()) outputData({ updated: true, githubId });
					else quietOutput(githubId);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ══ GitLab sub-group ══════════════════════════════════════════════════════════
	const gitlab = providers
		.command("gitlab")
		.description("Manage GitLab providers");

	gitlab
		.command("list")
		.alias("ls")
		.description("List GitLab providers")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching GitLab providers...");
				const list = await client.gitlab.gitlabProviders.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(list);
					return;
				}
				const items = Array.isArray(list) ? list : [];
				if (items.length === 0) {
					log("No GitLab providers found.");
					return;
				}
				log("");
				table(
					["NAME", "ID", "URL"],
					items.map((p: any) => [
						p.name || "-",
						colors.dim(p.gitlabId || "-"),
						p.gitlabUrl || "gitlab.com",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	gitlab
		.command("create")
		.description("Create a GitLab provider")
		.option("-n, --name <name>", "Display name for this provider")
		.option("--application-id <id>", "OAuth Application ID")
		.option("--secret <secret>", "OAuth Secret")
		.option("--gitlab-url <url>", "GitLab instance URL (default: gitlab.com)")
		.option("--group <group>", "GitLab group name")
		.option("--auth-id <id>", "Git auth id (defaults to the current user's id)")
		.action(
			async (options: {
				name?: string;
				applicationId?: string;
				secret?: string;
				gitlabUrl?: string;
				group?: string;
				authId?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const name =
						options.name ||
						(await input("Display name for this provider:", undefined, {
							field: "provider_name",
							flag: "--name",
						}));
					const applicationId =
						options.applicationId ||
						(await input("GitLab OAuth Application ID:", undefined, {
							field: "gitlab_application_id",
							flag: "--application-id",
						}));
					const secret =
						options.secret ||
						(await input("GitLab OAuth Secret:", undefined, {
							field: "gitlab_oauth_secret",
							flag: "--secret",
							sensitive: true,
						}));
					const client = getApiClient();
					// authId is a required field on apiCreateGitlab; the dashboard sources
					// it from the current user's id (api.user.get). Resolve the same way.
					const authId = options.authId || (await resolveAuthId(client));
					const _spinner = startSpinner("Creating GitLab provider...");
					const result = await client.gitlab.create.mutate({
						name,
						authId,
						applicationId,
						secret,
						gitlabUrl: options.gitlabUrl || "https://gitlab.com",
						groupName: options.group,
					} as any);
					succeedSpinner("GitLab provider created.");
					if (isJsonMode()) outputData(result);
					else quietOutput((result as any).gitlabId || "created");
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	gitlab
		.command("info <gitlab-id>")
		.description("Show a GitLab provider")
		.action(async (gitlabId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching provider...");
				const data = await client.gitlab.one.query({ gitlabId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const p = data as any;
				quietOutput(p.gitlabId || gitlabId);
				log("");
				log(colors.bold(p.name || gitlabId));
				log(`  ID:       ${colors.dim(p.gitlabId || "-")}`);
				log(`  URL:      ${p.gitlabUrl || "gitlab.com"}`);
				log(`  Group:    ${p.groupName || "-"}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	gitlab
		.command("repos <gitlab-id>")
		.description("List repositories for a GitLab provider")
		.action(async (gitlabId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching repositories...");
				const repos = await client.gitlab.getGitlabRepositories.query({
					gitlabId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(repos);
					return;
				}
				const list = Array.isArray(repos) ? repos : [];
				log("");
				table(
					["NAME", "VISIBILITY", "DEFAULT BRANCH"],
					list.map((r: any) => [
						colors.cyan(r.path_with_namespace || r.name || "-"),
						r.visibility || "-",
						r.default_branch || "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	gitlab
		.command("branches <gitlab-id> <owner> <repo>")
		.description("List branches for a GitLab repository")
		.action(async (gitlabId: string, owner: string, repo: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching branches...");
				const branches = await client.gitlab.getGitlabBranches.query({
					gitlabId,
					owner,
					repo,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(branches);
					return;
				}
				const list = Array.isArray(branches) ? branches : [];
				for (const b of list) quietOutput(b.name || b);
				log("");
				list.forEach((b: any) => log(`  ${b.name || b}`));
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	gitlab
		.command("test <gitlab-id>")
		.description("Test a GitLab provider connection")
		.action(async (gitlabId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Testing connection...");
				const result = await client.gitlab.testConnection.mutate({ gitlabId });
				succeedSpinner("Connection successful.");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	gitlab
		.command("update <gitlab-id>")
		.description("Update a GitLab provider")
		.option("-n, --name <name>", "New display name")
		.option("--application-id <id>", "New OAuth Application ID")
		.option("--secret <secret>", "New OAuth Secret")
		.option("--gitlab-url <url>", "New GitLab instance URL")
		.option("--group <group>", "New group name")
		.action(
			async (
				gitlabId: string,
				options: {
					name?: string;
					applicationId?: string;
					secret?: string;
					gitlabUrl?: string;
					group?: string;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Updating GitLab provider...");
					const data = (await client.gitlab.one.query({ gitlabId })) as any;
					// apiUpdateGitlab requires name (min 1) and gitlabUrl (valid URL) in
					// addition to gitlabId/gitProviderId — preserve current values when
					// the caller doesn't override them.
					await client.gitlab.update.mutate({
						gitlabId,
						gitProviderId: data.gitProviderId,
						name: options.name || data.git_provider?.name || data.name,
						applicationId: options.applicationId || data.application_id,
						secret: options.secret,
						gitlabUrl:
							options.gitlabUrl || data.gitlabUrl || "https://gitlab.com",
						groupName: options.group || data.group_name,
					} as any);
					succeedSpinner("GitLab provider updated.");
					if (isJsonMode()) outputData({ updated: true, gitlabId });
					else quietOutput(gitlabId);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ══ Bitbucket sub-group ═══════════════════════════════════════════════════════
	const bitbucket = providers
		.command("bitbucket")
		.description("Manage Bitbucket providers");

	bitbucket
		.command("list")
		.alias("ls")
		.description("List Bitbucket providers")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching Bitbucket providers...");
				const list = await client.bitbucket.bitbucketProviders.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(list);
					return;
				}
				const items = Array.isArray(list) ? list : [];
				if (items.length === 0) {
					log("No Bitbucket providers found.");
					return;
				}
				log("");
				table(
					["NAME", "ID", "WORKSPACE"],
					items.map((p: any) => [
						p.name || "-",
						colors.dim(p.bitbucketId || "-"),
						p.bitbucketWorkspaceName || "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// Bitbucket is retired as a Git provider — GitHub and GitLab only. `create`
	// and `update` are removed; the platform also drops bitbucket.create /
	// bitbucket.update from the agent surface, so `tarout call` cannot reach
	// them either. The read commands below stay so an org with a live
	// connection can still inspect the credential its deploys depend on.

	bitbucket
		.command("info <bitbucket-id>")
		.description("Show a Bitbucket provider")
		.action(async (bitbucketId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching provider...");
				const data = await client.bitbucket.one.query({ bitbucketId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const p = data as any;
				quietOutput(p.bitbucketId || bitbucketId);
				log("");
				log(colors.bold(p.name || bitbucketId));
				log(`  ID:        ${colors.dim(p.bitbucketId || "-")}`);
				log(`  Workspace: ${p.bitbucketWorkspaceName || "-"}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	bitbucket
		.command("repos <bitbucket-id>")
		.description("List repositories for a Bitbucket provider")
		.action(async (bitbucketId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching repositories...");
				const repos = await client.bitbucket.getBitbucketRepositories.query({
					bitbucketId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(repos);
					return;
				}
				const list = Array.isArray(repos) ? repos : [];
				log("");
				table(
					["FULL NAME", "PRIVATE", "LANGUAGE"],
					list.map((r: any) => [
						colors.cyan(r.full_name || r.name || "-"),
						r.is_private ? "yes" : "no",
						r.language || "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	bitbucket
		.command("branches <bitbucket-id> <owner> <repo>")
		.description("List branches for a Bitbucket repository")
		.action(async (bitbucketId: string, owner: string, repo: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching branches...");
				const branches = await client.bitbucket.getBitbucketBranches.query({
					bitbucketId,
					owner,
					repo,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(branches);
					return;
				}
				const list = Array.isArray(branches) ? branches : [];
				for (const b of list) quietOutput(b.name || b);
				log("");
				list.forEach((b: any) => log(`  ${b.name || b}`));
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	bitbucket
		.command("test <bitbucket-id>")
		.description("Test a Bitbucket provider connection")
		.action(async (bitbucketId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Testing connection...");
				const result = await client.bitbucket.testConnection.mutate({
					bitbucketId,
				});
				succeedSpinner("Connection successful.");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	void select; // suppress unused import warning
}

/**
 * Resolves the `authId` required by the gitlab/bitbucket create procedures.
 * The dashboard forms source this from `api.user.get` (the current user's id),
 * and the create services only require it to be a non-empty string. Mirror
 * that here so the CLI create flows satisfy validation without a web step.
 */
async function resolveAuthId(client: any): Promise<string> {
	const me = (await client.user.get.query()) as any;
	return me?.userId || me?.user?.id || me?.id || "";
}

interface ConnectGitHubOptions {
	wait?: boolean;
	app?: string;
	repo?: string;
	branch?: string;
	timeout?: string;
	open?: boolean;
}

function parseRepoArg(value: string): GitHubRepoRef {
	const parsed =
		parseGitHubRemote(value) ??
		(() => {
			const [owner, repository, extra] = value.trim().split("/");
			return owner && repository && !extra ? { owner, repository } : undefined;
		})();
	if (!parsed) {
		throw new InvalidArgumentError(
			`--repo must be "owner/name" or a GitHub URL (got "${value}").`,
		);
	}
	return parsed;
}

/**
 * `tarout providers github connect`.
 *
 * Installing a GitHub App is an authorization on github.com, so a person
 * clicks through it. Everything around that click is done here: open the page
 * (in `--json` mode too, as checkout does), wait until the connection can read
 * the repo, then bind the app. An agent runs this one command and the app is
 * on push-to-deploy when it returns.
 */
async function connectGitHub(options: ConnectGitHubOptions): Promise<void> {
	const url = gitHubSetupUrl();
	const noOpen = options.open === false;
	const waiting = Boolean(options.wait || options.app);

	if (!waiting) {
		const opened = noOpen ? false : await openSetupPage(url);
		if (isJsonMode()) {
			outputData({
				action: "connect_github_provider",
				url,
				opened,
				next: "Finish connecting GitHub in the browser, then run: tarout providers github connect --wait --app <app>",
			});
			return;
		}
		log("");
		log("Finish connecting GitHub in the browser, then put an app on push-to-deploy:");
		log(`  ${colors.dim("tarout providers github connect --wait --app <app>")}`);
		log("");
		return;
	}

	const timeoutSec = Number(options.timeout ?? "480");
	if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
		throw new InvalidArgumentError("--timeout must be a positive number of seconds.");
	}

	const client = getApiClient();
	const inspection = inspectCurrentProject();

	let app: AppSummary | undefined;
	if (options.app) {
		const apps: AppSummary[] = await client.application.allByOrganization.query();
		app = findApp(apps, options.app);
		if (!app) throw new NotFoundError("Application", options.app);
	}

	const repo = options.repo
		? parseRepoArg(options.repo)
		: app
			? inspection.git.githubRepo
			: undefined;
	if (app && !repo) {
		throw new InvalidArgumentError(
			"This folder has no GitHub remote. Run it from the repo's folder or pass --repo owner/name.",
		);
	}
	const branch = options.branch ?? inspection.git.branch;
	if (app && !branch) {
		throw new InvalidArgumentError(
			"No branch is checked out here (detached HEAD). Pass --branch <branch>.",
		);
	}

	if (!repo) {
		const connected = await waitForAnyConnection(client, url, {
			timeoutMs: timeoutSec * 1000,
			noOpen,
		});
		if (isJsonMode()) {
			outputData({ connected: true, providers: connected });
		} else {
			succeedSpinner("GitHub is connected.");
		}
		return;
	}

	const name = `${repo.owner}/${repo.repository}`;
	let access = (await findRepoAccess(client, repo)).access;
	if (!access) {
		access = await waitForRepoAccess(client, repo, {
			timeoutMs: timeoutSec * 1000,
			noOpen,
			openUrl: openSetupPage,
			onWaiting: ({ opened }) => announceWaiting(url, opened, name, timeoutSec),
		});
	}
	if (!access) {
		throw new CliError(
			`GitHub could not read ${name} after ${timeoutSec}s.`,
			ExitCode.GENERAL_ERROR,
			[
				`Finish the GitHub step at ${url} (install the app and give it access to ${name}), then rerun this command.`,
			],
			{ reason: "github_connect_timeout", url, repository: name },
		);
	}
	succeedSpinner(`GitHub can read ${access.owner}/${access.repository}.`);

	if (!app || !branch) {
		if (isJsonMode()) {
			outputData({
				connected: true,
				repository: `${access.owner}/${access.repository}`,
				next: `tarout providers github connect --wait --app <app> --repo ${access.owner}/${access.repository}`,
			});
		}
		return;
	}

	const bound = await bindGitHubRepo(client, app, access, branch);
	if (!bound) {
		throw new CliError(
			`Could not connect ${app.name} to ${access.owner}/${access.repository}.`,
		);
	}
	if (isJsonMode()) {
		outputData({
			connected: true,
			applicationId: app.applicationId,
			repository: `${access.owner}/${access.repository}`,
			branch,
			pushToDeploy: true,
			next: `Push to ${branch} to deploy, or run: tarout deploy ${app.applicationId} --wait`,
		});
		return;
	}
	log(
		`Run ${colors.dim(`tarout deploy ${app.name} --wait`)} to build from GitHub now, or just push.`,
	);
	log("");
}

async function openSetupPage(url: string): Promise<boolean> {
	return openInBrowser(url, {
		hint: "Connect GitHub on this page (if the browser didn't open, visit it):",
	});
}

function announceWaiting(
	url: string,
	opened: boolean,
	repository: string,
	timeoutSec: number,
): void {
	if (isJsonMode()) {
		outputJsonLine({
			type: "event",
			event: "github_connect_waiting",
			url,
			opened,
			repository,
			timeoutSec,
		});
		return;
	}
	startSpinner(
		`Waiting for GitHub to grant access to ${repository}. Finish it in the browser...`,
	);
}

async function waitForAnyConnection(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	url: string,
	opts: { timeoutMs: number; noOpen: boolean },
): Promise<number> {
	const existing = readGitHubProviders(await client.github.githubProviders.query());
	if (existing.length > 0) return existing.length;

	const opened = opts.noOpen ? false : await openSetupPage(url);
	if (isJsonMode()) {
		outputJsonLine({
			type: "event",
			event: "github_connect_waiting",
			url,
			opened,
			timeoutSec: Math.round(opts.timeoutMs / 1000),
		});
	} else {
		startSpinner("Waiting for GitHub. Finish connecting it in the browser...");
	}
	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		try {
			const list = readGitHubProviders(await client.github.githubProviders.query());
			if (list.length > 0) return list.length;
		} catch {
			// A dropped poll is not an answer; keep waiting.
		}
	}
	throw new CliError(
		`GitHub was not connected within ${Math.round(opts.timeoutMs / 1000)}s.`,
		ExitCode.GENERAL_ERROR,
		[`Finish the GitHub step at ${url}, then rerun this command.`],
		{ reason: "github_connect_timeout", url },
	);
}
