import { describe, expect, it } from "vitest";

/**
 * The agent-governance observability surface: `tarout agent-policies`,
 * `tarout approvals pending`, `tarout settings agent-tools` and the agent half
 * of `tarout dashboard`.
 *
 * Every command in this cluster is a read, so the only logic worth pinning is
 * the pure part: how a stored policy pattern is understood, the resolution
 * order the rule list is printed in, the client-side filters (the procedures
 * take no input), the digest and activity formatting, the severity ordering of
 * action items, and the pending→exit-code gate a CI step branches on. No
 * network, no tRPC mocks.
 */

import {
	AGENT_ACTION_MODES,
	AGENT_POLICY_EFFECTS,
	AGENT_POLICY_LEVELS,
	type AgentPolicyRule,
	type ApprovalCatalogEntry,
	APPROVAL_CATEGORIES,
	comparePolicySpecificity,
	DEFAULT_POLICY_LIMIT,
	describePolicyEffect,
	describePolicyPattern,
	describePolicyScope,
	filterCatalogEntries,
	filterPolicyRules,
	isCatalogEntryConfigured,
	MAX_POLICY_LIMIT,
	parseCatalogCategory,
	parseCatalogMode,
	parsePolicyEffect,
	parsePolicyLevel,
	parsePolicyLimit,
	parsePolicyPattern,
	policyLevel,
	sortCatalogEntries,
	sortPolicyRules,
	summarizeCatalog,
	summarizePolicyRules,
} from "../src/commands/agent-policies";
import {
	describePendingParkReason,
	normalizePendingSummary,
	PENDING_GATE_EXIT_CODE,
	pendingSummaryExitCode,
} from "../src/commands/approvals";
import {
	ACTION_ITEM_SEVERITIES,
	type ActionItem,
	compareActionItemSeverity,
	describeActionItemKind,
	describeDigestAnomaly,
	digestSparkline,
	filterActionItems,
	formatElapsed,
	parseActionItemSeverity,
	sortActionItems,
	summarizeActionItems,
	summarizeAppHealth,
	summarizeDigest,
} from "../src/commands/dashboard";
import {
	type AgentTool,
	buildAgentToolFilters,
	filterAgentTools,
	sortAgentTools,
	summarizeAgentTools,
} from "../src/commands/settings";
import { InvalidArgumentError } from "../src/lib/errors";
import { ExitCode } from "../src/utils/exit-codes";

function rule(overrides: Partial<AgentPolicyRule> = {}): AgentPolicyRule {
	return {
		id: "pol_1",
		pattern: "application.delete",
		effect: "deny",
		...overrides,
	};
}

function tool(overrides: Partial<AgentTool> = {}): AgentTool {
	return {
		name: "application_delete",
		path: "application.delete",
		router: "application",
		description: "Delete an application and everything it runs.",
		type: "mutation",
		readOnly: false,
		destructive: true,
		...overrides,
	};
}

function catalogEntry(
	overrides: Partial<ApprovalCatalogEntry> = {},
): ApprovalCatalogEntry {
	return {
		procedure: "application.delete",
		category: "apps",
		reason: "Deletes an application.",
		orgMode: "ask",
		keyOverrides: [],
		otherRuleCount: 0,
		...overrides,
	};
}

describe("agent policy patterns", () => {
	it("recognizes the three pattern shapes the platform stores", () => {
		expect(parsePolicyPattern("application.delete")).toEqual({
			kind: "procedure",
			value: "application.delete",
		});
		expect(parsePolicyPattern("application.*")).toEqual({
			kind: "router",
			value: "application",
		});
		expect(parsePolicyPattern("area:database")).toEqual({
			kind: "area",
			value: "database",
		});
		// Leading/trailing space is how a pattern gets pasted, and the server
		// trims before matching.
		expect(parsePolicyPattern("  postgres.*  ").kind).toBe("router");
	});

	it("reports an unparseable pattern instead of guessing", () => {
		// A rule whose pattern does not parse matches nothing, so the CLI must
		// be able to say so rather than render it as a working guardrail.
		for (const pattern of [
			"",
			"   ",
			"application",
			"application.*.delete",
			"*",
			"area:Database",
			"1application.delete",
			`${"a".repeat(121)}.delete`,
			undefined,
			null,
			42,
		]) {
			expect(parsePolicyPattern(pattern).kind).toBe("invalid");
		}
	});

	it("describes what each pattern covers in plain words", () => {
		expect(describePolicyPattern("application.delete")).toBe(
			"the application.delete procedure",
		);
		expect(describePolicyPattern("postgres.*")).toBe(
			"every procedure in the postgres router",
		);
		expect(describePolicyPattern("area:storage")).toBe(
			"every procedure in the storage area",
		);
		expect(describePolicyPattern("nonsense!")).toMatch(/never matches/);
	});

	it("explains each effect, including the operator-tier lift on allow", () => {
		expect(describePolicyEffect("deny")).toMatch(/refused, reads included/);
		expect(describePolicyEffect("approve")).toMatch(/mutations only/);
		expect(describePolicyEffect("allow")).toMatch(/approval parking is lifted/);
		expect(describePolicyEffect("sideways")).toMatch(/unknown effect/);
	});
});

describe("agent policy scope and resolution order", () => {
	it("derives the level when the server did not send one", () => {
		expect(policyLevel(rule({ apiKeyId: "key_1" }))).toBe("key");
		expect(policyLevel(rule({ projectId: "proj_1" }))).toBe("project");
		expect(policyLevel(rule())).toBe("org");
		// A key-scoped rule in a project is still key-level: the server says so.
		expect(
			policyLevel(rule({ level: "key", apiKeyId: "key_1", projectId: "p" })),
		).toBe("key");
	});

	it("names the scope, and flags a rule whose key is gone", () => {
		expect(describePolicyScope(rule())).toBe("every key in the organization");
		expect(
			describePolicyScope(rule({ projectId: "proj_1", projectName: "shop" })),
		).toBe("every key, in the shop project only");
		expect(
			describePolicyScope(rule({ apiKeyId: "key_1", keyName: "ci-bot" })),
		).toBe("only the ci-bot key");
		// keyName is null when the key was deleted - the rule now matches nothing.
		expect(
			describePolicyScope(rule({ apiKeyId: "key_abcdef12", keyName: null })),
		).toMatch(/no longer exists/);
	});

	it("orders rules the way the platform resolves them", () => {
		const org = rule({ id: "org", pattern: "area:application" });
		const orgRouter = rule({ id: "orgRouter", pattern: "application.*" });
		const project = rule({
			id: "project",
			pattern: "area:application",
			projectId: "proj_1",
		});
		const key = rule({
			id: "key",
			pattern: "area:application",
			apiKeyId: "key_1",
		});

		// Level first: key > project > org.
		expect(comparePolicySpecificity(key, project)).toBeGreaterThan(0);
		expect(comparePolicySpecificity(project, org)).toBeGreaterThan(0);
		// Then pattern kind inside one level: procedure > router > area.
		expect(comparePolicySpecificity(orgRouter, org)).toBeGreaterThan(0);
		expect(
			comparePolicySpecificity(rule({ pattern: "application.delete" }), orgRouter),
		).toBeGreaterThan(0);

		expect(sortPolicyRules([org, project, key, orgRouter]).map((r) => r.id)).toEqual(
			["key", "project", "orgRouter", "org"],
		);
	});

	it("breaks a same-scope tie toward the strictest effect", () => {
		// Two overlapping rules a human wrote twice: deny > approve > allow.
		const allow = rule({ id: "a", effect: "allow" });
		const approve = rule({ id: "b", effect: "approve" });
		const deny = rule({ id: "c", effect: "deny" });
		expect(sortPolicyRules([allow, approve, deny]).map((r) => r.id)).toEqual([
			"c",
			"b",
			"a",
		]);
	});

	it("never lets an unparseable pattern outrank a real one", () => {
		const broken = rule({ id: "broken", pattern: "nope", effect: "deny" });
		const real = rule({ id: "real", pattern: "area:application", effect: "allow" });
		expect(comparePolicySpecificity(real, broken)).toBeGreaterThan(0);
	});
});

describe("agent policy list filters", () => {
	it("parses the effect, level and limit flags", () => {
		expect(parsePolicyEffect("DENY")).toBe("deny");
		expect(parsePolicyEffect(" approve ")).toBe("approve");
		expect(parsePolicyEffect(undefined)).toBeUndefined();
		expect(parsePolicyEffect("")).toBeUndefined();
		expect(parsePolicyLevel("Org")).toBe("org");
		expect(parsePolicyLevel(undefined)).toBeUndefined();
		expect(parsePolicyLimit(undefined)).toBe(DEFAULT_POLICY_LIMIT);
		expect(parsePolicyLimit("1")).toBe(1);
		expect(parsePolicyLimit(String(MAX_POLICY_LIMIT))).toBe(MAX_POLICY_LIMIT);
	});

	it("refuses an out-of-range or non-numeric limit rather than clamping", () => {
		// Silently clamping would print 100 rules for `--limit 1000` and read as
		// a complete list.
		for (const value of ["0", "-1", "1.5", "abc", String(MAX_POLICY_LIMIT + 1)]) {
			expect(() => parsePolicyLimit(value)).toThrow(InvalidArgumentError);
		}
		expect(() => parsePolicyLimit("1000")).toThrow(/1 to 100/);
	});

	it("suggests the nearest value for a typo'd choice flag", () => {
		expect(() => parsePolicyEffect("dney")).toThrow(InvalidArgumentError);
		expect(() => parsePolicyEffect("alow")).toThrow(/Did you mean "allow"/);
		expect(() => parsePolicyLevel("keys")).toThrow(/Did you mean "key"/);
		expect(() => parseCatalogCategory("app")).toThrow(/Did you mean "apps"/);
		expect(() => parseCatalogMode("asked")).toThrow(/Did you mean "ask"/);
	});

	it("filters by effect and level, then applies the row cap", () => {
		const rules = [
			rule({ id: "1", effect: "deny", apiKeyId: "key_1" }),
			rule({ id: "2", effect: "deny" }),
			rule({ id: "3", effect: "allow" }),
			rule({ id: "4", effect: "deny", projectId: "proj_1" }),
		];
		expect(filterPolicyRules(rules, { effect: "deny" }).map((r) => r.id)).toEqual(
			["1", "2", "4"],
		);
		expect(filterPolicyRules(rules, { level: "org" }).map((r) => r.id)).toEqual([
			"2",
			"3",
		]);
		expect(
			filterPolicyRules(rules, { effect: "deny", limit: 2 }).map((r) => r.id),
		).toEqual(["1", "2"]);
		expect(filterPolicyRules(rules)).toHaveLength(4);
	});

	it("summarizes a rule set, counting the patterns that guard nothing", () => {
		expect(
			summarizePolicyRules([
				rule({ effect: "deny", apiKeyId: "key_1" }),
				rule({ effect: "approve", projectId: "proj_1" }),
				rule({ effect: "allow" }),
				rule({ effect: "deny", pattern: "typo!" }),
			]),
		).toEqual({
			total: 4,
			allow: 1,
			deny: 2,
			approve: 1,
			byLevel: { key: 1, project: 1, org: 2 },
			unparseable: 1,
		});
	});

	it("keeps the effect and level vocabularies aligned with the platform", () => {
		expect([...AGENT_POLICY_EFFECTS]).toEqual(["allow", "deny", "approve"]);
		expect([...AGENT_POLICY_LEVELS]).toEqual(["key", "project", "org"]);
		expect([...AGENT_ACTION_MODES]).toEqual(["ask", "allow", "deny"]);
		expect(APPROVAL_CATEGORIES).toHaveLength(9);
	});
});

describe("approvals catalog", () => {
	it("knows which actions a human has already configured", () => {
		expect(isCatalogEntryConfigured(catalogEntry())).toBe(false);
		expect(isCatalogEntryConfigured(catalogEntry({ orgMode: "allow" }))).toBe(
			true,
		);
		expect(
			isCatalogEntryConfigured(
				catalogEntry({
					keyOverrides: [
						{ apiKeyId: "key_1", keyName: "ci", mode: "deny", ruleId: "r1" },
					],
				}),
			),
		).toBe(true);
		// A project, router or area rule also decides this action.
		expect(isCatalogEntryConfigured(catalogEntry({ otherRuleCount: 2 }))).toBe(
			true,
		);
	});

	it("filters by category, mode and configured-only", () => {
		const entries = [
			catalogEntry({ procedure: "application.delete", category: "apps" }),
			catalogEntry({
				procedure: "postgres.delete",
				category: "databases",
				orgMode: "deny",
			}),
			catalogEntry({
				procedure: "storage.delete",
				category: "storage",
				otherRuleCount: 1,
			}),
		];
		expect(
			filterCatalogEntries(entries, { category: "databases" }).map(
				(e) => e.procedure,
			),
		).toEqual(["postgres.delete"]);
		expect(
			filterCatalogEntries(entries, { mode: "ask" }).map((e) => e.procedure),
		).toEqual(["application.delete", "storage.delete"]);
		expect(
			filterCatalogEntries(entries, { configuredOnly: true }).map(
				(e) => e.procedure,
			),
		).toEqual(["postgres.delete", "storage.delete"]);
	});

	it("groups entries by the platform's category order, then by path", () => {
		const entries = [
			catalogEntry({ procedure: "wallet.topUp", category: "billing" }),
			catalogEntry({ procedure: "storage.delete", category: "storage" }),
			catalogEntry({ procedure: "application.restart", category: "apps" }),
			catalogEntry({ procedure: "application.delete", category: "apps" }),
			catalogEntry({ procedure: "weird.thing", category: "unknown-group" }),
		];
		expect(sortCatalogEntries(entries).map((e) => e.procedure)).toEqual([
			"application.delete",
			"application.restart",
			"storage.delete",
			"wallet.topUp",
			// An unknown category sorts last rather than first.
			"weird.thing",
		]);
	});

	it("summarizes modes, overrides and conditional actions", () => {
		expect(
			summarizeCatalog([
				catalogEntry({ orgMode: "ask", condition: "destructiveSql" }),
				catalogEntry({ orgMode: "allow" }),
				catalogEntry({ orgMode: "deny" }),
				catalogEntry({
					orgMode: "unexpected",
					keyOverrides: [
						{ apiKeyId: "k1", keyName: "a", mode: "allow", ruleId: "r1" },
						{ apiKeyId: "k2", keyName: "b", mode: "deny", ruleId: "r2" },
					],
				}),
			]),
		).toEqual({
			total: 4,
			// An unrecognized mode counts as "ask": that is what no rule means.
			ask: 2,
			allow: 1,
			deny: 1,
			keyOverrides: 2,
			conditional: 1,
		});
	});
});

describe("approvals pending gate", () => {
	it("exits non-zero only while something is waiting for a human", () => {
		expect(pendingSummaryExitCode(0)).toBe(ExitCode.SUCCESS);
		expect(pendingSummaryExitCode(1)).toBe(PENDING_GATE_EXIT_CODE);
		expect(pendingSummaryExitCode(12)).toBe(PENDING_GATE_EXIT_CODE);
		// The documented code is the resumable-pending one `approvals wait` uses.
		expect(PENDING_GATE_EXIT_CODE).toBe(ExitCode.DEPLOYMENT_TIMEOUT);
		expect(PENDING_GATE_EXIT_CODE).toBe(11);
	});

	it("honors --exit-zero so the command can be a plain report", () => {
		expect(pendingSummaryExitCode(3, { exitZero: true })).toBe(
			ExitCode.SUCCESS,
		);
		expect(pendingSummaryExitCode(0, { exitZero: true })).toBe(
			ExitCode.SUCCESS,
		);
	});

	it("never reports 'waiting' because of a malformed payload", () => {
		expect(normalizePendingSummary({ count: 2, latest: [{ id: "a" }] })).toEqual(
			{ count: 2, latest: [{ id: "a" }] },
		);
		for (const raw of [null, undefined, {}, { count: "nope" }, { count: NaN }]) {
			const summary = normalizePendingSummary(raw);
			expect(summary.count).toBe(0);
			expect(summary.latest).toEqual([]);
			expect(pendingSummaryExitCode(summary.count)).toBe(ExitCode.SUCCESS);
		}
		// A string count the transport widened is still usable.
		expect(normalizePendingSummary({ count: "3" }).count).toBe(3);
		expect(normalizePendingSummary({ count: -5 }).count).toBe(0);
		expect(normalizePendingSummary({ latest: "not an array" }).latest).toEqual(
			[],
		);
	});

	it("says what parked each request, protection first", () => {
		expect(
			describePendingParkReason({
				id: "a",
				procedure: "application.delete",
				protectedResourceId: "app_1",
				policyId: "pol_1",
			}),
		).toMatch(/resource is protected/);
		expect(
			describePendingParkReason({
				id: "b",
				procedure: "application.delete",
				policyId: "pol_1",
			}),
		).toMatch(/policy rule/);
		expect(
			describePendingParkReason({ id: "c", procedure: "application.delete" }),
		).toMatch(/operator key tier/);
	});
});

describe("agent tool catalog", () => {
	it("refuses the contradictory read/write pair", () => {
		expect(() =>
			buildAgentToolFilters({ writes: true, readOnly: true }),
		).toThrow(InvalidArgumentError);
	});

	it("builds only the filters the caller actually asked for", () => {
		expect(buildAgentToolFilters()).toEqual({});
		expect(buildAgentToolFilters({ router: "  postgres  " })).toEqual({
			router: "postgres",
		});
		expect(buildAgentToolFilters({ router: "   " })).toEqual({});
		expect(buildAgentToolFilters({ readOnly: true })).toEqual({ writes: false });
		expect(buildAgentToolFilters({ writes: true, destructive: true })).toEqual({
			writes: true,
			destructiveOnly: true,
		});
	});

	it("filters by router, risk, kind and free text", () => {
		const tools = [
			tool(),
			tool({
				name: "application_all",
				path: "application.allByOrganization",
				type: "query",
				readOnly: true,
				destructive: false,
				description: "List applications with status and URL.",
			}),
			tool({
				name: "postgres_execute_sql",
				path: "postgres.executeSql",
				router: "postgres",
				description: "Run SQL against a managed database.",
			}),
		];
		expect(
			filterAgentTools(tools, { router: "POSTGRES" }).map((t) => t.path),
		).toEqual(["postgres.executeSql"]);
		expect(
			filterAgentTools(tools, { destructiveOnly: true }).map((t) => t.path),
		).toEqual(["application.delete", "postgres.executeSql"]);
		expect(filterAgentTools(tools, { writes: false }).map((t) => t.path)).toEqual(
			["application.allByOrganization"],
		);
		expect(filterAgentTools(tools, { writes: true })).toHaveLength(2);
		// Search covers the description, not just the path.
		expect(filterAgentTools(tools, { search: "SQL" }).map((t) => t.path)).toEqual(
			["postgres.executeSql"],
		);
		expect(filterAgentTools(tools, { search: "zzz" })).toEqual([]);
	});

	it("summarizes and groups the catalog", () => {
		const tools = [
			tool({ path: "postgres.delete", router: "postgres" }),
			tool({
				path: "application.allByOrganization",
				readOnly: true,
				destructive: false,
			}),
			tool(),
		];
		expect(summarizeAgentTools(tools)).toEqual({
			total: 3,
			readOnly: 1,
			writes: 2,
			destructive: 2,
			routers: 2,
		});
		expect(sortAgentTools(tools).map((t) => t.path)).toEqual([
			"application.allByOrganization",
			"application.delete",
			"postgres.delete",
		]);
		expect(summarizeAgentTools([]).routers).toBe(0);
	});
});

describe("dashboard action items", () => {
	function item(overrides: Partial<ActionItem> = {}): ActionItem {
		return { id: "i1", kind: "deploy_failed", severity: "high", ...overrides };
	}

	it("parses the severity flag and reports a typo", () => {
		expect(parseActionItemSeverity("HIGH")).toBe("high");
		expect(parseActionItemSeverity(undefined)).toBeUndefined();
		expect(parseActionItemSeverity("")).toBeUndefined();
		expect(() => parseActionItemSeverity("urgent")).toThrow(
			InvalidArgumentError,
		);
		expect(() => parseActionItemSeverity("hihg")).toThrow(/Did you mean "high"/);
		expect([...ACTION_ITEM_SEVERITIES]).toEqual(["high", "medium", "low"]);
	});

	it("orders items most urgent first and keeps insertion order within one", () => {
		const items = [
			item({ id: "low", severity: "low" }),
			item({ id: "high1", severity: "high" }),
			item({ id: "medium", severity: "medium" }),
			item({ id: "high2", severity: "high" }),
		];
		expect(sortActionItems(items).map((i) => i.id)).toEqual([
			"high1",
			"high2",
			"medium",
			"low",
		]);
		// The input is not mutated - the raw rows stay as the server sent them.
		expect(items[0]?.id).toBe("low");
	});

	it("sorts an unknown severity last rather than first", () => {
		const unknown = item({ id: "unknown", severity: "catastrophic" });
		const low = item({ id: "low", severity: "low" });
		expect(compareActionItemSeverity(unknown, low)).toBeGreaterThan(0);
		expect(sortActionItems([unknown, low]).map((i) => i.id)).toEqual([
			"low",
			"unknown",
		]);
	});

	it("filters by severity and counts each band", () => {
		const items = [
			item({ id: "a", severity: "high" }),
			item({ id: "b", severity: "medium" }),
			item({ id: "c", severity: "low" }),
			item({ id: "d", severity: "high" }),
		];
		expect(filterActionItems(items, { severity: "high" }).map((i) => i.id)).toEqual(
			["a", "d"],
		);
		expect(filterActionItems(items)).toHaveLength(4);
		expect(summarizeActionItems(items)).toEqual({
			total: 4,
			high: 2,
			medium: 1,
			low: 1,
		});
	});

	it("explains every kind the platform can emit", () => {
		for (const kind of [
			"deploy_failed",
			"billing_past_due",
			"checkout_pending",
			"domain_unverified",
			"storage_blocked",
			"support_open",
		]) {
			const prose = describeActionItemKind(kind);
			expect(prose.length).toBeGreaterThan(20);
			expect(prose).not.toContain("_");
		}
		// A kind added server-side still renders something useful.
		expect(describeActionItemKind("brand_new")).toContain("brand_new");
	});
});

describe("dashboard activity and agent digest", () => {
	it("summarizes app health, including the empty project", () => {
		expect(summarizeAppHealth(undefined)).toBe(
			"No applications in this project yet.",
		);
		expect(summarizeAppHealth({ total: 0 })).toBe(
			"No applications in this project yet.",
		);
		expect(
			summarizeAppHealth({ total: 3, running: 2, errored: 1, idle: 0 }),
		).toBe("3 applications: 2 running, 1 errored, 0 idle.");
		expect(summarizeAppHealth({ total: 1, running: 1 })).toBe(
			"1 application: 1 running, 0 errored, 0 idle.",
		);
	});

	it("summarizes the digest with a one-decimal error rate", () => {
		expect(
			summarizeDigest({
				total: 200,
				errors: 3,
				perDay: [
					{ day: "2026-10-30", count: 0 },
					{ day: "2026-10-31", count: 180 },
					{ day: "2026-11-01", count: 20 },
				],
				topProcedures: [
					{ action: "application.deploy", count: 90 },
					{ action: "postgres.executeSql", count: 40 },
				],
				anomalies: [
					{ kind: "error_spike", action: "application.deploy", count: 5 },
				],
			}),
		).toEqual({
			total: 200,
			errors: 3,
			errorRate: 1.5,
			days: 3,
			busiestDay: "2026-10-31",
			topProcedure: "application.deploy",
			anomalies: 1,
		});
	});

	it("reports an empty week without dividing by zero", () => {
		const empty = summarizeDigest({
			total: 0,
			errors: 0,
			perDay: [
				{ day: "2026-11-04", count: 0 },
				{ day: "2026-11-05", count: 0 },
			],
			topProcedures: [],
			anomalies: [],
		});
		expect(empty.errorRate).toBe(0);
		// No day was busiest when nothing happened.
		expect(empty.busiestDay).toBeNull();
		expect(empty.topProcedure).toBeNull();
		expect(summarizeDigest(null)).toMatchObject({ total: 0, days: 0 });
	});

	it("draws the per-day series, scaled to the busiest day", () => {
		expect(digestSparkline([])).toBe("");
		expect(digestSparkline(undefined)).toBe("");
		// A quiet week is dots, not a flat bar that reads as steady traffic.
		expect(digestSparkline([{ day: "d1", count: 0 }, { day: "d2" }])).toBe("··");
		const line = digestSparkline([
			{ day: "d1", count: 0 },
			{ day: "d2", count: 1 },
			{ day: "d3", count: 100 },
		]);
		expect(line).toHaveLength(3);
		expect(line[0]).toBe("·");
		expect(line[2]).toBe("█");
		expect(line[1]).not.toBe("█");
	});

	it("explains the anomaly flags the digest raises", () => {
		expect(
			describeDigestAnomaly({
				kind: "error_spike",
				action: "application.deploy",
				count: 7,
			}),
		).toMatch(/failed 7 times in the last 10 minutes/);
		expect(
			describeDigestAnomaly({
				kind: "first_destructive",
				action: "postgres.delete",
			}),
		).toMatch(/first destructive agent action/);
		// An anomaly kind added server-side falls back to the server's own prose.
		expect(
			describeDigestAnomaly({
				kind: "something_new",
				action: "x.y",
				detail: "A new signal",
			}),
		).toBe("A new signal");
	});

	it("formats how long a deployment has been running", () => {
		const now = Date.parse("2026-11-05T12:00:00.000Z");
		expect(formatElapsed(null, now)).toBe("-");
		expect(formatElapsed(undefined, now)).toBe("-");
		expect(formatElapsed("not a date", now)).toBe("-");
		expect(formatElapsed("2026-11-05T11:59:15.000Z", now)).toBe("45s");
		expect(formatElapsed("2026-11-05T11:55:48.000Z", now)).toBe("4m 12s");
		expect(formatElapsed("2026-11-05T09:30:00.000Z", now)).toBe("2h 30m");
		// A clock skew that puts the start in the future must not print "-1s".
		expect(formatElapsed("2026-11-05T12:00:30.000Z", now)).toBe("0s");
	});
});
