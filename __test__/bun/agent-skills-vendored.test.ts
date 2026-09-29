import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * `cli/skills/` vendors the two skills from the Tarout-SA/skills plugin so
 * `tarout agent setup` can install them from the npm package. When the sibling
 * checkout is present (the umbrella workspace), the copies must match it; the
 * CLI is also built from a git archive without the sibling, and then the
 * comparison is skipped rather than failed.
 *
 * The one allowed difference: em dashes (U+2014) are replaced with hyphens in
 * the vendored copies, because nothing this repo ships may contain one. Once
 * the upstream files drop them too, this comparison is byte-for-byte.
 */

const CLI_ROOT = join(import.meta.dir, "..", "..");
const UPSTREAM = join(CLI_ROOT, "..", "skills", "plugins", "tarout", "skills");
const SKILLS = ["tarout-deploy", "tarout-domains"];
const EM_DASH = "\u2014";

describe("vendored skills", () => {
	for (const skill of SKILLS) {
		const vendored = join(CLI_ROOT, "skills", skill, "SKILL.md");

		it(`ships ${skill}/SKILL.md with no em dash`, () => {
			const content = readFileSync(vendored, "utf-8");
			expect(content).toStartWith(`---\nname: ${skill}\n`);
			expect(content.includes(EM_DASH)).toBe(false);
		});

		const upstream = join(UPSTREAM, skill, "SKILL.md");
		it.skipIf(!existsSync(upstream))(
			`${skill}/SKILL.md matches ../skills (em dashes normalized)`,
			() => {
				const expected = readFileSync(upstream, "utf-8").replaceAll(EM_DASH, "-");
				expect(readFileSync(vendored, "utf-8")).toBe(expected);
			},
		);
	}
});
