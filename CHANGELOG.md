# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0]

### Changed

- **Self-update now runs on every command, not just `up`/`deploy`.** Before
  running any command the CLI checks npm for a newer `@tarout/cli` and, when
  one exists, installs it and re-runs the command on the new version — so the
  CLI (and any agent driving it) always runs the latest without anyone doing
  anything. The network check is **throttled** to at most once every 3 hours
  (a single local config read otherwise), so ordinary commands stay fast;
  `up`/`deploy` still force an immediate check. Tune with
  `TAROUT_UPDATE_CHECK_INTERVAL_SECONDS` (`0` = check on every command).
  Fail-open and the existing opt-outs (`--no-update-check`,
  `TAROUT_NO_UPDATE_CHECK=1`) are unchanged. The scaffolded agent block now
  tells agents the CLI keeps itself up to date.

## [1.4.0]

### Added

- **Full agent parity for databases and object storage over MCP.** The MCP
  server grew from 39 to 65 tools so an agent can do everything a human can:
  - DB: `db_tables`, `db_preview` (browse data), `db_import` (run a `.sql`
    file), `db_analytics`, `db_stats`, `db_backups`, `db_backup_now`,
    `db_backup_download`, `db_restore`, `db_restart`, `db_stop`,
    `db_reactivate`, `db_update`, `db_attach`, `db_detach`,
    `db_external_access` (on top of the existing list/create/info/credentials/
    sql/delete).
  - Storage: `storage_upload` / `storage_download` (real byte transfer, not
    just signed URLs), `storage_delete_file`, `storage_create_folder`,
    `storage_move`, `storage_file_versions`, `storage_restore_version`, and
    S3 access-key custody (`storage_access_keys`, `storage_access_key_create`,
    `storage_access_key_revoke`).
- **CLI `tarout db import <db> <file>`** — runs a local `.sql` file against a
  Postgres database (schema/seed/migration SQL; bounded by the server's 10k
  statement cap — a full pg_dump restore uses the backup/restore flow instead).
- **CLI `tarout storage put <bucket> <key> <file>` / `storage get <bucket>
  <key> <file>`** — transfer real object bytes (presigned PUT/GET under the
  hood).
- `storage_access_key_create`'s one-time secret is allowlisted through the MCP
  result sanitizer so the caller actually receives it.

### Fixed

- `tarout storage download-url` and `storage version-url` called
  `getDownloadUrl` / `getVersionDownloadUrl` as tRPC queries, but both are
  mutations on the platform — the commands failed. Now call `.mutate`.

## [1.3.2]

### Added

- `domains add-external` output now renders the full routing contract: apex A
  records or a CNAME with the correct record name (previously always `@`), the
  one-time `_tarout-verification` ownership TXT (previously omitted), and the
  **Proxied (orange cloud)** requirement for root domains on Cloudflare-hosted
  DNS — matching the platform's new flattened-CNAME apex support.

### Fixed

- `domains instructions` read response fields the API doesn't send
  (`cloudflareManaged`/`cloudflareNameservers`); now reads `managedDns`/
  `nameservers`, so managed-DNS domains render correctly.
- `PRECONDITION_FAILED` platform errors (e.g. a root-domain connect the
  platform can't route) now exit with code 2 (invalid arguments) instead of a
  generic 1.

## [1.3.1]

### Changed

- The scaffolded agent block (`tarout agent init`) now carries the
  zero-approval deploy contract: announce-then-run (never wait for "Proceed"),
  fix-and-redeploy on `BUILD_FAILED`/`DEPLOYMENT_FAILED` (up to 3 fix
  attempts), and the live `data.url` as the deliverable. Matches the rewritten
  onboarding guide at https://tarout.sa/docs/for-ai/onboarding.md.

## [1.3.0]

### Added

- **Self-update on deploy.** `tarout up` / `tarout deploy` now check the npm
  registry for a newer `@tarout/cli` before running; when one exists the CLI
  installs it (`npm install -g`) and re-executes the same invocation on the new
  version, so users are always deploying with the current CLI. Fail-open by
  design (offline/registry/npm errors just continue on the current version).
  Opt out with `--no-update-check` or `TAROUT_NO_UPDATE_CHECK=1`. Under
  `--json`, the update announces itself as a `{ "type": "event", "event":
  "cli_update" }` line on stderr; stdout stays a single envelope. Never wired
  into `tarout-mcp` (a mid-session package swap would break the stdio stream).

### Changed

- The scaffolded agent block (`tarout agent init`) now links the raw-markdown
  onboarding guide (`https://tarout.sa/docs/for-ai/onboarding.md`) instead of
  the HTML page.

## [1.2.0]

### Added

- MCP result sanitization: tool results are redacted for credentials before
  return, with a per-tool allowlist (`db_credentials` / `db_create` / `db_info`
  pass through so connection strings and passwords stay usable).
- A `process.exit` guard for MCP tool handlers — a handler that transitively
  reaches `exit()` (e.g. a needs-input prompt) can no longer kill the server.
- A schema contract test that validates every curated MCP tool's payload
  against the platform's real Zod input schemas (opt in with
  `TAROUT_PLATFORM_DIR` / `REQUIRE_PLATFORM_CONTRACT`).
- `biome.json` — formatter off, linter on; the repo previously inherited
  Biome's defaults with no committed config.
- `FORBIDDEN` errors from MCP tools now carry the entitlement remedy (the exact
  `billing_upgrade` / addon command to run).
- **`tarout-mcp` is now a self-contained local MCP server** (was a thin stdio
  proxy). ~36 curated tools plus a `call` / `list_procedures` /
  `describe_procedure` escape hatch cover the CLI's real capabilities — deploy
  from the current directory, sync `.env`, obtain connection credentials for
  Postgres/MySQL/S3-compatible buckets, switch org/project/environment context,
  and upgrade billing with hosted-checkout polling. Auth is lazy: the server
  stays alive when logged out; the first tool call returns an `AUTH_ERROR`
  envelope with remediation.
- `https://tarout.sa/agent-setup/prompt.md` — fetch-and-follow install
  bootstrap for coding agents (Claude Code, Cursor, Claude Desktop).

### Changed

- `warn()` now writes to stderr in all modes (was stdout), keeping stdout clean
  for piping.
- Quiet mode (`-q`) overhauled: spinners and warnings are silenced, tables emit
  plain rows, list commands emit one full identifier per line, and mutations
  emit the created / affected ids.
- `build --json` failures exit `12` (`BUILD_FAILED`) with the child's real code
  preserved as `childExitCode` in the envelope, plus a top-level error envelope.
- `logout` best-effort revokes the server-side CLI key, removes only the current
  profile, and announces when another saved profile becomes active.
- Expired / rejected stored tokens now surface a re-login hint instead of a bare
  auth error.
- `--json` stdout is a single JSON document; the agent-setup advisory moved to
  stderr.
- Untrusted `--api-url` hosts warn before any credentials are sent.
- Every authenticated command now uses a shared login-recovery gate instead of
  dead-ending when no profile is active. Interactive sessions offer browser
  login, agent/non-TTY sessions open and wait for the callback when possible,
  and headless sessions fall back to a token prompt. `TAROUT_NO_BROWSER`
  disables browser launches for headless safety and tests.
- `src/commands/call.ts` reuses `src/lib/surface-manifest.ts` (extracted).
- `src/commands/env.ts` reuses `src/lib/env-core.ts` (extracted).
- `src/commands/deploy.ts::createSourceArchive` is now exported.

### Removed

- `domains ns`, `domains set-nameservers`, and `domains dns-ext
  update-nameservers` — the platform deliberately does not expose customer
  nameserver management (Cloudflare-Registrar domains are Tarout-managed), so
  these commands always failed with `NOT_FOUND`.

### Fixed

- Browser login, registration, and deploy authentication now use a short-lived,
  single-use authorization code bound to an S256 PKCE challenge. Long-lived API
  keys and account/profile data are no longer carried in the loopback callback
  URL; the CLI exchanges the code through a bounded, non-redirecting POST and
  validates the complete response before saving it.
- MCP `app_create` / `db_create` now send the required `appName` slug alongside
  `organizationId`.
- MCP `env_unset` uses `envVariable.delete` / `envVariable.bulkDelete` (was an
  import the server always rejected).
- MCP `billing_upgrade` maps the plan `quantity` correctly.
- MCP `billing_status` reads the real usage endpoint (`billing.getUsageBreakdown`).
- MCP `context_switch` resolves environment names, not just ids.
- The `call` discovery network calls are bounded at 30s.
- `env unset` always sends `restart: true` (the server rejected `restart:false`,
  breaking unset whenever `--restart` was omitted); `--restart` is now a
  documented no-op.
- `db upgrade` auto-confirm reads the correct preview field
  (`totalProratedHalalas`) and is reachable non-interactively, so agent
  checkouts actually confirm.
- VAT labels now mirror the server-computed tax — real gross amount and actual
  rate, hidden when 0%.
- `settings openapi` now prints the spec in human (non-JSON) mode instead of
  producing no output without `--json`.
- deploy's database / storage choice prompts respect non-interactive mode,
  auto-selecting the detected defaults instead of dead-ending on an
  unanswerable prompt under `--json` / `--yes` / no TTY.
- `env bulk-set`'s agent-mode error now points at the real remedy (`--vars`
  with a JSON example) instead of `--yes`.

### Docs

- README domains / logs / config sections corrected to match the shipped
  commands and the real config-file location.

## [0.20.1]

### Changed

- Maintenance re-release of 0.20.0 with no functional changes.

## [0.20.0]

### Reverted

- **Rolled back the v0.19.0 deploy-denial fallback scaffolding.** `tarout agent
  init` no longer injects the classifier-denial fallback block into the generated
  CLAUDE.md; the agent scaffold returns to its 0.18.3 behavior. This release ships
  the 0.18.3 code under a new version number.

## [0.18.3]

### Changed

- **The app-slot gate now offers add-a-slot, upgrade, AND reuse — not just
  "upgrade".** Hitting the app cap previously surfaced only a single plan-upgrade
  option (e.g. Starter → Pro), because the server's gate message carried no
  entitlement key and the CLI fell back to a generic upgrade. Now the
  `NEEDS_UPGRADE` envelope (and the interactive deploy picker) presents the real
  choices: on **Starter** — add one app slot (`plan:quantity` bump) **or** upgrade
  **or** reuse an existing app; on **Pro/Dedicated** — upgrade to a bigger host
  **or** reuse. Reuse options list the org's existing apps with ready
  `tarout up --app <id>` commands (capped, with a `tarout apps list` pointer for
  the rest) so no charge is required to proceed. A fallback infers the app-slot
  tier from the org's plan even against older servers that send the legacy
  keyless gate message.

## [0.18.2]

### Fixed

- **`tarout up`/`tarout deploy` could silently charge a second time for a managed
  database add-on in agent mode.** When a paid org had no open database slot,
  `ensureDatabasePlan` auto-bought the plan-matched db add-on (`db.standard` on
  Shared, `db.pro` on Dedicated) — even under `--json` / `--non-interactive` /
  `--yes`, where a paid checkout has no consent surface. So deploying right after
  a non-interactive `billing upgrade` (which can't bundle a database) billed the
  org again with no prompt. The auto-buy now fires **only in interactive
  sessions**; agent mode emits a `NEEDS_UPGRADE` envelope (buy the add-on, or
  upgrade the plan) so the user approves the charge first — matching the
  app-slot and storage gates.

## [0.18.1]

### Fixed

- **`tarout billing upgrade/addon:buy/addon:add/plan:quantity --wait` failed with
  "unknown option '--wait'".** Those commands only defined `--no-wait`, but the
  CLI's own entitlement-remedy hints (and users) pass `--wait`. They now accept
  `--wait` as an explicit alias of the default wait-until-confirmed behavior.

## [0.18.0]

### Changed

- **A deploy never silently reuses an app — it asks.** Previously a directory
  linked to an app (`.tarout/project.json`) redeployed to it without prompting,
  and `--yes` auto-reused the linked app. Now, whenever any app exists, `tarout up`
  / `tarout deploy` prompt **create a new app vs. reuse an existing one** (the
  linked app is listed first). Interactive shows an arrow-key picker; agent /
  `--json` mode emits a `deploy_app` needs_input. `--app <id|name>` (reuse) and
  `--new-app` (create) remain the explicit no-prompt escapes — pass one for a
  hands-free / deterministic redeploy. The scaffolded `CLAUDE.md` is updated to
  tell agents to pass `--app`/`--new-app`.

## [0.17.0]

### Changed

- **A storage entitlement gate no longer aborts the deploy — it prompts.** When a
  plan doesn't include file storage (e.g. the Free tier) and the deploy would
  provision a bucket, the deploy now asks the user to **continue without file
  storage** or **upgrade the plan** instead of failing. Interactive shows an
  arrow-key picker; choosing upgrade runs checkout, provisions the bucket, and
  continues. In agent/`--json`/`--yes` mode it emits a `needs_input` naming
  `--skip-storage`, so the agent asks the user and the re-run completes. (Database
  gates are unchanged — the database is required, so they still surface
  `NEEDS_UPGRADE`.)

### Added

- **`--skip-storage` and `--skip-database`** flags on `tarout up` / `tarout deploy`
  to deploy without provisioning that resource (and to give the "continue without
  storage" choice a clean, deterministic re-run).
- **`tarout agent init`** auto-mode trust now explicitly covers redeploys to an
  existing app (`--app`, `--reuse-database`/`--reuse-storage`, `--skip-*`), so the
  Claude Code auto-mode classifier denies fewer agent-issued redeploy variants.

## [0.16.1]

### Changed

- **Agents now log in by themselves instead of handing `tarout login` to the
  user.** `tarout login` and the deploy flow already auto-open the browser, but an
  agent that hit an `AUTH_ERROR` (e.g. from `tarout whoami`) would stop and ask the
  user to run `! tarout login`. The `AUTH_ERROR` envelope now carries
  `details.hint` + `details.nextCommand: "tarout login"` telling the agent to run
  login directly (it opens a browser on the user's machine and waits for sign-in),
  and the scaffolded `CLAUDE.md` ("Auth is hands-free — run it yourself") says the
  same. The `--token` path remains the headless/CI fallback.

## [0.16.0]

### Fixed

- **Database detection now understands Java / Spring Boot projects.** Project
  inspection previously only read `package.json` and a JS-centric file set
  (`.properties`, `pom.xml`, `build.gradle` were never inspected), so a Spring
  Boot + Postgres/MySQL app was detected as having no database — and a hands-free
  deploy provisioned none. Inspection now reads `pom.xml`, `build.gradle(.kts)`,
  and `application*.properties`, and recognizes JDBC/driver signals
  (`jdbc:postgresql`, `org.postgresql`, `jdbc:mysql`, `mysql-connector`,
  `org.mariadb`).
- **`--database` / `--storage` are now honored on redeploys.** Resource
  provisioning only ran on first app creation, so an explicit `--database postgres`
  on a redeploy of an existing app was silently ignored. It now provisions on a
  reused app too — **attaching the existing project database when one exists**
  (never creating a duplicate billable DB) and creating one only when none exists.
  A redeploy with no resource flag still provisions nothing.

## [0.15.0]

### Changed

- **`tarout up` / `tarout deploy` now auto-launch the browser login when not
  signed in.** Instead of stopping with a "run `tarout login` yourself" hand-off,
  the deploy opens the browser, waits for sign-in via the local callback server,
  and then continues — in agent / `--json` mode too (the browser opens on the
  user's machine). In `--json` mode it emits `auth_browser_opened` /
  `authenticated` events so the agent can tell the user to complete sign-in.
  A headless host with no display still falls back to the API-token prompt
  (`--token` / `tarout login --token`).

## [0.14.0]

### Changed

- **`tarout deploy` clears a tier/entitlement gate inline and resumes — no manual
  re-run.** When a deploy hits a plan limit on an interactive terminal, it now
  shows the arrow-key upgrade picker, opens the hosted checkout, and waits for
  payment confirmation in the background; once the new plan is active the deploy
  continues automatically on it. Previously it printed "run `tarout deploy` again"
  and stopped. Non-interactive callers (`--json` / `--yes` / no TTY) are
  unchanged — they still get the structured `NEEDS_UPGRADE` envelope and exit.

## [0.13.2]

### Changed

- **`tarout agent init`** no longer writes the "Denied by auto mode classifier" /
  buy-add-on-vs-upgrade paragraph into the generated `CLAUDE.md`; the CLI surfaces
  that `NEEDS_UPGRADE` guidance at runtime instead. (Add-on purchasing is
  unchanged: blocked on the free tier — which prompts a plan upgrade — and
  available on paid tiers.)

## [0.1.0] - 2025-01-15

### Added

- **Authentication**
  - Browser-based login flow (`tarout login`)
  - Logout command (`tarout logout`)
  - Show current user/org/env (`tarout whoami`)

- **Application Management**
  - List applications (`tarout apps list`)
  - Create applications (`tarout apps create`)
  - Delete applications (`tarout apps delete`)
  - View application details (`tarout apps info`)
  - Open app in browser (`tarout apps open`)

- **Deployment**
  - Deploy applications (`tarout deploy`)
  - Check deployment status (`tarout deploy:status`)
  - Cancel deployments (`tarout deploy:cancel`)
  - List deployment history (`tarout deploy:list`)

- **Logs**
  - View application logs (`tarout logs`)
  - Real-time log streaming (`--follow`)
  - Filter by log level (`--level`)
  - Time-based filtering (`--since`)

- **Environment Variables**
  - List variables (`tarout env <app> list`)
  - Set variables (`tarout env <app> set`)
  - Unset variables (`tarout env <app> unset`)
  - Pull to .env file (`tarout env <app> pull`)
  - Push from .env file (`tarout env <app> push`)

- **Database Management**
  - List databases (`tarout db list`)
  - Create databases (`tarout db create`)
  - Delete databases (`tarout db delete`)
  - View connection info (`tarout db info`)
  - Connect to database shell (`tarout db connect`)
  - Support for PostgreSQL, MySQL, and Redis

- **Domain Management**
  - List domains (`tarout domains list`)
  - Add custom domains (`tarout domains add`)
  - Remove domains (`tarout domains remove`)
  - Verify DNS configuration (`tarout domains verify`)

- **Organization & Environment**
  - List organizations (`tarout orgs list`)
  - Switch organizations (`tarout orgs switch`)
  - List environments (`tarout envs list`)
  - Switch environments (`tarout envs switch`)

- **AI-Friendly Features**
  - JSON output mode (`--json`)
  - Non-interactive mode (`--yes`)
  - Quiet mode (`--quiet`)
  - Verbose mode (`--verbose`)
  - Consistent exit codes
  - Structured error messages with suggestions
