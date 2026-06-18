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

## MCP (agent access)

Connect Claude Desktop / Cursor to Tarout via the bundled `tarout-mcp` bridge:

```json
{ "mcpServers": { "tarout": { "command": "tarout-mcp" } } }
```

Hosted agents can hit the Streamable-HTTP endpoint `/api/mcp` directly with an
`x-api-key` header. See [`docs/MCP.md`](https://github.com/Tarout-SA/Platform/blob/main/docs/MCP.md).

## Commands

### Authentication

| Command | Description |
|---------|-------------|
| `tarout login` | Authenticate via browser |
| `tarout logout` | Sign out and clear credentials |
| `tarout whoami` | Show current user, organization, and environment |

```bash
# Login with a custom API URL (e.g. staging)
tarout login --api-url https://staging.tarout.sa
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
# Stream logs continuously
tarout logs my-app --follow

# Filter by log level
tarout logs my-app --level error

# Logs from last hour
tarout logs my-app --since 1h

# Last 100 lines
tarout logs my-app --lines 100
```

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

| Command | Description |
|---------|-------------|
| `tarout domains list [app]` | List domains |
| `tarout domains add <app> <domain>` | Add custom domain |
| `tarout domains remove <domain>` | Remove domain |
| `tarout domains verify <domain>` | Check DNS configuration |

```bash
# Add custom domain
tarout domains add my-app api.example.com

# Verify DNS is configured correctly
tarout domains verify api.example.com
```

### Organizations & Environments

| Command | Description |
|---------|-------------|
| `tarout orgs list` | List organizations |
| `tarout orgs switch <org>` | Switch active organization |
| `tarout envs list` | List environments |
| `tarout envs switch <env>` | Switch environment (production/staging) |

```bash
# Switch organization
tarout orgs switch "Acme Corp"

# Switch to staging environment
tarout envs switch staging
```

## Global Flags

These flags work with all commands:

| Flag | Description |
|------|-------------|
| `--json` | Output as JSON (machine-readable) |
| `--yes, -y` | Skip all confirmation prompts |
| `--quiet, -q` | Minimal output (errors only) |
| `--verbose, -v` | Extra debug information |
| `--no-color` | Disable colored output |

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

Configuration is stored at `~/.tarout/config.json`:

```json
{
  "currentProfile": "default",
  "profiles": {
    "default": {
      "token": "cli_xxx...",
      "apiUrl": "https://app.tarout.sa",
      "organizationId": "...",
      "organizationName": "My Org",
      "environmentId": "...",
      "environmentName": "production",
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
