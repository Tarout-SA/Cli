import { describe, expect, it } from "vitest";
import {
	GCP_REGION_IDS,
	normalizeRegionId,
	planBuildArgs,
} from "../src/commands/apps";
import {
	type DotenvEntry,
	parseDotenvDocument,
	planDotenvReplace,
} from "../src/commands/env";
import { resolveNotificationId } from "../src/commands/inbox";
import {
	DEFAULT_AUTOFIX_RUNS_LIMIT,
	MAX_AUTOFIX_RUNS_LIMIT,
	parseAutofixRunsLimit,
	parseAutofixState,
	resolveProjectRef,
} from "../src/commands/projects";
import { InvalidArgumentError, NotFoundError } from "../src/lib/errors";

describe("projects autofix contracts", () => {
	it("clamps --limit into the window project.autofixRuns accepts", () => {
		// Both ends: zod would reject either, so the CLI clamps instead.
		expect(parseAutofixRunsLimit("0")).toBe(1);
		expect(parseAutofixRunsLimit("-5")).toBe(1);
		expect(parseAutofixRunsLimit("500")).toBe(MAX_AUTOFIX_RUNS_LIMIT);
		expect(parseAutofixRunsLimit(String(MAX_AUTOFIX_RUNS_LIMIT))).toBe(
			MAX_AUTOFIX_RUNS_LIMIT,
		);
		expect(parseAutofixRunsLimit("7")).toBe(7);
	});

	it("falls back to the server default for a missing or unparseable limit", () => {
		expect(parseAutofixRunsLimit(undefined)).toBe(DEFAULT_AUTOFIX_RUNS_LIMIT);
		expect(parseAutofixRunsLimit("")).toBe(DEFAULT_AUTOFIX_RUNS_LIMIT);
		expect(parseAutofixRunsLimit("all")).toBe(DEFAULT_AUTOFIX_RUNS_LIMIT);
	});

	it("maps the on/off vocabulary to project.setAutofix's boolean", () => {
		expect(parseAutofixState("on")).toBe(true);
		expect(parseAutofixState("enable")).toBe(true);
		expect(parseAutofixState("TRUE")).toBe(true);
		expect(parseAutofixState("off")).toBe(false);
		expect(parseAutofixState("disable")).toBe(false);
		expect(parseAutofixState(" false ")).toBe(false);
	});

	it("refuses an ambiguous autofix state rather than guessing", () => {
		expect(() => parseAutofixState("yes")).toThrow(InvalidArgumentError);
		expect(() => parseAutofixState("")).toThrow('Use "on" or "off"');
	});
});

describe("project reference resolution", () => {
	const projects = [
		{ projectId: "proj_abc123", name: "Storefront", slug: "storefront" },
		{ projectId: "proj_xyz789", name: "Internal Tools", slug: "internal" },
	];

	it("resolves by id, id prefix, slug and case-insensitive name", () => {
		expect(resolveProjectRef(projects, "proj_abc123")?.slug).toBe("storefront");
		expect(resolveProjectRef(projects, "proj_abc")?.slug).toBe("storefront");
		expect(resolveProjectRef(projects, "internal")?.projectId).toBe(
			"proj_xyz789",
		);
		expect(resolveProjectRef(projects, "internal tools")?.projectId).toBe(
			"proj_xyz789",
		);
	});

	it("returns nothing for an unknown reference so the caller can suggest", () => {
		expect(resolveProjectRef(projects, "nope")).toBeUndefined();
		expect(resolveProjectRef([], "storefront")).toBeUndefined();
	});
});

describe("apps set-region validation", () => {
	it("accepts a known region and normalizes case and padding", () => {
		expect(normalizeRegionId("me-central2")).toBe("me-central2");
		expect(normalizeRegionId("  ME-Central2 ")).toBe("me-central2");
		expect(GCP_REGION_IDS).toContain("me-central2");
	});

	it("rejects an unknown region before the round trip", () => {
		expect(() => normalizeRegionId("mars-north1")).toThrow(
			InvalidArgumentError,
		);
		expect(() => normalizeRegionId("")).toThrow("Region cannot be empty");
	});

	it("points a near-miss at the real region id", () => {
		// saveRegion's input is a zod enum; a typo should come back as a name.
		expect(() => normalizeRegionId("us-east-1")).toThrow(/us-east1/);
	});
});

describe("apps build-args planning", () => {
	it("treats no write flag as a read", () => {
		expect(planBuildArgs({})).toBeNull();
	});

	it("maps each write flag onto the whole-blob replacement", () => {
		expect(planBuildArgs({ set: "NODE_VERSION=22" })).toEqual({
			buildArgs: "NODE_VERSION=22",
		});
		expect(planBuildArgs({ clear: true })).toEqual({ buildArgs: "" });
		expect(planBuildArgs({ file: "args.txt" }, "API_URL=https://x")).toEqual({
			buildArgs: "API_URL=https://x",
		});
	});

	it("refuses two sources at once, since each replaces everything", () => {
		expect(() =>
			planBuildArgs({ set: "A=1", clear: true }),
		).toThrow(InvalidArgumentError);
		expect(() => planBuildArgs({ set: "A=1", file: "args.txt" })).toThrow(
			/only one of --set, --file or --clear/,
		);
	});

	it("fails when the named file could not be read", () => {
		expect(() => planBuildArgs({ file: "missing.txt" })).toThrow(
			"File not found: missing.txt",
		);
	});
});

describe("env apply: dotenv parsing", () => {
	it("reads pairs, skipping comments and blank lines", () => {
		const parsed = parseDotenvDocument(
			["# comment", "", "FOO=bar", "export BAZ=qux", 'QUOTED="a b"'].join("\n"),
		);
		expect(parsed.errors).toEqual([]);
		expect(parsed.entries).toEqual([
			{ key: "FOO", value: "bar" },
			{ key: "BAZ", value: "qux" },
			{ key: "QUOTED", value: "a b" },
		]);
	});

	it("reports a malformed line with its number instead of sending it", () => {
		const parsed = parseDotenvDocument(["FOO=bar", "THIS IS NOT A PAIR"].join("\n"));
		expect(parsed.entries).toEqual([{ key: "FOO", value: "bar" }]);
		expect(parsed.errors).toHaveLength(1);
		expect(parsed.errors[0]).toContain("line 2");
		expect(parsed.errors[0]).toContain('no "="');
	});

	it("rejects a key the platform's own validator would refuse", () => {
		const parsed = parseDotenvDocument("1BAD=value\nalso bad=value");
		expect(parsed.entries).toEqual([]);
		expect(parsed.errors).toHaveLength(2);
		expect(parsed.errors[0]).toContain("not a valid variable name");
	});

	it("flags a key set twice, which would silently lose one value", () => {
		const parsed = parseDotenvDocument("FOO=1\nFOO=2");
		expect(parsed.entries).toEqual([{ key: "FOO", value: "1" }]);
		expect(parsed.errors[0]).toContain("set more than once");
	});

	it("treats an empty document as zero entries, not an error", () => {
		expect(parseDotenvDocument("")).toEqual({ entries: [], errors: [] });
		expect(parseDotenvDocument("\n# only a comment\n")).toEqual({
			entries: [],
			errors: [],
		});
	});
});

describe("env apply: replace-vs-merge planning", () => {
	const current: DotenvEntry[] = [
		{ key: "KEEP", value: "same" },
		{ key: "CHANGE", value: "old" },
		{ key: "DROP", value: "gone" },
	];

	it("names the deletions that replace semantics imply", () => {
		const plan = planDotenvReplace(current, [
			{ key: "KEEP", value: "same" },
			{ key: "CHANGE", value: "new" },
			{ key: "ADD", value: "fresh" },
		]);
		expect(plan.created).toEqual(["ADD"]);
		expect(plan.updated).toEqual(["CHANGE"]);
		expect(plan.unchanged).toEqual(["KEEP"]);
		// `push` would have left DROP alone; `apply` removes it.
		expect(plan.deleted).toEqual(["DROP"]);
		expect(plan.emptiesEverything).toBe(false);
	});

	it("flags an empty document as wiping every variable", () => {
		const plan = planDotenvReplace(current, []);
		expect(plan.emptiesEverything).toBe(true);
		expect(plan.deleted).toEqual(["KEEP", "CHANGE", "DROP"]);
	});

	it("does not call an empty document destructive when there is nothing to lose", () => {
		expect(planDotenvReplace([], []).emptiesEverything).toBe(false);
		expect(planDotenvReplace([], []).deleted).toEqual([]);
	});

	it("never counts a managed-database placeholder as a change", () => {
		const plan = planDotenvReplace(
			[{ key: "DATABASE_URL", value: "postgres://real" }],
			[{ key: "DATABASE_URL", value: "[managed database route hidden]" }],
			(value) => value.startsWith("[managed database route hidden"),
		);
		expect(plan.updated).toEqual([]);
		expect(plan.unchanged).toEqual(["DATABASE_URL"]);
		expect(plan.deleted).toEqual([]);
	});
});

describe("inbox notification reference resolution", () => {
	const notifications = [
		{ id: "ckaaa111", title: "Deploy failed" },
		{ id: "ckaaa222", title: "Backup done" },
		{ id: "ckbbb333", title: "Domain expiring" },
	];

	it("accepts a full id or a unique prefix", () => {
		expect(resolveNotificationId(notifications, "ckaaa111").title).toBe(
			"Deploy failed",
		);
		expect(resolveNotificationId(notifications, "ckb").title).toBe(
			"Domain expiring",
		);
	});

	it("refuses an ambiguous prefix rather than writing to the wrong row", () => {
		expect(() => resolveNotificationId(notifications, "ckaaa")).toThrow(
			InvalidArgumentError,
		);
		expect(() => resolveNotificationId(notifications, "ckaaa")).toThrow(
			/matches 2 notifications/,
		);
	});

	it("reports an unknown reference as not found", () => {
		expect(() => resolveNotificationId(notifications, "zzz")).toThrow(
			NotFoundError,
		);
		expect(() => resolveNotificationId([], "ckaaa111")).toThrow(NotFoundError);
	});
});
