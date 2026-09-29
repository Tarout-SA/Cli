/**
 * @fileoverview `tarout run -- <command> [args...]`: run a LOCAL command with the
 * linked app's environment variables injected, the way `doppler run` or
 * `op run` do. Handy for migrations, seeds, test suites and one-off scripts
 * that need the app's real configuration.
 * @module commands/run
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { reportAppEnvNotices, resolveAppEnv } from "../lib/app-env.js";
import {
	getProjectConfig,
	isLoggedIn,
	isProjectLinked,
} from "../lib/config.js";
import { resolveAppRef } from "../lib/env-core.js";
import {
	AuthError,
	CliError,
	handleError,
	InvalidArgumentError,
} from "../lib/errors.js";
import { isJsonMode } from "../lib/output.js";
import { runArgv } from "../lib/process.js";
import { exit } from "../utils/exit-codes.js";
import { startSpinner, stopSpinner } from "../utils/spinner.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/**
 * The app whose environment to inject: `--app` (id, name, slug or unique id
 * prefix) wins, otherwise the directory's linked app (`.tarout/project.json`).
 * `tarout exec` picks its target the same way.
 */
export async function resolveRunApp(
	client: TrpcClient,
	appRef: string | undefined,
): Promise<{ applicationId: string; name: string }> {
	if (appRef) return resolveAppRef(client, appRef);
	if (isProjectLinked()) {
		const config = getProjectConfig();
		if (!config) {
			throw new CliError(
				"Project config is corrupted. Run 'tarout link' to relink.",
			);
		}
		return { applicationId: config.applicationId, name: config.name };
	}
	throw new InvalidArgumentError(
		"No linked application. Run 'tarout link' first or use the --app flag.",
	);
}

function spawnErrorMessage(command: string, error: NodeJS.ErrnoException) {
	if (error.code === "ENOENT") {
		return `Command not found: ${command}. tarout run starts it directly, without a shell, so aliases, shell builtins and pipes are unavailable; wrap them as \`tarout run -- sh -c "..."\`.`;
	}
	if (error.code === "EACCES" || error.code === "EPERM") {
		return `Permission denied running ${command}. Check that it is executable.`;
	}
	return `Could not start ${command}: ${error.message}`;
}

export function registerRunCommand(program: Command): void {
	program
		.command("run")
		.description(
			"Run a local command with the linked app's environment variables injected",
		)
		.argument("[command...]", "The command and its arguments, after --")
		.option(
			"-a, --app <app>",
			"Application ID, name or slug (overrides the linked app)",
		)
		.addHelpText(
			"after",
			`
Put the command after --. It runs directly, without a shell, and every
argument reaches it exactly as typed. Managed database variables hold the
external connection details; a database without external access is left
unset with a hint on stderr. Values are never printed. The command's output
and exit code pass straight through (a signal exits 128+n), so --json does not
apply.

Examples:
  tarout run -- npm test
  tarout run --app api -- npx prisma migrate deploy
  tarout run -- node scripts/seed.js --dry-run`,
		)
		.action(async (argv: string[], options: { app?: string }) => {
			let exitCode: number;
			try {
				if (isJsonMode()) {
					throw new InvalidArgumentError(
						"tarout run hands the terminal to the command, so it has no JSON result. Drop --json; the command's own output and exit code pass straight through.",
					);
				}
				const [command, ...args] = argv ?? [];
				if (!command) {
					throw new InvalidArgumentError(
						"Pass the command to run after --, for example `tarout run -- npm test`.",
					);
				}
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const app = await resolveRunApp(client, options.app);

				startSpinner(`Loading environment variables for ${app.name}...`);
				let resolved: Awaited<ReturnType<typeof resolveAppEnv>>;
				try {
					resolved = await resolveAppEnv(client, app.applicationId);
				} finally {
					stopSpinner();
				}
				reportAppEnvNotices(resolved);

				const result = await runArgv(command, args, { env: resolved.env });
				if (result.error) {
					throw new CliError(
						spawnErrorMessage(command, result.error),
						result.exitCode,
					);
				}
				exitCode = result.exitCode;
			} catch (err) {
				handleError(err);
			}
			// The child's status, unmapped: a passthrough must not rewrite a test
			// runner's exit 2 into one of the CLI's own codes.
			exit(exitCode);
		});
}
