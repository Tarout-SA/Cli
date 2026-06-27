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
import { registerEnvCommands } from "./commands/env.js";
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
import { handleError } from "./lib/errors.js";
import { outputError, setGlobalOptions } from "./lib/output.js";
import { ExitCode } from "./utils/exit-codes.js";

const program = new Command();

/**
 * Commands that must run WITHOUT first forcing a sign-in. Everything else gets
 * the auto-auth recovery in the preAction hook so a logged-out invocation opens
 * the browser (or offers the arrow menu) instead of dead-ending on an AuthError.
 *
 * - `login`/`register`/`token`/`logout`: the auth flow itself.
 * - `up`/`deploy`/`init`: self-manage auth (browser auto-open + `--token`) via
 *   `ensureAuthenticatedForDeploy`; pre-authing here would double-handle it.
 * - the whole `agent` namespace: project scaffolding that works signed-out.
 */
const AUTH_EXEMPT_LEAF = new Set([
	"login",
	"register",
	"token",
	"logout",
	"up",
	"deploy",
	"init",
]);

/**
 * Whether the about-to-run command should be gated behind authentication.
 * Walks the command ancestry so nested commands (and the `agent` namespace at
 * any depth) are classified correctly, and never gates the bare root program.
 */
function commandRequiresAuth(
	actionCommand: Command | undefined,
	root: Command,
): boolean {
	if (!actionCommand || actionCommand === root) return false;
	const names: string[] = [];
	for (
		let cur: Command | null | undefined = actionCommand;
		cur && cur !== root;
		cur = cur.parent
	) {
		names.push(cur.name());
	}
	if (names.includes("agent")) return false;
	const leaf = names[0];
	return Boolean(leaf) && !AUTH_EXEMPT_LEAF.has(leaf);
}

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
	.hook("preAction", async (thisCommand, actionCommand) => {
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

// Parse and execute. parseAsync (not parse) so the async preAction hook —
// which may open a browser and wait for sign-in — is awaited before the
// command action runs. Errors thrown from the hook (e.g. a cancelled or failed
// auth recovery) surface here; the command actions handle their own errors
// internally and exit, so this catch is the hook's safety net.
program.parseAsync().catch((err) => handleError(err));
