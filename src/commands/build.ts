/**
 * @fileoverview Build command for building locally with cloud env vars.
 * Similar to Vercel's `vercel build` command.
 *
 * `tarout build --explain` is a different, remote mode: it asks the platform
 * what a deploy would build from the app's configured source on Tarout (the
 * tracked Git branch or the last uploaded archive) and prints the plan. It
 * runs nothing locally and reads no local files.
 * @module commands/build
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import {
	type AppEnv,
	reportAppEnvNotices,
	resolveAppEnv,
	unavailableEnvField,
} from "../lib/app-env.js";
import {
	type BuildExplainResult,
	DEFAULT_EXPLAIN_WAIT_SECONDS,
	EXPLAIN_RATE_LIMIT_MESSAGE,
	type ExplainBuildOutcome,
	explainBuild,
	explainRateLimitDetails,
	isExplainRateLimitError,
	MAX_EXPLAIN_WAIT_SECONDS,
	parseExplainWait,
} from "../lib/build-explain.js";
import {
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
import {
	colors,
	isJsonMode,
	log,
	outputData,
	outputError,
	quietOutput,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import {
	detectFramework,
	detectPackageManager,
	getBuildCommand,
	readPackageJson,
	runCommand,
} from "../lib/process.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";
import { quoteShellArg } from "./exec.js";
import { resolveRunApp } from "./run.js";

interface BuildOptions {
	app?: string;
	command?: string;
	explain?: boolean;
	wait?: string;
}

export function registerBuildCommand(program: Command) {
	program
		.command("build")
		.description(
			"Build locally with cloud environment variables, or --explain what Tarout would build",
		)
		.option("-a, --app <app>", "Application ID or name (overrides linked app)")
		.option("-c, --command <command>", "Custom build command to run")
		.option(
			"--explain",
			"Explain what a deploy would build from the app's configured source on Tarout; runs nothing locally",
		)
		.option(
			"--wait <seconds>",
			`With --explain: seconds to wait for a slow inspection, 0 to ${MAX_EXPLAIN_WAIT_SECONDS} (default ${DEFAULT_EXPLAIN_WAIT_SECONDS})`,
		)
		.addHelpText(
			"after",
			`
--explain asks Tarout what a deploy would build and whether it would get past
the pre-build checks, without building, deploying or changing anything. It
reads the app's CONFIGURED source on Tarout (the tracked Git branch, or the
last uploaded archive), not your local files: commit and push (or upload)
first to explain local changes. It prints the source, detected languages,
toolchain versions, build steps and commands, start command, port and the
NAMES of build-time variables (never values), then any warnings and errors.

Exit status with --explain: 0 when the plan is ok, 12 (BUILD_FAILED) when a
deploy would fail, 11 (EXPLAIN_PENDING) when Tarout is still inspecting after
--wait (run it again to pick up the same inspection). --json prints one
envelope carrying the platform's full answer. Limited to 10 a minute per user.

Examples:
  tarout build
  tarout build --command "npm run build:prod"
  tarout build --explain
  tarout build --explain --app api --wait 300 --json`,
		)
		.action(async (options: BuildOptions) => {
			if (options.explain) {
				await runBuildExplain(options);
				return;
			}
			try {
				if (options.wait !== undefined) {
					throw new InvalidArgumentError(
						"--wait only applies with --explain. A local build runs until its command exits.",
					);
				}
				if (!isLoggedIn()) throw new AuthError();

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
				let appEnv: AppEnv;

				try {
					// Shared with `tarout run`: drops the platform's managed-database
					// placeholder and injects the external connection details instead.
					appEnv = await resolveAppEnv(client, applicationId);
					envVars = appEnv.env;
					succeedSpinner(
						`Loaded ${Object.keys(envVars).length} environment variables`,
					);
				} catch (err) {
					failSpinner();
					throw new CliError(
						`Failed to fetch environment variables: ${err instanceof Error ? err.message : "Unknown error"}`,
					);
				}
				reportAppEnvNotices(appEnv);

				// Add NODE_ENV=production for build
				envVars.NODE_ENV = envVars.NODE_ENV || "production";

				// Detect framework for display
				const framework = detectFramework(pkg);

				if (isJsonMode()) {
					// In JSON mode, we still run the build but capture output
					const startTime = Date.now();
					const result = await runCommand(buildCommand, envVars);
					const duration = Math.round((Date.now() - startTime) / 1000);

					if (result.exitCode === 0) {
						outputData({
							success: true,
							applicationId,
							appName,
							command: buildCommand,
							framework: framework?.name || "Unknown",
							envVarCount: Object.keys(envVars).length,
							packageManager: pm,
							...unavailableEnvField(appEnv),
							exitCode: result.exitCode,
							details: { childExitCode: result.exitCode },
							duration,
						});
						return;
					}

					// A FAILED build must be a top-level failure envelope, not a
					// jsonSuccess wrapper around `{ success: false }` — an agent keying
					// on the top-level `.success` would otherwise misread the failure as
					// a pass. Reuse the structured-error shape other commands emit
					// (`{ success:false, error:{ code, message, details } }`); the child's
					// real code stays in `details.childExitCode`, and the process still
					// exits with the CLI's reserved BUILD_FAILED (12) rather than the raw
					// child code (which could collide with 2/3/4/5).
					outputError(
						"BUILD_FAILED",
						`Build failed with exit code ${result.exitCode}`,
						{
							applicationId,
							appName,
							command: buildCommand,
							framework: framework?.name || "Unknown",
							envVarCount: Object.keys(envVars).length,
							packageManager: pm,
							...unavailableEnvField(appEnv),
							exitCode: result.exitCode,
							childExitCode: result.exitCode,
							duration,
						},
					);
					exit(ExitCode.BUILD_FAILED);
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

// ---------------------------------------------------------------------------
// tarout build --explain
// ---------------------------------------------------------------------------

/** Past these, the report says so and points at --json for the full plan. */
const MAX_PACKAGES_SHOWN = 8;
const MAX_STEPS_SHOWN = 12;
const MAX_COMMANDS_SHOWN_PER_STEP = 4;
const MAX_COMMAND_CHARS = 120;
const MAX_ENV_NAMES_SHOWN = 20;
const LABEL_WIDTH = 12;

/** The command that asks again (and joins an inspection still running). */
export function buildExplainCommand(applicationId: string): string {
	return `tarout build --explain --app ${quoteShellArg(applicationId)}`;
}

/**
 * Remote mode: resolve the app, ask the platform, report. Never reads
 * package.json, never fetches env values, never runs a local command.
 */
async function runBuildExplain(options: BuildOptions): Promise<void> {
	let exitCode: number = ExitCode.SUCCESS;
	try {
		if (options.command !== undefined) {
			throw new InvalidArgumentError(
				"--explain runs nothing locally, so it takes no --command. Drop one of the two.",
			);
		}
		const waitSeconds = parseExplainWait(options.wait);
		if (!isLoggedIn()) throw new AuthError();

		const client = getApiClient();
		const app = await resolveRunApp(client, options.app);

		startSpinner(`Asking Tarout what it would build for ${app.name}...`);
		let outcome: ExplainBuildOutcome;
		try {
			outcome = await explainBuild(client, app.applicationId, {
				waitMs: waitSeconds * 1000,
				onPending: () =>
					updateSpinner(`Tarout is still inspecting ${app.name}'s source...`),
			});
		} finally {
			stopSpinner();
		}
		exitCode = reportBuildExplain(app, outcome, waitSeconds);
	} catch (err) {
		if (isExplainRateLimitError(err)) {
			outputError(
				"TOO_MANY_REQUESTS",
				EXPLAIN_RATE_LIMIT_MESSAGE,
				explainRateLimitDetails(),
			);
			exit(ExitCode.GENERAL_ERROR);
		}
		handleError(err);
	}
	if (exitCode !== ExitCode.SUCCESS) exit(exitCode);
}

/**
 * Prints the answer (one envelope under --json) and returns the exit code:
 *   ok                  0  SUCCESS
 *   failed             12  BUILD_FAILED (a deploy would stop on these errors)
 *   still pending      11  EXPLAIN_PENDING (resumable: ask again)
 */
export function reportBuildExplain(
	app: { applicationId: string; name: string },
	outcome: ExplainBuildOutcome,
	waitSeconds: number,
): number {
	const { result, timedOut } = outcome;
	const data = { applicationId: app.applicationId, name: app.name, ...result };

	if (timedOut || result?.status === "pending") {
		if (!isJsonMode()) quietOutput("pending");
		outputError(
			"EXPLAIN_PENDING",
			`Tarout is still inspecting ${app.name}'s source after ${waitSeconds}s. Nothing failed: run it again to pick up the same inspection, or raise --wait.`,
			{
				...data,
				stillPending: true,
				nextCommand: buildExplainCommand(app.applicationId),
			},
		);
		return ExitCode.DEPLOYMENT_TIMEOUT;
	}

	const ok = result?.status === "ok";
	if (!isJsonMode()) {
		quietOutput(ok ? "ok" : "failed");
		for (const line of formatBuildExplainReport(app.name, result)) log(line);
	}
	if (ok) {
		outputData(data);
		return ExitCode.SUCCESS;
	}
	outputError("BUILD_FAILED", explainFailureMessage(app.name, result), data);
	return ExitCode.BUILD_FAILED;
}

function explainFailureMessage(
	appName: string,
	result: BuildExplainResult,
): string {
	const errors = result?.errors ?? [];
	const first = errors[0] ?? result?.summary ?? "see the errors in the plan";
	const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
	return `A deploy of ${appName} would fail: ${first}${more}`;
}

function row(label: string, value: string): string {
	return `  ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s*\n\s*/g, " ");
	return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

/** `repo@branch (sha7)`, or what the upload is when there is no repository. */
function describeExplainSource(
	source: BuildExplainResult["source"] | undefined,
): string {
	if (!source) return colors.dim("unknown");
	const sha = source.commitSha ? ` (${source.commitSha.slice(0, 7)})` : "";
	if (source.repository) {
		const where = source.branch
			? `${source.repository}@${source.branch}`
			: source.repository;
		return `${where}${sha} ${colors.dim(`[${source.type}]`)}`;
	}
	if (source.type === "drop") return `last uploaded archive${sha}`;
	if (source.type === "dockerfileUpload") return "uploaded Dockerfile";
	return source.type || colors.dim("unknown");
}

/** The human report, one entry per line. Exported for tests. */
export function formatBuildExplainReport(
	appName: string,
	result: BuildExplainResult,
): string[] {
	const ok = result?.status === "ok";
	let truncated = false;
	const lines: string[] = [
		"",
		`${colors.bold(`Build plan for ${colors.cyan(appName)}`)}  ${
			ok ? colors.success("✓ ok") : colors.error("✗ failed")
		}`,
		colors.dim(
			"  From the app's configured source on Tarout, not your local files. Nothing was built or deployed.",
		),
		"",
		row("Source", describeExplainSource(result?.source)),
		row(
			"Detected",
			result?.detectedKind
				? `${result.detectedKind} (build type: ${result.buildType})`
				: `build type: ${result?.buildType ?? "unknown"}`,
		),
	];
	if (result?.summary) lines.push(row("Summary", result.summary));

	const plan = result?.plan;
	if (plan) {
		const providers = plan.providers ?? [];
		if (providers.length) lines.push(row("Providers", providers.join(", ")));

		const packages = plan.packages ?? [];
		if (packages.length) {
			const shown = packages
				.slice(0, MAX_PACKAGES_SHOWN)
				.map((p) => (p.version ? `${p.name} ${p.version}` : p.name));
			const rest = packages.length - shown.length;
			if (rest > 0) truncated = true;
			lines.push(
				row(
					"Packages",
					`${shown.join(", ")}${rest > 0 ? colors.dim(` (+${rest} more)`) : ""}`,
				),
			);
		}

		const steps = plan.steps ?? [];
		if (steps.length) {
			lines.push("  Steps:");
			const shownSteps = steps.slice(0, MAX_STEPS_SHOWN);
			for (const [index, step] of shownSteps.entries()) {
				lines.push(`    ${index + 1}. ${step.name}`);
				const commands = step.commands ?? [];
				for (const command of commands.slice(0, MAX_COMMANDS_SHOWN_PER_STEP)) {
					if (command.length > MAX_COMMAND_CHARS) truncated = true;
					lines.push(
						`       ${colors.dim("$")} ${clip(command, MAX_COMMAND_CHARS)}`,
					);
				}
				const rest = commands.length - MAX_COMMANDS_SHOWN_PER_STEP;
				if (rest > 0) {
					truncated = true;
					lines.push(
						colors.dim(
							`       ... ${rest} more command${rest === 1 ? "" : "s"}`,
						),
					);
				}
			}
			const restSteps = steps.length - MAX_STEPS_SHOWN;
			if (restSteps > 0) {
				truncated = true;
				lines.push(
					colors.dim(
						`    ... ${restSteps} more step${restSteps === 1 ? "" : "s"}`,
					),
				);
			}
		}

		lines.push(
			row(
				"Start",
				plan.startCommand
					? clip(plan.startCommand, MAX_COMMAND_CHARS)
					: colors.dim("none detected"),
			),
		);
		lines.push(
			row("Port", plan.port != null ? String(plan.port) : colors.dim("none")),
		);

		const buildEnv = plan.buildEnv ?? [];
		const envShown = buildEnv.slice(0, MAX_ENV_NAMES_SHOWN);
		const envRest = buildEnv.length - envShown.length;
		if (envRest > 0) truncated = true;
		lines.push(
			row(
				"Build env",
				buildEnv.length
					? `${envShown.join(", ")}${envRest > 0 ? ` (+${envRest} more)` : ""} ${colors.dim("(names only)")}`
					: colors.dim("none"),
			),
		);
	}

	const warnings = result?.warnings ?? [];
	if (warnings.length) {
		lines.push("", colors.warn(`  Warnings (${warnings.length}):`));
		for (const warning of warnings) lines.push(colors.warn(`    ⚠ ${warning}`));
	}
	const errors = result?.errors ?? [];
	if (errors.length) {
		lines.push("", colors.error(`  Errors (${errors.length}):`));
		for (const error of errors) lines.push(colors.error(`    ✗ ${error}`));
	}
	if (truncated) {
		lines.push(
			"",
			colors.dim(
				"  Some of the plan is shortened above; --json prints all of it.",
			),
		);
	}
	lines.push("");
	return lines;
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
