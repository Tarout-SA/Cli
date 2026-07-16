#!/usr/bin/env node

import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { registerAccountCommands } from "./commands/account.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerAiCommands } from "./commands/ai.js";
import { registerAppsCommands } from "./commands/apps.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerBackupsCommands } from "./commands/backups.js";
import { registerBillingCommands } from "./commands/billing.js";
import { registerBuildCommand } from "./commands/build.js";
import { registerCallCommand } from "./commands/call.js";
import { registerDashboardCommands } from "./commands/dashboard.js";
import { registerDbCommands } from "./commands/db.js";
import {
	registerDeployCommands,
	registerLogsCommand,
} from "./commands/deploy.js";
import { registerDestinationsCommands } from "./commands/destinations.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerDomainsCommands } from "./commands/domains.js";
import {
	normalizeEnvCommandArgs,
	registerEnvCommands,
} from "./commands/env.js";
import { registerFirewallCommands } from "./commands/firewall.js";
import { registerInboxCommands } from "./commands/inbox.js";
import { registerInitCommand } from "./commands/init.js";
import { registerKeysCommands } from "./commands/keys.js";
import { registerLinkCommands } from "./commands/link.js";
import { registerMonitorCommands } from "./commands/monitor.js";
import { registerNotificationsCommands } from "./commands/notifications.js";
import { registerEnvsCommands, registerOrgsCommands } from "./commands/orgs.js";
import { registerProjectsCommands } from "./commands/projects.js";
import { registerProvidersCommands } from "./commands/providers.js";
import { registerQueuesCommands } from "./commands/queues.js";
import { registerServersCommands } from "./commands/servers.js";
import { registerSettingsCommands } from "./commands/settings.js";
import { registerStorageCommands } from "./commands/storage.js";
import { registerTicketsCommands } from "./commands/tickets.js";
import { registerUpCommand } from "./commands/up.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { emitAgentSetupHint } from "./lib/agent-setup.js";
import { outputError, setGlobalOptions } from "./lib/output.js";
import { ExitCode } from "./utils/exit-codes.js";

const program = new Command();

// CLI metadata
program
	.name("tarout")
	.description("Tarout PaaS Command Line Interface")
	.version(packageJson.version)
	.option("--json", "Output as JSON (machine-readable)")
	.option("-y, --yes", "Skip all confirmation prompts")
	.option(
		"--non-interactive",
		"Fail fast on missing input (emit needs_input + exit 6 instead of prompting on TTY)",
	)
	.option("-q, --quiet", "Minimal output")
	.option("-v, --verbose", "Extra debug information")
	.option("--no-color", "Disable colored output")
	.hook("preAction", (thisCommand, actionCommand) => {
		const opts = thisCommand.opts();
		// Auto-detect non-interactive sessions: when stdin is not a TTY (agent
		// background runs, pipes, CI), inquirer can't prompt — falling through
		// would hang then force-close with exit 1. Treating it as
		// `--non-interactive` instead makes annotated prompts emit a structured
		// needs_input (exit 6) and skips interactive-only blocks (e.g. the
		// billing-upgrade addon bundle questions). `--json` and `--yes` retain
		// their own handling.
		const stdinIsTTY = Boolean(process.stdin.isTTY);
		setGlobalOptions({
			json: opts.json || false,
			yes: opts.yes || false,
			nonInteractive: opts.nonInteractive || !stdinIsTTY,
			quiet: opts.quiet || false,
			verbose: opts.verbose || false,
			noColor: opts.color === false,
		});

		// In agent mode, nudge the agent to run `tarout agent init` first when the
		// project isn't allowlisted yet. Skipped for the `agent` namespace itself
		// and for up/deploy/init, which auto-scaffold the allowlist in their action.
		const sub = actionCommand?.name();
		const isAgentNamespace = actionCommand?.parent?.name() === "agent";
		const autoRunsSetup = !!sub && ["up", "deploy", "init"].includes(sub);
		if (!isAgentNamespace && !autoRunsSetup) {
			emitAgentSetupHint(process.cwd());
		}
	});

// Register all commands
registerAuthCommands(program);
registerAppsCommands(program);
registerDeployCommands(program);
registerInitCommand(program);
registerAgentCommands(program);
registerUpCommand(program);
registerLogsCommand(program);
registerEnvCommands(program);
registerDbCommands(program);
registerDomainsCommands(program);
registerOrgsCommands(program);
registerProjectsCommands(program);
registerEnvsCommands(program);
registerLinkCommands(program);
registerDevCommand(program);
registerBuildCommand(program);
registerStorageCommands(program);
registerKeysCommands(program);
registerBillingCommands(program);
registerServersCommands(program);
registerMonitorCommands(program);
registerTicketsCommands(program);
registerWalletCommands(program);
registerAiCommands(program);
registerNotificationsCommands(program);
registerBackupsCommands(program);
registerAccountCommands(program);
registerDashboardCommands(program);
registerDestinationsCommands(program);
registerInboxCommands(program);
registerProvidersCommands(program);
registerSettingsCommands(program);
registerFirewallCommands(program);
registerQueuesCommands(program);
registerCallCommand(program);

// Configure Commander's stderr writer so parse-time failures (unknown
// flags, bad argParser values, missing required arguments) emit a JSON
// envelope under `--json` instead of a raw human error line. The exit
// code Commander would have used is preserved, but mapped onto our
// `INVALID_ARGUMENTS` constant for argument errors.
//
// `exitOverride` was tried first, but Commander does not always invoke it
// for subcommand argParser failures (`commander.invalidArgument` thrown
// from inside a custom argParser on a nested command bypasses the
// inherited override). Intercepting `writeErr` works for every error
// path because Commander always writes the human message before exiting.
const argErrorPatterns = [
	/invalid/i,
	/missing required/i,
	/unknown option/i,
	/unknown command/i,
];
const originalWriteErr = process.stderr.write.bind(process.stderr);
program.configureOutput({
	writeErr: (str: string) => {
		if (process.argv.includes("--json")) {
			setGlobalOptions({ json: true });
			const isArgError = argErrorPatterns.some((p) => p.test(str));
			outputError(
				isArgError ? "INVALID_ARGUMENTS" : "CLI_ERROR",
				str.replace(/^error:\s*/i, "").trim(),
			);
			process.exit(
				isArgError ? ExitCode.INVALID_ARGUMENTS : ExitCode.GENERAL_ERROR,
			);
		}
		return originalWriteErr(str);
	},
});

// Parse and execute. Normalize the original documented env syntax before
// Commander resolves nested subcommands.
program.parse(normalizeEnvCommandArgs(process.argv));
