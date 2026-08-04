import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	detectJsonIndent,
	mergeClaudeSettings,
} from "../src/lib/agent-scaffold";

/**
 * `tarout agent init` writes .claude/settings.local.json into SOMEONE ELSE'S
 * repo, where that repo's formatter then checks it. Hard-coding two spaces made
 * `biome ci` fail on a file the user never wrote — the scaffold broke the
 * project it was meant to set up. Biome's default indentStyle is tab, which is
 * exactly the case that bit a real user.
 */

function project(): string {
	return mkdtempSync(join(tmpdir(), "tarout-scaffold-"));
}

describe("detectJsonIndent", () => {
	it("uses tabs when a biome.json is present but silent on indentStyle", () => {
		// Biome's own default is tab, so "no opinion stated" still means tab.
		const root = project();
		writeFileSync(join(root, "biome.json"), '{ "linter": { "enabled": true } }');
		expect(detectJsonIndent(root)).toBe("\t");
	});

	it("honors an explicit Biome space indent and width", () => {
		const root = project();
		writeFileSync(
			join(root, "biome.json"),
			'{ "formatter": { "indentStyle": "space", "indentWidth": 4 } }',
		);
		expect(detectJsonIndent(root)).toBe("    ");
	});

	it("reads biome.jsonc even though it may contain comments", () => {
		const root = project();
		writeFileSync(
			join(root, "biome.jsonc"),
			'{\n  // trailing commas and comments are legal here\n  "formatter": { "indentStyle": "tab" },\n}',
		);
		expect(detectJsonIndent(root)).toBe("\t");
	});

	it("falls back to .editorconfig", () => {
		const root = project();
		writeFileSync(
			join(root, ".editorconfig"),
			"root = true\n\n[*]\nindent_style = space\nindent_size = 4\n",
		);
		expect(detectJsonIndent(root)).toBe("    ");
	});

	it("falls back to prettier", () => {
		const root = project();
		writeFileSync(join(root, ".prettierrc"), '{ "useTabs": true }');
		expect(detectJsonIndent(root)).toBe("\t");
	});

	it("matches the file's own indentation when nothing is configured", () => {
		// Adding one key to a file must not reformat the rest of it.
		const root = project();
		expect(detectJsonIndent(root, '{\n\t"permissions": {}\n}\n')).toBe("\t");
	});

	it("defaults to two spaces when there is nothing to go on", () => {
		expect(detectJsonIndent(project())).toBe("  ");
	});
});

describe("mergeClaudeSettings", () => {
	it("writes tab-indented settings in a default Biome project", () => {
		const root = project();
		writeFileSync(join(root, "biome.json"), "{}");

		const result = mergeClaudeSettings(join(root, ".claude"), root);
		expect(result.action).toBe("created");

		const written = readFileSync(
			join(root, ".claude", "settings.local.json"),
			"utf-8",
		);
		expect(written).toContain('\n\t"permissions"');
		expect(written).not.toContain('\n  "permissions"');
		// Every file we emit ends with a newline.
		expect(written.endsWith("\n")).toBe(true);
	});

	it("still writes two spaces in a project with no formatter config", () => {
		const root = project();
		const result = mergeClaudeSettings(join(root, ".claude"), root);
		expect(result.action).toBe("created");

		const written = readFileSync(
			join(root, ".claude", "settings.local.json"),
			"utf-8",
		);
		expect(written).toContain('\n  "permissions"');
	});

	it("preserves an existing file's indentation when adding rules", () => {
		const root = project();
		const claudeDir = join(root, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.local.json"),
			'{\n\t"permissions": {\n\t\t"allow": []\n\t}\n}\n',
		);

		mergeClaudeSettings(claudeDir, root);
		const written = readFileSync(
			join(claudeDir, "settings.local.json"),
			"utf-8",
		);
		expect(written).toContain("\t");
		expect(written).not.toContain('\n  "permissions"');
	});
});
