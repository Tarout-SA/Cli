# CLI db / plan upgrade + downgrade — design

Date: 2026-07-02
Branch: `feat/cli-db-plan-downgrade-upgrade`
Status: approved design, pre-implementation

## Problem

The CLI's tier-change surface is inconsistent and partly broken:

- **`db upgrade`** calls `client.postgres.upgrade` — a `rootAdminProcedure` (ops-only,
  auto-excluded from the REST/MCP/CLI surface via its `meta.rootAdmin` marker). Real
  (non-root) customers cannot invoke it, so the command fails today. The server code
  comment is explicit: *"Customers MUST upgrade via `subscription.purchaseDatabaseUpgrade`."*
- **`db downgrade`** does not exist.
- **`billing downgrade`** does not exist. The only downgrade path is `billing cancel`
  (which drops to free at period end); there is no way to move to a *cheaper paid* plan.

Meanwhile the server already exposes the correct customer-facing procedures. This work
routes the CLI to them and fills the two missing downgrade commands.

## Goals

- Fix `db upgrade` to use the customer-facing, billed endpoint.
- Add `db downgrade`.
- Add `billing downgrade <plan>`.
- Consistent UX, flags, agent envelopes, and exit codes with the existing `billing upgrade`.

## Non-goals (agreed scope: CLI-only, Postgres-only, fill gaps)

- **No `platform/` server changes.** We only consume existing tRPC procedures.
- **MySQL tier changes are out of scope** — the server has no customer-facing MySQL
  tier-change API (only an ops-only `mysql.upgrade`). MySQL databases get a clear
  "not supported yet" error, not a new endpoint.
- **App is left unchanged.** `apps change-plan` is already bidirectional
  (`FREE`/`SHARED`/`DEDICATED`, downgrades always allowed, upgrade-to-`DEDICATED` gated
  server-side). No new `apps upgrade`/`apps downgrade` command.
- No new `plan` noun; plan changes stay under `billing`.

## Server API facts (verified, `platform/src/server/api/routers/subscription.ts`)

All four DB procedures are `subscriptionOwnerProcedure` (on the CLI surface) and are
**Postgres-only** (`postgresId` input, no MySQL variant). Subscription/plan changes are
**per-project** scope (derived from `ctx.session.activeProjectId`; no project/org id in input).

| Procedure | Kind | Input | Returns |
|---|---|---|---|
| `subscription.previewDatabaseUpgrade` | query | `{ postgresId, targetPlan: STARTER\|STANDARD\|PRO }` | `{ willApplyImmediately, effectiveAt, prorated… }` |
| `subscription.purchaseDatabaseUpgrade` | mutation | `{ postgresId, targetPlan: STARTER\|STANDARD\|PRO }` | `billAndApplySubscriptionAction(...)` → `{applied}` \| `{paymentUrl, orderId, proratedChargeHalalas}` |
| `subscription.previewDatabaseDowngrade` | query | `{ postgresId, targetPlan: STARTER\|STANDARD }` | `{ willApplyImmediately: true, effectiveAt: now }` |
| `subscription.purchaseDatabaseDowngrade` | mutation | `{ postgresId, targetPlan: STARTER\|STANDARD }` | `billAndApplySubscriptionAction({... proratedChargeHalalas: 0})` → `{applied: true}` |
| `subscription.changePlan` | mutation | `{ planKey, planQuantity?, billingPeriod?, addons? }` | upgrade → `{applied}`/checkout; downgrade → `{ applied:false, effectiveAt: periodEnd, pendingPlanKey }` |

Key server behaviors:

- **DB upgrade**: rejects a non-higher `targetPlan` (`BAD_REQUEST` "Target plan must be
  higher"); requires an active subscription (`FORBIDDEN`); charges the prorated diff —
  returns a hosted-checkout `paymentUrl` when a balance is due, otherwise applies.
- **DB downgrade**: always free, applies immediately. Hard guards (all `BAD_REQUEST`):
  managed-SQL only; live DB size must fit the target tier's storage cap; linked-app count
  must be ≤ target's `maxLinkedApplications`; rejects if it would raise the recurring bill;
  rejects a non-lower `targetPlan`.
- **Plan downgrade** (`changePlan` to a lower `sortOrder`): deferred to period end
  (stored as `pendingPlanKey`), no charge, no refund. Guard: can't shrink a shared plan
  below the current shared-app count.
- **DB tiers**: `FREE`, `STARTER` (10 GB), `STANDARD` (10 GB), `PRO` (20 GB). Downgrade
  target enum excludes `PRO` by design (you can't "downgrade to" the top tier).

## Approach: reuse the billing engine

All three commands funnel through the existing, unit-tested engine in
`src/lib/billing-upgrade.ts`:

- `finalizeBillingMutation(client, result, ctx)` classifies any subscription-mutation
  result into `applied` | `deferred` | `payment_required` | `paid` | `pending_timeout` |
  `failed` | `expired`. The DB procedures return the same
  `{applied}` / `{paymentUrl, orderId, proratedChargeHalalas}` / deferred shape it already
  understands (both go through the shared `billAndApplySubscriptionAction` server helper).
- `emitBillingResult(result, {label})` renders the human box + one-line agent envelope and
  returns the exit code. It already handles the `applied` ("applied immediately"),
  `deferred` ("staged for end of billing period"), and checkout cases.
- `pollCheckoutUntilTerminal` powers `--wait`.

**One engine change:** add `"database"` to the `BillingChangeKind` union
(`"plan" | "addon" | "plan_quantity" | "database"`) so DB-change JSON envelopes carry an
accurate `kind`. Box titles are status-driven (not kind-driven), so they remain correct;
this is purely for envelope accuracy. `resolveTarget()` gets a `database` branch (returns
the target tier). No other engine logic changes.

Rejected alternative: bespoke per-command flows. That duplication is exactly the
"divergence across deployment flows" the single engine was built to eliminate.

## Command designs

### 1. `db upgrade <db> [--plan <tier>]` — fix

- Resolve DB via existing `getAllDatabases` + `findDatabase`.
- **Postgres-only guard**: if `db.type !== "postgres"`, emit a clear
  `NOT_SUPPORTED`-style error ("Database tier changes are available for PostgreSQL only;
  MySQL tier changes aren't supported yet.") and a non-zero exit. Shared helper
  `assertPostgresTierChange(db)`.
- Resolve `targetPlan`: from `--plan` or interactive/agent `input()` (`NEEDS_INPUT`).
  Normalize to uppercase; validate ∈ `{STARTER, STANDARD, PRO}`.
- **Interactive mode only** (not `--json`, not `--yes`/non-interactive): call
  `previewDatabaseUpgrade` to show the prorated charge, then confirm. Agent/JSON/`--yes`
  callers skip the preview and go straight to the mutation (fewer round-trips,
  deterministic); server errors still surface normally.
- Mutate `subscription.purchaseDatabaseUpgrade.mutate({ postgresId, targetPlan })`.
- `finalizeBillingMutation(client, result, { kind: "database", target: targetPlan, wait,
  timeoutMs, openBrowser, onCheckoutOpened })` → `emitBillingResult`.
- Flags identical to `billing upgrade`: `--wait/--no-wait` (default wait), `--timeout`,
  `--no-open`, `--json`, `--yes`.
- Server `BAD_REQUEST`/`FORBIDDEN` (e.g. "must be higher", "active subscription required")
  surface via the standard `handleError`.

### 2. `db downgrade <db> [--plan <tier>]` — new

- Same resolution + Postgres-only guard.
- Resolve `targetPlan`; validate ∈ `{STARTER, STANDARD}` (reject `PRO` with a hint that
  PRO is the top tier / use `db upgrade`).
- **Interactive mode only**: call `previewDatabaseDowngrade` to confirm "applies
  immediately, free" and let guard violations (storage doesn't fit, too many linked
  apps, would raise the bill) surface *before* mutating; then confirm (it sheds
  resources). Agent/JSON/`--yes` callers go straight to the mutation — the same guards
  are enforced server-side and surface via `handleError`.
- Mutate `subscription.purchaseDatabaseDowngrade.mutate({ postgresId, targetPlan })` →
  `{applied:true}` → `finalizeBillingMutation` (`kind: "database"`) → `emitBillingResult`
  → "applied immediately".
- No checkout/wait flags needed (always net-zero), but `--json`/`--yes` supported.

### 3. `billing downgrade <plan>` — new

- Fetch current subscription status + `subscription.getCatalog` to determine the current
  plan and compare `sortOrder`.
- Resolve target `planKey` (positional or `--plan`; the interactive picker lists only
  plans strictly lower than the current one). Validate **strictly lower**:
  - equal → "Already on <plan>." (no-op, exit 0)
  - higher → error pointing to `tarout billing upgrade <plan>`.
- Reuse `performBillingChange({ kind: "plan", planKey, billingPeriod?, wait, timeoutMs,
  openBrowser, onCheckoutOpened })`. **No addon estimator** (downgrades shed resources,
  never bundle paid addons).
- Downgrade returns deferred → `emitBillingResult` → "Plan change staged: applies at the
  end of the current billing period" (no charge, no refund).
- `billing downgrade free` is allowed (goes through the same `changePlan` deferred path).
  `billing cancel` stays as-is (distinct `cancelAtPeriodEnd` semantics).
- Server guard (can't shrink shared plan below current shared-app count) surfaces via
  `handleError`.
- Flags: `--plan`, `--billing-period`, `--json`, `--yes`. Downgrades apply at period end
  with no checkout, so `--wait/--timeout/--no-open` are accepted for symmetry with
  `billing upgrade` but are no-ops on the deferred path.

## Error handling summary

- **MySQL** → clear "PostgreSQL only" error, non-zero exit, before any mutation.
- **Wrong direction** → `db upgrade`/`db downgrade` validate the tier enum; `billing
  downgrade` validates `sortOrder` and points to the opposite command.
- **Server guards** (storage fit, linked apps, bill increase, shared-app count, active
  subscription) → surfaced through the existing `handleError` path with the server's
  `BAD_REQUEST`/`FORBIDDEN` message.

## Testing plan

Unit tests with a scripted fake tRPC client (the `billing-upgrade` / `reuse-upgrade`
test pattern under `__test__/`). No network. Cases:

1. `db upgrade` on a MySQL db → rejected with the not-supported error, no mutation call.
2. `db upgrade` (postgres) with a balance due → `purchaseDatabaseUpgrade` returns
   `{paymentUrl, orderId}` → result classified `payment_required`/`paid` (with `--wait`).
3. `db upgrade` (postgres) net-zero → `{applied:true}` → `applied`.
4. `db downgrade` (postgres) → preview then `purchaseDatabaseDowngrade` `{applied:true}`
   → `applied immediately`; MySQL → rejected.
5. `db downgrade` invalid target (`PRO`) → validation error, no mutation.
6. `billing downgrade` to a lower plan → `changePlan` deferred result → `deferred`
   ("staged for period end").
7. `billing downgrade` to a higher/equal plan → direction guard error, no mutation.
8. `BillingChangeKind` "database" round-trips through `emitBillingResult` envelope.

Full baseline before/after: `bun run test:vitest` (146) + `bun test` (50) = 196 green,
plus the new cases. `bun run typecheck` and `bun run lint` clean.

## Logistics

- Work lands in the git worktree `/home/stanoid/tarout/cli-db-plan-downgrade`
  (branch `feat/cli-db-plan-downgrade-upgrade`, off `main`) — not edited directly in
  `cli/`, whose working tree is reset by concurrent sessions / PR merges.
- Touched files: `src/commands/db.ts` (fix upgrade, add downgrade), `src/commands/billing.ts`
  (add downgrade), `src/lib/billing-upgrade.ts` (add `"database"` kind), new tests under
  `__test__/`.
