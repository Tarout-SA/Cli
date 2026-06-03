import type { Command } from "commander";
import open from "open";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	NotFoundError,
} from "../lib/errors.js";
import {
	box,
	colors,
	error,
	getStatusBadge,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

interface AppSummary {
	appName?: string;
	applicationId: string;
	applicationStatus: string;
	createdAt: Date | string;
	domain?: string | Array<{ host: string }> | null;
	name: string;
}

export function registerAppsCommands(program: Command) {
	const apps = program.command("apps").description("Manage applications");

	// List applications
	apps
		.command("list")
		.alias("ls")
		.description("List all applications")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching applications...");

				const applications: AppSummary[] =
					await client.application.allByOrganization.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(applications);
					return;
				}

				if (applications.length === 0) {
					log("");
					log("No applications found.");
					log("");
					log(`Create one with: ${colors.dim("tarout apps create <name>")}`);
					return;
				}

				log("");
				table(
					["ID", "NAME", "STATUS", "DOMAIN", "CREATED"],
					applications.map((app) => [
						colors.cyan(app.applicationId.slice(0, 8)),
						app.name,
						getStatusBadge(app.applicationStatus),
						formatDomain(app.domain),
						formatDate(app.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${applications.length} application${applications.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Create application
	apps
		.command("create")
		.argument("[name]", "Application name")
		.description("Create a new application")
		.option("-d, --description <description>", "Application description")
		.action(async (name, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				// Interactive mode if no name provided
				let appName = name;
				let description = options.description;

				if (!appName) {
					appName = await input("Application name:", undefined, {
						field: "app_name",
						flag: "<name>",
					});
				}

				if (!description && !shouldSkipConfirmation()) {
					description = await input("Description (optional):", undefined, {
						field: "description",
						flag: "--description",
					});
				}

				// Generate appName (URL-safe slug)
				const slug = generateSlug(appName);

				const client = getApiClient();
				const _spinner = startSpinner("Creating application...");

				const application = await client.application.create.mutate({
					name: appName,
					appName: slug,
					description: description || undefined,
					organizationId: profile.organizationId,
				});

				succeedSpinner("Application created!");

				if (isJsonMode()) {
					outputData(application);
					return;
				}

				quietOutput(application.applicationId);

				box("Application Created", [
					`ID: ${colors.cyan(application.applicationId)}`,
					`Name: ${application.name}`,
					`Slug: ${application.appName}`,
				]);

				log("Next steps:");
				log(
					`  1. Connect a source: ${colors.dim(`tarout apps info ${application.applicationId.slice(0, 8)}`)}`,
				);
				log(
					`  2. Deploy: ${colors.dim(`tarout deploy ${application.applicationId.slice(0, 8)}`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Delete application
	apps
		.command("delete")
		.alias("rm")
		.argument("<app>", "Application ID or name")
		.description("Delete an application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				succeedSpinner();

				// Confirm deletion
				if (!shouldSkipConfirmation()) {
					log("");
					log(`Application: ${colors.bold(app.name)}`);
					log(`ID: ${colors.dim(app.applicationId)}`);
					log("");

					const confirmed = await confirm(
						`Are you sure you want to delete "${app.name}"? This cannot be undone.`,
						false,
						{
							field: "confirm_delete_app",
							flag: "--yes",
							context: { appName: app.name, applicationId: app.applicationId },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting application...");

				await client.application.delete.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner("Application deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, applicationId: app.applicationId });
				} else {
					quietOutput(app.applicationId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get application info
	apps
		.command("info")
		.argument("<app>", "Application ID or name")
		.description("Show application details")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// First, get the list to find the app ID
				const _spinner = startSpinner("Fetching application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				// Get full details
				const app = await client.application.one.query({
					applicationId: appSummary.applicationId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(app);
					return;
				}

				log("");
				log(colors.bold(app.name));
				log(colors.dim(app.applicationId));
				log("");

				// Status
				log(`${colors.bold("Status")}`);
				log(`  ${getStatusBadge(app.applicationStatus)}`);
				log("");

				// Source
				log(`${colors.bold("Source")}`);
				if (app.sourceType) {
					log(`  Type: ${app.sourceType}`);
					if (app.github) {
						log(`  Repository: ${app.github.repository}`);
						log(`  Branch: ${app.github.branch}`);
					} else if (app.gitlab) {
						log(`  Repository: ${app.gitlab.gitlabRepository}`);
						log(`  Branch: ${app.gitlab.gitlabBranch}`);
					} else if (app.bitbucket) {
						log(`  Repository: ${app.bitbucket.bitbucketRepository}`);
						log(`  Branch: ${app.bitbucket.bitbucketBranch}`);
					}
				} else {
					log(`  ${colors.dim("Not configured")}`);
				}
				log("");

				// Build
				log(`${colors.bold("Build")}`);
				log(`  Type: ${app.buildType || colors.dim("Not configured")}`);
				if (app.dockerfile) {
					log(`  Dockerfile: ${app.dockerfile}`);
				}
				log("");

				// Domain
				log(`${colors.bold("Domain")}`);
				if (app.domain && app.domain.length > 0) {
					for (const domain of app.domain) {
						log(`  ${domain.host}`);
					}
				} else {
					log(`  ${colors.dim("No custom domain")}`);
				}
				log("");

				// URL
				const appUrl = app.appSubdomain ? `https://${app.appSubdomain}` : null;
				if (appUrl) {
					log(`${colors.bold("URL")}`);
					log(`  ${appUrl}`);
					log("");
				}

				// Created
				log(`${colors.bold("Created")}`);
				log(`  ${new Date(app.createdAt).toLocaleString()}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Restart application
	apps
		.command("restart")
		.argument("<app>", "Application ID or name")
		.description("Restart a running application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				const _restartSpinner = startSpinner(`Restarting ${app.name}...`);

				await client.application.restart.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner(`${app.name} is restarting`);

				if (isJsonMode()) {
					outputData({ restarted: true, applicationId: app.applicationId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Stop application
	apps
		.command("stop")
		.argument("<app>", "Application ID or name")
		.description("Stop a running application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				if (!shouldSkipConfirmation()) {
					const { confirm } = await import("../utils/prompts.js");
					const confirmed = await confirm(
						`Stop application "${app.name}"?`,
						false,
						{
							field: "confirm_stop_app",
							flag: "--yes",
							context: { appName: app.name, applicationId: app.applicationId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _stopSpinner = startSpinner(`Stopping ${app.name}...`);

				await client.application.stop.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner(`${app.name} stopped`);

				if (isJsonMode()) {
					outputData({ stopped: true, applicationId: app.applicationId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Update application settings
	apps
		.command("update")
		.argument("<app>", "Application ID or name")
		.description("Update application settings")
		.option("-n, --name <name>", "New application name")
		.option("-d, --description <description>", "New description")
		.option("--subdomain <subdomain>", "Custom subdomain")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				const updates: Record<string, any> = {
					applicationId: app.applicationId,
				};

				if (options.name) updates.name = options.name;
				if (options.description) updates.description = options.description;

				if (options.subdomain) {
					// Use dedicated endpoint for custom subdomain
					const _updateSpinner = startSpinner("Updating custom subdomain...");
					await client.application.updateCustomSubdomain.mutate({
						applicationId: app.applicationId,
						customSubdomain: options.subdomain,
					});
					succeedSpinner("Subdomain updated!");
				} else if (Object.keys(updates).length > 1) {
					const _updateSpinner = startSpinner("Updating application...");
					await client.application.update.mutate(updates);
					succeedSpinner("Application updated!");
				} else {
					log(
						"No changes specified. Use --name, --description, or --subdomain.",
					);
					return;
				}

				if (isJsonMode()) {
					outputData({ updated: true, applicationId: app.applicationId });
				} else {
					quietOutput(app.applicationId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Configure git/source provider
	const git = apps
		.command("git")
		.description("Configure source provider for an application");

	// Connect GitHub
	git
		.command("github")
		.argument("<app>", "Application ID or name")
		.description("Connect a GitHub repository as source")
		.option("-r, --repo <owner/repo>", "Repository (e.g., myorg/myapp)")
		.option("-b, --branch <branch>", "Branch to deploy", "main")
		.option("--provider-id <id>", "GitHub connection ID (from dashboard)")
		.option("--build-path <path>", "Build path within repository", "/")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				let repo = options.repo;
				const branch = options.branch;

				if (!repo) {
					repo = await input("Repository (owner/repo):", undefined, {
						field: "github_repo",
						flag: "--repo",
					});
				}

				const [owner, repository] = (repo || "").split("/");
				if (!owner || !repository) {
					error("Repository must be in owner/repo format (e.g., myorg/myapp)");
					return;
				}

				// Get github providers if no provider-id given
				let githubId = options.providerId;
				if (!githubId) {
					const providers = await client.github.githubProviders.query();
					const providerList = providers?.providers || providers || [];
					if (Array.isArray(providerList) && providerList.length > 0) {
						if (providerList.length === 1) {
							githubId = providerList[0].githubId || providerList[0].id;
						} else {
							githubId = await select(
								"Select GitHub connection:",
								providerList.map((p: any) => ({
									name: p.name || p.login || p.githubId,
									value: p.githubId || p.id,
								})),
								{
									field: "github_provider_id",
									flag: "--provider-id",
								},
							);
						}
					}
				}

				const _configSpinner = startSpinner("Connecting GitHub repository...");

				await client.application.saveGithubProvider.mutate({
					applicationId: app.applicationId,
					repository,
					branch: branch || "main",
					owner,
					buildPath: options.buildPath || "/",
					githubId: githubId || "",
					watchPaths: null,
					enableSubmodules: false,
				});

				succeedSpinner("GitHub repository connected!");

				if (isJsonMode()) {
					outputData({ connected: true, repository: repo, branch });
				} else {
					box("GitHub Connected", [
						`Repository: ${colors.cyan(`${owner}/${repository}`)}`,
						`Branch: ${branch || "main"}`,
						`Application: ${app.name}`,
					]);
					log(`Deploy: ${colors.dim(`tarout deploy ${appIdentifier}`)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Connect GitLab
	git
		.command("gitlab")
		.argument("<app>", "Application ID or name")
		.description("Connect a GitLab repository as source")
		.option("-r, --repo <namespace/repo>", "Repository path")
		.option("-b, --branch <branch>", "Branch to deploy", "main")
		.option("--provider-id <id>", "GitLab connection ID")
		.option("--build-path <path>", "Build path", "/")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				let repo = options.repo;
				if (!repo) {
					repo = await input("Repository (namespace/repo):", undefined, {
						field: "gitlab_repo",
						flag: "--repo",
					});
				}

				const parts = (repo || "").split("/");
				const gitlabOwner = parts.slice(0, -1).join("/");
				const gitlabRepository = parts[parts.length - 1];

				let gitlabId = options.providerId;
				if (!gitlabId) {
					const providers = await client.gitlab.gitlabProviders.query();
					const providerList = providers?.providers || providers || [];
					if (Array.isArray(providerList) && providerList.length === 1) {
						gitlabId = providerList[0].gitlabId || providerList[0].id;
					} else if (Array.isArray(providerList) && providerList.length > 1) {
						gitlabId = await select(
							"Select GitLab connection:",
							providerList.map((p: any) => ({
								name: p.name || p.gitlabId,
								value: p.gitlabId || p.id,
							})),
							{
								field: "gitlab_provider_id",
								flag: "--provider-id",
							},
						);
					}
				}

				const _configSpinner = startSpinner("Connecting GitLab repository...");

				await client.application.saveGitlabProvider.mutate({
					applicationId: app.applicationId,
					gitlabRepository: gitlabRepository || repo,
					gitlabOwner: gitlabOwner || "",
					gitlabBranch: options.branch || "main",
					gitlabBuildPath: options.buildPath || "/",
					gitlabId: gitlabId || "",
					gitlabProjectId: null,
					gitlabPathNamespace: repo,
					watchPaths: null,
					enableSubmodules: false,
				});

				succeedSpinner("GitLab repository connected!");

				if (isJsonMode()) {
					outputData({ connected: true, repository: repo });
				} else {
					box("GitLab Connected", [
						`Repository: ${colors.cyan(repo)}`,
						`Branch: ${options.branch || "main"}`,
					]);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Connect Docker Hub
	git
		.command("docker-hub")
		.argument("<app>", "Application ID or name")
		.description("Deploy from a Docker Hub image")
		.option("-i, --image <image>", "Docker image (e.g., nginx, myorg/myapp)")
		.option("--username <username>", "Docker Hub username (for private images)")
		.option("--token <token>", "Docker Hub access token (for private images)")
		.option("--private", "Mark as private image")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				let image = options.image;
				if (!image) {
					image = await input(
						"Docker image (e.g., nginx:latest or myorg/app:1.0):",
						undefined,
						{
							field: "docker_image",
							flag: "--image",
						},
					);
				}

				const _configSpinner = startSpinner("Configuring Docker Hub...");

				await client.application.saveDockerHubProvider.mutate({
					applicationId: app.applicationId,
					dockerHubImage: image,
					dockerHubUsername: options.username,
					dockerHubAccessToken: options.token,
					dockerHubIsPrivate: options.private || false,
				});

				succeedSpinner("Docker Hub image configured!");

				if (isJsonMode()) {
					outputData({ configured: true, image });
				} else {
					box("Docker Hub Configured", [
						`Image: ${colors.cyan(image)}`,
						`Access: ${options.private ? colors.warn("private") : "public"}`,
					]);
					log(`Deploy: ${colors.dim(`tarout deploy ${appIdentifier}`)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Connect custom git URL
	git
		.command("url")
		.argument("<app>", "Application ID or name")
		.description("Connect a custom git URL as source")
		.option("-u, --url <git-url>", "Git repository URL")
		.option("-b, --branch <branch>", "Branch to deploy", "main")
		.option("--build-path <path>", "Build path", "/")
		.option("--ssh-key <key-id>", "SSH key ID for private repos")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				let gitUrl = options.url;
				if (!gitUrl) {
					gitUrl = await input("Git URL (https://... or git@...):", undefined, {
						field: "git_url",
						flag: "--url",
					});
				}

				const _configSpinner = startSpinner("Connecting git repository...");

				await client.application.saveGitProvider.mutate({
					applicationId: app.applicationId,
					customGitUrl: gitUrl,
					customGitBranch: options.branch || "main",
					customGitBuildPath: options.buildPath || "/",
					customGitSSHKeyId: options.sshKey || null,
					watchPaths: null,
					enableSubmodules: false,
				});

				succeedSpinner("Git repository connected!");

				if (isJsonMode()) {
					outputData({
						connected: true,
						url: gitUrl,
						branch: options.branch || "main",
					});
				} else {
					box("Git Connected", [
						`URL: ${colors.cyan(gitUrl)}`,
						`Branch: ${options.branch || "main"}`,
					]);
					log(`Deploy: ${colors.dim(`tarout deploy ${appIdentifier}`)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Disconnect git provider
	git
		.command("disconnect")
		.argument("<app>", "Application ID or name")
		.description("Disconnect source provider from application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				if (!shouldSkipConfirmation()) {
					const { confirm } = await import("../utils/prompts.js");
					const confirmed = await confirm(
						`Disconnect source provider from "${app.name}"?`,
						false,
						{
							field: "confirm_disconnect_git_provider",
							flag: "--yes",
							context: { appName: app.name, applicationId: app.applicationId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _disconnectSpinner = startSpinner("Disconnecting provider...");

				await client.application.disconnectGitProvider.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner("Provider disconnected!");

				if (isJsonMode()) {
					outputData({ disconnected: true, applicationId: app.applicationId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Build type configuration
	apps
		.command("build")
		.argument("<app>", "Application ID or name")
		.description("Configure build settings for an application")
		.option(
			"-t, --type <type>",
			"Build type: nixpacks, dockerfile, dockercompose, static",
		)
		.option("--dockerfile <path>", "Path to Dockerfile (for dockerfile type)")
		.option("--publish-dir <dir>", "Publish directory (for static sites)")
		.option("--static", "Mark as a static SPA")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				let buildType = options.type;
				if (!buildType) {
					buildType = await select(
						"Build type:",
						[
							{ name: "Nixpacks (auto-detect)", value: "nixpacks" },
							{ name: "Dockerfile", value: "dockerfile" },
							{ name: "Static / SPA", value: "static" },
						],
						{
							field: "build_type",
							flag: "--type",
						},
					);
				}

				const _configSpinner = startSpinner("Saving build configuration...");

				await client.application.saveBuildType.mutate({
					applicationId: app.applicationId,
					buildType,
					dockerfile: options.dockerfile || "/Dockerfile",
					publishDirectory: options.publishDir || "/",
					isStaticSpa: options.static || false,
				});

				succeedSpinner("Build configuration saved!");

				if (isJsonMode()) {
					outputData({ configured: true, buildType });
				} else {
					log("");
					log(`Build type: ${colors.cyan(buildType)}`);
					if (options.dockerfile) log(`Dockerfile: ${options.dockerfile}`);
					if (options.publishDir) log(`Publish dir: ${options.publishDir}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Connect Bitbucket repository
	git
		.command("bitbucket")
		.argument("<app>", "Application ID or name")
		.description("Connect a Bitbucket repository as source")
		.option("-r, --repo <owner/repo>", "Repository (e.g., myorg/myapp)")
		.option("-b, --branch <branch>", "Branch to deploy", "main")
		.option("--provider-id <id>", "Bitbucket connection ID")
		.option("--build-path <path>", "Build path within repository", "/")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				let repo = options.repo;
				if (!repo) {
					repo = await input("Repository (owner/repo):", undefined, {
						field: "bitbucket_repo",
						flag: "--repo",
					});
				}

				const parts = (repo || "").split("/");
				const bitbucketOwner = parts.slice(0, -1).join("/") || parts[0] || "";
				const bitbucketRepository = parts[parts.length - 1] || repo;

				let bitbucketId = options.providerId;
				if (!bitbucketId) {
					try {
						const providers = await client.bitbucket.bitbucketProviders.query();
						const providerList = Array.isArray(providers) ? providers : [];
						if (providerList.length === 1) {
							bitbucketId = providerList[0].bitbucketId || providerList[0].id;
						} else if (providerList.length > 1) {
							bitbucketId = await select(
								"Select Bitbucket connection:",
								providerList.map((p: any) => ({
									name: p.username || p.bitbucketId,
									value: p.bitbucketId || p.id,
								})),
								{
									field: "bitbucket_provider_id",
									flag: "--provider-id",
								},
							);
						}
					} catch {
						// ignore — bitbucketId optional
					}
				}

				const _configSpinner = startSpinner(
					"Connecting Bitbucket repository...",
				);

				await client.application.saveBitbucketProvider.mutate({
					applicationId: app.applicationId,
					bitbucketRepository,
					bitbucketOwner,
					bitbucketBranch: options.branch || "main",
					bitbucketBuildPath: options.buildPath || "/",
					bitbucketId: bitbucketId || "",
					watchPaths: null,
					enableSubmodules: false,
				});

				succeedSpinner("Bitbucket repository connected!");

				if (isJsonMode()) {
					outputData({ connected: true, repository: repo });
				} else {
					box("Bitbucket Connected", [
						`Repository: ${colors.cyan(repo)}`,
						`Branch: ${options.branch || "main"}`,
					]);
					log(`Deploy: ${colors.dim(`tarout deploy ${appIdentifier}`)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Connect Gitea repository
	git
		.command("gitea")
		.argument("<app>", "Application ID or name")
		.description("Connect a Gitea repository as source")
		.option("-r, --repo <owner/repo>", "Repository (e.g., myorg/myapp)")
		.option("-b, --branch <branch>", "Branch to deploy", "main")
		.option("--provider-id <id>", "Gitea connection ID")
		.option("--build-path <path>", "Build path within repository", "/")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				let repo = options.repo;
				if (!repo) {
					repo = await input("Repository (owner/repo):", undefined, {
						field: "gitea_repo",
						flag: "--repo",
					});
				}

				const parts = (repo || "").split("/");
				const giteaOwner = parts.slice(0, -1).join("/") || parts[0] || "";
				const giteaRepository = parts[parts.length - 1] || repo;

				const giteaId = options.providerId || "";

				const _configSpinner = startSpinner("Connecting Gitea repository...");

				await client.application.saveGiteaProvider.mutate({
					applicationId: app.applicationId,
					giteaRepository,
					giteaOwner,
					giteaBranch: options.branch || "main",
					giteaBuildPath: options.buildPath || "/",
					giteaId,
					watchPaths: null,
					enableSubmodules: false,
				});

				succeedSpinner("Gitea repository connected!");

				if (isJsonMode()) {
					outputData({ connected: true, repository: repo });
				} else {
					box("Gitea Connected", [
						`Repository: ${colors.cyan(repo)}`,
						`Branch: ${options.branch || "main"}`,
					]);
					log(`Deploy: ${colors.dim(`tarout deploy ${appIdentifier}`)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// View application logs
	apps
		.command("logs")
		.argument("<app>", "Application ID or name")
		.description("View application runtime logs")
		.option("-n, --lines <n>", "Number of log lines", "200")
		.option(
			"-l, --level <level>",
			"Log level: ALL, ERROR, WARN, INFO, DEBUG",
			"ALL",
		)
		.option("--range <range>", "Time range: 1h, 6h, 24h, 7d, all", "all")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				const _logSpinner = startSpinner("Fetching logs...");

				const result = await client.application.getApplicationLogs.query({
					applicationId: app.applicationId,
					lines: Number.parseInt(options.lines) || 200,
					level: options.level || "ALL",
					timeRange: options.range || "all",
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				const logs = result?.logs || [];

				if (!logs.length) {
					log("");
					log(
						`No logs found for ${colors.cyan(app.name)}. Deploy first or check the time range.`,
					);
					return;
				}

				log("");
				log(`Logs for ${colors.cyan(app.name)} (${logs.length} lines):`);
				log(colors.dim("─".repeat(60)));

				for (const entry of logs) {
					const ts = entry.timestamp
						? `${colors.dim(new Date(entry.timestamp).toLocaleTimeString())} `
						: "";
					const lvl = formatLogLevel(entry.level);
					const msg = entry.message || entry.raw || "";
					log(`${ts}${lvl} ${msg}`);
				}

				log(colors.dim("─".repeat(60)));
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Application analytics
	apps
		.command("analytics")
		.argument("<app>", "Application ID or name")
		.description("View application analytics")
		.option("-d, --days <days>", "Days of data", "7")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				const _analyticsSpinner = startSpinner("Fetching analytics...");

				const data = await client.application.getAnalytics.query({
					applicationId: app.applicationId,
					days: Number.parseInt(options.days) || 7,
				} as any);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				const d = data as any;

				log("");
				log(
					colors.bold(`Analytics for ${app.name} — last ${options.days} days`),
				);
				log("");

				if (d.requests !== undefined)
					log(`  Requests: ${colors.cyan(String(d.requests))}`);
				if (d.visitors !== undefined)
					log(`  Visitors: ${colors.cyan(String(d.visitors))}`);
				if (d.bandwidth !== undefined)
					log(`  Bandwidth: ${colors.cyan(formatBytes(d.bandwidth))}`);
				if (d.responseTime !== undefined)
					log(`  Avg response: ${colors.cyan(`${d.responseTime}ms`)}`);
				if (d.errorRate !== undefined)
					log(
						`  Error rate: ${colors.cyan(`${(d.errorRate * 100).toFixed(2)}%`)}`,
					);

				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Application metrics
	apps
		.command("metrics")
		.argument("<app>", "Application ID or name")
		.description("View application resource metrics (CPU, memory)")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				const _metricsSpinner = startSpinner("Fetching metrics...");

				const data = await client.application.getMetrics.query({
					applicationId: app.applicationId,
				} as any);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				const d = data as any;

				log("");
				log(colors.bold(`Metrics for ${app.name}`));
				log("");

				if (d.cpu !== undefined) log(`  CPU: ${colors.cyan(`${d.cpu}%`)}`);
				if (d.memory !== undefined)
					log(`  Memory: ${colors.cyan(formatBytes(d.memory))}`);
				if (d.memoryUsage !== undefined && d.memoryLimit !== undefined)
					log(
						`  Memory: ${colors.cyan(formatBytes(d.memoryUsage))} / ${formatBytes(d.memoryLimit)}`,
					);
				if (d.uptime !== undefined)
					log(`  Uptime: ${colors.cyan(String(d.uptime))}`);
				if (d.restarts !== undefined)
					log(`  Restarts: ${colors.cyan(String(d.restarts))}`);

				const metrics = d.metrics || d.data || [];
				if (Array.isArray(metrics) && metrics.length > 0) {
					log("");
					table(
						["TIME", "CPU %", "MEM"],
						metrics
							.slice(-10)
							.map((m: any) => [
								formatTime(m.timestamp || m.time),
								`${m.cpu || 0}%`,
								formatBytes(m.memory || m.memoryUsage || 0),
							]),
					);
				}

				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Refresh application screenshot
	apps
		.command("screenshot")
		.argument("<app>", "Application ID or name")
		.description("Refresh the application screenshot")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				const _screenshotSpinner = startSpinner("Refreshing screenshot...");

				await client.application.refreshScreenshot.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner("Screenshot refresh queued!");

				if (isJsonMode()) {
					outputData({
						queued: true,
						applicationId: app.applicationId,
					});
				} else {
					log("");
					log(colors.success("Screenshot will be updated shortly."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Sync application status
	apps
		.command("sync")
		.argument("<app>", "Application ID or name")
		.description("Sync application status from deployment platform")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				const _syncSpinner = startSpinner("Syncing status...");

				await client.application.syncApplicationStatus.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner("Status synced!");

				if (isJsonMode()) {
					outputData({
						synced: true,
						applicationId: app.applicationId,
					});
				} else {
					log("");
					log(
						`${colors.success("Status synced.")} Run ${colors.dim(`tarout apps info ${appIdentifier}`)} to view.`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Open application in browser
	apps
		.command("open")
		.argument("<app>", "Application ID or name")
		.description("Open application URL in browser")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Finding application...");

				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				const app = await client.application.one.query({
					applicationId: appSummary.applicationId,
				});

				succeedSpinner();

				// Find URL to open
				let url: string | null = null;

				if (app.domain && app.domain.length > 0) {
					url = `https://${app.domain[0].host}`;
				} else if (app.appSubdomain) {
					url = `https://${app.appSubdomain}`;
				}

				if (!url) {
					error(
						"No URL found for this application. Deploy first or add a domain.",
					);
					return;
				}

				if (isJsonMode()) {
					outputData({ url });
					return;
				}

				log(`Opening ${colors.cyan(url)}...`);
				await open(url);
			} catch (err) {
				handleError(err);
			}
		});

	// ── Visitor stats ────────────────────────────────────────────────────────────
	apps
		.command("visitors")
		.argument("<app>", "Application ID or name")
		.description("Show visitor traffic statistics for an application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching visitor stats...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const data = await client.application.getVisitorStats.query({
					applicationId: app.applicationId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold(`Visitor Stats: ${app.name}`));
				if (d.totalVisitors !== undefined)
					log(`  Total Visitors:  ${colors.cyan(String(d.totalVisitors))}`);
				if (d.uniqueVisitors !== undefined)
					log(`  Unique Visitors: ${colors.cyan(String(d.uniqueVisitors))}`);
				if (d.pageViews !== undefined)
					log(`  Page Views:      ${colors.cyan(String(d.pageViews))}`);
				if (d.bounceRate !== undefined)
					log(`  Bounce Rate:     ${d.bounceRate}%`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Check subdomain SSL ──────────────────────────────────────────────────────
	apps
		.command("ssl-status")
		.argument("<app>", "Application ID or name")
		.description("Check SSL certificate status for an application subdomain")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking SSL status...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const data = await client.application.checkSubdomainSSL.query({
					applicationId: app.applicationId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(`SSL Status for ${colors.bold(app.name)}`);
				log(
					`  Certificate: ${d.valid || d.hasSSL ? colors.success("valid") : colors.error("invalid/missing")}`,
				);
				if (d.expiresAt)
					log(`  Expires:     ${new Date(d.expiresAt).toLocaleDateString()}`);
				if (d.issuer) log(`  Issuer:      ${d.issuer}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Deployment status ────────────────────────────────────────────────────────
	apps
		.command("deploy-status")
		.argument("<app>", "Application ID or name")
		.description("Check the latest deployment status")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching deployment status...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const data = await client.application.getDeploymentStatus.query({
					applicationId: app.applicationId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold(`Deployment Status: ${app.name}`));
				log(
					`  Status:   ${d.status === "done" || d.status === "success" ? colors.success(d.status) : d.status === "error" ? colors.error(d.status) : colors.warn(d.status || "-")}`,
				);
				if (d.deployedAt)
					log(`  Deployed: ${new Date(d.deployedAt).toLocaleString()}`);
				if (d.buildDuration) log(`  Duration: ${d.buildDuration}s`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Observability ────────────────────────────────────────────────────────────
	apps
		.command("observability")
		.argument("<app>", "Application ID or name")
		.description("Show observability data (traces, errors) for an application")
		.option("--period <period>", "Time period (1h, 24h, 7d)", "24h")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching observability data...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const data = await client.application.getObservabilityData.query({
					applicationId: app.applicationId,
					period: options.period || "24h",
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold(`Observability: ${app.name}`));
				if (d.errorRate !== undefined) log(`  Error Rate:   ${d.errorRate}%`);
				if (d.p50 !== undefined) log(`  P50 Latency:  ${d.p50}ms`);
				if (d.p95 !== undefined) log(`  P95 Latency:  ${d.p95}ms`);
				if (d.p99 !== undefined) log(`  P99 Latency:  ${d.p99}ms`);
				if (d.requestCount !== undefined)
					log(`  Requests:     ${colors.cyan(String(d.requestCount))}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Change plan ──────────────────────────────────────────────────────────────
	apps
		.command("change-plan")
		.argument("<app>", "Application ID or name")
		.argument("<plan>", "New plan (shared, dedicated)")
		.description("Change the hosting plan for an application")
		.action(async (appIdentifier, newPlan) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching applications...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Change plan for "${app.name}" to "${newPlan}"?`,
						false,
						{
							field: "confirm_change_plan",
							flag: "--yes",
							context: {
								appName: app.name,
								applicationId: app.applicationId,
								newPlan,
							},
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const _changeSpinner = startSpinner(`Changing plan to ${newPlan}...`);
				await client.application.changePlan.mutate({
					applicationId: app.applicationId,
					newPlan,
				} as any);
				succeedSpinner(`Plan changed to ${newPlan}.`);
				if (isJsonMode())
					outputData({
						changed: true,
						applicationId: app.applicationId,
						newPlan,
					});
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Check Coolify live status ─────────────────────────────────────────────────
	apps
		.command("live-status")
		.argument("<app>", "Application ID or name")
		.description("Check real-time Coolify status for an application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking live status...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const data = await client.application.checkCoolifyLiveStatus.query({
					applicationId: app.applicationId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold(`Live Status: ${app.name}`));
				log(
					`  Status:  ${d.status === "running" ? colors.success(d.status) : d.status === "error" ? colors.error(d.status) : colors.warn(d.status || "-")}`,
				);
				if (d.health) log(`  Health:  ${d.health}`);
				if (d.uptime) log(`  Uptime:  ${d.uptime}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Cancel deployment ────────────────────────────────────────────────────────
	apps
		.command("cancel")
		.argument("<app>", "Application ID or name")
		.description("Cancel the current in-progress deployment")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching application...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _cancelSpinner = startSpinner("Cancelling deployment...");
				await client.application.cancelDeployment.mutate({
					applicationId: app.applicationId,
				});
				succeedSpinner("Deployment cancelled.");
				if (isJsonMode())
					outputData({ cancelled: true, applicationId: app.applicationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Clean queues ─────────────────────────────────────────────────────────────
	apps
		.command("clean-queues")
		.argument("<app>", "Application ID or name")
		.description("Clean pending deployment queues for an application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching application...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _cleanSpinner = startSpinner("Cleaning queues...");
				await client.application.cleanQueues.mutate({
					applicationId: app.applicationId,
				});
				succeedSpinner("Queues cleaned.");
				if (isJsonMode())
					outputData({ cleaned: true, applicationId: app.applicationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Mark running ─────────────────────────────────────────────────────────────
	apps
		.command("mark-running")
		.argument("<app>", "Application ID or name")
		.description("Manually mark an application as running")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching application...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _markSpinner = startSpinner("Marking as running...");
				await client.application.markRunning.mutate({
					applicationId: app.applicationId,
				});
				succeedSpinner("Application marked as running.");
				if (isJsonMode())
					outputData({ marked: true, applicationId: app.applicationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Refresh token ────────────────────────────────────────────────────────────
	apps
		.command("refresh-token")
		.argument("<app>", "Application ID or name")
		.description("Refresh the application deployment token")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching application...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _refreshSpinner = startSpinner("Refreshing token...");
				const result = await client.application.refreshToken.mutate({
					applicationId: app.applicationId,
				});
				succeedSpinner("Token refreshed.");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Validate source provider ──────────────────────────────────────────────────
	apps
		.command("validate-source")
		.argument("<app>", "Application ID or name")
		.description("Validate the configured source provider for an application")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching application...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _validateSpinner = startSpinner("Validating source provider...");
				const result = await client.application.validateSourceProvider.query({
					applicationId: app.applicationId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				log("");
				const isValid = r.valid ?? r.isValid ?? true;
				log(
					`Source provider: ${isValid ? colors.success("valid") : colors.error("invalid")}`,
				);
				if (r.message) log(`Message: ${r.message}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Check subdomain availability ──────────────────────────────────────────────
	apps
		.command("check-subdomain")
		.argument("<subdomain>", "Subdomain to check")
		.description("Check if a subdomain is available")
		.option("--app <app-id>", "Exclude this application from the check")
		.action(async (subdomain, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking subdomain availability...");
				const result =
					await client.application.checkSubdomainAvailability.query({
						subdomain,
						applicationId: options.app,
					} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				const available = r.available ?? r.isAvailable ?? true;
				log(
					`Subdomain "${subdomain}": ${available ? colors.success("available") : colors.error("taken")}`,
				);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Dockerfile upload provider ────────────────────────────────────────────────
	apps
		.command("use-dockerfile")
		.argument("<app>", "Application ID or name")
		.description("Set Dockerfile content as the build source")
		.option("--content <dockerfile>", "Dockerfile content")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching application...");
				const appsList: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(appsList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const dockerfileContent =
					options.content ||
					(await input("Dockerfile content:", undefined, {
						field: "dockerfile_content",
						flag: "--content",
					}));
				const _saveSpinner = startSpinner("Saving Dockerfile...");
				await client.application.saveDockerfileUploadProvider.mutate({
					applicationId: app.applicationId,
					dockerfileContent,
				} as any);
				succeedSpinner("Dockerfile saved as build source.");
				if (isJsonMode())
					outputData({ saved: true, applicationId: app.applicationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// Get create options (frameworks, runtimes, etc.)
	apps
		.command("create-options")
		.description("List available frameworks and runtimes for new applications")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching create options...");
				const opts = await client.application.getCreateOptions.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(opts);
					return;
				}
				const o = opts as any;
				log("");
				log(colors.bold("Application Create Options"));
				if (o.frameworks) {
					log(
						colors.dim("Frameworks: ") + (o.frameworks as string[]).join(", "),
					);
				}
				if (o.buildTypes) {
					log(
						colors.dim("Build types: ") + (o.buildTypes as string[]).join(", "),
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Save environment settings for an application
	apps
		.command("save-env-settings")
		.argument("<app>", "App ID or name")
		.option("--port <port>", "Application port", Number.parseInt)
		.option("--health-path <path>", "Health check path")
		.option("--restart <policy>", "Restart policy: always, on-failure, never")
		.description("Save environment/runtime settings for an application")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching apps...");
				const apps2 = await client.application.allByOrganization.query();
				const appList = Array.isArray(apps2)
					? apps2
					: (apps2 as any)?.applications || [];
				const app = findApp(appList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _saveSpinner = startSpinner("Saving environment settings...");
				await client.application.saveEnvironment.mutate({
					applicationId: app.applicationId,
					port: options.port,
					healthCheckPath: options.healthPath,
					restartPolicy: options.restart,
				} as any);
				succeedSpinner("Environment settings saved!");
				if (isJsonMode())
					outputData({ saved: true, applicationId: app.applicationId });
			} catch (err) {
				handleError(err);
			}
		});

	// Get a pre-signed upload URL for drag-and-drop deployment
	apps
		.command("upload-url")
		.argument("<app>", "App ID or name")
		.description("Get a pre-signed URL to upload a zip/tar for deployment")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching apps...");
				const apps2 = await client.application.allByOrganization.query();
				const appList = Array.isArray(apps2)
					? apps2
					: (apps2 as any)?.applications || [];
				const app = findApp(appList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _urlSpinner = startSpinner("Getting upload URL...");
				const result = await client.application.getDropUploadUrl.query({
					applicationId: app.applicationId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				log("");
				log(colors.bold("Upload URL"));
				log(`  URL: ${colors.cyan(r.uploadUrl || r.url || "-")}`);
				if (r.expiresAt) log(`  Expires: ${r.expiresAt}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Complete a drag-and-drop upload deployment
	apps
		.command("complete-upload")
		.argument("<app>", "App ID or name")
		.argument("<upload-key>", "Upload key returned from the upload URL")
		.description("Finalize a drag-and-drop upload and trigger deployment")
		.action(async (appIdentifier, uploadKey) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching apps...");
				const apps2 = await client.application.allByOrganization.query();
				const appList = Array.isArray(apps2)
					? apps2
					: (apps2 as any)?.applications || [];
				const app = findApp(appList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _completeSpinner = startSpinner("Completing upload...");
				const result = await client.application.completeDropUpload.mutate({
					applicationId: app.applicationId,
					uploadKey,
				} as any);
				succeedSpinner("Upload complete — deployment triggered!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});
}

// Helper functions
function findApp(apps: AppSummary[], identifier: string) {
	const lowerIdentifier = identifier.toLowerCase();

	return apps.find(
		(app) =>
			app.applicationId === identifier ||
			app.applicationId.startsWith(identifier) ||
			app.name.toLowerCase() === lowerIdentifier ||
			app.appName?.toLowerCase() === lowerIdentifier,
	);
}

function formatDomain(domain: AppSummary["domain"]): string {
	if (typeof domain === "string") return domain;
	if (Array.isArray(domain)) return domain[0]?.host ?? colors.dim("-");
	return colors.dim("-");
}

function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);
}

function formatDate(date: Date | string): string {
	const d = new Date(date);
	const now = new Date();
	const diffDays = Math.floor(
		(now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
	);

	if (diffDays === 0) {
		return "Today";
	}
	if (diffDays === 1) {
		return "Yesterday";
	}
	if (diffDays < 7) {
		return `${diffDays}d ago`;
	}
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatLogLevel(level: string | null | undefined): string {
	if (!level) return "";
	switch ((level || "").toUpperCase()) {
		case "ERROR":
			return colors.error("[ERROR]");
		case "WARN":
		case "WARNING":
			return colors.warn("[WARN]");
		case "INFO":
			return colors.info("[INFO]");
		case "DEBUG":
			return colors.dim("[DEBUG]");
		default:
			return colors.dim(`[${level}]`);
	}
}

function formatBytes(bytes: number): string {
	if (!bytes || bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function formatTime(ts: string | Date | null | undefined): string {
	if (!ts) return "-";
	return new Date(ts).toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
	});
}
