import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

interface AppSummary {
	appName?: string;
	applicationId: string;
	name: string;
}

export function registerEnvCommands(program: Command) {
	const env = program
		.command("env")
		.argument("<app>", "Application ID or name")
		.description("Manage environment variables");

	// List environment variables
	env
		.command("list")
		.alias("ls")
		.description("List all environment variables")
		.option("--reveal", "Show actual values (not masked)")
		.action(async (options, command) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const appIdentifier = command.parent.args[0];
				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Fetching environment variables...");
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

				const variables = await client.envVariable.list.query({
					applicationId: app.applicationId,
					includeValues: options.reveal || false,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(variables);
					return;
				}

				if (variables.length === 0) {
					log("");
					log("No environment variables found.");
					log("");
					log(
						`Set one with: ${colors.dim(`tarout env ${app.name} set KEY=value`)}`,
					);
					return;
				}

				log("");
				table(
					["KEY", "VALUE", "SECRET", "UPDATED"],
					variables.map((v: any) => [
						colors.cyan(v.key),
						options.reveal ? v.value || colors.dim("-") : maskValue(v.value),
						v.isSecret ? colors.warn("Yes") : "No",
						formatDate(v.updatedAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${variables.length} variable${variables.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Set environment variable
	env
		.command("set")
		.argument("<key=value>", "Variable to set (KEY=value format)")
		.description("Set an environment variable")
		.option("-s, --secret", "Mark as secret (default)", true)
		.option("--no-secret", "Mark as non-secret")
		.action(async (keyValue, options, command) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const appIdentifier = command.parent.parent.args[0];

				// Parse KEY=value
				const eqIndex = keyValue.indexOf("=");
				if (eqIndex === -1) {
					throw new InvalidArgumentError(
						"Invalid format. Use KEY=value (e.g., API_KEY=secret123)",
					);
				}

				const key = keyValue.slice(0, eqIndex);
				const value = keyValue.slice(eqIndex + 1);

				if (!key) {
					throw new InvalidArgumentError("Key cannot be empty");
				}

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Setting environment variable...");
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

				// Check if variable exists
				const existing = await client.envVariable.list.query({
					applicationId: app.applicationId,
					includeValues: false,
				});

				const existingVar = existing.find((v: any) => v.key === key);

				if (existingVar) {
					// Update existing
					await client.envVariable.update.mutate({
						applicationId: app.applicationId,
						key,
						value,
						isSecret: options.secret,
					});
				} else {
					// Create new
					await client.envVariable.create.mutate({
						applicationId: app.applicationId,
						key,
						value,
						isSecret: options.secret,
					});
				}

				succeedSpinner(`Set ${key}`);

				if (isJsonMode()) {
					outputData({ key, updated: !!existingVar });
				} else {
					quietOutput(key);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Unset environment variable
	env
		.command("unset")
		.argument("<key>", "Variable key to remove")
		.description("Remove an environment variable")
		.action(async (key, _options, command) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const appIdentifier = command.parent.parent.args[0];
				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Removing environment variable...");
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

				await client.envVariable.delete.mutate({
					applicationId: app.applicationId,
					key,
				});

				succeedSpinner(`Removed ${key}`);

				if (isJsonMode()) {
					outputData({ key, deleted: true });
				} else {
					quietOutput(key);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Pull environment variables to .env file
	env
		.command("pull")
		.description("Download environment variables as .env file")
		.option("-o, --output <file>", "Output file path", ".env")
		.option("--reveal", "Include actual secret values")
		.action(async (options, command) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const appIdentifier = command.parent.parent.args[0];
				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Downloading environment variables...");
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

				// Check if file exists
				if (existsSync(options.output) && !shouldSkipConfirmation()) {
					succeedSpinner();
					const confirmed = await confirm(
						`File ${options.output} already exists. Overwrite?`,
						false,
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const result = await client.envVariable.export.query({
					applicationId: app.applicationId,
					format: "dotenv",
					maskSecrets: !options.reveal,
				});

				writeFileSync(options.output, result.content);

				succeedSpinner(`Saved to ${options.output}`);

				if (isJsonMode()) {
					outputData({ file: options.output, content: result.content });
				} else {
					quietOutput(options.output);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Push environment variables from .env file
	env
		.command("push")
		.description("Upload environment variables from .env file")
		.option("-i, --input <file>", "Input file path", ".env")
		.option("--replace", "Replace all existing variables (default: merge)")
		.action(async (options, command) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const appIdentifier = command.parent.parent.args[0];

				// Read the file
				if (!existsSync(options.input)) {
					throw new InvalidArgumentError(`File not found: ${options.input}`);
				}

				const content = readFileSync(options.input, "utf-8");

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Uploading environment variables...");
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

				const result = await client.envVariable.import.mutate({
					applicationId: app.applicationId,
					content,
					format: "dotenv",
					merge: !options.replace,
				});

				succeedSpinner(`Imported ${result.imported} variables`);

				if (isJsonMode()) {
					outputData(result);
				} else {
					quietOutput(String(result.imported));
					if (result.skipped > 0) {
						log(colors.dim(`Skipped ${result.skipped} (already exist)`));
					}
				}
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

function maskValue(value: string | null | undefined): string {
	if (!value) return colors.dim("-");
	if (value.length <= 4) return "****";
	return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

function formatDate(date: Date | string): string {
	const d = new Date(date);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
