/**
 * @fileoverview Build command for building locally with cloud env vars.
 * Similar to Vercel's `vercel build` command.
 * @module commands/build
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
	BuildFailedError,
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
	getBuildCommand,
	readPackageJson,
	runCommand,
} from "../lib/process.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerBuildCommand(program: Command) {
	program
		.command("build")
		.description("Build locally with cloud environment variables")
		.option("-a, --app <app>", "Application ID or name (overrides linked app)")
		.option("-c, --command <command>", "Custom build command to run")
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

				// Get build command
				let buildCommand = options.command;
				if (!buildCommand) {
					buildCommand = getBuildCommand(pkg, pm);
				}

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

				// Add NODE_ENV=production for build
				envVars.NODE_ENV = envVars.NODE_ENV || "production";

				// Detect framework for display
				const framework = detectFramework(pkg);

				if (isJsonMode()) {
					// In JSON mode, we still run the build but capture output
					const startTime = Date.now();
					const result = await runCommand(buildCommand, envVars);
					const duration = Math.round((Date.now() - startTime) / 1000);

					outputData({
						success: result.exitCode === 0,
						applicationId,
						appName,
						command: buildCommand,
						framework: framework?.name || "Unknown",
						envVarCount: Object.keys(envVars).length,
						packageManager: pm,
						exitCode: result.exitCode,
						duration,
					});

					if (result.exitCode !== 0) {
						process.exit(result.exitCode);
					}
					return;
				}

				// Display build info
				log("");
				log(colors.bold(`Building ${colors.cyan(appName)}`));
				log("");
				log(`  Framework:       ${colors.dim(framework?.name || "Unknown")}`);
				log(`  Package Manager: ${colors.dim(pm)}`);
				log(`  Command:         ${colors.dim(buildCommand)}`);
				log(
					`  Env Variables:   ${colors.dim(String(Object.keys(envVars).length))}`,
				);
				log("");
				log(colors.dim("─".repeat(50)));
				log("");

				// Run the build command
				const startTime = Date.now();
				const result = await runCommand(buildCommand, envVars);
				const duration = Math.round((Date.now() - startTime) / 1000);

				// Handle exit
				log("");
				log(colors.dim("─".repeat(50)));
				log("");

				if (result.exitCode === 0) {
					log(colors.success(`Build completed successfully in ${duration}s`));
					log("");
					log("Next steps:");
					log(`  ${colors.dim("tarout deploy")}  - Deploy to cloud`);
					log("");
				} else {
					log(
						colors.error(
							`Build failed with exit code ${result.exitCode} (${duration}s)`,
						),
					);
					log("");
					log("Troubleshooting:");
					log(`  ${colors.dim("1.")} Check the build output above for errors`);
					log(`  ${colors.dim("2.")} Verify all dependencies are installed`);
					log(
						`  ${colors.dim("3.")} Make sure environment variables are correct`,
					);
					log("");

					throw new BuildFailedError(
						`Build failed with exit code ${result.exitCode}`,
					);
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
