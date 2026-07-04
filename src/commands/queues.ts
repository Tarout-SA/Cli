import type { Command } from "commander";
import { CliError, handleError } from "../lib/errors.js";

/**
 * The `queues` tRPC router is platform-ops only: every procedure calls
 * `checkAdminAccess` (throws FORBIDDEN for any non-root-admin), and the whole
 * router sits in `EXCLUDED_ROUTERS` (surface-scope.ts), so it is never exposed
 * on the REST/MCP/`tarout call` surface either. A normal customer API key — the
 * CLI's entire audience — can therefore NEVER use `tarout queues`.
 *
 * Rather than ship subcommands that always fail with an opaque server FORBIDDEN,
 * the group is neutralized here: every subcommand fails fast with a clear,
 * actionable CliError. Registration still happens from `src/index.ts` (which
 * this worktree must not edit); neutralizing inside this file keeps the group
 * present-but-unusable-by-design and never reaches the server.
 */
const QUEUES_UNAVAILABLE_MESSAGE =
	"`tarout queues` manages internal background job queues and is restricted to Tarout platform operators. It is not available to customer accounts or API keys.";

export function registerQueuesCommands(program: Command) {
	const queues = program
		.command("queues")
		.description(
			"(unavailable) Background job queues — platform operators only",
		);

	// Preserve the original subcommand names so `--help` still documents them,
	// but every invocation fails with a single clear message instead of a raw
	// FORBIDDEN from the server.
	const unavailable = () => {
		try {
			throw new CliError(QUEUES_UNAVAILABLE_MESSAGE);
		} catch (err) {
			handleError(err);
		}
	};

	const stub = (name: string, description: string) => {
		queues
			.command(name)
			.description(description)
			.allowUnknownOption(true)
			.action(unavailable);
	};

	stub("stats", "(unavailable) Show statistics for all queues");
	stub("jobs [args...]", "(unavailable) List jobs in a queue");
	stub("job [args...]", "(unavailable) Get details of a specific job");
	stub("retry [args...]", "(unavailable) Retry a failed job");
	stub("retry-all [args...]", "(unavailable) Retry all failed jobs in a queue");
	stub("pause [args...]", "(unavailable) Pause a queue");
	stub("resume [args...]", "(unavailable) Resume a paused queue");
	stub("clean [args...]", "(unavailable) Remove completed/failed jobs");
	stub("remove [args...]", "(unavailable) Remove a specific job");

	// Bare `tarout queues` also reports the same clear message.
	queues.action(unavailable);
}
