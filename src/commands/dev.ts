/**
 * @fileoverview Dev command for running local development server with cloud env vars.
 * Similar to Vercel's `vercel dev` command.
 * @module commands/dev
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import {
	getCurrentProfile,
	getProjectConfig,
	isLoggedIn,
	isProjectLinked,
} from "../lib/config.js";
import {
	AuthError,
	CliError,
	findSimilar,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
import { colors, isJsonMode, log, outputData } from "../lib/output.js";
import {
	detectFramework,
	detectPackageManager,
	envVarsToObject,
	getDefaultPort,
	getDevCommand,
	readPackageJson,
	runCommand,
} from "../lib/process.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerDevCommand(program: Command) {
	program
		.command("dev")
		.description(
			"Run local development server with cloud environment variables",
		)
		.option("-a, --app <app>", "Application ID or name (overrides linked app)")
		.option("-p, --port <port>", "Port to run the dev server on")
		.option("-c, --command <command>", "Custom dev command to run")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				const client = getApiClient();

				// Determine which app to use
				let applicationId: string;
				let appName: string;

				if (options.app) {
					// Find app by identifier
					const _spinner = startSpinner("Finding application...");
					const apps = await client.application.allByOrganization.query();
					const app = findApp(apps, options.app);

					if (!app) {
						failSpinner();
						const suggestions = findSimilar(
							options.app,
							apps.map((a: any) => a.name),
						);
						throw new NotFoundError("Application", options.app, suggestions);
					}

					applicationId = app.applicationId;
					appName = app.name;
					succeedSpinner();
				} else if (isProjectLinked()) {
					// Use linked app
					const config = getProjectConfig();
					if (!config) {
						throw new CliError(
							"Project config is corrupted. Run 'tarout link' to relink.",
						);
					}
					applicationId = config.applicationId;
					appName = config.name;
				} else {
					throw new InvalidArgumentError(
						"No linked application. Run 'tarout link' first or use --app flag.",
					);
				}

				// Read package.json
				const pkg = readPackageJson();
				if (!pkg) {
					throw new CliError(
						"No package.json found in current directory. Make sure you're in a Node.js project.",
					);
				}

				// Detect package manager
				const pm = detectPackageManager();

				// Get dev command
				let devCommand = options.command;
				if (!devCommand) {
					devCommand = getDevCommand(pkg, pm);
				}

				// Handle port override
				const defaultPort = getDefaultPort(pkg);
				const port = options.port || defaultPort;

				// Fetch environment variables
				const _envSpinner = startSpinner(
					`Fetching environment variables for ${appName}...`,
				);
				let envVars: Record<string, string> = {};

				try {
					const variables = await client.envVariable.list.query({
						applicationId,
						includeValues: true,
					});
					envVars = envVarsToObject(variables);
					succeedSpinner(
						`Loaded ${Object.keys(envVars).length} environment variables`,
					);
				} catch (err) {
					failSpinner();
					throw new CliError(
						`Failed to fetch environment variables: ${err instanceof Error ? err.message : "Unknown error"}`,
					);
				}

				// Add PORT to env vars if specified
				if (options.port) {
					envVars.PORT = String(port);
				}

				// Detect framework for display
				const framework = detectFramework(pkg);

				if (isJsonMode()) {
					outputData({
						applicationId,
						appName,
						command: devCommand,
						port,
						framework: framework?.name || "Unknown",
						envVarCount: Object.keys(envVars).length,
						packageManager: pm,
					});
					return;
				}

				// Display startup info
				log("");
				log(colors.bold(`Running dev server for ${colors.cyan(appName)}`));
				log("");
				log(`  Framework:       ${colors.dim(framework?.name || "Unknown")}`);
				log(`  Package Manager: ${colors.dim(pm)}`);
				log(`  Command:         ${colors.dim(devCommand)}`);
				log(`  Port:            ${colors.dim(String(port))}`);
				log(
					`  Env Variables:   ${colors.dim(String(Object.keys(envVars).length))}`,
				);
				log("");
				log(colors.dim("─".repeat(50)));
				log("");

				// Run the dev command
				const result = await runCommand(devCommand, envVars);

				// Handle exit
				if (result.signal) {
					log("");
					log(colors.dim(`Process terminated by ${result.signal}`));
				} else if (result.exitCode !== 0) {
					log("");
					log(colors.error(`Process exited with code ${result.exitCode}`));
					process.exit(result.exitCode);
				}
			} catch (err) {
				handleError(err);
			}
		});
}

// Helper function
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
