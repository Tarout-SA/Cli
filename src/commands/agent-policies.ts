/**
 * @fileoverview Agent policy rules (`tarout agent-policies`) — the READ side of
 * the guardrails that bind agent credentials. Wraps the platform's
 * `agentPolicy` router.
 *
 * A policy rule is one row an organization owner or admin wrote: a pattern, an
 * effect, and a scope. The pattern names what the rule covers — one procedure
 * (`application.delete`), a whole router (`application.*`), or a resource area
 * (`area:database`). The effect is what happens when an agent API key calls
 * something the pattern names: `deny` refuses the call outright (reads
 * included), `approve` parks the mutation as an approval request for a human,
 * and `allow` is "always allow" — it runs without asking and also lifts the
 * operator tier's built-in approval parking for that procedure. The scope is
 * how narrowly it applies: one API key, one project, or every key in the
 * organization. Exactly one rule decides a call — the most specific match, in
 * that order (key beats project beats organization; within a level an exact
 * procedure beats a router wildcard, which beats an area; a remaining tie goes
 * to the strictest effect). Human sessions in the dashboard are never affected
 * by any of this.
 *
 * There is deliberately no create, delete, or set-mode command. The platform
 * keeps `agentPolicy.create`, `.delete` and `.setActionMode` off every agent
 * surface (REST, MCP, CLI) because an agent must never be able to loosen the
 * guardrails that bind it — the same reason `tarout approvals` has no approve
 * or deny command. Writing a rule is a human action in the dashboard, under
 * Agent > Agent approvals (and Advanced rules). These commands are how an
 * agent, and the human supervising it, SEE the rules in force.
 * @module commands/agent-policies
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { agentDashboardUrl } from "../lib/approvals.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	InvalidArgumentError,
} from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	table,
} from "../lib/output.js";
import { startSpinner, stopSpinner, succeedSpinner } from "../utils/spinner.js";

/**
 * What a matching rule does to the call. Mirrors `AGENT_POLICY_EFFECTS` in the
 * platform's `server/api/agent-policy.ts`.
 */
export const AGENT_POLICY_EFFECTS = ["allow", "deny", "approve"] as const;
export type AgentPolicyEffect = (typeof AGENT_POLICY_EFFECTS)[number];

/** How narrowly a rule applies. The server computes this onto every row. */
export const AGENT_POLICY_LEVELS = ["key", "project", "org"] as const;
export type AgentPolicyLevel = (typeof AGENT_POLICY_LEVELS)[number];

/**
 * How the approvals catalog reports one action: `ask` means a human is asked
 * (no rule, or an `approve` rule), `allow` means it runs unasked, `deny` means
 * it is refused. Mirrors `AGENT_ACTION_MODES` in `agent-policy-mode.ts`.
 */
export const AGENT_ACTION_MODES = ["ask", "allow", "deny"] as const;
export type AgentActionMode = (typeof AGENT_ACTION_MODES)[number];

/**
 * Catalog display groups, in the server's order. Mirrors
 * `APPROVAL_CATEGORIES` in `server/api/agent-approval-catalog.ts`.
 */
export const APPROVAL_CATEGORIES = [
	"apps",
	"databases",
	"storage",
	"servers",
	"domains",
	"billing",
	"jobs",
	"access",
	"other",
] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

/** Per-organization rule cap enforced by the platform on create. */
export const MAX_POLICIES_PER_ORG = 100;

/** `agent-policies list --limit` bounds. A rule set cannot exceed the cap. */
export const DEFAULT_POLICY_LIMIT = 50;
export const MAX_POLICY_LIMIT = MAX_POLICIES_PER_ORG;

/** Longest pattern the platform stores. A longer one matches nothing. */
export const AGENT_POLICY_PATTERN_MAX_LENGTH = 120;

/** One row of `agentPolicy.list`. */
export interface AgentPolicyRule {
	id: string;
	pattern: string;
	effect: string;
	level?: string;
	projectId?: string | null;
	projectName?: string | null;
	apiKeyId?: string | null;
	keyName?: string | null;
	note?: string | null;
	createdAt?: string | Date | null;
}

/** One action of `agentPolicy.catalog`. */
export interface ApprovalCatalogEntry {
	procedure: string;
	category: string;
	/** Why this action can wait for a human, in the platform's own words. */
	reason: string;
	condition?: string | null;
	conditionNote?: string | null;
	orgMode: string;
	orgRuleId?: string | null;
	keyOverrides?: Array<{
		apiKeyId: string;
		keyName?: string | null;
		mode: string;
		ruleId: string;
	}>;
	/** Project-level, router and area rules that can also decide this action. */
	otherRuleCount?: number;
}

export interface AgentPolicyCatalog {
	categories: string[];
	actions: ApprovalCatalogEntry[];
}

// The identifier grammar of tRPC router and procedure names, as the platform's
// `parseAgentPolicyPattern` defines it. Kept in sync so the CLI can say which
// kind of pattern a stored rule is — and flag one that parses as nothing.
const POLICY_NAME = "[a-zA-Z][a-zA-Z0-9]*";
const POLICY_PROCEDURE_RE = new RegExp(`^(${POLICY_NAME})\\.(${POLICY_NAME})$`);
const POLICY_ROUTER_RE = new RegExp(`^(${POLICY_NAME})\\.\\*$`);
const POLICY_AREA_RE = /^area:([a-z]+)$/;

export type PolicyPatternKind = "procedure" | "router" | "area" | "invalid";

export interface ParsedPolicyPattern {
	kind: PolicyPatternKind;
	/** The procedure path, the router name, or the area name. */
	value: string;
}

/**
 * Which of the three pattern shapes a stored rule uses. `invalid` is a real
 * outcome, not a parse failure to swallow: a rule whose pattern does not parse
 * matches nothing at all, so a typo'd deny rule guards nothing while still
 * being listed as a guardrail.
 */
export function parsePolicyPattern(pattern: unknown): ParsedPolicyPattern {
	const trimmed = typeof pattern === "string" ? pattern.trim() : "";
	if (!trimmed || trimmed.length > AGENT_POLICY_PATTERN_MAX_LENGTH) {
		return { kind: "invalid", value: trimmed };
	}
	const area = POLICY_AREA_RE.exec(trimmed);
	if (area?.[1]) return { kind: "area", value: area[1] };
	const router = POLICY_ROUTER_RE.exec(trimmed);
	if (router?.[1]) return { kind: "router", value: router[1] };
	if (POLICY_PROCEDURE_RE.test(trimmed)) {
		return { kind: "procedure", value: trimmed };
	}
	return { kind: "invalid", value: trimmed };
}

/** One plain sentence saying what a pattern covers. No colors. */
export function describePolicyPattern(pattern: unknown): string {
	const parsed = parsePolicyPattern(pattern);
	switch (parsed.kind) {
		case "procedure":
			return `the ${parsed.value} procedure`;
		case "router":
			return `every procedure in the ${parsed.value} router`;
		case "area":
			return `every procedure in the ${parsed.value} area`;
		default:
			return "nothing — this pattern does not parse, so the rule never matches";
	}
}

/** What the effect does to a matching call. No colors. */
export function describePolicyEffect(effect: string): string {
	switch (effect) {
		case "allow":
			return "runs without asking, and the operator tier's approval parking is lifted for it";
		case "deny":
			return "is refused, reads included";
		case "approve":
			return "is parked for a human to approve (mutations only — a read is never parked)";
		default:
			return `unknown effect "${effect}" — the platform ignores a rule it cannot read`;
	}
}

/** Who and where a rule applies to. No colors. */
export function describePolicyScope(rule: AgentPolicyRule): string {
	if (rule.apiKeyId) {
		const name = rule.keyName || `key ${rule.apiKeyId.slice(0, 8)}`;
		return rule.keyName
			? `only the ${name} key`
			: `only ${name} (that key no longer exists, so the rule matches nothing)`;
	}
	if (rule.projectId) {
		const name = rule.projectName || rule.projectId;
		return `every key, in the ${name} project only`;
	}
	return "every key in the organization";
}

/** The level the platform computed, or the one the scope fields imply. */
export function policyLevel(rule: AgentPolicyRule): AgentPolicyLevel {
	if (rule.level === "key" || rule.level === "project" || rule.level === "org") {
		return rule.level;
	}
	if (rule.apiKeyId) return "key";
	if (rule.projectId) return "project";
	return "org";
}

// Resolution ranks, straight from the platform's `agent-policy.ts`: level
// first, then pattern kind, then (for a tie a human created by writing two
// overlapping rules) the strictest effect.
const LEVEL_RANK: Record<AgentPolicyLevel, number> = {
	key: 3,
	project: 2,
	org: 1,
};
const KIND_RANK: Record<PolicyPatternKind, number> = {
	procedure: 3,
	router: 2,
	area: 1,
	// A pattern that does not parse never wins anything; it never matches.
	invalid: 0,
};
const EFFECT_RANK: Record<string, number> = { deny: 3, approve: 2, allow: 1 };

/**
 * Orders two rules the way the platform resolves them: positive when `a` is
 * more specific than `b`, so a descending sort puts the rule that would win
 * first. Only meaningful between rules that match the same call, but it is
 * also the clearest reading order for a whole rule set.
 */
export function comparePolicySpecificity(
	a: AgentPolicyRule,
	b: AgentPolicyRule,
): number {
	return (
		LEVEL_RANK[policyLevel(a)] - LEVEL_RANK[policyLevel(b)] ||
		KIND_RANK[parsePolicyPattern(a.pattern).kind] -
			KIND_RANK[parsePolicyPattern(b.pattern).kind] ||
		(EFFECT_RANK[a.effect] ?? 0) - (EFFECT_RANK[b.effect] ?? 0)
	);
}

/** A copy of the rule set, most specific first. */
export function sortPolicyRules(rules: AgentPolicyRule[]): AgentPolicyRule[] {
	return [...rules].sort((a, b) => comparePolicySpecificity(b, a));
}

function invalidChoice(
	flag: string,
	value: unknown,
	choices: readonly string[],
): InvalidArgumentError {
	const raw = String(value);
	const similar = findSimilar(raw, [...choices]);
	return new InvalidArgumentError(
		`Invalid ${flag} "${raw}". Use one of: ${choices.join(", ")}.${
			similar.length ? ` Did you mean "${similar[0]}"?` : ""
		}`,
	);
}

/** `--effect`: one of allow, deny, approve. Undefined when the flag is absent. */
export function parsePolicyEffect(
	value: unknown,
): AgentPolicyEffect | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const normalized = String(value).trim().toLowerCase();
	const match = AGENT_POLICY_EFFECTS.find((effect) => effect === normalized);
	if (!match) throw invalidChoice("--effect", value, AGENT_POLICY_EFFECTS);
	return match;
}

/** `--level`: one of key, project, org. Undefined when the flag is absent. */
export function parsePolicyLevel(value: unknown): AgentPolicyLevel | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const normalized = String(value).trim().toLowerCase();
	const match = AGENT_POLICY_LEVELS.find((level) => level === normalized);
	if (!match) throw invalidChoice("--level", value, AGENT_POLICY_LEVELS);
	return match;
}

/**
 * `--limit`: a whole number of rules to print, 1 to the platform's per-org cap.
 * The procedure takes no input, so this trims the rows client-side rather than
 * asking the server for fewer.
 */
export function parsePolicyLimit(value: unknown): number {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_POLICY_LIMIT;
	}
	const raw = String(value).trim();
	const limit = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_POLICY_LIMIT) {
		throw new InvalidArgumentError(
			`--limit must be a whole number from 1 to ${MAX_POLICY_LIMIT} (an organization can hold at most ${MAX_POLICIES_PER_ORG} rules).`,
		);
	}
	return limit;
}

/** `--category`: one of the catalog's display groups. */
export function parseCatalogCategory(
	value: unknown,
): ApprovalCategory | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const normalized = String(value).trim().toLowerCase();
	const match = APPROVAL_CATEGORIES.find(
		(category) => category === normalized,
	);
	if (!match) throw invalidChoice("--category", value, APPROVAL_CATEGORIES);
	return match;
}

/** `--mode`: one of ask, allow, deny. */
export function parseCatalogMode(value: unknown): AgentActionMode | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const normalized = String(value).trim().toLowerCase();
	const match = AGENT_ACTION_MODES.find((mode) => mode === normalized);
	if (!match) throw invalidChoice("--mode", value, AGENT_ACTION_MODES);
	return match;
}

export interface PolicyRuleFilters {
	effect?: AgentPolicyEffect;
	level?: AgentPolicyLevel;
	limit?: number;
}

/**
 * Applies the client-side `list` filters: effect, level, then the row cap.
 * `agentPolicy.list` takes no input, so every filter happens here.
 */
export function filterPolicyRules(
	rules: AgentPolicyRule[],
	filters: PolicyRuleFilters = {},
): AgentPolicyRule[] {
	const matched = rules.filter((rule) => {
		if (filters.effect && rule.effect !== filters.effect) return false;
		if (filters.level && policyLevel(rule) !== filters.level) return false;
		return true;
	});
	return filters.limit === undefined
		? matched
		: matched.slice(0, filters.limit);
}

/** Rule-set totals, for the one-line footer and the `--json` envelope. */
export function summarizePolicyRules(rules: AgentPolicyRule[]): {
	total: number;
	allow: number;
	deny: number;
	approve: number;
	byLevel: Record<AgentPolicyLevel, number>;
	unparseable: number;
} {
	const summary = {
		total: rules.length,
		allow: 0,
		deny: 0,
		approve: 0,
		byLevel: { key: 0, project: 0, org: 0 } as Record<
			AgentPolicyLevel,
			number
		>,
		unparseable: 0,
	};
	for (const rule of rules) {
		if (rule.effect === "allow") summary.allow++;
		else if (rule.effect === "deny") summary.deny++;
		else if (rule.effect === "approve") summary.approve++;
		summary.byLevel[policyLevel(rule)]++;
		if (parsePolicyPattern(rule.pattern).kind === "invalid") {
			summary.unparseable++;
		}
	}
	return summary;
}

export interface CatalogFilters {
	category?: ApprovalCategory;
	mode?: AgentActionMode;
	/** Only actions a rule has already changed away from the default "ask". */
	configuredOnly?: boolean;
}

/** The catalog filters, applied in the order the flags are documented. */
export function filterCatalogEntries(
	entries: ApprovalCatalogEntry[],
	filters: CatalogFilters = {},
): ApprovalCatalogEntry[] {
	return entries.filter((entry) => {
		if (filters.category && entry.category !== filters.category) return false;
		if (filters.mode && entry.orgMode !== filters.mode) return false;
		if (filters.configuredOnly && !isCatalogEntryConfigured(entry)) {
			return false;
		}
		return true;
	});
}

/** True when a human has written any rule that touches this action. */
export function isCatalogEntryConfigured(entry: ApprovalCatalogEntry): boolean {
	return (
		entry.orgMode !== "ask" ||
		(entry.keyOverrides?.length ?? 0) > 0 ||
		(entry.otherRuleCount ?? 0) > 0
	);
}

/** Catalog entries by category (server order), then procedure path. */
export function sortCatalogEntries(
	entries: ApprovalCatalogEntry[],
): ApprovalCatalogEntry[] {
	const order = new Map<string, number>(
		APPROVAL_CATEGORIES.map((category, index) => [category, index]),
	);
	return [...entries].sort(
		(a, b) =>
			(order.get(a.category) ?? APPROVAL_CATEGORIES.length) -
				(order.get(b.category) ?? APPROVAL_CATEGORIES.length) ||
			a.procedure.localeCompare(b.procedure),
	);
}

/** Catalog totals: how many actions ask, run unasked, or are blocked. */
export function summarizeCatalog(entries: ApprovalCatalogEntry[]): {
	total: number;
	ask: number;
	allow: number;
	deny: number;
	keyOverrides: number;
	conditional: number;
} {
	const summary = {
		total: entries.length,
		ask: 0,
		allow: 0,
		deny: 0,
		keyOverrides: 0,
		conditional: 0,
	};
	for (const entry of entries) {
		if (entry.orgMode === "allow") summary.allow++;
		else if (entry.orgMode === "deny") summary.deny++;
		else summary.ask++;
		summary.keyOverrides += entry.keyOverrides?.length ?? 0;
		if (entry.condition) summary.conditional++;
	}
	return summary;
}

function paintEffect(effect: string): string {
	switch (effect) {
		case "allow":
			return colors.success("allow");
		case "deny":
			return colors.error("deny");
		case "approve":
			return colors.warn("approve");
		default:
			return colors.dim(effect);
	}
}

function paintMode(mode: string): string {
	switch (mode) {
		case "allow":
			return colors.success("allow");
		case "deny":
			return colors.error("deny");
		case "ask":
			return colors.warn("ask");
		default:
			return colors.dim(mode);
	}
}

function shortScope(rule: AgentPolicyRule): string {
	if (rule.apiKeyId) {
		return rule.keyName || `key ${rule.apiKeyId.slice(0, 8)}`;
	}
	if (rule.projectId) return rule.projectName || rule.projectId;
	return colors.dim("organization");
}

function formatDate(value: string | Date | null | undefined): string {
	if (!value) return colors.dim("-");
	return new Date(value).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function registerAgentPolicyCommands(program: Command) {
	const policies = program
		.command("agent-policies")
		.alias("agent-policy")
		.description(
			"See the agent policy rules that govern this organization's agent credentials: which procedures are denied, which are parked for a human to approve, and which are always allowed",
		)
		.addHelpText(
			"after",
			() =>
				`
A rule is a pattern, an effect, and a scope.

  Pattern   one procedure (application.delete), a whole router
            (application.*), or a resource area (area:database).
  Effect    deny    the call is refused, reads included.
            approve the mutation is parked as an approval request for a
                    human; a read is never parked.
            allow   the call runs without asking, and the operator tier's
                    built-in approval parking is lifted for it.
  Scope     one API key, one project, or every key in the organization.

Exactly one rule decides a call: the most specific match. A key-level rule
beats a project-level rule, which beats an organization-wide rule; within one
level an exact procedure beats a router wildcard, which beats an area; a
remaining tie goes to the strictest effect (deny, then approve, then allow).
Human sessions in the dashboard are never affected by any of this.

These commands are read-only on purpose. The platform keeps rule WRITES
(create, delete, set-mode) off every agent surface, because an agent must
never be able to loosen the guardrails that bind it — the same reason
\`tarout approvals\` has no approve or deny command. A human writes rules in
the dashboard: ${agentDashboardUrl()}

Related:
  tarout approvals pending            is anything waiting for a human right now
  tarout settings agent-tools         every action an agent can call at all
  tarout agent sessions               the credentials these rules bind`,
		);

	// ── list ─────────────────────────────────────────────────────────────────────
	policies
		.command("list")
		.alias("ls")
		.description(
			"List the agent policy rules in force, most specific first — the order the platform resolves them in. An agent credential sees the organization-wide rules plus its own; a human sees every rule in the organization",
		)
		.option(
			"-e, --effect <effect>",
			`Only rules with this effect: ${AGENT_POLICY_EFFECTS.join(", ")}`,
		)
		.option(
			"-l, --level <level>",
			`Only rules at this scope: ${AGENT_POLICY_LEVELS.join(", ")} (key = one API key, project = one project, org = every key)`,
		)
		.option(
			"-n, --limit <n>",
			`How many rules to print, 1 to ${MAX_POLICY_LIMIT} (default ${DEFAULT_POLICY_LIMIT})`,
		)
		.action(
			async (options: {
				effect?: string;
				level?: string;
				limit?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					const effect = parsePolicyEffect(options.effect);
					const level = parsePolicyLevel(options.level);
					const limit = parsePolicyLimit(options.limit);
					const client = getApiClient();

					const _spinner = startSpinner("Fetching agent policy rules...");
					const raw = (await client.agentPolicy.list.query()) as
						| AgentPolicyRule[]
						| null;
					succeedSpinner();

					const all = Array.isArray(raw) ? raw : [];
					const rules = filterPolicyRules(sortPolicyRules(all), {
						effect,
						level,
						limit,
					});

					if (isJsonMode()) {
						outputData({
							rules,
							summary: summarizePolicyRules(rules),
							totalInOrganization: all.length,
						});
						return;
					}

					quietOutput(String(rules.length));

					if (!rules.length) {
						log("");
						log(
							all.length
								? "No agent policy rules match those filters."
								: "No agent policy rules. Every agent credential is governed by its key tier alone: a read-only key can only read, an operator key has its destructive calls parked for approval, and a full key has no guardrails.",
						);
						log("");
						log(
							`See every action that can wait for a human: ${colors.dim("tarout agent-policies catalog")}`,
						);
						log("");
						return;
					}

					log("");
					table(
						["ID", "PATTERN", "EFFECT", "SCOPE", "NOTE", "CREATED"],
						rules.map((rule) => [
							colors.cyan(rule.id),
							parsePolicyPattern(rule.pattern).kind === "invalid"
								? colors.error(rule.pattern)
								: colors.bold(rule.pattern),
							paintEffect(rule.effect),
							shortScope(rule),
							rule.note ? truncate(rule.note, 40) : colors.dim("-"),
							formatDate(rule.createdAt),
						]),
					);
					log("");

					const summary = summarizePolicyRules(rules);
					log(
						colors.dim(
							`${summary.total} rule${summary.total === 1 ? "" : "s"}, most specific first: ${summary.deny} deny, ${summary.approve} approve, ${summary.allow} allow.`,
						),
					);
					if (all.length > rules.length) {
						log(
							colors.dim(
								`${all.length} rule${all.length === 1 ? "" : "s"} visible to this credential in total.`,
							),
						);
					}
					if (summary.unparseable > 0) {
						log(
							colors.warn(
								`${summary.unparseable} rule${summary.unparseable === 1 ? " has a pattern that" : "s have patterns that"} do not parse, so ${summary.unparseable === 1 ? "it guards" : "they guard"} nothing. A human should fix or remove ${summary.unparseable === 1 ? "it" : "them"} in the dashboard.`,
							),
						);
					}
					log("");
					for (const rule of rules.slice(0, 5)) {
						log(
							`  ${colors.cyan(rule.id)} — ${describePolicyPattern(rule.pattern)}, called by ${describePolicyScope(rule)}, ${describePolicyEffect(rule.effect)}.`,
						);
					}
					log("");
				} catch (err) {
					stopSpinner();
					handleError(err);
				}
			},
		);

	// ── catalog ──────────────────────────────────────────────────────────────────
	policies
		.command("catalog")
		.alias("actions")
		.description(
			"List every action that can wait for a human approval, with why it waits and whether this organization currently asks, always allows, or blocks it",
		)
		.option(
			"-c, --category <category>",
			`Only one group: ${APPROVAL_CATEGORIES.join(", ")}`,
		)
		.option(
			"-m, --mode <mode>",
			`Only actions whose organization-wide mode is this: ${AGENT_ACTION_MODES.join(", ")} (ask is the default for an action no rule covers)`,
		)
		.option(
			"--configured",
			"Only actions a rule has already changed away from the default (an organization-wide mode, a per-key override, or a project/router/area rule)",
		)
		.action(
			async (options: {
				category?: string;
				mode?: string;
				configured?: boolean;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					const category = parseCatalogCategory(options.category);
					const mode = parseCatalogMode(options.mode);
					const client = getApiClient();

					const _spinner = startSpinner("Fetching the approvals catalog...");
					const raw = (await client.agentPolicy.catalog.query()) as
						| AgentPolicyCatalog
						| null;
					succeedSpinner();

					const allActions = Array.isArray(raw?.actions) ? raw.actions : [];
					const actions = sortCatalogEntries(
						filterCatalogEntries(allActions, {
							category,
							mode,
							configuredOnly: !!options.configured,
						}),
					);

					if (isJsonMode()) {
						outputData({
							categories: raw?.categories ?? [...APPROVAL_CATEGORIES],
							actions,
							summary: summarizeCatalog(actions),
							totalActions: allActions.length,
						});
						return;
					}

					quietOutput(String(actions.length));

					if (!actions.length) {
						log("");
						log(
							allActions.length
								? "No approvable actions match those filters."
								: "The platform reported no approvable actions.",
						);
						log("");
						return;
					}

					log("");
					table(
						["ACTION", "CATEGORY", "MODE", "OVERRIDES", "OTHER", "WAITS"],
						actions.map((entry) => [
							colors.bold(entry.procedure),
							entry.category,
							paintMode(entry.orgMode),
							entry.keyOverrides?.length
								? colors.cyan(
										entry.keyOverrides
											.map(
												(override) =>
													`${override.keyName || override.apiKeyId.slice(0, 8)}=${override.mode}`,
											)
											.join(", "),
									)
								: colors.dim("-"),
							entry.otherRuleCount
								? String(entry.otherRuleCount)
								: colors.dim("-"),
							entry.condition
								? colors.warn("sometimes")
								: colors.dim("always"),
						]),
					);
					log("");

					const summary = summarizeCatalog(actions);
					log(
						colors.dim(
							`${summary.total} action${summary.total === 1 ? "" : "s"}: ${summary.ask} ask a human, ${summary.allow} always allowed, ${summary.deny} blocked. ${summary.keyOverrides} per-key override${summary.keyOverrides === 1 ? "" : "s"}.`,
						),
					);
					log(
						colors.dim(
							'MODE is the organization-wide setting; a per-key override or a more specific project, router or area rule can still win. WAITS "sometimes" means only certain inputs ask.',
						),
					);
					log("");
					for (const entry of actions.filter((a) => a.conditionNote).slice(0, 5)) {
						log(`  ${colors.bold(entry.procedure)}: ${entry.conditionNote}`);
					}
					log("");
					log(
						`A human changes any of this in the dashboard: ${colors.cyan(`${agentDashboardUrl()}/approvals`)}`,
					);
					log("");
				} catch (err) {
					stopSpinner();
					handleError(err);
				}
			},
		);
}
