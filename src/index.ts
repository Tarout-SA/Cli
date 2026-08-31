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
	ensureAuthenticated,
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
import { registerJobsCommands } from "./commands/jobs.js";
import { registerKeysCommands } from "./commands/keys.js";
import { registerLinkCommands } from "./commands/link.js";
import { registerMonitorCommands } from "./commands/monitor.js";
import { registerNotificationsCommands } from "./commands/notifications.js";
import { registerOrgsCommands } from "./commands/orgs.js";
import { registerProjectsCommands } from "./commands/projects.js";
import { registerProvidersCommands } from "./commands/providers.js";
import { registerQueuesCommands } from "./commands/queues.js";
import { registerServersCommands } from "./commands/servers.js";
import { registerSettingsCommands } from "./commands/settings.js";
import { registerStorageCommands } from "./commands/storage.js";
import { registerTicketsCommands } from "./commands/tickets.js";
import { registerUpCommand } from "./commands/up.js";
import { registerUpgradeCommand } from "./commands/upgrade.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { resolveActiveProject } from "./lib/active-project.js";
import { emitAgentSetupHint } from "./lib/agent-setup.js";
import { announceProjectCredential } from "./lib/auth-notice.js";
import {
	commandRequiresAuth,
	commandRequiresProject,
} from "./lib/command-gates.js";
import { getCurrentProfile, isLoggedIn } from "./lib/config.js";
import { handleError } from "./lib/errors.js";
import { outputError, setGlobalOptions } from "./lib/output.js";
import { setGlobalAuthOnly } from "./lib/project-auth.js";
import { maybeSelfUpdate } from "./lib/update-check.js";
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
	.option(
		"--no-update-check",
		"Skip the automatic CLI self-update on up/deploy",
	)
	.option(
		"--global-auth",
		"Ignore this project's .tarout/auth.json and use the machine-wide login",
	)
	.option(
		"--project <slugOrId>",
		"Act on this project for this invocation (overrides the saved project)",
	)
	.hook("preAction", async (thisCommand, actionCommand) => {
		const opts = thisCommand.opts();

		// Must run before anything reads a credential: this is the documented
		// opt-out from project-scoped auth, so the whole invocation has to agree
		// on which layer it is using.
		setGlobalAuthOnly(opts.globalAuth === true);
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

		// Output settings are live now, so the "which account is this?" notice can
		// respect --json/--quiet. Announced once per invocation, and only when the
		// project credential names a DIFFERENT account than the machine-wide one —
		// the case where a command would otherwise act on an unexpected org.
		announceProjectCredential();

		// Self-update on every command: if a newer @tarout/cli is published,
		// install it and re-exec this invocation on the new version, so the CLI
		// (and any agent driving it) always runs the current version. The network
		// check is throttled (at most once per few hours) so ordinary commands
		// stay fast; up/deploy force an immediate check so a deploy is never on a
		// stale CLI. Fail-open; opt out with --no-update-check /
		// TAROUT_NO_UPDATE_CHECK.
		const sub = actionCommand?.name();
		// up/deploy normally force an immediate update check so a human never
		// deploys on a stale CLI. In machine mode (JSON output or a non-TTY agent/
		// CI run) that forced npm-registry round-trip is paid on every deploy in a
		// tight edit→deploy loop, so there we fall back to the throttled check
		// (still runs on every command, at most once per few hours). The regular
		// opt-outs (--no-update-check / TAROUT_NO_UPDATE_CHECK) are unchanged.
		const machineMode = opts.json === true || !stdinIsTTY;
		// `agent connect` forces the check in EVERY mode, machine included. It is
		// the one command handed a payload minted by a newer dashboard than the
		// CLI reading it - a handoff format this version may not parse yet - and it
		// is a once-per-project action, so the round-trip costs nothing in a loop.
		// Without this, a CLI whose throttle window has not elapsed reports a
		// perfectly valid handoff as invalid.
		const isAgentConnect =
			sub === "connect" && actionCommand?.parent?.name() === "agent";
		// The explicit command owns its output and failure status. Running the
		// fail-open background updater first could consume the update and leave
		// `tarout upgrade --json` with no deterministic result of its own.
		if (sub !== "upgrade") {
			await maybeSelfUpdate({
				currentVersion: packageJson.version,
				disabled: opts.updateCheck === false,
				force:
					isAgentConnect ||
					((sub === "up" || sub === "deploy") && !machineMode),
			});
		}

		// In agent mode, nudge the agent to run `tarout agent init` first when the
		// project isn't allowlisted yet. Skipped for the `agent` namespace itself
		// and for up/deploy/init, which auto-scaffold the allowlist in their action.
		// `upgrade` is local package maintenance and should not emit project setup
		// advice unrelated to the command the user asked for.
		const isAgentNamespace = actionCommand?.parent?.name() === "agent";
		const skipsAgentSetup =
			!!sub && ["up", "deploy", "init", "upgrade"].includes(sub);
		if (!isAgentNamespace && !skipsAgentSetup) {
			emitAgentSetupHint(process.cwd());
		}

		// Auto-recover authentication for any command that needs it, so a
		// logged-out invocation opens the browser (or, on a real terminal, shows
		// an arrow menu whose default opens the browser) instead of dead-ending
		// on "Run `tarout login`". The command's own `isLoggedIn()` guard then
		// passes. Exempt commands (the auth flow itself, the self-authing
		// up/deploy/init, and the agent scaffolding namespace) are skipped.
		if (commandRequiresAuth(actionCommand, thisCommand)) {
			const cmdOpts = actionCommand?.opts() ?? {};
			await ensureAuthenticated({
				apiUrl: typeof cmdOpts.apiUrl === "string" ? cmdOpts.apiUrl : undefined,
				token: typeof cmdOpts.token === "string" ? cmdOpts.token : undefined,
			});
		}

		// Resolve the project the command will act on. Login binds the account and
		// organization only, so this is where a project is chosen — from --project,
		// the saved profile, or a picker — and the id then rides along in the
		// x-tarout-project header on every request.
		//
		// Gated on isLoggedIn(): up/deploy/init are exempt from the auth hook above
		// because they authenticate inside their own action, and resolving a
		// project here needs an API call, which would dead-end a logged-out
		// invocation on AuthError before its self-auth ever ran.
		//
		// Also requires somewhere to resolve FROM. A TAROUT_TOKEN session is
		// logged in with no profile (config.getCurrentProfile reads only the
		// stored layers), so resolving would find nothing saved, fall through to
		// the picker, and in CI emit needs_input + exit 6 on every command — and
		// updateProfile would be a no-op, so it would repeat forever. With no
		// profile and no flag, send no header and let the server decide: a legacy
		// pinned key keeps working on its pin, an account key gets an actionable
		// "No project selected — pass --project".
		const projectFlag =
			typeof opts.project === "string" ? opts.project : undefined;
		if (
			commandRequiresProject(actionCommand, thisCommand) &&
			isLoggedIn() &&
			(projectFlag || getCurrentProfile())
		) {
			await resolveActiveProject({ projectFlag });
		}
	});

// Register all commands
registerAuthCommands(program);
registerAppsCommands(program);
registerDeployCommands(program);
registerInitCommand(program);
registerAgentCommands(program);
registerUpCommand(program);
registerUpgradeCommand(program);
registerLogsCommand(program);
registerEnvCommands(program);
registerDbCommands(program);
registerDomainsCommands(program);
registerOrgsCommands(program);
registerProjectsCommands(program);
// No `tarout envs` namespace: the platform has no environment model/router, so
// the whole namespace could only ever fail at runtime. Do not re-add it without
// an `environment` router in the platform appRouter.
registerLinkCommands(program);
registerDevCommand(program);
registerBuildCommand(program);
registerStorageCommands(program);
registerKeysCommands(program);
registerBillingCommands(program);
registerServersCommands(program);
registerMonitorCommands(program);
registerJobsCommands(program);
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

// Parse and execute. parseAsync (not parse) so the async preAction hook —
// which may open a browser and wait for sign-in — is awaited before the
// command action runs. Errors thrown from the hook (e.g. a cancelled or failed
// auth recovery) surface here; the command actions handle their own errors
// internally and exit, so this catch is the hook's safety net. The argv is run
// through `normalizeEnvCommandArgs` first so the original documented env syntax
// is rewritten before Commander resolves nested subcommands.
program.parseAsync(normalizeEnvCommandArgs(process.argv)).catch((err) =>
	handleError(err),
);
