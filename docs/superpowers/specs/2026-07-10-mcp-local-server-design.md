# Tarout local MCP server — CLI parity design

Date: 2026-07-10
Branch: `feat/mcp-local-server`
Worktree: `/home/stanoid/tarout/cli-mcp-local`
Status: approved design, pre-implementation

## Context

Agents (Claude Code, Cursor, Claude Desktop) reach Tarout two ways today: they
shell out to the `tarout` CLI, or they connect to the hosted `/api/mcp` endpoint
which auto-exposes every in-scope tRPC procedure as a raw MCP tool (~300 tools,
generated in `platform/src/server/mcp/build-tools.ts` from the tRPC appRouter).
The current 69-line `tarout-mcp` binary is a thin stdio proxy to that hosted
endpoint — no local capability, and it exits when logged out (a dead server in
Claude Desktop, no auth remediation).

Neither surface gives an agent what the CLI does over MCP: deploy from a local
directory, `.env` push/pull, linked-directory context, or composed workflows
like checkout-and-poll billing upgrades. Agents that need those must shell out,
which forces a subprocess boundary, loses the MCP progress/annotation channel,
and breaks in sandboxed clients (Claude Desktop) that can't invoke arbitrary
CLIs.

Goal: replace the proxy with a self-contained local MCP server that reuses the
CLI's internals, exposes ~36 curated tools plus a `call` escape hatch for the
long tail, and mirrors the CLI's non-interactive JSON behavior.

## Decisions (from brainstorm, 2026-07-10)

1. **Approach: fat local MCP server in the CLI repo.** Not a hosted
   composition, not a curated proxy. Hosted `/api/mcp` and its CI parity test
   are untouched — remote agents keep the raw catalog.
2. **Tool surface: ~36 curated tools + `call` / `list_procedures` /
   `describe_procedure` escape hatch.** Curated set covers the CLI's high-value
   workflows with agent-friendly descriptions; long tail (servers, VMs, AI
   gateway, tickets, DNS zones, backups, …) reachable via `call`.
3. **Deploy UX: blocking by default with `wait=false` opt-out.** `deploy` runs
   inspect → resolve/create → upload → trigger → poll-until-done. Timeout is
   an outcome (`in_progress` + `deploymentId`), not an error. Separate
   `deployment_status` / `deployment_logs` tools exist for polling.
4. **Out of scope (agents keep using the CLI for these):**
   - interactive shells: `db connect` REPL, `servers console`, SSH sessions
   - `tarout dev` (long-running local dev server)
   - browser login / register flows (auth errors return remediation text)
   - `dashboard` (opens a browser)
   - hosted-endpoint changes / parity-test changes
   - `tarout agent init` writing `.mcp.json` (follow-up)
5. **Agent bootstrap: ship a hosted setup prompt** at
   `https://tarout.sa/agent-setup/prompt.md`, in the Cloudflare
   `developers.cloudflare.com/agent-setup/prompt.md` style — a
   fetch-and-follow bootstrap that installs the CLI, registers the MCP server
   with Claude Code, and defers auth to first tool call. Details in the
   "Agent bootstrap" section below. Claude Code plugin + marketplace path is
   a follow-up (needs a skills bundle to be worth the packaging overhead).

## Architecture

```
cli/src/mcp/
  stdio.ts        entry — stdout hygiene, non-interactive setup, connect
  server.ts       assembles McpServer, registers all tools
  runtime.ts      auth guard, error→envelope mapping, result helpers
  tools/
    deploy.ts     deploy, deployment_status, deployment_logs
    context.ts    context_status, context_switch, link_app, unlink_app
    env.ts        env_list, env_set, env_unset, env_pull, env_push
    apps.ts       app_list, app_info, app_create, app_logs, app_restart,
                  app_stop, app_delete
    db.ts         db_list, db_create, db_info, db_credentials, db_sql,
                  db_delete
    storage.ts    storage_list, storage_create, storage_info,
                  storage_credentials, storage_files, storage_delete
    domains.ts    domain_list, domain_link, domain_verify
    billing.ts    billing_status, billing_upgrade
    call.ts       call, list_procedures, describe_procedure
```

New shared libs (extracted, used by both commander actions and MCP tools —
extracting for reuse, not just for MCP):

- `src/lib/env-core.ts` — dotenv parse/serialize + app-by-name/id resolution
  (extracted from inline logic in `commands/env.ts`; `commands/env.ts` reworked
  to call it).
- `src/lib/surface-manifest.ts` — `loadManifest`/`fetchManifestFresh`
  (extracted from `commands/call.ts`; same cache file + TTL + refetch-on-miss;
  `commands/call.ts` reworked to import it).
- `createSourceArchive()` promoted to a top-level export in
  `commands/deploy.ts:3984` (currently private).

### Boot sequence (`stdio.ts`)

1. `setGlobalOptions({ quiet: true, nonInteractive: true, yes: true,
   noColor: true })` — silences `log()`/spinners in reused helpers so any that
   slip through don't print.
2. **stdout hygiene**: redirect `console.log` → `console.error` before
   connecting the transport. `StdioServerTransport` writes JSON-RPC frames to
   `process.stdout` directly (SDK bypasses console), so redirecting `console.*`
   is safe and makes stray CLI prints harmless. This is a backstop; handlers
   also avoid `outputJsonLine` and `promptOrEmit` (both print unconditionally).
3. Register tools; connect `StdioServerTransport`. **No auth check at boot.**
   The current proxy exits when logged out — that produces a dead server in
   Claude Desktop with no way to remediate. Auth is checked lazily per tool
   call and returned as a structured error the agent can act on.

### Auth model

- Token from active CLI profile (`~/.tarout/config.json`) or `TAROUT_TOKEN` env
  var (`lib/config.ts`: `getToken`, `getApiUrl`, `isLoggedIn`) — identical to
  the CLI.
- Shared handler wrapper (`runtime.ts::withAuth`): if not logged in, return
  `isError: true` result with body
  `{ code: "AUTH_ERROR", remediation: "Run \`tarout login\` or set TAROUT_TOKEN" }`.
- Handlers never `process.exit`; they never call `handleError()` from
  `lib/errors.ts` (which exits).

### Local-filesystem convention

Every FS-touching tool (`deploy`, `env_pull`, `env_push`, `link_app`,
`unlink_app`, `context_status`) takes an optional `path` param defaulting to
the server process cwd. Claude Code launches MCP servers in the project dir,
so cwd is meaningful; Claude Desktop does not, so `path` is often required
there. Tool descriptions state this explicitly.

## Tool catalog (36 curated + 3 discovery)

| Domain | Tool | Behavior / key params |
|---|---|---|
| Workflow | `deploy` | `path?`, `name?`, `wait=true`, `timeoutSeconds=600`, `createIfMissing=true`; pipeline below |
| | `deployment_status` | by `deploymentId` or `appId`/`name` → status + URL |
| | `deployment_logs` | `deploymentId`, `offset?`, `limit?` → build/deploy logs |
| Context | `context_status` | whoami + active org/project/env + link info for `path` |
| | `context_switch` | any of `organization?`, `project?`, `environment?` (id or slug) |
| | `link_app` / `unlink_app` | bind/unbind directory ↔ app (`.tarout/project.json`) |
| Env | `env_list` | `app`, `reveal=false` |
| | `env_set` / `env_unset` | `app`, `vars` map / `keys[]`; optional `restart` |
| | `env_pull` / `env_push` | `app`, `path?`, `file=".env"`; push: `merge=true`, `restart?` |
| Apps | `app_list` · `app_info` · `app_create` · `app_logs` · `app_restart` · `app_stop` · `app_delete` | create supports GitHub/GitLab/Docker source params |
| DB | `db_list` · `db_create` · `db_info` · `db_credentials` · `db_sql` · `db_delete` | `type: postgres\|mysql`; `db_sql` postgres-only (mirrors CLI) |
| Storage | `storage_list` · `storage_create` · `storage_info` · `storage_credentials` · `storage_files` · `storage_delete` | credentials = S3 HMAC keys |
| Domains | `domain_list` · `domain_link` · `domain_verify` | link returns DNS instructions; verify has `wait?`/`timeoutSeconds?` |
| Billing | `billing_status` | subscription + usage summary |
| | `billing_upgrade` | `plan?`/`addon?`/`quantity?`, `wait=true` → `applied` \| `payment_required` (+ `paymentUrl` for a human to click) \| `paid` \| `failed` |
| Escape hatch | `call` | `procedure` (dot-path), `input` — manifest-validated, refetch-on-miss |
| | `list_procedures` | `filter?` — fresh manifest fetch |
| | `describe_procedure` | input JSON Schema from hosted `/api/mcp` tools/list, cached per process |

Curation rules:

- Mutating tools carry MCP annotations (`destructiveHint` on delete/stop);
  queries carry `readOnlyHint`.
- List results trimmed to essential fields (id, name, status, url). `*_info`
  returns full objects.
- Everything not curated is reachable via `call` — full parity without
  context bloat.

## Deploy pipeline (flagship tool)

Reuses the exported, non-prompting helper chain from `commands/deploy.ts`.
Target resolution is reimplemented thinly in the MCP handler because the CLI's
`resolveDeploymentTarget` (deploy.ts:903) prompts / emits `needs_input` and
calls `exit(6)` — unusable in-process.

1. `inspectCurrentProject(path)` (deploy.ts:556) — framework/db detection.
   Pure function.
2. Resolve target:
   - `getProjectConfig(path)` → linked `applicationId`, or
   - `name` match via `application.allByOrganization.query()`, or
   - (`createIfMissing=true`) `createAppFromCurrentDirectory(client, options,
     inspection)` (deploy.ts:1075) with config from `buildConfigFromOptions`
     (deploy.ts:2043); then `setProjectConfig` to link the directory.
3. `uploadCurrentDirectorySource(client, applicationId, appName)`
   (deploy.ts:3931) — archives cwd via `createSourceArchive`, PUTs to
   `application.getDropUploadUrl.mutate()`, confirms via
   `application.completeDropUpload.mutate()`.
4. `client.application.deployToCloud.mutate({ applicationId })` →
   `deploymentId`.
5. `wait=true`: poll `client.deployment.one.query({ deploymentId })` every 3s
   up to `timeoutSeconds`, emitting **MCP progress notifications** on each
   poll (keeps clients with reset-on-progress timeouts alive). Fetch logs via
   `client.deployment.getDeploymentLogs.query()` for the final tail.
   Do NOT reuse `streamDeploymentWithLogs` (deploy.ts:4751) — it prints to
   stdout and juggles WebSocket + fallback, complexity we don't need here.
6. Result: `{ status, appUrl, deploymentId, logsTail (last ~80 lines) }`.
   Timeout →
   `{ status: "in_progress", deploymentId, hint: "poll deployment_status" }`.

Entitlement failure at step 2 → catch, run `resolveEntitlementRemedy` /
`buildRemedyOptions` (non-interactive path), return structured remediation:
plan/addon key, price, and a `billing_upgrade` invocation template. Same
information the CLI's `promptEntitlementRemedy` would surface to a human, in
JSON.

## Verified reuse map (source: 2026-07-10 exploration + spot-verified)

- **Deploy**: `inspectCurrentProject` :556 · `createAppFromCurrentDirectory`
  :1075 · `uploadCurrentDirectorySource` :3931 · `buildConfigFromOptions`
  :2043 · procedures `application.deployToCloud`, `application.getDropUploadUrl`,
  `application.completeDropUpload`, `deployment.one`,
  `deployment.getDeploymentLogs`.
- **Env**: procedures `envVariable.list`, `envVariable.export` (dotenv format),
  `envVariable.import` (merge + restart), `envVariable.listAcrossEnvs`.
- **Context**: `user.get`, `organization.all`/`setActive`,
  `project.all`/`setActive`/`getActive`,
  `environment.getActive`/`setActive`; local link via `getProjectConfig`,
  `setProjectConfig`, `removeProjectConfig`, `isProjectLinked`
  (config.ts:227/236/257/294).
- **Apps**: `application.allByOrganization`, `.one`, `.create`,
  `.getApplicationLogs`, `.restart`, `.stop`, `.delete`.
- **DB**: `postgres.allByOrganization`/`.create`/`.one`/`.remove`,
  `mysql.allByOrganization`/`.create`/`.one`/`.remove`,
  `postgres.updateExternalAccess` (db.ts:1235), `postgres.executeSql`
  mutation (db.ts:1388).
- **Storage**: `storage.allByOrganization`/`.create`/`.findById`/
  `.getCredentials`/`.getFiles`/`.delete` (verified storage.ts:68–508).
- **Domains**: `domainRegistrar.getAll`/`.verifyExternalDomain`,
  `domain.create`/`.one`/`.all`/`.byApplicationId`.
- **Billing**: `subscription.getCurrent`/`.getUsage`;
  `performBillingChange(input)` (billing-upgrade.ts:139) — already
  exit-free/non-interactive; MCP just doesn't pass an `openBrowser` callback.
- **Escape hatch**: `settings.getSurfaceManifest` + manifest cache extracted
  from `commands/call.ts`; tRPC dispatch via untyped proxy (`getApiClient()`),
  query vs mutation from manifest entry type.

## Error handling

`runtime.ts::toEnvelope(err)` maps every thrown error to an `isError: true`
result whose text is JSON `{ error, code, remediation?, details? }`:

| Cause | code | Notes |
|---|---|---|
| `AuthError` (from `lib/errors.ts`) | `AUTH_ERROR` | + `tarout login` remediation |
| Entitlement error (detected via `isEntitlementError` from deploy.ts:1598) | `PERMISSION_DENIED` | + remedy options |
| `TRPCClientError` | mapped from `data.code` | message passed through |
| `DeploymentFailedError` | `DEPLOYMENT_FAILED` | + `deploymentId`, `errorAnalysis` |
| `BuildFailedError` | `BUILD_FAILED` | + `deploymentId` |
| `DeploymentTimeoutError` | `DEPLOYMENT_TIMEOUT` | + `deploymentId` |
| unknown | `GENERAL_ERROR` | `err.message` passed through |

Codes reuse the CLI's exit-code taxonomy (`utils/exit-codes.ts`) so agents
speaking to both the CLI (`--json` mode) and the MCP server see the same
vocabulary.

## Testing

- **Unit (vitest, existing `fakeClient` pattern)**: per-domain handler specs
  with hand-stubbed tRPC clients (`{ router: { proc: { query|mutate } } }`).
  The deploy tool gets its own file covering: linked directory / name match /
  create-new / no-wait / timeout / entitlement failure — with the helper chain
  mocked at import boundary via `vi.mock`.
- **Integration**: MCP SDK `InMemoryTransport` — a real `Client` against the
  assembled server. Asserts `tools/list` catalog (names, annotations,
  schemas), `tools/call` round-trips, and the logged-out auth envelope.
- **Contract**: snapshot of curated tool names + input schemas — catches
  accidental surface drift; also asserts every name matches
  `^[a-zA-Z0-9_-]{1,64}$` (MCP requirement).
- **stdout hygiene**: booting the server + running a tool writes nothing to
  stdout besides JSON-RPC frames (validated by running the server as a child
  process and grep-ing stdout for non-JSON lines).

Location: `cli/__test__/mcp/` (new subdir); mirrors existing layout. All
vitest — no bun:test specs needed (no `open` mocking involved).

## Agent bootstrap (`tarout.sa/agent-setup/prompt.md`)

Cloudflare exposes `developers.cloudflare.com/agent-setup/prompt.md` as a
one-URL "fetch this and follow it" bootstrap: the agent reads plain-markdown
install instructions, runs the commands verbatim, and the plugin's OAuth
kicks in on first use. We mirror the pattern with a lighter distribution
(no plugin marketplace yet — the CLI + `tarout-mcp` bin are already on npm).

**Location.** Static file at `platform/public/agent-setup/prompt.md`, served
by Next.js at `https://tarout.sa/agent-setup/prompt.md` with
`Content-Type: text/markdown`. `platform/next.config.mjs` adds a header rule
for `/agent-setup/:path*.md` if the default `application/octet-stream` fights
Claude Code's fetcher (Cloudflare's file returns `text/plain`; either is
fine). No API route needed; no dynamic content today.

**Content (verbatim shape).**

```markdown
# Tarout Agent Setup Instructions

Install the Tarout CLI and register its local MCP server with Claude Code:

    npm i -g @tarout/cli
    claude mcp add tarout -- tarout-mcp

Then restart Claude Code (or run `/mcp` and reconnect the `tarout` server).

The first Tarout tool call triggers a browser sign-in if you're not
already authenticated (`tarout login` writes a token to
`~/.tarout/config.json`; or set `TAROUT_TOKEN` for CI). No OAuth
integration inside Claude Code — the local CLI owns the token.

For Cursor / Claude Desktop, see the `README` section in
https://github.com/Tarout-SA/cli#mcp — the same `tarout-mcp` binary
plugs into their `mcp.json` / `claude_desktop_config.json`.

The full setup prompt is at https://tarout.sa/agent-setup/prompt.md.
```

**How agents use it.** In a fresh Claude Code session the user (or the
project's `CLAUDE.md`) says "set up Tarout — see
https://tarout.sa/agent-setup/prompt.md". The agent WebFetches the URL,
runs the two commands, restarts the MCP link, and everything else falls
into the local MCP server's lazy-auth model.

**Follow-up (Phase 2, out of scope here).** Publish a Claude Code plugin
containing the MCP server + Tarout-specific skills
(deploy-from-this-directory, debug-deployment, plan-recommendation). The
prompt.md then flips to the Cloudflare 1:1 shape:

    claude plugin marketplace add tarout-sa/tarout
    claude plugin install tarout@tarout
    # then /reload-plugins

That requires: a `.claude-plugin/plugin.json` manifest, a marketplace repo
under Tarout-SA, and the skill set — none of which we design in this spec.
Tracked as an open follow-up.

## Packaging & rollout

- Same `tarout-mcp` bin; tsup already builds `src/mcp/stdio.ts` (see
  `package.json` build script: `tsup src/index.ts src/mcp/stdio.ts …`).
  Proxy code replaced, not kept alongside.
- Version bump 1.1.0 → 1.2.0 (minor: new tools + new local capabilities).
- CHANGELOG entry under `[1.2.0]` — describes the tool surface, links to
  README.
- README section: setup snippets for Claude Code
  (`claude mcp add tarout -- tarout-mcp`), Cursor
  (`~/.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json`);
  note about `path` param for non-cwd-aware clients.
- Work lands in worktree `/home/stanoid/tarout/cli-mcp-local` on branch
  `feat/mcp-local-server` → PR. Shared `cli/` tree gets reset by concurrent
  Claude sessions and PR merges; the worktree keeps commits safe.
  `node_modules` symlinked from main checkout.
- **Platform change** (only one, non-CLI): commit
  `platform/public/agent-setup/prompt.md`. Separate branch + PR on the
  platform repo (`docs(agent-setup): add tarout MCP bootstrap prompt`) so it
  can ship independently of the CLI release.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Stray stdout from a reused helper corrupts JSON-RPC | `console.log` → stderr redirect at boot + quiet global options + stdout-hygiene test |
| A reused helper calls `exit()`/prompts | Only reuse the pure helpers listed above (verified 2026-07-10); target resolution reimplemented thin in-handler; try/catch on every handler; never import `handleError` |
| Long blocking deploy vs MCP client timeouts | Progress notifications every poll; `timeoutSeconds` cap; `in_progress` result resumable via `deployment_status` |
| `outputJsonLine` prints unconditionally | Redirect backstop + handlers avoid `promptOrEmit`, `emitNeedsUpgrade`, and any code path that could reach it |
| Concurrent sessions resetting `cli/` | All work in dedicated worktree, committed early and often |
| Long-tail procedure input schemas not in curated set | `describe_procedure` fetches the JSON Schema from the hosted `/api/mcp` `tools/list` (which already builds them via `zodToJsonSchema` in `platform/src/server/mcp/build-tools.ts`) and caches per process |

## Open questions (defer to implementation plan)

None from the design gate. The following will surface during plan writing and
implementation:

- Exact input schemas per tool (Zod schemas in `src/mcp/tools/*.ts`).
- Whether `context_switch` should require `organizationId` or accept slug
  (the CLI accepts both).
- Whether `app_create` should offer Docker Hub source or leave it to `call`
  (CLI has it; agents will rarely use it).
