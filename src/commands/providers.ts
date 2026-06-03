import type { Command } from "commander";
import open from "open";
import { getApiClient } from "../lib/api.js";
import { getApiUrl, isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerProvidersCommands(program: Command) {
	const providers = program
		.command("providers")
		.description("Manage Git providers (GitHub, GitLab, Bitbucket)");

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

				const list = Array.isArray(all) ? all : [];
				if (list.length === 0) {
					log("");
					log("No Git providers connected.");
					log("");
					log(
						`Connect one with: ${colors.dim("tarout providers github connect")}`,
					);
					return;
				}

				log("");
				table(
					["TYPE", "NAME", "ID"],
					list.map((p: any) => [
						colors.cyan(p.type || p.provider || "-"),
						p.name || p.gitProviderName || "-",
						colors.dim(p.gitProviderId || p.id || "-"),
					]),
				);
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
		.description("Open Tarout's GitHub provider setup flow")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const url = `${getApiUrl().replace(/\/+$/, "")}/dashboard/settings/git-providers`;
				if (isJsonMode()) {
					outputData({
						action: "connect_github_provider",
						url,
						next: "Complete the browser flow, then run tarout apps git github <app> --repo <owner/repo> or tarout deploy <app> --source configured.",
					});
					return;
				}

				log("");
				log(`Opening Tarout Git provider setup: ${colors.cyan(url)}`);
				log(
					"Complete the GitHub browser flow, then connect the repository to your app.",
				);
				await open(url);
			} catch (err) {
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
		.action(async (githubId: string, options: { name?: string }) => {
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
				// Fetch to get gitProviderId
				const data = (await client.github.one.query({ githubId })) as any;
				await client.github.update.mutate({
					githubId,
					gitProviderId: data.gitProviderId,
					name,
				});
				succeedSpinner("Provider updated.");
				if (isJsonMode()) outputData({ updated: true, githubId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

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
		.option("--application-id <id>", "OAuth Application ID")
		.option("--secret <secret>", "OAuth Secret")
		.option("--gitlab-url <url>", "GitLab instance URL (default: gitlab.com)")
		.option("--group <group>", "GitLab group name")
		.action(
			async (options: {
				applicationId?: string;
				secret?: string;
				gitlabUrl?: string;
				group?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
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
					const _spinner = startSpinner("Creating GitLab provider...");
					const result = await client.gitlab.create.mutate({
						applicationId,
						secret,
						gitlabUrl: options.gitlabUrl,
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
		.option("--application-id <id>", "New OAuth Application ID")
		.option("--secret <secret>", "New OAuth Secret")
		.option("--gitlab-url <url>", "New GitLab instance URL")
		.option("--group <group>", "New group name")
		.action(
			async (
				gitlabId: string,
				options: {
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
					await client.gitlab.update.mutate({
						gitlabId,
						gitProviderId: data.gitProviderId,
						applicationId: options.applicationId || data.applicationId,
						secret: options.secret,
						gitlabUrl: options.gitlabUrl || data.gitlabUrl,
						groupName: options.group || data.groupName,
					} as any);
					succeedSpinner("GitLab provider updated.");
					if (isJsonMode()) outputData({ updated: true, gitlabId });
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

	bitbucket
		.command("create")
		.description("Create a Bitbucket provider")
		.option("--client-id <id>", "Bitbucket OAuth Client ID")
		.option("--secret <secret>", "Bitbucket OAuth Secret")
		.action(async (options: { clientId?: string; secret?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const appPassword =
					options.secret ||
					(await input("Bitbucket App Password or Secret:", undefined, {
						field: "bitbucket_oauth_secret",
						flag: "--secret",
						sensitive: true,
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Creating Bitbucket provider...");
				const result = await client.bitbucket.create.mutate({
					bitbucketClientId: options.clientId,
					bitbucketClientSecret: appPassword,
				} as any);
				succeedSpinner("Bitbucket provider created.");
				if (isJsonMode()) outputData(result);
				else quietOutput((result as any).bitbucketId || "created");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

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

	bitbucket
		.command("update <bitbucket-id>")
		.description("Update a Bitbucket provider")
		.option("--client-id <id>", "New Client ID")
		.option("--secret <secret>", "New Client Secret")
		.action(
			async (
				bitbucketId: string,
				options: { clientId?: string; secret?: string },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Updating Bitbucket provider...");
					const data = (await client.bitbucket.one.query({
						bitbucketId,
					})) as any;
					await client.bitbucket.update.mutate({
						bitbucketId,
						gitProviderId: data.gitProviderId,
						bitbucketClientId: options.clientId,
						bitbucketClientSecret: options.secret,
					} as any);
					succeedSpinner("Bitbucket provider updated.");
					if (isJsonMode()) outputData({ updated: true, bitbucketId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	void select; // suppress unused import warning
}
