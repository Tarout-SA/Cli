/**
 * @fileoverview Link command for connecting local directory to a Tarout application.
 * Similar to Vercel's `vercel link` command.
 * @module commands/link
 */

import { basename } from "node:path";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import {
	getCurrentProfile,
	getProjectConfig,
	isLoggedIn,
	isProjectLinked,
	removeProjectConfig,
	setProjectConfig,
} from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	NotFoundError,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
} from "../lib/output.js";
import { confirm, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerLinkCommands(program: Command) {
	// Link command - connect local directory to a Tarout app
	program
		.command("link")
		.argument(
			"[app]",
			"Application ID or name (optional, will prompt if not provided)",
		)
		.description("Link local directory to a Tarout application")
		.option("-y, --yes", "Skip confirmation prompts")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				const client = getApiClient();
				const cwd = process.cwd();
				const dirName = basename(cwd);

				// Check if already linked
				if (isProjectLinked()) {
					const existingConfig = getProjectConfig();
					if (existingConfig && !shouldSkipConfirmation() && !options.yes) {
						log("");
						log(
							`This directory is already linked to ${colors.cyan(existingConfig.name)}`,
						);
						log(`Application ID: ${colors.dim(existingConfig.applicationId)}`);
						log("");

						const confirmed = await confirm(
							"Do you want to relink to a different application?",
							false,
							{
								field: "confirm_relink",
								flag: "--yes",
								context: { currentApp: existingConfig.name },
							},
						);

						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}
				}

				// Fetch applications
				const _spinner = startSpinner("Fetching applications...");
				const apps = await client.application.allByOrganization.query();
				succeedSpinner();

				if (apps.length === 0) {
					log("");
					log("No applications found in your organization.");
					log("");
					log(`Create one with: ${colors.dim("tarout apps create <name>")}`);
					return;
				}

				let selectedApp: { applicationId: string; name: string } | null = null;

				// If app identifier provided, find it
				if (appIdentifier) {
					selectedApp = findApp(apps, appIdentifier) || null;

					if (!selectedApp) {
						const suggestions = findSimilar(
							appIdentifier,
							apps.map((a: { name: string }) => a.name),
						);
						throw new NotFoundError("Application", appIdentifier, suggestions);
					}
				} else {
					// Interactive selection
					log("");
					log(`Linking ${colors.cyan(dirName)} to a Tarout application`);
					log("");

					const choices = apps.map(
						(app: { applicationId: string; name: string }) => ({
							name: `${app.name} ${colors.dim(`(${app.applicationId.slice(0, 8)})`)}`,
							value: app.applicationId,
						}),
					);

					const selectedId = await select(
						"Select an application:",
						choices,
						{ field: "app", flag: "--app" },
					);
					selectedApp =
						apps.find(
							(a: { applicationId: string }) => a.applicationId === selectedId,
						) || null;
				}

				if (!selectedApp) {
					log("No application selected.");
					return;
				}

				// Save project config
				setProjectConfig({
					applicationId: selectedApp.applicationId,
					name: selectedApp.name,
					organizationId: profile.organizationId,
					linkedAt: new Date().toISOString(),
				});

				if (isJsonMode()) {
					outputData({
						linked: true,
						applicationId: selectedApp.applicationId,
						name: selectedApp.name,
						directory: cwd,
					});
					return;
				}

				quietOutput(selectedApp.applicationId);

				box("Project Linked", [
					`Application: ${colors.cyan(selectedApp.name)}`,
					`ID: ${colors.dim(selectedApp.applicationId)}`,
					`Directory: ${colors.dim(cwd)}`,
				]);

				log("You can now use:");
				log(
					`  ${colors.dim("tarout dev")}     - Run dev server with cloud env vars`,
				);
				log(
					`  ${colors.dim("tarout build")}   - Build locally with cloud env vars`,
				);
				log(`  ${colors.dim("tarout deploy")}  - Deploy to cloud`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Unlink command - remove local project config
	program
		.command("unlink")
		.description("Unlink the current directory from Tarout")
		.action(async () => {
			try {
				const config = getProjectConfig();

				if (!config) {
					log("");
					log("This directory is not linked to any Tarout application.");
					log("");
					log(`Link with: ${colors.dim("tarout link")}`);
					return;
				}

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Currently linked to: ${colors.cyan(config.name)}`);
					log(`Application ID: ${colors.dim(config.applicationId)}`);
					log("");

					const confirmed = await confirm(
						"Are you sure you want to unlink this directory?",
						false,
						{
							field: "confirm_unlink",
							flag: "--yes",
							context: { currentApp: config.name },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const removed = removeProjectConfig();

				if (isJsonMode()) {
					outputData({
						unlinked: removed,
						applicationId: config.applicationId,
						name: config.name,
					});
					return;
				}

				if (removed) {
					log("");
					log(colors.success(`Unlinked from ${config.name}`));
					log("");
				} else {
					log("");
					log(colors.warn("Could not remove project configuration."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Status command - show current link status
	program
		.command("status")
		.description("Show link status for current directory")
		.action(async () => {
			try {
				const config = getProjectConfig();

				if (!config) {
					if (isJsonMode()) {
						outputData({ linked: false });
						return;
					}

					log("");
					log("This directory is not linked to any Tarout application.");
					log("");
					log(`Link with: ${colors.dim("tarout link")}`);
					return;
				}

				// If logged in, fetch latest app info
				if (isLoggedIn()) {
					const client = getApiClient();
					const _spinner = startSpinner("Fetching application status...");

					try {
						const app = await client.application.one.query({
							applicationId: config.applicationId,
						});
						succeedSpinner();

						if (isJsonMode()) {
							outputData({
								linked: true,
								applicationId: config.applicationId,
								name: config.name,
								status: app.applicationStatus,
								url: app.appSubdomain ? `https://${app.appSubdomain}` : null,
								linkedAt: config.linkedAt,
							});
							return;
						}

						log("");
						log(colors.bold("Project Status"));
						log("");
						log(`Application: ${colors.cyan(app.name)}`);
						log(`ID: ${colors.dim(config.applicationId)}`);
						log(`Status: ${getStatusIndicator(app.applicationStatus)}`);
						if (app.appSubdomain) {
							log(`URL: ${colors.cyan(`https://${app.appSubdomain}`)}`);
						}
						log(`Linked: ${new Date(config.linkedAt).toLocaleString()}`);
						log("");
					} catch {
						failSpinner();
						// App may have been deleted
						log("");
						log(colors.warn("Warning: Could not fetch application status."));
						log("The application may have been deleted.");
						log("");
						log(`Unlink with: ${colors.dim("tarout unlink")}`);
						log("");
					}
				} else {
					if (isJsonMode()) {
						outputData({
							linked: true,
							applicationId: config.applicationId,
							name: config.name,
							linkedAt: config.linkedAt,
						});
						return;
					}

					log("");
					log(colors.bold("Project Status"));
					log("");
					log(`Application: ${colors.cyan(config.name)}`);
					log(`ID: ${colors.dim(config.applicationId)}`);
					log(`Linked: ${new Date(config.linkedAt).toLocaleString()}`);
					log("");
					log(colors.dim("Log in to see full application status."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});
}

// Helper functions
function findApp(
	apps: Array<{ applicationId: string; name: string; appName?: string }>,
	identifier: string,
) {
	const lowerIdentifier = identifier.toLowerCase();

	return apps.find(
		(app) =>
			app.applicationId === identifier ||
			app.applicationId.startsWith(identifier) ||
			app.name.toLowerCase() === lowerIdentifier ||
			app.appName?.toLowerCase() === lowerIdentifier,
	);
}

function getStatusIndicator(status: string): string {
	const indicators: Record<string, string> = {
		running: colors.success("running"),
		idle: colors.warn("idle"),
		error: colors.error("error"),
		deploying: colors.info("deploying"),
		stopped: colors.dim("stopped"),
	};
	return indicators[status.toLowerCase()] || status;
}
