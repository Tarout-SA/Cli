# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
