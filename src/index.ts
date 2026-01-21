#!/usr/bin/env node

import { Command } from "commander";
import { registerAppsCommands } from "./commands/apps.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerBuildCommand } from "./commands/build.js";
import { registerDbCommands } from "./commands/db.js";
import {
	registerDeployCommands,
	registerLogsCommand,
} from "./commands/deploy.js";
import { registerDevCommand } from "./commands/dev.js";
import { registerDomainsCommands } from "./commands/domains.js";
import { registerEnvCommands } from "./commands/env.js";
import { registerLinkCommands } from "./commands/link.js";
import { registerEnvsCommands, registerOrgsCommands } from "./commands/orgs.js";
import { setGlobalOptions } from "./lib/output.js";

const program = new Command();

// CLI metadata
program
	.name("tarout")
	.description("Tarout PaaS Command Line Interface")
	.version("0.1.3")
	.option("--json", "Output as JSON (machine-readable)")
	.option("-y, --yes", "Skip all confirmation prompts")
	.option("-q, --quiet", "Minimal output")
	.option("-v, --verbose", "Extra debug information")
	.option("--no-color", "Disable colored output")
	.hook("preAction", (thisCommand) => {
		const opts = thisCommand.opts();
		setGlobalOptions({
			json: opts.json || false,
			yes: opts.yes || false,
			quiet: opts.quiet || false,
			verbose: opts.verbose || false,
			noColor: opts.color === false,
		});
	});

// Register all commands
registerAuthCommands(program);
registerAppsCommands(program);
registerDeployCommands(program);
registerLogsCommand(program);
registerEnvCommands(program);
registerDbCommands(program);
registerDomainsCommands(program);
registerOrgsCommands(program);
registerEnvsCommands(program);
registerLinkCommands(program);
registerDevCommand(program);
registerBuildCommand(program);

// Parse and execute
program.parse();
