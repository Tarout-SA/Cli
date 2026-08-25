import { describe, expect, it } from "vitest";
import { toAppNameSlug } from "../src/lib/app-name";

// The platform rejects any appName that fails this pattern with
// "App name must start with a letter, can contain lowercase letters, numbers
// and hyphens (not consecutive), and must end with a letter or number".
// Keep it byte-identical to cloud/src/server/validations/application.ts.
const PLATFORM_APP_NAME = /^[a-z](?!.*--)([a-z0-9-]*[a-z0-9])?$/;

describe("toAppNameSlug", () => {
	it("keeps an already-valid slug untouched", () => {
		expect(toAppNameSlug("my-api")).toBe("my-api");
	});

	it("prefixes names that start with a digit instead of shipping an invalid slug", () => {
		// The old per-file generateSlug() copies passed "2048-game" straight to
		// application.create, which rejected it at the regex.
		expect(toAppNameSlug("2048 Game")).toBe("app-2048-game");
	});

	it("falls back when the name has no ASCII alphanumerics", () => {
		expect(toAppNameSlug("متجري")).toBe("app");
		expect(toAppNameSlug("   ")).toBe("app");
		expect(toAppNameSlug(undefined)).toBe("app");
	});

	it("collapses separator runs so no consecutive hyphens survive", () => {
		expect(toAppNameSlug("My  Cool__App!!")).toBe("my-cool-app");
	});

	it("caps length and never ends on a hyphen", () => {
		const slug = toAppNameSlug(`${"a".repeat(62)} tail`);
		expect(slug.length).toBeLessThanOrEqual(63);
		expect(slug.endsWith("-")).toBe(false);
	});

	it("emits a platform-valid slug for every hostile input", () => {
		const inputs = [
			"2048 Game",
			"3D Portfolio",
			"---",
			"__",
			"!!!",
			"متجري",
			"🚀",
			"a",
			"9",
			"UPPER CASE NAME",
			"trailing-hyphen-",
			"-leading-hyphen",
			"double--hyphen",
			"x".repeat(200),
			`${"a".repeat(62)} tail`,
			"",
		];
		for (const input of inputs) {
			expect(toAppNameSlug(input)).toMatch(PLATFORM_APP_NAME);
		}
	});
});
