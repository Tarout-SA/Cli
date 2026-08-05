# CLI Account-Only Authorization — Design

**Date:** 2026-08-03
**Status:** Approved (pending implementation)
**Scope:** `cli/` and `platform/` (spec canonical here; platform changes described below)

## Problem

`tarout login` currently forces the user to pick a project in the browser
(`/cli-authorize`) and mints a **project-scoped** API key (project id baked into
key metadata, immutable). Consequences:

- Switching projects requires a full browser re-login; `tarout projects use` is
  effectively a no-op for API-key sessions (long-standing bug).
- `tarout projects create` exists but is undermined by the pinned key scope.
- With per-project billing, a stale pinned project silently bills the wrong
  project.

## Goal

Login authorizes the **account + organization only**. Project selection and
creation happen afterwards through CLI commands. No regression for any existing
CLI feature or already-issued key.

## Decisions

1. **Key scope:** org-scoped key (metadata `{ organizationId }`, no
   `projectId`). Browser auth confirms account + org; no project picker.
2. **Active project transport:** per-request header `x-tarout-project`
   (Approach A). Rejected: mutable server-side active project (race between
   concurrent sessions sharing a key); explicit `projectId` input on every
   procedure (massive churn).
3. **Post-login UX:** interactive picker on first project-requiring command
   (TTY); clear actionable error in non-TTY/CI.

## Design

### Platform

- **`/cli-authorize` page** (`platform/src/pages/cli-auth.tsx`): remove the
  project `Select` (~lines 230–262). Show account + organization confirmation
  and Authorize button only.
- **`user.createCliSession`** (`platform/src/server/api/routers/user.ts:1423`):
  drop the `projectId` input requirement; issue the key with metadata
  `{ organizationId }` only (org-wide keys are already a valid metadata shape).
- **`/api/cli/exchange`**: same response shape; `projectId` / `projectName` /
  `projectSlug` absent for new logins.

### Server-side project-scope resolution (`platform/src/server/lib/auth.ts`)

In the API-key session path, resolve `session.projectScopeId` as follows:

**Blocking discovery — the legacy back-fill.** `validateRequest()` today *auto-pins*
any key whose metadata lacks a `projectId`: it derives the default/oldest project
and **persists it into `apikey.metadata`** (`platform/src/server/lib/auth.ts:1414-1424`),
precisely so legacy org-only keys can't drift. Left alone, the very first request
from a new org key would re-pin it and restore the old behavior. An org key is
therefore not merely "a key without `projectId`" — it needs an explicit marker.

**Discriminator:** new keys are minted with metadata
`{ organizationId, accountScoped: true }` and **no** `projectId`. The back-fill at
auth.ts:1414 is skipped when `accountScoped === true`; every other key keeps
today's behavior byte-for-byte.

| Key metadata | `x-tarout-project` header | Result |
|---|---|---|
| `projectId` set (legacy pinned) | absent | pinned project (today's behavior, unchanged) |
| `projectId` set | matches pin | pinned project |
| `projectId` set | differs from pin | **403** — "key is pinned to project X; re-login to switch" |
| `accountScoped` | valid project **in the key's org** | header project becomes `projectScopeId` |
| `accountScoped` | nonexistent or cross-org project | **403** with project id in message |
| `accountScoped` | absent | `projectScopeId` unset; `getApiKeyProjectScope()` (auth.ts:984) throws only when a project-scoped procedure needs it: "No project selected — run `tarout projects use` or pass `--project`" |
| neither (legacy org-only) | any | back-fill runs exactly as today |

`accountScoped` keys must **not** be rejected by the "org has no project" guard
(auth.ts:1401-1412) — an account key authenticating against a zero-project org is
valid; it simply has no scope until one is selected. That guard stays for
non-account keys.

**Authorization intent:** `CliAuthorizationIntent.projectId` becomes optional
(`platform/src/server/services/cli-authorization.ts:178, 192-237`) and the exchange
endpoint (`platform/src/pages/api/cli/exchange.ts:101-155`) stops requiring a
project row. Intents live 5 minutes, so in-flight v2 records still parse — no
version bump needed.

**Security invariant:** header project MUST belong to the key's organization —
validated before setting scope (prevents cross-org access). Billing/entitlement
resolution uses the resolved scope, so per-project billing lands on the project
the user actually selected.

Org-level procedures (`projects list/create/update/delete`, org billing views)
do not call `assertApiKeyProjectScope` and work with no project set. All
existing per-router `assertApiKeyProjectScope()` call sites remain unchanged.

### CLI

**Existing architecture to compose with (do not rework):**

- A central auth gate already runs in the `preAction` hook
  (`cli/src/index.ts:121-194`): `commandRequiresAuth()` + `AUTH_EXEMPT_LEAF`
  auto-recover a logged-out invocation via `ensureAuthenticated()`
  (`cli/src/commands/deploy.ts:331`). Project resolution mirrors this exact
  pattern in the same hook, immediately after it.

**Where project resolution runs.** Only 4 of ~30 command files read
`profile.projectId` (`auth.ts`, `deploy.ts`, `projects.ts`, `apps.ts`) — every
other command relies on the *server-side* key scope. So the change is carried by
two centralized pieces, with no per-command churn:

1. `api.ts` attaches `x-tarout-project` whenever a project is set. Existing
   commands keep working untouched.
2. `resolveActiveProject()` runs in the `preAction` hook behind a
   `PROJECT_EXEMPT_LEAF` set (mirroring `AUTH_EXEMPT_LEAF`), guaranteeing a
   project is selected before non-exempt commands run.

Exempt from project resolution (they are org-level or manage projects
themselves): `projects`, `orgs`, `billing`, `login`, `register`, `token`,
`logout`, `whoami`, plus the already-auth-exempt `agent` namespace. A missing
entry fails loudly and safely — the server returns "No project selected" rather
than acting on the wrong project.
- Credentials resolve through two layers (`cli/src/lib/project-auth.ts`): a
  per-directory `.tarout/auth.json` and the machine-wide profile, with
  `--global-auth` forcing the latter. Both use the same `Profile` shape, so the
  active project is saved into whichever layer the invocation resolved —
  `requireProject()` must persist through the existing profile writer, never by
  writing a file path directly. A directory-local credential keeps its own
  active project, which is the desired behavior for per-repo workflows.

- **Profile** (`cli/src/lib/config.ts`): `projectId/projectName/projectSlug` remain
  optional; unset after a fresh login.
- **API client** (`cli/src/lib/api.ts`): `headers` becomes a function; attaches
  `x-tarout-project` from the resolved active project id → else omitted. Slug →
  id resolution for `--project` happens once in `requireProject()` (one API
  lookup, cached for the process) before project-scoped requests are made — the
  header function itself stays synchronous.
- **`resolveActiveProject()`** (new `cli/src/lib/active-project.ts`), called from
  the `preAction` hook for non-exempt commands. Resolution order: `--project`
  flag → profile → single project in org (auto-select, printed notice) →
  interactive picker. The picker uses the existing `select()` primitive
  (`cli/src/utils/prompts.ts:113`) with a `PromptDescriptor`, so `--json` /
  non-TTY runs emit a structured `needs_input` (`field: "project"`,
  `flag: "--project"`) and exit 6 instead of hanging — matching how the rest of
  the CLI handles agent-driven input. Includes a "Create new project…" choice
  that runs the create flow inline. The resolved project is saved to the profile.
- **`tarout login`** (`cli/src/commands/auth.ts:408`): authorizes account+org.
  On success in a TTY, offers the picker ("Select or create a project now?"),
  skippable, never blocking.
- **`tarout projects use <slug|id>`**: validates project exists in org via API,
  saves to profile. Works for org keys (fixes the no-op bug). Legacy pinned
  keys: keep today's clear error that re-login is required.
- **`tarout projects create <name>`**: works immediately after login. If no
  active project is set, auto-set the new project as active (printed notice).
- **`tarout projects active`**: shows profile project or "none selected" +
  guidance.

## Error handling

- Cross-org / nonexistent header project → 403 including the project id.
- Mismatched header on pinned key → 403 "pinned to X, re-login to switch".
- Org key, no header, project procedure → actionable "no project selected".
- Deleted active project → server 403/404 → CLI clears stale profile project,
  re-prompts (TTY) or errors (CI).

## Backwards compatibility & rollout

- **Existing logged-in users** (pinned keys): zero behavior change; header path
  never triggers for them.
- **Rollout order:** platform first, then CLI release. This avoids the only bad
  pairing (new CLI ↔ old platform).
- **Old CLI + new platform:** already-logged-in old CLIs work indefinitely. An
  old CLI doing a *fresh* login receives an org key it cannot scope; project
  commands then hit the "No project selected" error, whose message includes
  "upgrade the CLI". Explicit, not silent.

## Testing

- **Platform** (Vitest via `bun run test`): full scope-resolution matrix from
  the table above; `createCliSession` issues org-scoped keys; org-level
  procedures work with no scope.
- **CLI**: `requireProject()` resolution order; header attachment (flag vs
  profile vs none); `projects use/create` flows incl. auto-set-active;
  non-TTY fallbacks; entire existing suite stays green.
- **Manual e2e**: fresh login → `projects create` → deploy; legacy-profile
  session sanity check.

## Implementation notes

- `cli/` changes land via a git worktree (shared tree gets reset by concurrent
  sessions).
- Platform deploys before the CLI npm release.
