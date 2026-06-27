import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const {
	TAROUT_ALLOW_ENTRY,
	TAROUT_ASK_ENTRIES,
	TAROUT_AUTOMODE_ALLOW_ENTRY,
	TAROUT_AUTOMODE_ENV_ENTRY,
	hasTaroutAgentConfig,
	markdownTargetFor,
	scaffoldAgentConfig,
} = await import("../../src/lib/agent-scaffold");

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tarout-agent-init-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function readJson(path: string): any {
	return JSON.parse(readFileSync(path, "utf-8"));
}

function settingsPath(): string {
	return join(dir, ".claude", "settings.local.json");
}

describe("scaffoldAgentConfig — claude", () => {
	it("creates CLAUDE.md and .claude/settings.local.json from scratch", () => {
		const result = scaffoldAgentConfig({ cwd: dir, agent: "claude" });

		const md = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
		expect(md).toContain("<!-- BEGIN TAROUT -->");
		expect(md).toContain("<!-- END TAROUT -->");
		expect(md).toContain("https://tarout.sa/docs/for-ai/onboarding");

		// The classifier-denied / buy-add-on-vs-upgrade paragraph was removed: the
		// CLI surfaces NEEDS_UPGRADE (plan-upgrade only) at runtime, so the scaffold
		// no longer hard-codes that guidance.
		expect(md).not.toContain("Denied by auto mode classifier");
		expect(md).not.toContain("buy the add-on");
		expect(md).toContain("Deploys run hands-free");
		// Auth guidance: the agent must run `tarout login` itself, not delegate.
		expect(md).toContain("Auth is hands-free");

		const settings = readJson(settingsPath());
		expect(settings.permissions.allow).toContain(TAROUT_ALLOW_ENTRY);
		for (const entry of TAROUT_ASK_ENTRIES) {
			expect(settings.permissions.ask).toContain(entry);
		}

		expect(result.agent).toBe("claude");
		expect(result.files.map((f) => f.action)).toEqual(["created", "created"]);
		expect(result.nextSteps).toContain("tarout up --json --yes");
	});

	it("tells the agent how to survive an auto-mode deploy denial", () => {
		scaffoldAgentConfig({ cwd: dir, agent: "claude" });
		const md = readFileSync(join(dir, "CLAUDE.md"), "utf-8");

		// Hands-free stays the happy path, but the block now also defines a fallback
		// for when the auto-mode classifier holds/denies a deploy anyway: scope the
		// command, have the user approve in place, then drop to the inspected plan +
		// create-vs-reuse options instead of dead-ending.
		expect(md).toContain("Deploys run hands-free");
		expect(md).toContain("fall back");
		expect(md).toContain("scope the command");
		expect(md).toContain("approve it in place");
		// Must not resurrect the removed hard-deny / buy-add-on paragraph.
		expect(md).not.toContain("Denied by auto mode classifier");
	});

	it("runs deploys hands-free (no ask rule) but gates paid/destructive commands", () => {
		scaffoldAgentConfig({ cwd: dir, agent: "claude" });
		const settings = readJson(settingsPath());

		// Deploy + up are NOT gated by ask rules — the broad allow covers them so
		// they run without a prompt; only paid/destructive commands still ask.
		expect(settings.permissions.ask).not.toContain("Bash(tarout deploy*)");
		expect(settings.permissions.ask).not.toContain("Bash(tarout up:*)");
		expect(settings.permissions.ask).toContain("Bash(tarout undeploy*)");
		expect(settings.permissions.ask).toContain("Bash(tarout billing*)");

		// autoMode keeps the built-in rules ($defaults first) and trusts Tarout
		// deploys so the classifier clears them.
		expect(settings.autoMode.environment[0]).toBe("$defaults");
		expect(settings.autoMode.environment).toContain(TAROUT_AUTOMODE_ENV_ENTRY);
		expect(settings.autoMode.allow[0]).toBe("$defaults");
		expect(settings.autoMode.allow).toContain(TAROUT_AUTOMODE_ALLOW_ENTRY);
	});

	it("is idempotent — re-running adds no duplicate block, ask, or $defaults", () => {
		scaffoldAgentConfig({ cwd: dir, agent: "claude" });
		const result = scaffoldAgentConfig({ cwd: dir, agent: "claude" });

		const md = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
		const beginCount = md.split("<!-- BEGIN TAROUT -->").length - 1;
		expect(beginCount).toBe(1);

		const settings = readJson(settingsPath());
		const allow = settings.permissions.allow as string[];
		expect(allow.filter((e) => e === TAROUT_ALLOW_ENTRY).length).toBe(1);
		const ask = settings.permissions.ask as string[];
		expect(ask.filter((e) => e === "Bash(tarout undeploy*)").length).toBe(1);
		const env = settings.autoMode.environment as string[];
		expect(env.filter((e) => e === "$defaults").length).toBe(1);

		expect(result.files.map((f) => f.action)).toEqual([
			"unchanged",
			"unchanged",
		]);
	});

	it("appends to an existing CLAUDE.md without markers, preserving prose", () => {
		const original = "# My project\n\nSome notes the user wrote.\n";
		writeFileSync(join(dir, "CLAUDE.md"), original);

		const result = scaffoldAgentConfig({ cwd: dir, agent: "claude" });

		const md = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
		expect(md).toContain("Some notes the user wrote.");
		expect(md).toContain("<!-- BEGIN TAROUT -->");
		expect(md.indexOf("Some notes")).toBeLessThan(md.indexOf("BEGIN TAROUT"));
		expect(result.files[0]?.action).toBe("appended");
	});

	it("refreshes an existing Tarout block in place when it differs", () => {
		const stale = `<!-- BEGIN TAROUT -->\nold content\n<!-- END TAROUT -->\n`;
		writeFileSync(join(dir, "CLAUDE.md"), stale);

		const result = scaffoldAgentConfig({ cwd: dir, agent: "claude" });

		const md = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
		expect(md).not.toContain("old content");
		expect(md).toContain("Use the **Tarout CLI**");
		expect(result.files[0]?.action).toBe("updated");
	});

	it("merges into an existing settings.local.json, preserving other keys", () => {
		const claudeDir = join(dir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify(
				{ permissions: { allow: ["Bash(git:*)"] }, other: true },
				null,
				2,
			),
		);

		const result = scaffoldAgentConfig({ cwd: dir, agent: "claude" });

		const settings = readJson(settingsPath());
		expect(settings.permissions.allow).toContain("Bash(git:*)");
		expect(settings.permissions.allow).toContain(TAROUT_ALLOW_ENTRY);
		expect(settings.permissions.ask).toContain("Bash(tarout undeploy*)");
		expect(settings.other).toBe(true);
		expect(result.files[1]?.action).toBe("updated");
	});

	it("upgrades an old allow-only config by merging ask + autoMode rules", () => {
		const claudeDir = join(dir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		// Simulates a project scaffolded by a previous CLI version (allow only).
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			JSON.stringify({ permissions: { allow: [TAROUT_ALLOW_ENTRY] } }, null, 2),
		);

		expect(hasTaroutAgentConfig(dir)).toBe(false);

		const result = scaffoldAgentConfig({ cwd: dir, agent: "claude" });
		expect(result.files[1]?.action).toBe("updated");

		const settings = readJson(settingsPath());
		expect(settings.permissions.allow.filter((e: string) => e === TAROUT_ALLOW_ENTRY).length).toBe(1);
		for (const entry of TAROUT_ASK_ENTRIES) {
			expect(settings.permissions.ask).toContain(entry);
		}
		expect(hasTaroutAgentConfig(dir)).toBe(true);
	});

	it("leaves an unparseable settings.local.json untouched and reports skipped", () => {
		const claudeDir = join(dir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		const garbage = "{ not valid json";
		writeFileSync(join(claudeDir, "settings.local.json"), garbage);

		const result = scaffoldAgentConfig({ cwd: dir, agent: "claude" });

		expect(readFileSync(join(claudeDir, "settings.local.json"), "utf-8")).toBe(
			garbage,
		);
		const settingsFile = result.files[1];
		expect(settingsFile?.action).toBe("skipped");
		expect(settingsFile?.reason).toBeTruthy();
	});
});

describe("hasTaroutAgentConfig", () => {
	it("is false when no .claude/settings.local.json exists", () => {
		expect(hasTaroutAgentConfig(dir)).toBe(false);
	});

	it("is false when the allowlist lacks Bash(tarout:*)", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			settingsPath(),
			JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
		);
		expect(hasTaroutAgentConfig(dir)).toBe(false);
	});

	it("is false when allow is present but ask rules are missing", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			settingsPath(),
			JSON.stringify({ permissions: { allow: [TAROUT_ALLOW_ENTRY] } }),
		);
		expect(hasTaroutAgentConfig(dir)).toBe(false);
	});

	it("is false when settings.local.json is unparseable", () => {
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(settingsPath(), "{ not json");
		expect(hasTaroutAgentConfig(dir)).toBe(false);
	});

	it("is true after scaffoldAgentConfig has run for claude", () => {
		scaffoldAgentConfig({ cwd: dir, agent: "claude" });
		expect(hasTaroutAgentConfig(dir)).toBe(true);
	});
});

describe("scaffoldAgentConfig — non-claude agents", () => {
	for (const agent of ["codex", "cursor", "other"] as const) {
		it(`writes AGENTS.md and no .claude dir for ${agent}`, () => {
			const result = scaffoldAgentConfig({ cwd: dir, agent });

			expect(markdownTargetFor(agent)).toBe("AGENTS.md");
			expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
			expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
			expect(existsSync(join(dir, ".claude"))).toBe(false);
			expect(result.files).toHaveLength(1);
			expect(result.files[0]?.path).toBe("AGENTS.md");
		});
	}
});
