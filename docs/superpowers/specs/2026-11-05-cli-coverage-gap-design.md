# CLI coverage gap — audit and remediation plan

Date: 2026-11-05
Status: **implemented 2026-11-06** on `feat/cli-coverage-all`. All five phases
landed; 104 uncovered procedures went to 0 unexplained. See "Outcome" at the
foot of this document.
Scope: `@tarout/cli` (this repo) against `platform` tRPC surface at `cc96feb1`

## Intent

The CLI has drifted behind the platform. Features shipped on the web app and on
the tRPC API have no CLI counterpart, so an operator or an agent driving Tarout
headlessly cannot reach them. This document establishes exactly what is missing,
what is deliberately absent, and the order in which to close the gap.

## Method

The customer-facing API surface is not "every tRPC procedure". `platform/src/server/api/surface-scope.ts`
is the single source of truth: it excludes whole platform-ops routers
(`EXCLUDED_ROUTERS`) and individual procedures (`EXCLUDED_PROCEDURES`), and
auto-excludes anything marked `rootAdminProcedure` or typed as a subscription.

Coverage was computed as: every procedure in `root.ts`, minus the surface-scope
exclusions, minus every procedure reached by a real `client.<router>.<proc>.query|mutate`
call site anywhere in `src/`. String-literal mentions in help text were counted
separately so a doc reference could not masquerade as coverage (only 6 such
cases existed, none material).

Result: **772 procedures total, 350 of them platform-ops or otherwise out of
scope, and 104 in-scope procedures with no CLI command.**

### A note on the starting state

The local `cli/` checkout used to begin this audit was **37 commits behind
`origin/main`** — it reported version `1.8.0` while npm had `1.15.2` and
`origin/main` was `1.16.0`. A first pass against that tree produced a gap list
that was substantially wrong: `referral`, `approvals`, `template`, `exec` and
`ai-ocr` command groups had already landed upstream. Every number in this
document was recomputed in a clean worktree off `origin/main`.

The practical lesson belongs in the plan: **the first fix is syncing the local
checkout**, and any future coverage check must state which commit it ran against.
There are also unmerged upstream branches (`feat/platform-import`,
`feat/ai-services-1.17.0`, `feat/ocr-region`, `fix/bigint-json-output`) whose
contents must be rechecked before building anything adjacent to them.

## Goals

- Every reachable, customer-facing platform capability has a curated CLI command.
- An AI agent driving the CLI can observe and manage what it is doing without a browser.
- Coverage drift becomes detectable instead of accumulating silently.

## Non-goals

- Admin and platform-ops routers (`admin`, `adminInfraCost`, `adminNeed`,
  `adminOcr`, `adminPromoCode`, `adminReferral`, `evacuation`, `platformConfig`,
  `queues`). These are excluded by design; `queues` already ships as a
  deliberately-neutralized group with a clear refusal message, which is the
  correct pattern.
- Browser-only plumbing: `user.getUserByToken` (public, pre-signin invitation
  page, IP rate-limited), `user.generateToken`, `github.createSetupState` (the
  GitHub App install redirect handshake). These are not user capabilities.
- `dashboard.agentActivityStream` — a tRPC **subscription**. The CLI's HTTP
  client cannot consume it and surface-scope already auto-excludes subscriptions.
  The pollable `getAgentDigest` / `getRecentActivity` cover the same need.
- `domainRegistrar.updateNameservers` — see "Deliberately not shipping" below.

## Anti-goals

What would make this a failure even if every command existed:

- Shipping commands that always throw. `tarout email` is the live example: all
  19 of its uncovered procedures sit behind `EMAIL_SERVICE_COMING_SOON = true`
  in `platform/src/lib/feature-flags.ts`, which refuses every non-root-admin
  caller with `PRECONDITION_FAILED`. Building 24 email subcommands today ships a
  command group that is broken for 100% of real users.
- Letting an agent loosen its own guardrails. `agentPolicy.create`, `.delete`
  and `.setActionMode` are excluded from the surface precisely so an agent
  cannot rewrite the rules that constrain it. The CLI must expose the
  **read** side only.
- Exposing a nameserver-delegation path. See below.

## Deliberately not shipping

**`domainRegistrar.updateNameservers`.** The service chain is fully wired
(router → `updateDomainNameservers` → `DnetClient.updateNameservers` → DB write)
and the dashboard uses it, so it is not half-finished. But it is deliberately
un-surfaced, and there is a contract test —
`platform/__test__/contract/trpc-rest-mcp-parity.test.ts` — asserting that *"does
not expose a customer nameserver path on tRPC, REST, or MCP"* for three sibling
names. Delegating a zone away from Tarout's Cloudflare zone dark-breaks managed
DNS, linked-app routing and Universal SSL, and no reverse command exists. A
stricter implementation in `dns-management.ts` that only permits re-applying the
domain's *own* nameservers is dead code with no importer — and is the only one
with tests.

Recommendation: do not add a free-form `tarout domains nameservers <ns1> <ns2>`.
If this is ever wanted, it should be a `--reset-to-tarout` form only. Flag to the
platform team that the live procedure is reachable on REST/MCP while its three
siblings are test-guarded against exactly that.

## Findings by cluster

Counts are reachable, in-scope, uncovered procedures.

| Cluster | Count | Reachable | Verdict |
|---|---|---|---|
| `email` | 19 | **No** — `EMAIL_SERVICE_COMING_SOON = true` | Build last, or behind the flag |
| `subscription` | 13 | Yes | High value — ops recovery |
| `domainRegistrar` | 7 (of 8, minus nameservers) | Yes, `DNET_BILLABLE_ENABLED` dependent | Saudi domain flow is the prize |
| `agentWebhook` | 7 | Yes | Highest-value clean build |
| `serverSoftware` | 6 | Yes | Clean build |
| `machineAlert` | 5 | Yes | Clean build |
| `gitea` | 5 | Yes | Documented promise, unkept |
| `dashboard` | 5 (of 6, minus subscription) | Yes | Agent observability |
| `storage` / `postgres` / `application` / `project` / misc | ~30 | Mixed | Long tail, fill in place |

### Email is built but not launched

All 22 procedures call `assertEmailServiceLaunched`. The service auto-provisions
on first touch, runs in sandbox (100/day, recipients must be org members) until
the first verified domain flips it off (1000/day). A sending domain must be a
subdomain of an org-owned registered domain with a Cloudflare zone. Three
procedures return one-time secrets (`createApiKey`, `createWebhook`,
`rotateWebhookSecret`) — excluded from REST/MCP but legitimately callable from
curated CLI commands over the native transport, exactly as `tarout account
api-keys create` already does.

The full 24-command tree is designed and ready to build (see Phase 5). It is
sequenced last **only** because of the flag.

Two platform bugs found in passing, worth filing regardless of the CLI:
`listSuppressions` is hard-capped at 500 rows with no cursor or filter, so an
address past that cap cannot be removed by name; and `removeSuppression` takes a
`suppressionId` rather than the address a human actually has.

### `subscription` — the ops-recovery cluster

Thirteen uncovered procedures, two of which are multi-step flows:

- **shared→dedicated app migration**: `getMigratableSharedApps` → `migrateSharedAppsToDedicated`
  → `getActiveMigration` (`copying` → `ready_to_cutover`) → `completeSharedToDedicatedCutover`
  or `rollbackSharedToDedicatedCutover`. Safely CLI-drivable: every mutation
  takes no input, is server-gated and idempotent, and no money moves. Note the
  normal path is an automatic cutover from the queue; the manual mutation is the
  retry/fallback. Also note `COPIED` rows are never aged out, so a poller can
  legitimately see a months-old `ready_to_cutover`.
- **billing period change**: `previewBillingPeriodChange` → `changeBillingPeriod`.
  Both share one charge computation, so the previewed amount is the charged
  amount, and both reject on the same three conditions — a preview can never
  render for a change that would then fail. yearly→monthly schedules
  (undo via the existing `plan:cancel-pending`); monthly→yearly charges today and
  returns a hosted payment URL, which is the existing `billing upgrade` shape.

**`retryRenewal` is the single highest-value procedure in this audit.** It
charges an already-owed renewal against the saved card under a Postgres advisory
lock with a deterministic `given_id`, so it cannot double-charge and cannot pick
its own amount. It refuses unless the subscription is `PAST_DUE` or `PAUSED`, and
returns `{status:"no_card"}` early when there is nothing to charge. This repo's
own history includes a renewal failing on insufficient funds three times and
being recovered by hand-written SQL; this is the supported lever for exactly that,
and today it has no CLI path.

It must ship with a mandatory confirmation and must **not** reuse
`shouldAutoConfirmPaidCheckout` — that helper exists because a hosted browser
page collects consent, and here nothing does.

### `machineAlert` is a real customer surface

`machineAlert.list` is plain `protectedProcedure`, filters on
`organizationId`, and joins both `server` (VM) and `coolifyServer` (dedicated
host) relations. The 2026-09-29 work that made ops incidents platform-only
suppressed **email notification**, not the alert records — so customers with VMs
or dedicated hosts do have rows here. This is distinct from the existing `tarout
servers alerts` commands, which call `virtualMachine.listAlertConfigs` and manage
alert *configuration*; `machineAlert` is the fired-alert instances you
acknowledge, resolve and mute. Both belong in the CLI.

### `gitea` — a documented promise the CLI does not keep

`surface-scope.ts` retires Gitea as a provider by excluding only `gitea.create`
and `gitea.update`, and states the read procedures stay exposed *"so an org with
a live connection can still inspect it from the CLI and MCP, and so its deploys
keep working."* `src/commands/providers.ts` has `github`, `gitlab` and
`bitbucket` subgroups and no `gitea` subgroup. The bitbucket subgroup — which is
retired on identical terms and *does* exist — is the exact template. `tarout call
gitea.giteaProviders` is a technically-adequate fallback but is not what the
platform documents.

### Corrections to the raw diff

Three procedures the mechanical diff flagged are effectively covered already, and
should not be built as new commands:

- `application.screenshot` — `tarout apps screenshot` exists and calls
  `application.refreshScreenshot`.
- `postgres.getTableData` — `tarout db tables` and `tarout db preview` cover this
  via `listTables` / `previewTable`.
- `virtualMachine.cancelSubscription` — a `servers cancel-vm-subscription`
  command existed in the stale local tree but is absent from `origin/main`;
  confirm intent before re-adding.

Two more are maintenance plumbing, not user capabilities, and should be skipped
unless an operator asks: `postgres.backfillExternalAccess` and
`storage.releaseStorageSlot`.

## Plan

Phases are ordered by value-per-risk. Each is independently shippable and ends
with `bun run test` (note: bare `bun test` is a no-op in this repo) plus
`typecheck` and `lint` green.

**Phase 0 — sync and instrument.** Fast-forward the local checkout to
`origin/main`. Then add a coverage test that recomputes this diff from
`settings.getSurfaceManifest` and fails when an in-scope procedure has neither a
curated command nor an explicit, reasoned entry in a new `KNOWN_UNCOVERED` map —
the same belt-and-braces shape `surface-scope.ts` uses. Without this, the gap
silently reopens. This phase is the actual fix for "the CLI has not been updated
for a while".

**Phase 1 — agent governance and observability.** `agentWebhook` (7),
`agentPolicy` read-only (2), `approvals.pendingSummary`,
`settings.getAgentToolCatalog`, `dashboard` (5). Highest value because the CLI's
own audience is agents, and because none of it is destructive or spends money.
Mutations that would let an agent widen its own permissions stay out.

**Phase 2 — ops recovery.** `billing retry-renewal` (mandatory `--yes`),
`billing standing` / `summary` / `discount` / `cancel-checkout` / `order`,
`billing period preview|set`, `billing migrate:*` (5), `wallet status` /
`wallet cancel`. Directly serves the renewal-failure and dunning scenarios this
repo has hit in production.

**Phase 3 — infrastructure.** `serverSoftware` (6) as a `servers software`
subgroup, `machineAlert` (5) as a `servers incidents` subgroup (named distinctly
from the existing `servers alerts` config commands),
`server.retryDedicatedProvisioning`, `virtualMachine.getGlobalGpuCatalog`.

**Phase 4 — gaps in existing groups.** `gitea` subgroup in `providers` (mirror
bitbucket), `domains saudi` subgroup + `domains cert` / `can-connect` /
`renew-quote` / `cancel-payment` / `apex-mode`, `domains app delete`
(`domain.delete` — today no CLI path deletes an app-domain host row; the command
named `domains delete` covers a different resource and hard-stops on purchased
domains), `destinations create-native`, `projects autofix` on/off/runs, plus the
storage/postgres/env/inbox/ai long tail.

**Phase 5 — Tarout Email.** The full 24-command `tarout email` group. Gated on
`EMAIL_SERVICE_COMING_SOON` flipping to `false`. If it must land earlier, ship it
with a preflight that turns the server's `PRECONDITION_FAILED` into a clear
"Tarout Email has not launched yet" message rather than a raw error.

## Constraints

- House style is fixed and must be matched, not reinvented: commander
  subcommands, `isLoggedIn()` guard, `startSpinner`/`succeedSpinner`,
  `isJsonMode() → outputData()` before any human rendering, `table()` for lists,
  `quietOutput()` for scripting, `confirm()`/`--yes` on destructive paths, and
  `handleError(err)` in every catch. One-time secrets render in a `box()` with a
  save-this warning and must never go through `quietOutput`.
- Identifier resolution follows the `findBucket` pattern in `storage.ts`: exact
  id → exact name (case-insensitive) → unique id prefix, refusing ambiguity by
  listing candidates.
- This repo is worked by concurrent sessions and local merges; uncommitted edits
  in the shared `cli/` tree get wiped. All work lands in a git worktree on a
  feature branch and is committed there.
- `listLogs` (email) is the only cursor-paginated procedure in the set and the
  CLI has no `--cursor` precedent. Prefer `--all` looping over `nextCursor`.

## Left to the builder

- Whether `machineAlert` lives at `servers incidents` or a top-level `tarout
  incidents`. Recommendation: `servers incidents`, to keep it next to the
  existing alert-config commands and make the distinction visible in `--help`.
- Exact MCP tool selection. The MCP server exposes a curated subset plus a
  `tarout_call` escape hatch, so new commands do not automatically need tools.
  Recommendation: add tools only for Phase 1 (agent-facing by definition) and
  `billing retry-renewal`.
- Arabic strings, if any command surfaces user-facing prose beyond labels.

## Outcome (2026-11-06)

All five phases shipped. Of 470 in-scope procedures, every one is now either
reached by a command or carries a stated reason in
`src/lib/coverage-exceptions.ts` — 104 unexplained gaps went to 0.

New command groups: `tarout email` (22 subcommands), `tarout agent-webhooks`,
`tarout agent-policies`. New subgroups: `servers software`, `servers
incidents`, `providers gitea`, `domains saudi`, `billing migrate:*`. Plus ~40
subcommands filled into existing groups.

Tests went 1184 → 1506 (111 → 121 files); `bun test` 101 pass; typecheck and
`biome check src/` both clean, with zero new lint findings (the three in
touched files pre-exist upstream at shifted line numbers).

### Decisions taken during implementation

- **15 procedures are deliberately uncovered**, each with a reason in
  `coverage-exceptions.ts`: two tRPC subscriptions the transport cannot
  consume, two browser-only handshakes, three procedures that always throw
  (including a `user.generateToken` tombstone), two platform-ops repair jobs,
  four covered by a deliberately different command, one static-analysis false
  negative, and `updateNameservers` withheld as described above.
- **`servers incidents`** was chosen over a top-level `tarout incidents` so
  fired alerts sit beside the pre-existing `servers alerts` threshold config.
  Both groups' help text now points at the other, because "acknowledge a
  firing alert" and "edit a threshold" were otherwise easy to confuse.
- **`db rotate-password`** exits non-zero when it cannot re-sync an attached
  app. Rotation updates linked apps best-effort and swallows per-app failures,
  so a clean exit would have been a lie.
- **`env apply`** (replace semantics) is kept verbally distinct from the
  pre-existing `env push` (merge), and refuses an empty document rather than
  silently wiping every variable.
- **`destinations create-native`** is a sibling command, not a flag on
  `create`: `--bucket` there already means "bucket name at the external
  provider", and a flag that silently turns five required flags optional
  cannot be expressed in `--help`.

### The regression guard

`__test__/surface-coverage.test.ts` is the part that matters for drift. It
checks a committed snapshot of the surface
(`__test__/fixtures/platform-surface.json`, refreshed by
`scripts/refresh-surface-snapshot.mjs`) and fails when a procedure has neither
a command nor a reason, when an exception goes stale, or when a reason is empty
or says "not implemented yet". It was verified to fail on a seeded gap, not
just to pass today.

Snapshot refresh is deliberately manual: the gap is only invisible while nobody
regenerates the file, so regenerating it is the act that surfaces new drift. A
CI step that refreshes and fails on a diff would close that loop.

### Platform bugs found while reading the routers

Not fixed here — this branch only touches the CLI. Worth filing:

- `subscription.retryRenewal`'s precondition is stricter than the charger it
  guards: it demands an initial transaction id, while
  `chargeSubscriptionRenewal` can charge off a default payment method alone. A
  portal-added card on a subscription with no initial transaction returns
  `no_card` despite being chargeable.
- `subscription.getStanding` reads `ctx.session.activeProjectId` directly
  instead of going through the project-scope helper, so an API key scoped to
  one project can read another's standing.
- `email.listSuppressions` is capped at 500 rows with no cursor or address
  filter, and `removeSuppression` takes an id rather than an address — so an
  address past the cap cannot be removed by name.
- `domainRegistrar.getRenewalQuote` omits a `years` input and so always quotes
  one year; a multi-year renewal cannot be pre-quoted.
- `payment.getCheckoutOrder` returns FORBIDDEN ("different project") where it
  means NOT_FOUND, when a `sub_` order has no resolvable subscription.
- `subscription.getActiveMigration.stage` hides failures in a mixed batch:
  `copied > 0` wins over `failed > 0`, so failures show only in `counts`.
- `serverSoftware.list/status/logs` skip the `assertCloudServersLaunched` guard
  that `install/update/uninstall` apply — harmless while the flag is false,
  but asymmetric.
- The hidden `taroutCore` server-software addon cannot install at all (its
  bootstrap clones a non-public repo), and rows persisted under the legacy
  `"Tarout Core"` literal read as not-installed, needing a data migration that
  was never written.
