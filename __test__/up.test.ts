import { describe, expect, it } from "vitest";
import {
	inferSuggestedPlan,
	isEntitlementError,
	normalizeSource,
	parseRepo,
} from "../src/commands/up";
import { isGitSourced } from "../src/commands/deploy";

describe("tarout up — argument parsing", () => {
	it("defaults --source to upload", () => {
		expect(normalizeSource(undefined)).toBe("upload");
		expect(normalizeSource("")).toBe("upload");
	});

	it("accepts upload and github (case-insensitive)", () => {
		expect(normalizeSource("upload")).toBe("upload");
		expect(normalizeSource("GITHUB")).toBe("github");
		expect(normalizeSource("Github")).toBe("github");
	});

	it("rejects unknown source values with a descriptive error", () => {
		expect(() => normalizeSource("zip")).toThrowError(/Invalid --source/);
		expect(() => normalizeSource("gitlab")).toThrowError(/Invalid --source/);
	});

	it("parses owner/name", () => {
		expect(parseRepo("acme/widget")).toEqual({
			owner: "acme",
			repository: "widget",
		});
	});

	it("parses an HTTPS GitHub URL (with .git suffix)", () => {
		expect(parseRepo("https://github.com/acme/widget.git")).toEqual({
			owner: "acme",
			repository: "widget",
		});
	});

	it("parses an SSH GitHub URL", () => {
		expect(parseRepo("git@github.com:acme/widget.git")).toEqual({
			owner: "acme",
			repository: "widget",
		});
	});

	it("rejects malformed repo strings", () => {
		expect(() => parseRepo("nope")).toThrowError(
			/--repo must be "owner\/name" or a GitHub URL/,
		);
		expect(() => parseRepo("a/b/c")).toThrowError(
			/--repo must be "owner\/name" or a GitHub URL/,
		);
	});
});

describe("tarout up — entitlement detection", () => {
	it("recognizes the exact server message from assertEntitlement", () => {
		expect(
			isEntitlementError({
				code: "FORBIDDEN",
				message:
					"Plan limit reached for app.free.slots: 2/1. Upgrade to add more.",
			}),
		).toBe(true);
	});

	it("recognizes the tRPC-client-wrapped shape (code on .data.code)", () => {
		expect(
			isEntitlementError({
				data: { code: "FORBIDDEN" },
				message:
					"Plan limit reached for app.shared.slots: 6/5. Upgrade to add more.",
			}),
		).toBe(true);
	});

	it("recognizes 'entitlement' and 'active subscription' variants", () => {
		expect(
			isEntitlementError({
				code: "FORBIDDEN",
				message: "Org has no entitlement for app.shared.slots",
			}),
		).toBe(true);
		expect(
			isEntitlementError({
				code: "FORBIDDEN",
				message: "Active subscription required",
			}),
		).toBe(true);
	});

	it("ignores FORBIDDEN errors with unrelated messages (role checks)", () => {
		expect(
			isEntitlementError({
				code: "FORBIDDEN",
				message: "Only org owners can perform this action",
			}),
		).toBe(false);
	});

	it("ignores non-FORBIDDEN errors and non-objects", () => {
		expect(isEntitlementError({ code: "NOT_FOUND", message: "slot" })).toBe(
			false,
		);
		expect(isEntitlementError(null)).toBe(false);
		expect(isEntitlementError(undefined)).toBe(false);
		expect(isEntitlementError("FORBIDDEN")).toBe(false);
	});
});

describe("tarout up — upgrade suggestion", () => {
	it("maps requested plan to the subscription tier that grants its entitlement", () => {
		expect(inferSuggestedPlan("free")).toBe("shared");
		expect(inferSuggestedPlan(undefined)).toBe("shared");
		expect(inferSuggestedPlan("FREE")).toBe("shared");
		expect(inferSuggestedPlan("shared")).toBe("shared");
		expect(inferSuggestedPlan("dedicated")).toBe("dedicated_small");
		expect(inferSuggestedPlan("dedicated_small")).toBe("dedicated_small");
		expect(inferSuggestedPlan("dedicated_medium")).toBe("dedicated_medium");
		expect(inferSuggestedPlan("dedicated_large")).toBe("dedicated_large");
	});
});

describe("isGitSourced — the guard that keeps `up` from breaking push-to-deploy", () => {
	it("recognises every source that redeploys on push", () => {
		// Retired for NEW connections, but apps created on them still exist and
		// still deploy on push, so they must keep the guard.
		for (const type of ["git", "github", "gitlab", "bitbucket", "gitea"]) {
			expect(isGitSourced(type)).toBe(true);
		}
		expect(isGitSourced("GitHub")).toBe(true);
		expect(isGitSourced(" github ")).toBe(true);
	});

	it("does not claim an uploaded or image-based app is Git-sourced", () => {
		// `drop` is the uploaded-folder source `up` produces; blocking it would
		// break the ordinary redeploy this guard is not about.
		for (const type of ["drop", "dockerfileUpload", "dockerhub"]) {
			expect(isGitSourced(type)).toBe(false);
		}
	});

	it("treats an unknown or missing source as not Git", () => {
		// Fail open: a sourceType this CLI has never heard of must not block a
		// deploy on a guess. The refusal is a safety net, not an authority.
		expect(isGitSourced(undefined)).toBe(false);
		expect(isGitSourced(null)).toBe(false);
		expect(isGitSourced("")).toBe(false);
		expect(isGitSourced("something-new")).toBe(false);
	});
});
