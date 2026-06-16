/**
 * @fileoverview Onboarding glue that makes the permission step (`tarout agent
 * init`) happen first. Two behaviors:
 *   - `ensureAgentSetup` auto-scaffolds the allowlist when an agent-driven
 *     onboarding command (up/deploy/init) runs in a not-yet-configured project.
 *   - `emitAgentSetupHint` nudges the agent to run `tarout agent init` when any
 *     other command runs without the allowlist in place.
 * Both are gated to agent mode so a human at a TTY never gets surprise files or
 * noise. The actual file writes live in the pure `agent-scaffold` engine.
 * @module lib/agent-setup
 */

import { hasTaroutAgentConfig, scaffoldAgentConfig } from "./agent-scaffold.js";
import {
	colors,
	isJsonMode,
	isNonInteractiveMode,
	log,
	outputJsonLine,
	warn,
} from "./output.js";

const SETUP_HINT =
	"Run `tarout agent init` to set up Tarout permissions: read-only commands run without prompts, and deploys/paid actions ask for in-editor approval instead of being blocked.";

/** An agent (not a human at a TTY) is driving when JSON or non-interactive mode is on. */
export function isAgentDriven(): boolean {
	return isJsonMode() || isNonInteractiveMode();
}

/**
 * Auto-scaffold the agent permission allowlist (and instructions) the first time
 * an agent-driven onboarding command runs in a project that lacks it. Idempotent
 * and gated to agent mode, so a human's `tarout up` never writes surprise files.
 * `disabled` comes from `--no-agent-setup`.
 */
export function ensureAgentSetup(cwd: string, disabled = false): void {
	if (disabled || !isAgentDriven() || hasTaroutAgentConfig(cwd)) return;

	const result = scaffoldAgentConfig({ cwd, agent: "claude" });
	if (isJsonMode()) {
		outputJsonLine({
			type: "event",
			event: "agent_setup_done",
			files: result.files,
		});
	} else {
		for (const file of result.files) {
			log(colors.dim(`  agent setup: ${file.action} ${file.path}`));
		}
	}
}

/**
 * Non-blocking nudge: when an agent runs a tarout command in a project that
 * hasn't been allowlisted yet, tell it to run `tarout agent init` first. No-op
 * for humans and for already-configured projects.
 */
export function emitAgentSetupHint(cwd: string): void {
	if (!isAgentDriven() || hasTaroutAgentConfig(cwd)) return;

	if (isJsonMode()) {
		outputJsonLine({
			type: "event",
			event: "agent_setup_required",
			hint: SETUP_HINT,
		});
	} else {
		warn(SETUP_HINT);
	}
}
