# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
