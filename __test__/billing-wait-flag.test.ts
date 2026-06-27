import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerBillingCommands } from "../src/commands/billing";

/**
 * The CLI's own entitlement-remedy hints generate commands like
 * `tarout billing upgrade <plan> --wait`, `tarout billing addon:buy <key> --wait`,
 * and `tarout billing plan:quantity <n> --wait`. Those commands must therefore
 * ACCEPT `--wait` (waiting is the default; `--wait` is an explicit no-op alias).
 * Previously they only defined `--no-wait`, so the generated `--wait` failed with
 * "unknown option '--wait'".
 */

function billingSubcommand(name: string) {
	const program = new Command();
	program.exitOverride(); // don't call process.exit during the test
	registerBillingCommands(program);
	const billing = program.commands.find((c) => c.name() === "billing");
	return billing?.commands.find((c) => c.name() === name);
}

describe("billing checkout commands accept --wait", () => {
	for (const name of ["upgrade", "addon:add", "addon:buy", "plan:quantity"]) {
		it(`\`${name}\` registers both --wait and --no-wait`, () => {
			const cmd = billingSubcommand(name);
			expect(cmd, `subcommand ${name} should exist`).toBeTruthy();
			const longs = cmd?.options.map((o) => o.long) ?? [];
			expect(longs).toContain("--wait");
			expect(longs).toContain("--no-wait");
		});
	}
});
