# Tarout CLI

[![npm version](https://img.shields.io/npm/v/@tarout/cli.svg)](https://www.npmjs.com/package/@tarout/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

The official command-line interface for [Tarout](https://tarout.sa) — the Saudi cloud platform built for coding agents. Your agent writes code and defines infrastructure; Tarout provisions it instantly.

## Installation

```bash
curl -fsSL https://tarout.sa/install.sh | sh
```

Or with other package managers:

```bash
# Using npm
npm install -g @tarout/cli

# Using yarn
yarn global add @tarout/cli

# Using pnpm
pnpm add -g @tarout/cli

# Using bun
bun add -g @tarout/cli
```

## Quick Start

```bash
# 1. Login via browser (opens authentication page)
tarout login

# 2. Inspect and deploy from your project root
tarout deploy --wait --source upload

# The first deploy prompts to create or link an app, and to create detected resources.
```

## Call any API (`tarout call`)

Beyond the curated commands, `tarout call` reaches **every** platform procedure
directly — the same control surface exposed via REST and MCP:

```bash
tarout call --list                 # discover all callable procedures + type
tarout call application.create --input '{"name":"my-app"}' --json
tarout call deployment.all --input '{"applicationId":"app_123"}'
```

## MCP server

`tarout-mcp` is a local MCP server that gives coding agents (Claude Code,
Cursor, Claude Desktop) the CLI's capabilities as first-class tools:
deploy from the current directory, sync `.env`, run SQL against Postgres,
schedule cron tasks (`job_*`), switch org/project/env, upgrade billing, and
more — with a `call` escape hatch covering the entire platform API.

### Setup

**Claude Code**

```
npm i -g @tarout/cli
claude mcp add tarout -- tarout-mcp
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
	"mcpServers": {
		"tarout": { "command": "tarout-mcp" }
	}
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
	"mcpServers": {
		"tarout": { "command": "tarout-mcp" }
	}
}
```

### Auth

The server reuses the credential `tarout login` wrote — the project's
`.tarout/auth.json` first, then the machine-wide profile. **Launch it from the
project directory**, or pass a `path` argument on the tools that accept one, so
it resolves the right project. If nothing resolves, tool calls return a
structured `AUTH_ERROR`.

### Bootstrap URL

Point an agent at `https://tarout.sa/agent-setup/prompt.md` and it will
install the CLI + register the server in one shot.

## Commands

### Authentication

| Command | Description |
|---------|-------------|
| `tarout login` | Authenticate via browser; writes this project's `.tarout/auth.json` |
| `tarout login --token <key>` | Same, headless — no browser |
| `tarout register` | Create a new account via browser |
| `tarout token <key>` | Alias for `login --token` |
| `tarout token:create` | Mint a new API key for the current account |
| `tarout logout` | Sign this project out (`--global` for the machine-wide login) |
| `tarout whoami` | Show current user, organization, project, and credential `scope` |

Credentials are **per project** — see [Configuration](#configuration).

```bash
# Login with a custom API URL (e.g. staging)
tarout login --api-url https://staging.tarout.sa

# Store the credential machine-wide instead of in this project
tarout login --global

# Ignore this project's credential for a single command
tarout whoami --global-auth
```

### Applications

| Command | Description |
|---------|-------------|
| `tarout apps list` | List all applications |
| `tarout apps create <name>` | Create a new application |
| `tarout apps delete <app>` | Delete an application |
| `tarout apps info <app>` | Show application details |
| `tarout apps open <app>` | Open application URL in browser |

```bash
# List apps as JSON
tarout apps list --json

# Create an app
tarout apps create my-api

# Delete without confirmation
tarout apps delete my-api --yes
```

### Deployment

| Command | Description |
|---------|-------------|
| `tarout deploy [app]` | Deploy an application |
| `tarout deploy:status <app>` | Check deployment status |
| `tarout deploy:cancel <app>` | Cancel running deployment |
| `tarout deploy:list <app>` | List recent deployments |

```bash
# Inspect and deploy the current folder
tarout deploy --wait --source upload

# Deploy and wait for completion
tarout deploy my-app --wait

# Check deployment status
tarout deploy:status my-app
```

`tarout deploy` inspects the current folder for database, file storage, and Git signals before it asks questions. If Git exists, local upload remains available, so users without GitHub can still deploy. If the user chooses GitHub, run `tarout providers github connect` to open Tarout's Git provider setup page, then connect the repository to the app and deploy with `--source configured`.

### Logs

| Command | Description |
|---------|-------------|
| `tarout logs <app>` | View application logs |

```bash
# Fetch a snapshot of recent logs
tarout logs my-app

# Filter by log level
tarout logs my-app --level error

# Logs from last hour
tarout logs my-app --since 1h

# Last 100 lines
tarout logs my-app --limit 100

# Follow continuously (Ctrl+C to stop)
tarout logs my-app --follow
```

> `--follow` polls every 3s and prints only new lines — the platform exposes runtime
> (container) logs as a snapshot query, not a stream. Under `--json` it emits JSON Lines,
> one object per line, so agents can consume it incrementally.

### Environment Variables

| Command | Description |
|---------|-------------|
| `tarout env <app> list` | List environment variables (masked) |
| `tarout env <app> set <KEY=value>` | Set an environment variable |
| `tarout env <app> unset <KEY>` | Remove an environment variable |
| `tarout env <app> pull` | Download variables as .env file |
| `tarout env <app> push` | Upload variables from .env file |

```bash
# Set a variable
tarout env my-app set DATABASE_URL=postgres://...

# Set multiple variables
tarout env my-app set API_KEY=xxx SECRET=yyy

# Download to .env file
tarout env my-app pull

# Upload from .env file
tarout env my-app push
```

### Databases

| Command | Description |
|---------|-------------|
| `tarout db list` | List all databases |
| `tarout db create [name]` | Create a new database |
| `tarout db delete <db>` | Delete a database |
| `tarout db info <db>` | Show connection details |
| `tarout db connect <db>` | Open database shell |

```bash
# Create PostgreSQL database
tarout db create mydb --type postgres

# Create MySQL database
tarout db create mydb --type mysql

# Get connection string
tarout db info mydb

# Connect directly (opens psql/mysql client)
tarout db connect mydb
```

### Domains

External (customer-owned) domains connect through one flow: **add-external → DNS records → verify → link to app**.

| Command | Description |
|---------|-------------|
| `tarout domains list` | List domains |
| `tarout domains add-external <hostname>` | Register an external hostname (creates the edge hostname) |
| `tarout domains instructions <hostname>` | Show the exact DNS records to create |
| `tarout domains verify <hostname>` | Check DNS configuration |
| `tarout domains wait-verified <hostname>` | Poll until verified (`--timeout`, `--interval`) |
| `tarout domains app link-to-app --domain-id <id> --app-id <id>` | Attach the verified domain to an app |
| `tarout domains unlink <domain>` | Unlink a domain from an application |

```bash
# 1. Register the hostname, 2. add the records it prints, 3. verify, 4. attach
tarout domains add-external www.example.com
tarout domains instructions www.example.com
tarout domains wait-verified www.example.com --timeout 1800
tarout domains app link-to-app --domain-id <domain-id> --app-id <app-id>
```

Root domains (`example.com`) connect only when the domain's DNS is hosted on
Cloudflare: the CLI instructs a root CNAME that must be set to **Proxied
(orange cloud)**. On other DNS providers, connect `www.example.com` and
redirect the root to it. Hostnames under a Tarout-registered domain use
`tarout domains app link-registered` instead (`domains link` is retired and
always rejected by the platform).

### Scheduled Tasks (cron)

Two kinds of task: **http** fires a signed request at your app's own URL,
**command** runs a shell command inside the app's running container (so the app
must already be deployed).

| Command | Description |
|---------|-------------|
| `tarout jobs list` | List scheduled tasks (defaults to the linked app) |
| `tarout jobs info <id>` | Show a task, including its signing secret |
| `tarout jobs create` | Create a scheduled task |
| `tarout jobs update <id>` | Update a scheduled task |
| `tarout jobs delete <id>` | Delete a task and its run history |
| `tarout jobs enable <id>` / `disable <id>` | Pause or resume a task |
| `tarout jobs run <id>` | Run a task immediately |
| `tarout jobs runs <id>` | Show recent runs (exit code, duration, output) |

```bash
# Ping /cron/hourly on the linked app every hour
tarout jobs create --name hourly --schedule "0 * * * *" --path /cron/hourly

# Run a command inside the container every night at 02:00 Riyadh time
tarout jobs create --name cleanup --type command \
  --command "bun run cleanup" --schedule "0 2 * * *" --timezone Asia/Riyadh

# Fire it now and wait for the result (command runs are queued in the background)
tarout jobs run <id> --wait

# Inspect the history
tarout jobs runs <id> --limit 5
```

Command tasks may run for up to 15 minutes, so `jobs run` only queues them:
without `--wait` it reports `queued` and you read the outcome from
`tarout jobs runs <id>`. HTTP tasks run inline (60s cap) and print their result
immediately. Each HTTP fire carries `x-tarout-cron-timestamp` and
`x-tarout-cron-signature` headers — verify them with the task's signing secret
(`tarout jobs info <id>`).

### Organizations

| Command | Description |
|---------|-------------|
| `tarout orgs list` | List organizations |
| `tarout orgs switch <org>` | Switch active organization (local CLI default) |
| `tarout orgs activate <org>` | Set the active organization server-side |

```bash
# Switch organization
tarout orgs switch "Acme Corp"
```

> Tarout has no separate "environment" (production/staging) concept — apps are
> scoped to an organization and a project. Use `tarout projects` to separate
> workloads.

## All commands

The sections above cover the everyday flows. The full command surface (run any
with `--help` for its subcommands and flags):

| Namespace | Description |
|-----------|-------------|
| `tarout login` / `logout` / `whoami` | Authenticate, sign out, show current context |
| `tarout apps` | Manage applications |
| `tarout deploy` / `up` | Deploy an application (`up` = inspect + deploy the current folder) |
| `tarout logs` | View application logs |
| `tarout env` | Manage application environment variables |
| `tarout db` | Manage databases |
| `tarout domains` | Manage domains and DNS |
| `tarout storage` | Manage cloud storage buckets |
| `tarout servers` | Manage cloud servers (VMs) |
| `tarout backups` | Manage database backup configurations |
| `tarout destinations` | Manage backup storage destinations |
| `tarout billing` | Manage subscription and billing |
| `tarout wallet` | Manage AI Gateway wallet balance |
| `tarout ai` | Manage AI Gateway models and API keys |
| `tarout monitor` | Manage uptime monitors for applications |
| `tarout jobs` | Manage scheduled tasks (cron) for applications |
| `tarout projects` | Manage projects within the active organization |
| `tarout orgs` | Manage and switch the active organization |
| `tarout providers` | Manage Git providers (GitHub, GitLab) |
| `tarout keys` | Manage SSH keys for server access |
| `tarout firewall` | Manage firewall templates for cloud servers |
| `tarout tickets` | Manage support tickets |
| `tarout notifications` | Manage notification preferences |
| `tarout inbox` | Manage in-app notifications |
| `tarout link` | Link the local directory to a Tarout application |
| `tarout dev` | Run local dev server with cloud environment variables |
| `tarout build` | Build locally with cloud environment variables |
| `tarout settings` | Platform settings and information |
| `tarout queues` | Background job queues (platform operators only) |
| `tarout call` | Call any platform procedure directly (see above) |

## Global Flags

These flags work with all commands:

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (machine-readable) |
| `--yes, -y` | Skip all confirmation prompts |
| `--quiet, -q` | Minimal output (errors only) |
| `--verbose, -v` | Extra debug information |
| `--no-color` | Disable colored output |
| `--no-update-check` | Skip the automatic CLI self-update for this command |

### Self-update on every command

Before running any command, the CLI checks npm for a newer `@tarout/cli`; when
one exists it installs it globally and re-runs your exact command on the new
version — so the CLI (and any agent driving it) always runs the latest, with no
action needed. The network check is **throttled** to at most once every 3 hours
(so ordinary commands stay fast — the throttle window is a single local read);
`tarout up` / `tarout deploy` force an immediate check so a deploy is never on a
stale CLI. It fails open (offline or npm errors just continue on the current
version). Opt out per-invocation with `--no-update-check` or permanently with
`TAROUT_NO_UPDATE_CHECK=1`; tune the throttle with
`TAROUT_UPDATE_CHECK_INTERVAL_SECONDS` (set `0` to check on every command).
Under `--json` the update is announced as a
`{ "type": "event", "event": "cli_update" }` line on stderr.

## AI & Automation Usage

The CLI is designed to be 100% AI-friendly and scriptable:

```bash
# Get JSON output for parsing
tarout apps list --json

# Non-interactive operations (no prompts)
tarout apps delete my-app --yes

# Quiet mode for scripts
tarout deploy my-app --quiet

# Pipe-friendly
APP_ID=$(tarout apps list --json | jq -r '.[0].id')
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Authentication error (not logged in) |
| 4 | Resource not found |
| 5 | Permission denied |
| 6 | Needs input — see `needs_input` event below |

### JSON Output Format

All `--json` output follows a consistent structure:

```json
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": { "code": "NOT_FOUND", "message": "..." } }

// List operations
{ "success": true, "data": [...], "meta": { "total": 10 } }
```

### Agent Input Relay (`needs_input`)

When `tarout up --json` hits a choice point and the value wasn't passed as a
flag, it emits a single `needs_input` line on stdout and exits with code `6`
instead of crashing or silently defaulting. The external agent reads that
event, asks the human user in its chat UI, then re-invokes `tarout up` with
the same arguments plus the new flag.

```json
{
  "type": "needs_input",
  "field": "name",
  "kind": "input",
  "question": "Application name:",
  "default": "my-project",
  "flag": "--name",
  "sensitive": false,
  "context": { "step": "app_name", "defaultName": "my-project" }
}
```

Fields:
- `field` — stable id (e.g. `name`, `region`, `token`, `source`).
- `kind` — `"input" | "select" | "confirm" | "password"`.
- `question` — show verbatim to the user.
- `choices` — present when `kind: "select"`.
- `default` — pre-fill suggestion.
- `flag` — the CLI flag to pass on the next invocation.
- `sensitive` — `true` for tokens / passwords (mask in UI, omit from logs).
- `context` — free-form metadata the agent can use to phrase a richer prompt.

Loop pattern for an agent:

```text
1. invoke `tarout up --json [flags]`
2. read stdout line-by-line
3. if line.type === "needs_input":
     - ask the user for `question`
     - re-invoke with the same flags + `${flag} ${answer}`
4. otherwise treat the final JSON envelope as success / error
```

Flags currently supported by `tarout up` for skipping the relay:
`--token`, `--name`, `--plan`, `--source`, `--repo`, `--branch`, `--region`, `--yes`.

## Configuration

**Credentials are per project.** `tarout login` writes `./.tarout/auth.json`,
and the CLI finds it by walking **up** from the working directory — so it works
from any subfolder, and connecting a key in one project never re-points another
at a different account.

```
your-project/
  .tarout/
    auth.json      # the credential — mode 0600, in a 0700 directory
    project.json   # which Tarout app this directory deploys to
    .gitignore     # written automatically: ignores everything but itself
```

`.tarout/` is git-ignored on creation and excluded from deploy archives, so the
key never ships anywhere. You normally never edit these by hand.

### Resolution order

| # | Layer | Set by |
|---|-------|--------|
| 1 | `.tarout/auth.json` at or above the cwd | `tarout login` (default) |
| 2 | Machine-wide profile | `tarout login --global` |
| 3 | `TAROUT_TOKEN` environment variable | your shell — **lowest** precedence, and ignored entirely whenever 1 or 2 exists |

`tarout whoami --json` reports which one is in effect as `scope`
(`project` / `global` / `env` / `none`) plus the `credentialPath`. Pass
`--global-auth` on any command to skip layer 1 for that invocation.

Running `tarout login` somewhere that is not a project (no `.tarout`, `.git`, or
package manifest above it) falls back to the machine-wide profile and tells you
so, rather than scattering a `.tarout/` folder.

### The machine-wide profile

Stored in the OS-standard config directory (via the `conf` package), **not**
`~/.tarout/`:

- **macOS**: `~/Library/Preferences/tarout-nodejs/config.json`
- **Linux**: `~/.config/tarout-nodejs/config.json` (or `$XDG_CONFIG_HOME`)
- **Windows**: `%APPDATA%\tarout-nodejs\Config\config.json`

Both layers hold the same shape:

```json
{
  "currentProfile": "default",
  "profiles": {
    "default": {
      "token": "cli_xxx...",
      "apiUrl": "https://tarout.sa",
      "organizationId": "...",
      "organizationName": "My Org",
      "projectId": "...",
      "projectName": "My Project",
      "projectSlug": "my-project",
      "userId": "...",
      "userEmail": "user@example.com"
    }
  }
}
```

## Requirements

- Node.js 18.0.0 or higher
- A Tarout account ([sign up](https://tarout.sa))

## Support

- Documentation: [tarout.sa/docs](https://tarout.sa/docs)
- Issues: [GitHub Issues](https://github.com/Tarout-SA/cli/issues)
- Discord: [Join our community](https://discord.gg/2tBnJ3jDJc)

## License

MIT - see [LICENSE](./LICENSE) for details.
