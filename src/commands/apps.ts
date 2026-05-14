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
import { confirm, input } from "../utils/prompts.js";
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
					appName = await input("Application name:");
				}

				if (!description && !shouldSkipConfirmation()) {
					description = await input("Description (optional):");
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
