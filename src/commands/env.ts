import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
						{
							field: "confirm_overwrite_env_file",
							flag: "--yes",
							context: { outputPath: options.output },
						},
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

				writeFileSync(options.output, result.content, { mode: 0o600 });
				try {
					chmodSync(options.output, 0o600);
				} catch {
					// Best-effort: keep exported env files private where supported.
				}

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

	// View env variable audit log
	env
		.command("audit")
		.description("Show audit log for environment variables")
		.option("-k, --key <key>", "Filter by variable key")
		.option("-n, --limit <n>", "Number of entries to show", "50")
		.action(async (options: any, command: any) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const appIdentifier = command.parent.args[0];
				if (!appIdentifier) {
					throw new Error("Usage: tarout env <app> audit");
				}

				const client = getApiClient();
				const _spinner = startSpinner("Fetching audit log...");

				const apps = await client.application.allByOrganization.query();
				const app = findApp(apps as any[], appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				const entries = await client.envVariable.audit.query({
					applicationId: (app as any).applicationId,
					key: options.key,
					limit: Number.parseInt(options.limit) || 50,
				} as any);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(entries);
					return;
				}

				const list = Array.isArray(entries) ? entries : [];

				if (!list.length) {
					log("");
					log("No audit log entries found.");
					return;
				}

				log("");
				log(colors.bold("Environment Variable Audit Log"));
				log("");
				table(
					["DATE", "KEY", "ACTION", "USER"],
					list.map((e: any) => [
						new Date(e.createdAt || e.timestamp || "").toLocaleString(),
						colors.cyan(e.variableKey || e.key || "-"),
						e.action || "-",
						e.user?.email || e.userId || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Reveal a specific env variable value
	env
		.command("reveal")
		.argument("<key>", "Variable key to reveal")
		.description(
			"Reveal the plaintext value of an environment variable (logged)",
		)
		.action(async (key: string, _options: any, command: any) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const appIdentifier = command.parent.parent.args[0];
				if (!appIdentifier) {
					throw new Error("Usage: tarout env <app> reveal <KEY>");
				}

				const client = getApiClient();
				const _spinner = startSpinner("Revealing variable...");

				const apps = await client.application.allByOrganization.query();
				const app = findApp(apps as any[], appIdentifier);

				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}

				const variable = await client.envVariable.reveal.mutate({
					applicationId: (app as any).applicationId,
					key,
				} as any);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(variable);
					return;
				}

				const v = variable as any;
				log("");
				log(`${colors.bold(key)}: ${v.value || String(variable)}`);
				log(colors.dim("This reveal has been recorded in the audit log."));
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get a single env variable by key
	env
		.command("get")
		.argument("<app>", "App ID or name")
		.argument("<key>", "Variable key")
		.description("Get a specific environment variable value")
		.action(async (appIdentifier, key) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(
					Array.isArray(apps) ? apps : (apps as any)?.applications || [],
					appIdentifier,
				);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const v = await client.envVariable.get.query({
					applicationId: (app as any).applicationId,
					key,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(v);
					return;
				}
				const val = v as any;
				log(`\n${colors.bold(key)}: ${maskValue(val.value || String(v))}\n`);
			} catch (err) {
				handleError(err);
			}
		});

	// Get env variable as a string
	env
		.command("get-string")
		.argument("<app>", "App ID or name")
		.argument("<key>", "Variable key")
		.description("Get an environment variable formatted as a string")
		.action(async (appIdentifier, key) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(
					Array.isArray(apps) ? apps : (apps as any)?.applications || [],
					appIdentifier,
				);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const v = await client.envVariable.getAsString.query({
					applicationId: (app as any).applicationId,
					key,
				} as any);
				succeedSpinner();
				if (isJsonMode()) outputData(v);
				else log(typeof v === "string" ? v : JSON.stringify(v));
			} catch (err) {
				handleError(err);
			}
		});

	// List env vars across all environments
	env
		.command("list-all-envs")
		.argument("<app>", "App ID or name")
		.description("List environment variables across all environments")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(
					Array.isArray(apps) ? apps : (apps as any)?.applications || [],
					appIdentifier,
				);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const result = await client.envVariable.listAcrossEnvs.query({
					applicationId: (app as any).applicationId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const list = Array.isArray(result)
					? result
					: (result as any)?.variables || [];
				log("");
				table(
					["KEY", "ENV", "VALUE"],
					list.map((v: any) => [
						colors.cyan(v.key || "-"),
						v.environmentName || v.environment || "-",
						maskValue(v.value),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Bulk upsert env variables from JSON file
	env
		.command("bulk-set")
		.argument("<app>", "App ID or name")
		.description("Bulk create/update environment variables from a JSON object")
		.option("--vars <json>", "JSON object of key-value pairs")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const apps = await client.application.allByOrganization.query();
				const app = findApp(
					Array.isArray(apps) ? apps : (apps as any)?.applications || [],
					appIdentifier,
				);
				if (!app) throw new NotFoundError("Application", appIdentifier);
				let vars: Record<string, string>;
				if (options.vars) {
					vars = JSON.parse(options.vars);
				} else {
					const _raw = await import("node:process");
					log('Enter JSON key-value object (e.g. {"KEY":"value"}):');
					const input2 = await (await import("../utils/prompts.js")).input(
						"JSON:",
					);
					vars = JSON.parse(input2);
				}
				const _spinner = startSpinner("Bulk setting variables...");
				await client.envVariable.bulkUpsert.mutate({
					applicationId: (app as any).applicationId,
					variables: Object.entries(vars).map(([key, value]) => ({
						key,
						value,
					})),
				} as any);
				succeedSpinner(`Bulk set ${Object.keys(vars).length} variable(s)!`);
				if (isJsonMode()) outputData({ updated: Object.keys(vars).length });
			} catch (err) {
				handleError(err);
			}
		});

	// Bulk delete env variables
	env
		.command("bulk-delete")
		.argument("<app>", "App ID or name")
		.argument("<keys...>", "Keys to delete")
		.description("Delete multiple environment variables by key")
		.action(async (appIdentifier, keys) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const { confirm: confirmFn } = await import("../utils/prompts.js");
					const ok = await confirmFn(
						`Delete ${keys.length} variable(s)?`,
						false,
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const apps = await client.application.allByOrganization.query();
				const app = findApp(
					Array.isArray(apps) ? apps : (apps as any)?.applications || [],
					appIdentifier,
				);
				if (!app) throw new NotFoundError("Application", appIdentifier);
				const _spinner = startSpinner("Deleting variables...");
				await client.envVariable.bulkDelete.mutate({
					applicationId: (app as any).applicationId,
					keys,
				} as any);
				succeedSpinner(`Deleted ${keys.length} variable(s)!`);
				if (isJsonMode()) outputData({ deleted: keys.length });
			} catch (err) {
				handleError(err);
			}
		});

	// Copy env variables between environments
	env
		.command("copy")
		.argument("<app>", "App ID or name")
		.argument("<from-env>", "Source environment ID")
		.argument("<to-env>", "Target environment ID")
		.description("Copy environment variables from one environment to another")
		.action(async (appIdentifier, fromEnvId, toEnvId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const apps = await client.application.allByOrganization.query();
				const app = findApp(
					Array.isArray(apps) ? apps : (apps as any)?.applications || [],
					appIdentifier,
				);
				if (!app) throw new NotFoundError("Application", appIdentifier);
				if (!shouldSkipConfirmation()) {
					const { confirm: confirmFn } = await import("../utils/prompts.js");
					const ok = await confirmFn(
						`Copy env vars from ${fromEnvId} to ${toEnvId}?`,
						false,
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const _spinner = startSpinner("Copying variables...");
				await client.envVariable.copy.mutate({
					applicationId: (app as any).applicationId,
					fromEnvironmentId: fromEnvId,
					toEnvironmentId: toEnvId,
				} as any);
				succeedSpinner("Variables copied!");
				if (isJsonMode()) outputData({ copied: true });
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
