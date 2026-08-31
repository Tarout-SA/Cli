/**
 * @fileoverview Explicit Tarout CLI upgrade command.
 * @module commands/upgrade
 */

import type { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import {
	type CliUpgradeResult,
	upgradeCli as runCliUpgrade,
	type UpgradeCliOptions,
} from "../lib/update-check.js";
import {
	error,
	isJsonMode,
	isQuietMode,
	outputData,
	outputError,
	quietOutput,
} from "../lib/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import {
	failSpinner,
	startSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

export interface UpgradeCommandDependencies {
	currentVersion: string;
	upgradeCli: (options: UpgradeCliOptions) => Promise<CliUpgradeResult>;
}

const defaultDependencies: UpgradeCommandDependencies = {
	currentVersion: packageJson.version,
	upgradeCli: runCliUpgrade,
};

function emitFailure(
	code: "UPGRADE_CHECK_FAILED" | "UPGRADE_INSTALL_FAILED",
	message: string,
	details: Record<string, unknown>,
): void {
	failSpinner("Tarout CLI upgrade failed");
	if (isJsonMode()) {
		outputError(code, message, details);
	} else {
		error(message);
	}
	process.exitCode = ExitCode.GENERAL_ERROR;
}

export function emitUpgradeResult(result: CliUpgradeResult): void {
	if (result.status === "check_failed") {
		emitFailure(
			"UPGRADE_CHECK_FAILED",
			"Could not determine the latest published Tarout CLI version.",
			{ currentVersion: result.currentVersion },
		);
		return;
	}

	if (result.status === "install_failed") {
		emitFailure(
			"UPGRADE_INSTALL_FAILED",
			`Could not upgrade Tarout CLI to ${result.latestVersion}: ${result.error}`,
			{
				currentVersion: result.currentVersion,
				latestVersion: result.latestVersion,
				command: `npm install -g @tarout/cli@${result.latestVersion}`,
			},
		);
		return;
	}

	if (result.status === "upgraded") {
		succeedSpinner(
			`Tarout CLI upgraded ${result.previousVersion} → ${result.currentVersion}`,
		);
	} else if (result.currentIsNewer) {
		succeedSpinner(
			`Tarout CLI ${result.currentVersion} is newer than the published ${result.latestVersion}`,
		);
	} else {
		succeedSpinner(`Tarout CLI is already up to date (${result.currentVersion})`);
	}

	if (isJsonMode()) {
		outputData(result);
	} else if (isQuietMode()) {
		quietOutput(result.currentVersion);
	}
}

/** Register `tarout upgrade`, which deliberately needs no auth or project. */
export function registerUpgradeCommand(
	program: Command,
	dependencies: Partial<UpgradeCommandDependencies> = {},
): void {
	const deps = { ...defaultDependencies, ...dependencies };
	program
		.command("upgrade")
		.description("Upgrade Tarout CLI to the latest published version")
		.action(async () => {
			startSpinner("Checking for Tarout CLI updates...");
			const result = await deps.upgradeCli({
				currentVersion: deps.currentVersion,
				onUpdateAvailable: (currentVersion, latestVersion) => {
					updateSpinner(
						`Upgrading Tarout CLI ${currentVersion} → ${latestVersion}...`,
					);
				},
			});
			emitUpgradeResult(result);
		});
}
