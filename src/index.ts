#!/usr/bin/env node

import { Command } from "commander";
import { setGlobalOptions } from "./lib/output.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerAppsCommands } from "./commands/apps.js";
import { registerDeployCommands, registerLogsCommand } from "./commands/deploy.js";
import { registerEnvCommands } from "./commands/env.js";
import { registerDbCommands } from "./commands/db.js";
import { registerDomainsCommands } from "./commands/domains.js";
import { registerOrgsCommands, registerEnvsCommands } from "./commands/orgs.js";

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

// Parse and execute
program.parse();
