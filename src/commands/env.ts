import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isManagedDbEnvPlaceholder } from "../lib/app-env.js";
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

const envSubcommands = new Set([
	"list",
	"ls",
	"set",
	"unset",
	"pull",
	"push",
	"apply",
	"audit",
	"reveal",
	"get",
	"get-string",
	"bulk-set",
	"bulk-delete",
	"copy",
]);

/** One `KEY=value` pair read out of a local .env file. */
export interface DotenvEntry {
	key: string;
	value: string;
}

export interface DotenvParseResult {
	entries: DotenvEntry[];
	/** Human-readable problems, one per offending line, with line numbers. */
	errors: string[];
}

/**
 * Parse a .env document the way `envVariable.saveDotenv` does on the server,
 * so a malformed file is rejected locally with line numbers instead of coming
 * back as one aggregated BAD_REQUEST. Blank lines and `#` comments are
 * skipped; `export ` prefixes are tolerated; a single pair of matching quotes
 * around a value is stripped.
 */
export function parseDotenvDocument(content: string): DotenvParseResult {
	const entries: DotenvEntry[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();

	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index] ?? "";
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const withoutExport = line.startsWith("export ")
			? line.slice("export ".length).trim()
			: line;
		const separator = withoutExport.indexOf("=");
		if (separator === -1) {
			errors.push(`line ${index + 1}: no "=" in "${truncateLine(line)}"`);
			continue;
		}

		const key = withoutExport.slice(0, separator).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			errors.push(
				`line ${index + 1}: "${truncateLine(key)}" is not a valid variable name (letters, digits and underscores; cannot start with a digit)`,
			);
			continue;
		}
		if (seen.has(key)) {
			errors.push(`line ${index + 1}: ${key} is set more than once`);
			continue;
		}
		seen.add(key);

		let value = withoutExport.slice(separator + 1).trim();
		const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
		if (quoted?.[2] !== undefined) value = quoted[2];
		entries.push({ key, value });
	}

	return { entries, errors };
}

function truncateLine(line: string): string {
	return line.length > 40 ? `${line.slice(0, 40)}...` : line;
}

export interface DotenvReplacePlan {
	created: string[];
	deleted: string[];
	/** True when the app currently has variables and the new document has none. */
	emptiesEverything: boolean;
	unchanged: string[];
	updated: string[];
}

/**
 * Work out what `envVariable.saveDotenv` will do with a document before
 * sending it. The server replaces the whole set — every key missing from the
 * file is DELETED — so the caller has to be shown the deletions, and an empty
 * document has to be recognised as "wipe everything" rather than "no-op".
 *
 * `placeholder` values are the platform's managed-database notice rather than
 * a real secret; a line still holding one keeps the stored value, so it is
 * never counted as a change.
 */
export function planDotenvReplace(
	current: DotenvEntry[],
	desired: DotenvEntry[],
	isPlaceholder: (value: string) => boolean = () => false,
): DotenvReplacePlan {
	const currentByKey = new Map(current.map((entry) => [entry.key, entry.value]));
	const desiredKeys = new Set(desired.map((entry) => entry.key));

	const created: string[] = [];
	const updated: string[] = [];
	const unchanged: string[] = [];
	for (const entry of desired) {
		const existing = currentByKey.get(entry.key);
		if (existing === undefined) {
			created.push(entry.key);
		} else if (isPlaceholder(entry.value) || existing === entry.value) {
			unchanged.push(entry.key);
		} else {
			updated.push(entry.key);
		}
	}

	const deleted = current
		.map((entry) => entry.key)
		.filter((key) => !desiredKeys.has(key));

	return {
		created,
		deleted,
		emptiesEverything: desired.length === 0 && current.length > 0,
		unchanged,
		updated,
	};
}

/**
 * Preserve the original documented `tarout env <app> <command>` form while
 * Commander uses the unambiguous `tarout env <command> <app>` grammar.
 */
export function normalizeEnvCommandArgs(argv: string[]): string[] {
	// Only the CLI's own arguments: everything after `--` belongs to another
	// program (`tarout run -- env FOO=1 printenv`) and must reach it untouched.
	const separator = argv.indexOf("--");
	const own = separator === -1 ? argv : argv.slice(0, separator);
	const envIndex = own.indexOf("env");
	if (envIndex === -1) return argv;

	const app = own[envIndex + 1];
	const subcommand = own[envIndex + 2];
	if (
		!app ||
		app.startsWith("-") ||
		envSubcommands.has(app) ||
		!subcommand ||
		!envSubcommands.has(subcommand)
	) {
		return argv;
	}

	const normalized = [...argv];
	normalized[envIndex + 1] = subcommand;
	normalized[envIndex + 2] = app;
	return normalized;
}

export function registerEnvCommands(program: Command) {
	const env = program
		.command("env")
		.description("Manage environment variables");

	// List environment variables
	env
		.command("list")
		.alias("ls")
		.argument("<app>", "Application ID or name")
		.description("List all environment variables")
		.option("--reveal", "Show actual values (not masked)")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
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
					["KEY", "VALUE", "SECRET", "AVAILABLE", "UPDATED"],
					variables.map((v: any) => [
						colors.cyan(v.key),
						options.reveal ? v.value || colors.dim("-") : maskValue(v.value),
						v.isSecret ? colors.warn("Yes") : "No",
						// Which stage can actually read this variable. Only public
						// prefixes reach the build; everything else exists solely in
						// the running container. A build that reads a runtime-only
						// variable sees nothing, and without this column there was no
						// way to tell that from "the variable is set".
						v.buildTimeAvailable
							? "build + runtime"
							: colors.dim("runtime only"),
						formatDate(v.updatedAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${variables.length} variable${variables.length === 1 ? "" : "s"}`,
					),
				);
				if (variables.some((v: any) => v.buildTimeAvailable === false)) {
					log(
						colors.dim(
							"Runtime-only variables are injected when the container starts — they are not visible to your build.",
						),
					);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Set environment variable
	env
		.command("set")
		.argument("<app>", "Application ID or name")
		.argument(
			"<key[=value]>",
			"Variable to set (KEY=value), or just KEY to read the value from stdin",
		)
		.description("Set an environment variable")
		.option("-s, --secret", "Mark as secret (default)", true)
		.option("--no-secret", "Mark as non-secret")
		.action(async (appIdentifier, keyValue, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				// Parse KEY=value, or take the value from stdin when only KEY is
				// given. Argv can't carry multi-line secrets (PEM keys, .npmrc) and
				// leaks values into shell history, so
				// `tarout env <app> set KEY < key.pem` is the safe form.
				const eqIndex = keyValue.indexOf("=");
				let key: string;
				let value: string;
				if (eqIndex === -1) {
					// Only when stdin is piped/redirected — on an interactive TTY
					// there is nothing to read and we would hang forever.
					if (process.stdin.isTTY) {
						throw new InvalidArgumentError(
							"Invalid format. Use KEY=value (e.g., API_KEY=secret123), or pipe the value: tarout env <app> set API_KEY < secret.txt",
						);
					}
					key = keyValue;
					value = await readStdin();
				} else {
					key = keyValue.slice(0, eqIndex);
					value = keyValue.slice(eqIndex + 1);
				}

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

				// Whether the build can see this key at all. The server is the
				// authority (isSafeBuildTimeEnvironmentKey); re-read the row we just
				// wrote rather than duplicating the prefix list here, where it would
				// drift.
				const written = (
					await client.envVariable.list
						.query({
							applicationId: app.applicationId,
							includeValues: false,
						})
						.catch(() => [] as any[])
				).find((v: any) => v.key === key);
				const buildTimeAvailable = written?.buildTimeAvailable !== false;

				if (isJsonMode()) {
					outputData({ key, updated: !!existingVar, buildTimeAvailable });
				} else {
					quietOutput(key);
					// create/update persist the value but do not push it to the
					// running container — it takes effect on the next deploy.
					log(colors.dim(`Applies on next deploy: tarout deploy ${appIdentifier}`));
					if (!buildTimeAvailable) {
						// Said here rather than discovered from a failed build: a
						// build step that reads this key gets nothing, however
						// correctly it was set.
						log(
							colors.dim(
								`${key} is runtime-only — it is injected when the container starts and is NOT visible during the build.`,
							),
						);
					}
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Unset environment variable
	env
		.command("unset")
		.argument("<app>", "Application ID or name")
		.argument("<key>", "Variable key to remove")
		.description("Remove an environment variable")
		.option(
			"--restart",
			"Deprecated no-op: deleting a variable always restarts the app to apply (kept for backward compatibility)",
		)
		.action(async (appIdentifier, key, _options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
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

				// The platform contract (apiDeleteEnvVariable) requires restart to be
				// the literal `true` — a deletion is only complete once Tarout
				// confirms a healthy replacement workload, so it always restarts.
				// Sending restart:false was rejected by the server, which broke
				// `env unset` whenever --restart was omitted.
				await client.envVariable.delete.mutate({
					applicationId: app.applicationId,
					key,
					restart: true,
				});

				succeedSpinner(`Removed ${key}`);

				if (isJsonMode()) {
					outputData({ key, deleted: true, restarted: true });
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
		.argument("<app>", "Application ID or name")
		.description("Download environment variables as .env file")
		.option("-o, --output <file>", "Output file path", ".env")
		.option("--reveal", "Include actual secret values")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
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
		.argument("<app>", "Application ID or name")
		.description("Upload environment variables from .env file")
		.option("-i, --input <file>", "Input file path", ".env")
		.option(
			"--replace",
			"Replace all existing variables (default: merge). Requires --restart",
		)
		.option(
			"--restart",
			"Restart the app to apply now (default: apply on next restart)",
		)
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				// The platform refuses a replace-all import without a restart
				// (apiImportEnvVariables: it must confirm a healthy replacement
				// workload), so say why here instead of after the round trip.
				if (options.replace && !options.restart) {
					throw new InvalidArgumentError(
						"--replace deletes every variable missing from the file, so the platform only accepts it together with --restart (the app restarts to confirm it is healthy with the new set). Re-run with --replace --restart, or drop --replace to merge.",
					);
				}

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
					restart: !!options.restart,
				});

				succeedSpinner(`Imported ${result.imported} variables`);

				if (isJsonMode()) {
					outputData(result);
				} else {
					quietOutput(String(result.imported));
					// `skipped` counts entries the platform refused as invalid
					// (bad key name or oversized value), not existing keys.
					if (result.skipped > 0) {
						log(
							colors.dim(
								`Skipped ${result.skipped} invalid entr${result.skipped === 1 ? "y" : "ies"} (keys use letters, digits and underscores and cannot start with a digit; values are limited to 64 KB)`,
							),
						);
					}
					if (!options.restart)
						log(
							colors.dim(`Apply now with: tarout apps restart ${appIdentifier}`),
						);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Apply a .env file as the app's COMPLETE variable set.
	//
	// Distinct from `push`, which merges through `envVariable.import` (and whose
	// `--replace` needs `--restart`). `saveDotenv` is the dashboard's .env
	// editor save: it takes the revision the document was read at, so a
	// concurrent change by a teammate or another agent is a CONFLICT instead of
	// a silent overwrite, it keeps managed-database values whose line still
	// holds the platform's placeholder, and any key missing from the file is
	// deleted through the confirmed replacement (which redeploys the app and
	// verifies the key is gone at the provider).
	env
		.command("apply")
		.argument("<app>", "Application ID or name")
		.description(
			"Replace an application's entire environment variable set with the contents of a .env file. Unlike `env push`, which merges, this is the dashboard's .env editor save: every key missing from the file is DELETED, the file is checked against the revision it was read at so a concurrent edit fails as a conflict rather than being overwritten, and a removal redeploys the app to confirm the key is really gone. Use `env push` to add or update without deleting anything.",
		)
		.option("-i, --input <file>", "Input file path", ".env")
		.option(
			"--allow-empty",
			"Permit an empty or comment-only file, which deletes every variable the application has",
		)
		.action(
			async (
				appIdentifier: string,
				options: { allowEmpty?: boolean; input?: string },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					const inputPath = options.input ?? ".env";
					if (!existsSync(inputPath)) {
						throw new InvalidArgumentError(`File not found: ${inputPath}`);
					}
					const content = readFileSync(inputPath, "utf-8");

					// Refuse a malformed document here: the server aggregates the
					// first five problems into one message, and line numbers are more
					// use than that.
					const parsed = parseDotenvDocument(content);
					if (parsed.errors.length > 0) {
						throw new InvalidArgumentError(
							`${inputPath} has ${parsed.errors.length} problem(s) and was not sent: ${parsed.errors.slice(0, 5).join("; ")}${
								parsed.errors.length > 5
									? `; and ${parsed.errors.length - 5} more`
									: ""
							}`,
						);
					}

					const client = getApiClient();

					const _spinner = startSpinner("Reading current variables...");
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

					// The revision is the server's optimistic lock: it is only valid
					// for the set as it is right now, so it is read immediately before
					// the save and never cached.
					const document = (await client.envVariable.getDotenv.query({
						applicationId: app.applicationId,
					} as any)) as { content?: string; count?: number; revision: string };
					succeedSpinner();

					const currentEntries = parseDotenvDocument(
						document?.content ?? "",
					).entries;
					const plan = planDotenvReplace(
						currentEntries,
						parsed.entries,
						isManagedDbEnvPlaceholder,
					);

					// With replace semantics an empty file is not a no-op, it is a
					// request to delete everything — almost always a wrong path or an
					// empty heredoc rather than an intention.
					if (plan.emptiesEverything && !options.allowEmpty) {
						throw new InvalidArgumentError(
							`${inputPath} contains no variables, and applying it would DELETE all ${currentEntries.length} variable(s) on "${app.name}". Re-run with --allow-empty if that is what you want, or use \`tarout env bulk-delete\` to remove specific keys.`,
						);
					}

					const changeCount =
						plan.created.length + plan.updated.length + plan.deleted.length;
					if (changeCount === 0) {
						if (isJsonMode()) {
							outputData({
								applicationId: app.applicationId,
								changed: false,
								created: [],
								updated: [],
								deleted: [],
							});
							return;
						}
						log("");
						log(`${app.name} already matches ${inputPath}. Nothing to do.`);
						log("");
						return;
					}

					// Deletions are the dangerous half of replace semantics, so they
					// are named rather than counted.
					if (!shouldSkipConfirmation()) {
						log("");
						log(colors.bold(`Apply ${inputPath} to ${app.name}`));
						log(`  Add:    ${plan.created.length}`);
						log(`  Update: ${plan.updated.length}`);
						log(
							`  Delete: ${plan.deleted.length}${
								plan.deleted.length > 0
									? ` ${colors.warn(`(${plan.deleted.join(", ")})`)}`
									: ""
							}`,
						);
						if (plan.deleted.length > 0) {
							log("");
							log(
								colors.warn(
									"Deleting a variable redeploys the application so the platform can confirm it is gone.",
								),
							);
						}
						log("");
						const confirmed = await confirm(
							`Replace the environment of "${app.name}" with ${inputPath}?`,
							false,
							{
								field: "confirm_env_apply",
								flag: "--yes",
								context: {
									appName: app.name,
									applicationId: app.applicationId,
									deleted: plan.deleted.length,
								},
							},
						);
						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}

					const _saveSpinner = startSpinner("Applying variables...");
					const result = (await client.envVariable.saveDotenv.mutate({
						applicationId: app.applicationId,
						content,
						revision: document.revision,
					} as any)) as {
						changed?: boolean;
						created?: string[];
						deleted?: string[];
						restarted?: boolean;
						updated?: string[];
					};
					succeedSpinner("Environment applied.");

					if (isJsonMode()) {
						outputData(result);
						return;
					}

					const created = result?.created ?? [];
					const updated = result?.updated ?? [];
					const deleted = result?.deleted ?? [];
					quietOutput(String(created.length + updated.length + deleted.length));
					log("");
					log(
						`  ${colors.success(String(created.length))} added, ${colors.cyan(String(updated.length))} updated, ${colors.warn(String(deleted.length))} deleted`,
					);
					if (result?.restarted) {
						log(
							colors.dim(
								"The application was redeployed to confirm the removals.",
							),
						);
					} else {
						log(
							colors.dim(
								`Applies on next restart: tarout apps restart ${appIdentifier}`,
							),
						);
					}
					log("");
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// View env variable audit log
	env
		.command("audit")
		.argument("<app>", "Application ID or name")
		.description("Show audit log for environment variables")
		.option("-k, --key <key>", "Filter by variable key")
		.option("-n, --limit <n>", "Number of entries to show", "50")
		.action(async (appIdentifier: string, options: any) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

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
		.argument("<app>", "Application ID or name")
		.argument("<key>", "Variable key to reveal")
		.description(
			"Reveal the plaintext value of an environment variable (logged)",
		)
		.action(async (appIdentifier: string, key: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

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
				// getAsString returns the FULL env set (the server ignores a `key`
				// input). Scope to the requested key client-side so this command
				// doesn't dump every secret when the user asked for one.
				const raw = await client.envVariable.getAsString.query({
					applicationId: (app as any).applicationId,
				} as any);
				succeedSpinner();
				const text = typeof raw === "string" ? raw : String(raw ?? "");
				const line = text
					.split("\n")
					.find((l) => l.trimStart().startsWith(`${key}=`));
				if (!line) {
					throw new NotFoundError("Environment variable", key);
				}
				if (isJsonMode()) {
					outputData({ key, value: line.slice(line.indexOf("=") + 1) });
				} else {
					log(line.trim());
				}
			} catch (err) {
				handleError(err);
			}
		});

	// NOTE: there is no `list-all-envs` command. It called
	// `envVariable.listAcrossEnvs`, a procedure that does not exist on the
	// platform (see cloud/src/server/api/routers/env-variable.ts), so it always
	// failed. It was also premised on the phantom per-app "environments" model.
	// Environment variables belong to an application, full stop — use
	// `tarout env <app> list`.

	// Bulk upsert env variables from JSON file
	env
		.command("bulk-set")
		.argument("<app>", "App ID or name")
		.description("Bulk create/update environment variables from a JSON object")
		.option("--vars <json>", "JSON object of key-value pairs")
		.option(
			"--restart",
			"Restart the app to apply now (default: apply on next restart)",
		)
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
					log('Enter JSON key-value object (e.g. {"KEY":"value"}):');
					const input2 = await (await import("../utils/prompts.js")).input(
						"JSON:",
						undefined,
						{
							field: "vars",
							flag: "--vars",
							context: {
								example: '{"KEY":"value","OTHER":"123"}',
							},
						},
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
					restart: !!options.restart,
				} as any);
				succeedSpinner(`Bulk set ${Object.keys(vars).length} variable(s)!`);
				if (isJsonMode())
					outputData({
						updated: Object.keys(vars).length,
						restarted: !!options.restart,
					});
				else if (!options.restart)
					log(
						colors.dim(`Apply now with: tarout apps restart ${appIdentifier}`),
					);
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

	// Copy env variables from one app to another.
	// The server contract (apiCopyEnvVariables) is strictly app-to-app:
	// { sourceApplicationId, targetApplicationId, keys?, overwrite? }. It has no
	// notion of "environments" — the old `<app> <from-env> <to-env>` form sent
	// sourceEnvironmentId/targetEnvironmentId (silently stripped by zod) with the
	// SAME applicationId on both sides, so it copied an app onto itself and
	// reported success. Keep source and target as two distinct apps here.
	env
		.command("copy")
		.argument("<source-app>", "App ID or name to copy variables FROM")
		.argument("<target-app>", "App ID or name to copy variables INTO")
		.description("Copy environment variables from one app to another")
		.option(
			"-k, --keys <keys...>",
			"Only copy these keys (default: every variable)",
		)
		.option(
			"--overwrite",
			"Overwrite keys that already exist on the target (default: skip them)",
		)
		.action(async (sourceIdentifier, targetIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				// One fetch resolves both refs — same name-or-id + did-you-mean idiom
				// the rest of this file uses.
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const resolveApp = (identifier: string) => {
					const found = findApp(apps, identifier);
					if (!found) {
						const suggestions = findSimilar(
							identifier,
							apps.map((a) => a.name),
						);
						throw new NotFoundError("Application", identifier, suggestions);
					}
					return found;
				};
				const source = resolveApp(sourceIdentifier);
				const target = resolveApp(targetIdentifier);

				if (source.applicationId === target.applicationId) {
					throw new InvalidArgumentError(
						"Source and target must be different applications",
					);
				}

				// Accept both `--keys A B` and `--keys A,B`.
				const keys: string[] | undefined = Array.isArray(options.keys)
					? (options.keys as string[])
							.flatMap((k) => k.split(","))
							.map((k) => k.trim())
							.filter(Boolean)
					: undefined;

				if (!shouldSkipConfirmation()) {
					const { confirm: confirmFn } = await import("../utils/prompts.js");
					const ok = await confirmFn(
						keys?.length
							? `Copy ${keys.length} variable(s) from ${source.name} to ${target.name}?`
							: `Copy all environment variables from ${source.name} to ${target.name}?`,
						false,
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}

				const _spinner = startSpinner("Copying variables...");
				const result = await client.envVariable.copy.mutate({
					sourceApplicationId: source.applicationId,
					targetApplicationId: target.applicationId,
					// Omit `keys` entirely (rather than sending []) so the server
					// copies everything — the schema treats it as optional.
					...(keys?.length ? { keys } : {}),
					overwrite: !!options.overwrite,
				} as any);

				const copied = (result as any)?.copied ?? 0;
				const skipped = (result as any)?.skipped ?? 0;
				succeedSpinner(`Copied ${copied} variable(s) to ${target.name}`);

				if (isJsonMode()) {
					outputData(result);
					return;
				}
				quietOutput(String(copied));
				if (skipped > 0) {
					log(
						colors.dim(
							`Skipped ${skipped} existing variable(s) — re-run with --overwrite to replace them`,
						),
					);
				}
				// copy persists values but does not push them into the running
				// container — they take effect on the target's next deploy.
				log(
					colors.dim(`Applies on next deploy: tarout deploy ${targetIdentifier}`),
				);
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

/**
 * Reads the whole of stdin as UTF-8, used for `tarout env <app> set KEY`.
 * Exactly one trailing newline is stripped: `echo secret |` and heredocs append
 * one that is never part of the intended value, while interior newlines (a PEM
 * body, a multi-line .npmrc) are preserved verbatim.
 */
async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "");
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
