# CLI db / plan upgrade + downgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken `db upgrade`, add `db downgrade` and `billing downgrade` to the `@tarout/cli`, all funneling through the existing billing-change engine.

**Architecture:** DB tier changes call the customer-facing `subscription.purchaseDatabaseUpgrade`/`purchaseDatabaseDowngrade` (Postgres-only), then classify via `finalizeBillingMutation`. Plan downgrade reuses `performBillingChange({kind:"plan"})`, which the server defers to period end. All results render through `emitBillingResult`.

**Tech Stack:** TypeScript (ESM), commander, an untyped tRPC proxy client, vitest + `bun test`, biome.

## Global Constraints

- Work only in the worktree `/home/stanoid/tarout/cli-db-plan-downgrade` on branch `feat/cli-db-plan-downgrade-upgrade`. Do NOT edit `/home/stanoid/tarout/cli` directly.
- CLI-only. NO changes under `/home/stanoid/tarout/platform`. Consume existing tRPC procedures only.
- DB tier changes are **Postgres-only**. MySQL databases must be rejected before any mutation with `ExitCode.INVALID_ARGUMENTS`.
- Exact server procedures + input schemas (copy verbatim):
  - `subscription.purchaseDatabaseUpgrade.mutate({ postgresId: string, targetPlan: "STARTER"|"STANDARD"|"PRO" })`
  - `subscription.previewDatabaseUpgrade.query({ postgresId, targetPlan: "STARTER"|"STANDARD"|"PRO" })`
  - `subscription.purchaseDatabaseDowngrade.mutate({ postgresId: string, targetPlan: "STARTER"|"STANDARD" })`
  - `subscription.previewDatabaseDowngrade.query({ postgresId, targetPlan: "STARTER"|"STANDARD" })`
  - `subscription.changePlan.mutate({ planKey, billingPeriod? })` (via `performBillingChange`) — a lower `sortOrder` target defers to period end.
  - `subscription.getCurrent.query()` → `{ planKey, status, ... }`; `subscription.getCatalog.query()` → `{ plans: [{ planKey, sortOrder, priceHalalas, ... }], addons }` (plans ordered by `sortOrder` asc).
- `targetPlan` enums are UPPERCASE. Normalize user input with the existing module-local `normalizeDbPlan()`.
- Reuse the billing engine in `src/lib/billing-upgrade.ts`; `emitBillingResult` box titles are status-driven and stay correct for `kind: "database"`.
- Test commands: `bun run test:vitest`, `bun test`, `bun run typecheck`, `bun run lint`. Baseline before changes: 146 vitest + 50 bun = 196 green.
- Commit style: conventional (`feat(cli):` / `fix(cli):`) with trailer `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.

## File Structure

- Modify `src/lib/billing-upgrade.ts` — widen `BillingChangeKind` with `"database"`; add a `resolveTarget` branch.
- Modify `src/commands/db.ts` — add exported helpers `assertPostgresTierChange`, `resolveDbTierTarget`, `runDatabaseTierChange`; fix the `db upgrade` action; add the `db downgrade` command.
- Modify `src/commands/billing.ts` — add exported `planKeyOf` + `classifyPlanDirection`; add the `billing downgrade` command.
- Create `__test__/db-tier-change.test.ts` — unit tests for the three db helpers.
- Create `__test__/billing-downgrade.test.ts` — unit tests for `classifyPlanDirection` + command registration.
- Modify `__test__/billing-upgrade-engine.test.ts` — add a `finalizeBillingMutation — database kind` block.

## App note

`apps change-plan` is already bidirectional and is intentionally left unchanged (agreed "fill gaps only" scope). No task modifies it.

---

### Task 1: Engine — add `"database"` BillingChangeKind

**Files:**
- Modify: `src/lib/billing-upgrade.ts` (`BillingChangeKind` ~line 41; `resolveTarget` ~line 119)
- Test: `__test__/billing-upgrade-engine.test.ts`

**Interfaces:**
- Produces: `BillingChangeKind = "plan" | "addon" | "plan_quantity" | "database"`. `finalizeBillingMutation(client, result, { kind: "database", target, wait?, timeoutMs?, openBrowser?, onCheckoutOpened? })` returns a `BillingChangeResult` with `kind: "database"`.

- [ ] **Step 1: Write the failing test** — add to the end of `__test__/billing-upgrade-engine.test.ts`, and add `finalizeBillingMutation` to the existing import from `../src/lib/billing-upgrade`.

```ts
import { finalizeBillingMutation } from "../src/lib/billing-upgrade";

describe("finalizeBillingMutation — database kind", () => {
	it("classifies an applied (net-zero) db change", async () => {
		const r = await finalizeBillingMutation(
			{} as never,
			{ applied: true, proratedChargeHalalas: 0 },
			{ kind: "database", target: "STANDARD" },
		);
		expect(r.status).toBe("applied");
		expect(r.kind).toBe("database");
		expect(r.target).toBe("STANDARD");
	});

	it("classifies a db upgrade that returns a hosted checkout", async () => {
		const r = await finalizeBillingMutation(
			{} as never,
			{ applied: false, paymentUrl: "https://pay.test/x", orderId: "ord_9", proratedChargeHalalas: 2000 },
			{ kind: "database", target: "PRO" },
		);
		expect(r.status).toBe("payment_required");
		expect(r.kind).toBe("database");
		expect(r.target).toBe("PRO");
	});
});
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `bun run typecheck`
Expected: FAIL — `Type '"database"' is not assignable to type 'BillingChangeKind'`.

- [ ] **Step 3: Widen the union**

In `src/lib/billing-upgrade.ts`, change:

```ts
export type BillingChangeKind = "plan" | "addon" | "plan_quantity";
```

to:

```ts
export type BillingChangeKind = "plan" | "addon" | "plan_quantity" | "database";
```

- [ ] **Step 4: Add the `resolveTarget` branch** (defensive — db commands call `finalizeBillingMutation` directly, but keep `resolveTarget` total). In `resolveTarget`, before the final `return`:

```ts
	if (input.kind === "database") return input.planKey ?? "";
```

- [ ] **Step 5: Verify typecheck + tests pass**

Run: `bun run typecheck && bun run test:vitest`
Expected: typecheck clean; the two new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/billing-upgrade.ts __test__/billing-upgrade-engine.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add "database" BillingChangeKind to the billing engine

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: db.ts — postgres guard, tier validation, and mutation runner

**Files:**
- Modify: `src/commands/db.ts` (imports at top; add exported helpers near `normalizeDbPlan`, ~line 52)
- Test: `__test__/db-tier-change.test.ts` (create)

**Interfaces:**
- Consumes: `finalizeBillingMutation`, `type BillingChangeResult` from `../lib/billing-upgrade.js`; existing module-local `normalizeDbPlan`; `CliError`, `ExitCode`.
- Produces:
  - `assertPostgresTierChange(db: { type: DatabaseType; name: string }): void` — throws `CliError` if not postgres.
  - `resolveDbTierTarget(direction: "upgrade" | "downgrade", raw: string | undefined): "STARTER" | "STANDARD" | "PRO"` — normalizes + validates; downgrade rejects `PRO`; both reject `FREE`/empty/invalid.
  - `runDatabaseTierChange(client, input: DatabaseTierChangeInput): Promise<BillingChangeResult>` where `DatabaseTierChangeInput = { direction: "upgrade" | "downgrade"; postgresId: string; targetPlan: "STARTER" | "STANDARD" | "PRO"; wait?: boolean; timeoutMs?: number; openBrowser?: (url: string) => Promise<void>; onCheckoutOpened?: (info: { orderId: string; paymentUrl: string }) => void }`.

- [ ] **Step 1: Write the failing test** — create `__test__/db-tier-change.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	assertPostgresTierChange,
	resolveDbTierTarget,
	runDatabaseTierChange,
} from "../src/commands/db";

describe("assertPostgresTierChange", () => {
	it("passes for a postgres database", () => {
		expect(() => assertPostgresTierChange({ type: "postgres", name: "main" })).not.toThrow();
	});
	it("throws a clear error for mysql", () => {
		expect(() => assertPostgresTierChange({ type: "mysql", name: "shop" })).toThrow(/PostgreSQL/);
	});
});

describe("resolveDbTierTarget", () => {
	it("upgrade normalizes to uppercase and accepts pro", () => {
		expect(resolveDbTierTarget("upgrade", "pro")).toBe("PRO");
		expect(resolveDbTierTarget("upgrade", "standard")).toBe("STANDARD");
	});
	it("downgrade accepts standard but rejects pro", () => {
		expect(resolveDbTierTarget("downgrade", "standard")).toBe("STANDARD");
		expect(() => resolveDbTierTarget("downgrade", "pro")).toThrow(/highest tier/);
	});
	it("rejects free, empty, and invalid tiers", () => {
		expect(() => resolveDbTierTarget("upgrade", "free")).toThrow();
		expect(() => resolveDbTierTarget("upgrade", undefined)).toThrow(/required/);
		expect(() => resolveDbTierTarget("upgrade", "huge")).toThrow();
	});
});

describe("runDatabaseTierChange", () => {
	it("upgrade routes to purchaseDatabaseUpgrade and classifies a checkout", async () => {
		let captured: unknown;
		const client = {
			subscription: {
				purchaseDatabaseUpgrade: {
					mutate: async (i: unknown) => {
						captured = i;
						return { applied: false, paymentUrl: "https://pay.test/x", orderId: "ord_1", proratedChargeHalalas: 2000 };
					},
				},
			},
		};
		const r = await runDatabaseTierChange(client, { direction: "upgrade", postgresId: "pg_1", targetPlan: "PRO" });
		expect(captured).toEqual({ postgresId: "pg_1", targetPlan: "PRO" });
		expect(r.status).toBe("payment_required");
		expect(r.kind).toBe("database");
		expect(r.target).toBe("PRO");
	});
	it("downgrade routes to purchaseDatabaseDowngrade and applies immediately", async () => {
		let captured: unknown;
		const client = {
			subscription: {
				purchaseDatabaseDowngrade: {
					mutate: async (i: unknown) => {
						captured = i;
						return { applied: true, proratedChargeHalalas: 0 };
					},
				},
			},
		};
		const r = await runDatabaseTierChange(client, { direction: "downgrade", postgresId: "pg_2", targetPlan: "STARTER" });
		expect(captured).toEqual({ postgresId: "pg_2", targetPlan: "STARTER" });
		expect(r.status).toBe("applied");
		expect(r.kind).toBe("database");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:vitest __test__/db-tier-change.test.ts`
Expected: FAIL — the three helpers are not exported from `../src/commands/db`.

- [ ] **Step 3: Add the imports** to the top of `src/commands/db.ts`. Extend the existing `../lib/billing-upgrade.js` usage by adding this import block after the `errors.js` import:

```ts
import {
	type BillingChangeResult,
	finalizeBillingMutation,
} from "../lib/billing-upgrade.js";
```

- [ ] **Step 4: Add the helpers** right after `normalizeDbPlan` (before `resolveDbPlan`) in `src/commands/db.ts`:

```ts
export function assertPostgresTierChange(dbSummary: {
	type: DatabaseType;
	name: string;
}): void {
	if (dbSummary.type !== "postgres") {
		throw new CliError(
			`Tier changes are available for PostgreSQL databases only. "${dbSummary.name}" is a ${dbSummary.type} database; MySQL tier changes aren't supported yet.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
}

export function resolveDbTierTarget(
	direction: "upgrade" | "downgrade",
	raw: string | undefined,
): "STARTER" | "STANDARD" | "PRO" {
	const plan = normalizeDbPlan(raw);
	if (!plan) {
		throw new CliError("A target tier is required (--plan).", ExitCode.INVALID_ARGUMENTS);
	}
	if (plan === "FREE") {
		throw new CliError(
			"FREE is not a paid tier. To stop billing for a database, delete it instead.",
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	if (direction === "downgrade" && plan === "PRO") {
		throw new CliError(
			"PRO is the highest tier — use `tarout db upgrade` to move up.",
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	return plan as "STARTER" | "STANDARD" | "PRO";
}

export interface DatabaseTierChangeInput {
	direction: "upgrade" | "downgrade";
	postgresId: string;
	targetPlan: "STARTER" | "STANDARD" | "PRO";
	wait?: boolean;
	timeoutMs?: number;
	openBrowser?: (url: string) => Promise<void>;
	onCheckoutOpened?: (info: { orderId: string; paymentUrl: string }) => void;
}

export async function runDatabaseTierChange(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	input: DatabaseTierChangeInput,
): Promise<BillingChangeResult> {
	const result =
		input.direction === "upgrade"
			? await client.subscription.purchaseDatabaseUpgrade.mutate({
					postgresId: input.postgresId,
					targetPlan: input.targetPlan,
				})
			: await client.subscription.purchaseDatabaseDowngrade.mutate({
					postgresId: input.postgresId,
					targetPlan: input.targetPlan,
				});
	return finalizeBillingMutation(client, result, {
		kind: "database",
		target: input.targetPlan,
		wait: input.wait,
		timeoutMs: input.timeoutMs,
		openBrowser: input.openBrowser,
		onCheckoutOpened: input.onCheckoutOpened,
	});
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test:vitest __test__/db-tier-change.test.ts && bun run typecheck`
Expected: all 8 assertions PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/db.ts __test__/db-tier-change.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add postgres tier-change helpers (guard, validate, runner)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Fix the `db upgrade` command

Reroute the broken `db upgrade` (which calls the ops-only `client.postgres.upgrade`) onto the customer-facing runner from Task 2, and add checkout flags for parity with `billing upgrade`.

**Files:**
- Modify: `src/commands/db.ts` — top imports; replace the `db.command("upgrade")` block (currently ~lines 831–876).
- Test: `__test__/db-tier-change.test.ts` — add a command-registration test.

**Interfaces:**
- Consumes: `runDatabaseTierChange`, `assertPostgresTierChange`, `resolveDbTierTarget` (Task 2); `emitBillingResult` from `../lib/billing-upgrade.js`; `paymentBrowserOpener` from `../lib/browser.js`; `shouldAutoConfirmPaidCheckout` from `../lib/browser.js`; `outputJsonLine` from `../lib/output.js`; existing `getAllDatabases`, `findDatabase`.

- [ ] **Step 1: Write the failing test** — append to `__test__/db-tier-change.test.ts`:

```ts
import { Command } from "commander";
import { registerDbCommands } from "../src/commands/db";

function dbSubcommand(name: string) {
	const program = new Command();
	program.exitOverride();
	registerDbCommands(program);
	const db = program.commands.find((c) => c.name() === "db");
	return db?.commands.find((c) => c.name() === name);
}

describe("db upgrade command registration", () => {
	it("registers upgrade with --plan and checkout flags", () => {
		const cmd = dbSubcommand("upgrade");
		expect(cmd, "db upgrade should exist").toBeTruthy();
		const longs = cmd?.options.map((o) => o.long) ?? [];
		expect(longs).toContain("--plan");
		expect(longs).toContain("--wait");
		expect(longs).toContain("--no-wait");
		expect(longs).toContain("--timeout");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:vitest __test__/db-tier-change.test.ts`
Expected: FAIL — `db upgrade` has no `--wait`/`--timeout` options yet.

- [ ] **Step 3: Extend the top imports** of `src/commands/db.ts`.

Add to the existing `../lib/billing-upgrade.js` import (from Task 2) so it reads:

```ts
import {
	type BillingChangeResult,
	emitBillingResult,
	finalizeBillingMutation,
} from "../lib/billing-upgrade.js";
```

Add a new import for the browser helpers:

```ts
import { paymentBrowserOpener, shouldAutoConfirmPaidCheckout } from "../lib/browser.js";
```

Add `outputJsonLine` to the existing `../lib/output.js` import list.

- [ ] **Step 4: Replace the `db.command("upgrade")` block** (the whole current block from `// ── Upgrade database ──` through its closing `});`) with:

```ts
	// ── Upgrade database ─────────────────────────────────────────────────────────
	db.command("upgrade")
		.argument("<db>", "Database ID or name")
		.description("Upgrade a managed PostgreSQL database to a higher tier")
		.option("--plan <plan>", "Target tier (starter, standard, pro)")
		.option("--wait", "Wait/poll until the hosted checkout is confirmed (default)")
		.option("--no-wait", "Return as soon as the hosted checkout opens")
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.option("--no-open", "Do not auto-open the payment URL in the browser")
		.action(async (dbIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				succeedSpinner();
				assertPostgresTierChange(dbSummary);
				const rawPlan =
					options.plan ||
					(await input("Target tier (starter, standard, pro):", undefined, {
						field: "target_plan",
						flag: "--plan",
						context: { id: dbSummary.id, name: dbSummary.name, type: dbSummary.type },
					}));
				const targetPlan = resolveDbTierTarget("upgrade", rawPlan);

				// Interactive-only preview + confirm; agent/--json/--yes go straight to
				// the mutation (fewer round-trips, deterministic).
				if (!isJsonMode() && !isNonInteractiveMode() && !shouldSkipConfirmation()) {
					const _p = startSpinner("Calculating change...");
					// biome-ignore lint/suspicious/noExplicitAny: server preview shape varies.
					let preview: any = null;
					try {
						preview = await client.subscription.previewDatabaseUpgrade.query({
							postgresId: dbSummary.id,
							targetPlan,
						});
						succeedSpinner();
					} catch {
						failSpinner();
					}
					const dueHalalas =
						typeof preview?.proratedChargeHalalas === "number"
							? preview.proratedChargeHalalas
							: undefined;
					if (dueHalalas !== undefined) {
						log(
							`Amount due now: ${colors.bold(`${(dueHalalas / 100).toFixed(2)} SAR`)} ${colors.dim("(incl. 15% VAT at checkout)")}`,
						);
					}
					if (shouldAutoConfirmPaidCheckout(dueHalalas)) {
						log("Opening the secure payment page in your browser to complete the upgrade...");
					} else {
						const confirmed = await confirm(
							`Upgrade "${dbSummary.name}" to ${targetPlan}?`,
							false,
							{
								field: "confirm_db_upgrade",
								flag: "--yes",
								context: { id: dbSummary.id, name: dbSummary.name, targetPlan, amountDueHalalas: dueHalalas },
							},
						);
						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}
				}

				const _u = startSpinner(`Upgrading ${dbSummary.name} to ${targetPlan}...`);
				const result = await runDatabaseTierChange(client, {
					direction: "upgrade",
					postgresId: dbSummary.id,
					targetPlan,
					wait: options.wait,
					timeoutMs: options.timeout * 1000,
					openBrowser: paymentBrowserOpener({ noOpen: options.open === false }),
					onCheckoutOpened: ({ orderId, paymentUrl }) => {
						if (isJsonMode()) {
							outputJsonLine({ type: "event", event: "checkout_started", orderId, paymentUrl });
						} else {
							log("");
							log("Open this URL to complete payment:");
							log(`  ${colors.cyan(paymentUrl)}`);
							log(`Order ID: ${colors.dim(orderId)}`);
							log(`Polling for confirmation (up to ${options.timeout}s)...`);
						}
					},
				});
				succeedSpinner("Upgrade processed.");
				const code = emitBillingResult(result, {
					label: `Database ${dbSummary.name} → ${targetPlan}`,
				});
				if (code !== ExitCode.SUCCESS) exit(code);
			} catch (err) {
				handleError(err);
			}
		});
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test:vitest __test__/db-tier-change.test.ts && bun run typecheck`
Expected: registration test PASSES; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/db.ts __test__/db-tier-change.test.ts
git commit -m "$(cat <<'EOF'
fix(cli): route db upgrade to purchaseDatabaseUpgrade (was ops-only endpoint)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Add the `db downgrade` command

**Files:**
- Modify: `src/commands/db.ts` — add a `db.command("downgrade")` block immediately after the `upgrade` block.
- Test: `__test__/db-tier-change.test.ts` — add a registration test.

**Interfaces:**
- Consumes: same helpers as Task 3 (`runDatabaseTierChange`, `assertPostgresTierChange`, `resolveDbTierTarget`, `emitBillingResult`).

- [ ] **Step 1: Write the failing test** — append to `__test__/db-tier-change.test.ts`:

```ts
describe("db downgrade command registration", () => {
	it("registers downgrade with --plan", () => {
		const cmd = dbSubcommand("downgrade");
		expect(cmd, "db downgrade should exist").toBeTruthy();
		const longs = cmd?.options.map((o) => o.long) ?? [];
		expect(longs).toContain("--plan");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:vitest __test__/db-tier-change.test.ts`
Expected: FAIL — `db downgrade` does not exist.

- [ ] **Step 3: Add the `db.command("downgrade")` block** immediately after the `upgrade` block:

```ts
	// ── Downgrade database ───────────────────────────────────────────────────────
	db.command("downgrade")
		.argument("<db>", "Database ID or name")
		.description("Downgrade a managed PostgreSQL database to a lower tier (applies immediately, no refund)")
		.option("--plan <plan>", "Target tier (starter, standard)")
		.action(async (dbIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				succeedSpinner();
				assertPostgresTierChange(dbSummary);
				const rawPlan =
					options.plan ||
					(await input("Target tier (starter, standard):", undefined, {
						field: "target_plan",
						flag: "--plan",
						context: { id: dbSummary.id, name: dbSummary.name, type: dbSummary.type },
					}));
				const targetPlan = resolveDbTierTarget("downgrade", rawPlan);

				// Interactive-only preview + confirm. Preview errors are swallowed —
				// the mutation enforces the same guards and surfaces the real message.
				if (!isJsonMode() && !isNonInteractiveMode() && !shouldSkipConfirmation()) {
					const _p = startSpinner("Checking downgrade...");
					try {
						await client.subscription.previewDatabaseDowngrade.query({
							postgresId: dbSummary.id,
							targetPlan,
						});
						succeedSpinner();
					} catch {
						failSpinner();
					}
					const confirmed = await confirm(
						`Downgrade "${dbSummary.name}" to ${targetPlan}? Applies immediately; no refund.`,
						false,
						{
							field: "confirm_db_downgrade",
							flag: "--yes",
							context: { id: dbSummary.id, name: dbSummary.name, targetPlan },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _d = startSpinner(`Downgrading ${dbSummary.name} to ${targetPlan}...`);
				const result = await runDatabaseTierChange(client, {
					direction: "downgrade",
					postgresId: dbSummary.id,
					targetPlan,
				});
				succeedSpinner("Downgrade processed.");
				const code = emitBillingResult(result, {
					label: `Database ${dbSummary.name} → ${targetPlan}`,
				});
				if (code !== ExitCode.SUCCESS) exit(code);
			} catch (err) {
				handleError(err);
			}
		});
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test:vitest __test__/db-tier-change.test.ts && bun run typecheck`
Expected: all db-tier-change tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/db.ts __test__/db-tier-change.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add db downgrade command (postgres, applies immediately)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: billing.ts — plan-direction classifier

**Files:**
- Modify: `src/commands/billing.ts` — add `CliError` to the `../lib/errors.js` import; add exported `planKeyOf` + `classifyPlanDirection` near the top-level helpers (after `reportBillingResult`, ~line 54).
- Test: `__test__/billing-downgrade.test.ts` (create)

**Interfaces:**
- Produces:
  - `planKeyOf(p: unknown): string` — reads `planKey || key || name`.
  - `classifyPlanDirection(plans: unknown[], currentPlanKey: string | null | undefined, targetPlanKey: string): "upgrade" | "same" | "downgrade"` — ranks by catalog `sortOrder`; treats missing/`free` as the lowest baseline; throws `CliError(INVALID_ARGUMENTS)` if the target is unknown.

- [ ] **Step 1: Write the failing test** — create `__test__/billing-downgrade.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyPlanDirection } from "../src/commands/billing";

const PLANS = [
	{ planKey: "free", sortOrder: 0, priceHalalas: 0 },
	{ planKey: "shared", sortOrder: 1, priceHalalas: 1900 },
	{ planKey: "dedicated_1", sortOrder: 2, priceHalalas: 9900 },
];

describe("classifyPlanDirection", () => {
	it("detects a downgrade (higher → lower)", () => {
		expect(classifyPlanDirection(PLANS, "dedicated_1", "shared")).toBe("downgrade");
	});
	it("detects an upgrade (lower → higher)", () => {
		expect(classifyPlanDirection(PLANS, "shared", "dedicated_1")).toBe("upgrade");
	});
	it("detects the same plan", () => {
		expect(classifyPlanDirection(PLANS, "shared", "shared")).toBe("same");
	});
	it("treats paid → free as a downgrade", () => {
		expect(classifyPlanDirection(PLANS, "shared", "free")).toBe("downgrade");
	});
	it("throws on an unknown target plan", () => {
		expect(() => classifyPlanDirection(PLANS, "shared", "bogus")).toThrow(/Unknown plan/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:vitest __test__/billing-downgrade.test.ts`
Expected: FAIL — `classifyPlanDirection` is not exported from `../src/commands/billing`.

- [ ] **Step 3: Add `CliError` to the errors import** in `src/commands/billing.ts`:

```ts
import { AuthError, CliError, handleError } from "../lib/errors.js";
```

- [ ] **Step 4: Add the helpers** after `reportBillingResult` (~line 54) in `src/commands/billing.ts`:

```ts
/** Read a plan's key across the catalog's field variants. */
export function planKeyOf(p: unknown): string {
	const o = p as { planKey?: string; key?: string; name?: string };
	return (o?.planKey || o?.key || o?.name || "").toString();
}

/**
 * Classify a target plan relative to the current one using catalog `sortOrder`.
 * Missing keys and `free` rank as the lowest baseline (-1). Throws on an unknown
 * target so `billing downgrade` fails loudly instead of guessing.
 */
export function classifyPlanDirection(
	plans: unknown[],
	currentPlanKey: string | null | undefined,
	targetPlanKey: string,
): "upgrade" | "same" | "downgrade" {
	const rankOf = (key: string | null | undefined): number | null => {
		const k = (key ?? "").toString();
		if (!k) return -1;
		const match = plans.find(
			(x) => planKeyOf(x).toLowerCase() === k.toLowerCase(),
		) as { sortOrder?: number } | undefined;
		if (match && typeof match.sortOrder === "number") return match.sortOrder;
		if (k.toLowerCase() === "free") return -1;
		return null;
	};
	const targetRank = rankOf(targetPlanKey);
	if (targetRank === null) {
		throw new CliError(
			`Unknown plan "${targetPlanKey}". Run \`tarout billing plans\` to see available plans.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	const currentRank = rankOf(currentPlanKey) ?? -1;
	if (targetRank > currentRank) return "upgrade";
	if (targetRank === currentRank) return "same";
	return "downgrade";
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `bun run test:vitest __test__/billing-downgrade.test.ts && bun run typecheck`
Expected: 5 assertions PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/billing.ts __test__/billing-downgrade.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add plan-direction classifier for billing downgrade

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Add the `billing downgrade` command

**Files:**
- Modify: `src/commands/billing.ts` — add a `billing.command("downgrade")` block immediately after the `upgrade` command block (after ~line 474).
- Test: `__test__/billing-downgrade.test.ts` — add a registration test.

**Interfaces:**
- Consumes: `classifyPlanDirection`, `planKeyOf` (Task 5); existing `performBillingChange`, `reportBillingResult`, `paymentBrowserOpener`, `parseBillingPeriod`, `select`, `confirm`.

- [ ] **Step 1: Write the failing test** — append to `__test__/billing-downgrade.test.ts`:

```ts
import { Command } from "commander";
import { registerBillingCommands } from "../src/commands/billing";

describe("billing downgrade command registration", () => {
	it("registers downgrade with --plan and --billing-period", () => {
		const program = new Command();
		program.exitOverride();
		registerBillingCommands(program);
		const billing = program.commands.find((c) => c.name() === "billing");
		const downgrade = billing?.commands.find((c) => c.name() === "downgrade");
		expect(downgrade, "billing downgrade should exist").toBeTruthy();
		const longs = downgrade?.options.map((o) => o.long) ?? [];
		expect(longs).toContain("--plan");
		expect(longs).toContain("--billing-period");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:vitest __test__/billing-downgrade.test.ts`
Expected: FAIL — `billing downgrade` does not exist.

- [ ] **Step 3: Add the `billing.command("downgrade")` block** immediately after the `upgrade` command block:

```ts
	// Downgrade to a lower plan (deferred to end of billing period)
	billing
		.command("downgrade")
		.argument("[plan]", "Plan key to downgrade to (alias: --plan)")
		.description("Downgrade to a lower subscription plan (applies at the end of the billing period)")
		.option("--plan <key>", "Plan key (alias for the positional argument)")
		.option(
			"--billing-period <period>",
			"Billing period: monthly or yearly",
			parseBillingPeriod,
		)
		.action(async (planArg, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching subscription...");
				const [subscription, catalog] = await Promise.all([
					client.subscription.getCurrent.query(),
					client.subscription.getCatalog.query(),
				]);
				succeedSpinner();
				if (!subscription || !subscription.planKey) {
					throw new CliError("No active subscription to downgrade.", ExitCode.INVALID_ARGUMENTS);
				}
				const plans: unknown[] = catalog?.plans || catalog || [];
				let targetPlan: string | undefined = planArg || options.plan;

				if (!targetPlan) {
					const lower = plans.filter((p) => {
						try {
							return (
								classifyPlanDirection(plans, subscription.planKey, planKeyOf(p)) === "downgrade"
							);
						} catch {
							return false;
						}
					});
					if (lower.length === 0) {
						log("You are already on the lowest plan.");
						return;
					}
					targetPlan = await select<string>(
						"Downgrade to:",
						lower.map((p) => {
							const price = (p as { priceHalalas?: number }).priceHalalas;
							return {
								name: `${planKeyOf(p)}${price ? ` (${(price / 100).toFixed(2)} SAR/mo)` : " (Free)"}`,
								value: planKeyOf(p),
							};
						}),
						{
							field: "plan",
							flag: "--plan",
							context: { current: subscription.planKey, available: lower.map((p) => planKeyOf(p)) },
						},
					);
				}
				if (!targetPlan) {
					throw new CliError("No plan selected.", ExitCode.INVALID_ARGUMENTS);
				}

				const direction = classifyPlanDirection(plans, subscription.planKey, targetPlan);
				if (direction === "same") {
					log(`Already on plan "${targetPlan}".`);
					return;
				}
				if (direction === "upgrade") {
					throw new CliError(
						`"${targetPlan}" is higher than your current plan "${subscription.planKey}". Use \`tarout billing upgrade ${targetPlan}\` to move up.`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Downgrade from "${subscription.planKey}" to "${targetPlan}"? Takes effect at the end of the current billing period; no refund for the remainder.`,
						false,
						{
							field: "confirm_downgrade",
							flag: "--yes",
							context: { from: subscription.planKey, to: targetPlan },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _c = startSpinner("Scheduling downgrade...");
				const result = await performBillingChange(client, {
					kind: "plan",
					planKey: targetPlan,
					billingPeriod: options.billingPeriod,
				});
				succeedSpinner("Downgrade processed.");
				reportBillingResult(result, `Plan: ${targetPlan}`);
			} catch (err) {
				handleError(err);
			}
		});
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun run test:vitest __test__/billing-downgrade.test.ts && bun run typecheck`
Expected: registration test PASSES; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/billing.ts __test__/billing-downgrade.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add billing downgrade command (deferred to period end)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `bun run test:vitest && bun test`
Expected: vitest ≥ 146 + new tests, all PASS; bun 50 PASS. 0 failures.

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no type errors; biome clean. If biome flags formatting, run `bun run lint --write` (or `biome check --write src/`) and re-run.

- [ ] **Step 3: Smoke-check the command tree builds**

Run: `bun run build`
Expected: tsup build succeeds (no unresolved imports).

- [ ] **Step 4: Manual sanity (optional, requires a logged-in session)**

`tarout db upgrade <mysql-db> --plan pro` → clear "PostgreSQL only" error, exit 2, no mutation.
`tarout billing downgrade <higher-plan>` → error pointing to `tarout billing upgrade`.

- [ ] **Step 5: Final commit if lint applied changes**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(cli): lint/format pass for db+plan up/down commands

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Self-Review (completed during planning)

- **Spec coverage:** fix `db upgrade` → T3; `db downgrade` → T4; `billing downgrade` → T6; `"database"` kind → T1; postgres-only guard → T2 (+used in T3/T4); MySQL rejection tested → T2; plan-direction guard → T5/T6; preview interactive-only → T3/T4; app unchanged → noted. All spec sections mapped.
- **Placeholders:** none — every code/test step has complete code and exact run commands.
- **Type consistency:** `runDatabaseTierChange` input/`DatabaseTierChangeInput`, `targetPlan: "STARTER"|"STANDARD"|"PRO"`, `classifyPlanDirection` return union, and `emitBillingResult`/`finalizeBillingMutation` signatures are consistent across T1–T6. `registerDbCommands`/`registerBillingCommands` match existing exports.

