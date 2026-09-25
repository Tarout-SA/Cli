# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.13.0] - 2026-09-25

### Added

- **`tarout db tables` has a SIZE column** (the table's on-disk size,
  indexes included), and `tarout db analytics` lists the largest tables.

### Changed

- **`tarout backups files` and `tarout backups download-url` take a backup
  schedule id** (from `tarout db backups <db>`) instead of a destination id:
  `backups files <backup-id>` and `backups download-url <backup-id> <path>`.
  The platform needs the database, its engine and the destination, and a
  schedule carries all three. The old form could not work (every call was
  rejected), so no working script changes. The file list now prints the full
  object path that `download-url` needs.
- **`tarout db restart` and `tarout db stop` (and the MCP `db_restart` /
  `db_stop` tools) now say that managed databases run on shared hosts and
  cannot be stopped, started or restarted, and exit non-zero without calling
  the API.** They called `changeStatus`, which only writes a status column: a
  free database was refused, and a paid one was shown as stopped while it kept
  running.
- **Only PostgreSQL can be created.** `tarout db create --type mysql` and the
  MCP `db_create` tool with `type: "mysql"` say so before calling the API (the
  platform refuses every MySQL create). Listing, inspecting, backing up and
  deleting existing MySQL databases still work.
- **External access always uses TLS.** `tarout db external-access` and the MCP
  `db_external_access` tool always send `requireSsl: true`; `--allow-insecure`
  (or `requireSsl: false`) fails fast with an explanation. `--require-ssl` is
  still accepted and no longer needed.
- **`tarout backups create` defaults `--prefix` to `tarout-backups`** (the
  platform requires one), defaults `--database` to the database's own name
  instead of prompting, and checks `--schedule` (5 cron fields, or 6 with
  seconds) and `--keep` (a positive whole number) before sending.
- **`tarout db import`, `tarout db sql` and the MCP `db_import` / `db_sql`
  tools explain the SQL console's limits before sending**: at most 10,000
  characters per call, no `COPY ... FROM stdin`, and no GRANT, REVOKE, role or
  database-level statements. The message suggests `pg_dump --inserts
  --no-owner --no-privileges`, or loading the file with psql over external
  access (`tarout db connect <db> < dump.sql`). Surrounding whitespace is
  trimmed before sending, as the platform does.
- **`tarout backups backup-web` explains that web server backups are not
  supported** instead of calling an endpoint that always fails.
- **Hints about external access point at `tarout db external-access`** (or the
  MCP `db_external_access` tool); there is no dashboard toggle for it. Restore
  hints point at the database's Backups tab in the dashboard.
- **`tarout apps git docker-hub` requires a public image pinned to a digest.** The platform deploys only `image@sha256:<digest>` and refuses private images, but the prompt suggested `nginx:latest` and the command offered `--private`, `--username` and `--token`. A tag is now refused before the request (with how to find the digest), the private-image flags are refused with the reason, and a new `--port` sets the container port (the platform default is 3000).
- **`tarout apps git url` is HTTPS only.** The platform clones custom Git remotes over HTTPS and never used the SSH key. The prompt no longer offers `git@...`; SSH and `http://` URLs, and URLs with embedded credentials, are refused up front; and `--ssh-key` is refused with a pointer to `apps git github` / `apps git gitlab` for private repositories.
- **`tarout apps metrics` help describes what it shows.** It advertised CPU and memory, but the platform reports request telemetry. `metrics`, `visitors` and `observability` take `--period` (1h, 6h, 24h, 7d, 30d), checked before the request.
- **`tarout apps analytics --days` is ignored.** The platform reports all-time counts plus a fixed 7-day window. The flag is still accepted (hidden) so existing scripts keep working.
- **`tarout apps live-status` help no longer names the infrastructure provider,** and the status is labeled by what it means: serving, starting, stopped, or not deployed yet.
- **MCP tools report refused arguments as `INVALID_ARGUMENTS`.** An argument refused inside the CLI layer (such as an ambiguous app name or id prefix, or a domain that was never added) came back with the numeric code `"2"`; it now uses the same `INVALID_ARGUMENTS` code as the tools' own checks.
- **MCP `deploy` takes `replaceGitSource`.** Set it to `true` to upload the directory over a connected repository on purpose (this stops push-to-deploy, as `tarout up --source upload` does).
- **`tarout storage create --plan` is ignored.** The platform picks the bucket plan from the project's subscription. The interactive plan prompt is gone; the flag is still accepted so existing scripts keep working, and passing it prints a note.
- **`tarout storage create` hints print the full bucket id.** The follow-up commands (`storage files`, `storage attach`) now carry the full id instead of an 8-character prefix.
- **MCP `storage_credentials` says it is for custom buckets only.** Its description now points managed buckets at `storage_access_key_create`.
- **`tarout domains transfer-in --auth-code` is no longer sent.** The platform never accepted it (support requests the EPP code over a secure channel after verifying ownership, and the ticket must not hold it). The flag is still accepted for compatibility, and the command now says the code was not sent.
- **`tarout domains register` help no longer names Name.com.** Registrations go through Tarout's managed registrar.

### Fixed

- **`tarout db analytics` reads the platform's real fields** (size, tables,
  rows, connections, cache hit rate, largest tables) and says "Analytics are
  not available for this database right now" when the platform has none,
  instead of crashing on `null`.
- **`tarout db stats` reads the platform's real fields** (plan, connections
  against the plan's limit, storage used against the limit, read-only state
  and reason) and handles `null`. It printed nothing before.
- **`tarout db tables` reads `estimatedRows`**; a table that was never
  analyzed shows `-` instead of a wrong count.
- **Every table that prints an id prints it in full**: `tarout db list`,
  `tarout db backups` and the next-step hint after `tarout db create`. The
  8-character prefixes did not work with `tarout backups <cmd>` or MCP tools,
  which match exact ids.
- **`tarout db connect` falls back to the pooler port 6432, not 5432**, reads
  the host and port the platform returns (including from
  `externalConnectionString`), and always sets `PGSSLMODE=require`. The
  connection string `tarout db info` prints now ends in `?sslmode=require`,
  like the platform's. MCP `db_credentials` uses the same 6432 fallback and
  also returns the platform's `connectionString`.
- **`tarout backups update` sends only the fields you change.** It echoed the
  stored row back, so a schedule with no retention, a null `enabled` or no
  destination sent `null`, which the platform rejects.
- **`tarout backups info` no longer prints an always-empty `Created` line** (a
  backup schedule has no creation date); it shows the database, destination
  and retention instead. `tarout backups run` picks the engine from the
  schedule's `databaseType`.
- **`tarout db preview --limit` is checked against the platform's 1-100 range**
  before sending.
- **MCP `db_create` accepts the FREE plan**, which the platform supports.
- **MCP `app_list` reports deployed apps as deployed.** It read `status` and `deployedUrl` / `url`, which the platform never sends, so every app came back with no status and no URL and agents concluded nothing was deployed. It now returns the app's `applicationStatus` as `status`, its live URL as `url` (null only when never deployed), and `lastDeployment`.
- **MCP `deploy` no longer disconnects an app's Git repository.** It always uploaded the directory, which replaced a connected repository with the upload and silently stopped push-to-deploy. An existing app with a connected repository is now deployed from that repository (the result carries `source: "git"` and a note to push first), the same rule `tarout up` enforces.
- **MCP `deploy` fills `appUrl` and `logsTail`.** It read a `url` field deployments do not have and a `logs` field the log endpoint does not return (and fetched the first 200 lines, not the last). It now returns the app's public URL and the last 80 build-log lines.
- **Deployment ids are printed in full.** `tarout deploy:list`, the `deploy:rollback` summary and the `deploy:logs` hints printed 8-character prefixes, but `deploy:logs` looks a deployment up by its exact id, so the printed id never worked. `deploy:retry --deployment` and `deploy:rollback --to` now accept a unique prefix and refuse an ambiguous one instead of taking the first match.
- **MCP tools resolve app ids of any shape, and unique id prefixes.** App references in the MCP tools matched an id only when it started with `app_`, but app ids are plain 21-character ids, so passing an id failed with NOT_FOUND. Exact ids, names, slugs and unique id prefixes (4+ characters) now resolve; a name or prefix that matches several apps is refused with the matching ids, so a destructive tool never guesses.
- **`tarout apps sync` works.** It called the status sync as a mutation; the platform exposes it as a query, so the command always failed. It now prints the synced status.
- **`tarout apps info` shows the connected source.** It read nested `github` / `gitlab` objects the platform strips from the response, so the repository and branch never printed. It now shows the repository and branch, custom Git URL, Docker image or uploaded archive from the app itself.
- **`tarout deploy:status` no longer prints `Provider: undefined` and `Updated: Invalid Date`.** It now prints whether the app is deployed, its region and its latest deployment.
- **`tarout apps deploy-status` prints the real status.** It showed only a status line; it now also shows whether the app is deployed and its URL.
- **`tarout apps ssl-status` reports the real certificate state.** It read `valid` / `hasSSL`, which the platform never returns, and printed "invalid/missing" for every app. It now shows the platform subdomain (and custom subdomain) status: active, pending or failed.
- **`tarout apps analytics`, `metrics`, `visitors`, `observability` and `create-options` print their data.** Each printed only a header because it read fields the platform does not return. `analytics` shows deployment counts, success rate, the last deploy and domains; `metrics` and `visitors` show requests, page views, errors, latency, status codes and top paths; `observability` shows traffic, uptime and deployment health; `create-options` shows the app tiers you can create and the slots left in each.
- **`tarout apps complete-upload` no longer claims a deployment started.** Completing an upload only saves the archive as the app's source and queues nothing. The command now says so and points at `tarout deploy <app> --source configured`, which builds the saved archive.
- **`tarout apps upload-url` shows when the URL expires.** It read `expiresAt`; the platform returns `expiresIn` (seconds).
- **`tarout env push --replace` without `--restart` is refused up front, with the reason.** The platform always rejected it, because a replace-all import must restart the app to confirm the new set is healthy. The CLI now says so before uploading anything.
- **`tarout env push` describes skipped entries correctly.** "Skipped N (already exist)" was wrong: skipped entries are ones the platform refused as invalid (a bad key name or a value over 64 KB).
- **`tarout apps create` points at the real source commands.** Its "Connect a source" step named `tarout apps info`, which only reads the app. It now names `tarout apps git github` (and `gitlab`, `url`, `docker-hub`).
- **`tarout up` names the source type when it refuses to replace a Git source,** instead of "connected undefined repository".
- **`tarout storage info` shows real usage.** It read `usedBytes` / `fileCount`, which the platform never sends, so every bucket showed 0 B used and 0 files. It now reads `storageUsed` / `filesCount`.
- **`tarout storage create` prints what the platform created.** The summary no longer shows `Name: undefined`, and `Plan:` is the plan the platform actually assigned instead of the one you picked.
- **`tarout storage create` no longer recommends `tarout storage credentials`.** That command is refused for every managed bucket. The next step now points at `tarout storage attach <bucket-id> <app-id>`, which gives the app a scoped key and the S3 env vars.
- **`tarout storage credentials` explains the managed-bucket refusal.** On a managed bucket it now says direct credentials are only for custom buckets and names the `tarout storage attach` command, instead of a bare FORBIDDEN.
- **`tarout storage complete-upload` no longer requires `--expected-size`.** The platform ignores it (and `--size`) and reads the real size itself. Both flags are now optional; the success line shows the stored size.
- **Bucket references no longer pick the wrong bucket when names collide.** Bucket names are not unique. The CLI and the MCP storage tools (including `storage_delete`) now refuse a name or id prefix that matches more than one bucket and list the matching ids; an exact id still works.
- **MCP `storage_create` no longer requires `plan`.** The platform ignores it, so it is optional and is not sent.
- **MCP `domain_link` works again.** It called `domain.create` without a registered domain, which the platform refuses for every hostname. It now follows the same plan as `tarout domains link`: a hostname already added as an external domain is attached with `domain.linkToApplication`, and a subdomain of a domain registered through Tarout is created under it. A hostname nobody added returns a clear error that names the add, verify and link steps.
- **MCP `domain_verify` with `wait` polls the right record.** It polled `domain.one` with a registered-domain id (always NOT_FOUND) and read a `verified` field that procedure never returns. It now polls `domainRegistrar.getById` until the domain's DNS status is `active`, accepts the domain name as well as its id, and on timeout returns the first check's reasons and required records.
- **`tarout domains register` no longer says every domain is unavailable.** It read an `available` field the platform never sends; it now reads `purchasable`, shows the platform's reason when a domain is taken, defaults to the registry's minimum term (for example two years for `.ai`), and refuses a shorter `--years` before any payment.
- **`tarout domains register` stops early for `.sa` domains.** Those need a Saudi registry application and a supporting document that the CLI cannot collect, so it now points to the dashboard instead of failing after the contact prompts.
- **`tarout domains search` and `search-multiple` show real availability and prices.** They read `available` and `price`, which the platform never sends, so every row read "no" with no price. They now read `purchasable` and `purchasePrice`, and show the minimum term when a TLD sells in multi-year blocks.
- **`tarout domains verify` shows the records you actually need.** Every domain used to fall into a "Nameserver change not yet detected" message with no records, because the fields it branched on are no longer returned. It now prints the platform's reasons plus the exact A or CNAME record, any ownership TXT record, and the CAA record to add when a CAA policy blocks the certificate.
- **`tarout domains list` fills the DNS column.** The `CF ZONE` column was always empty; it is now `DNS`, read from the returned `dnsZoneStatus`.
- **`tarout domains info` shows privacy and expiry correctly.** It read `privacyEnabled` and `expiresAt` (never returned), so privacy always read "disabled" and expiry "-". It now reads `whoisPrivacy` and `expiryDate`, shows DNS and SSL status, lists the hostnames under the domain, and hides registrar-only rows for external domains.
- **`tarout domains ssl` no longer reports a pending certificate as "invalid/missing".** It now prints the returned status, the platform's message and the activation date.
- **`tarout domains registrar-status` reports readiness correctly.** It read a `ready` field that does not exist and always printed "no".

## [1.12.0]

### Added

- **`tarout servers kept-storage` (alias `kept`).** Lists every volume,
  snapshot and reserved IP that was kept when its server was terminated, in one
  table with its size or IP and the server it came from. These keep billing
  until they are deleted with `servers volumes delete`, `servers snapshots
  delete` or `servers ips release`, and the command says so. `--json` prints the
  platform's object as is; `--quiet` prints only the ids.
- **`--keep-volumes`, `--keep-snapshots` and `--keep-ips` on `servers
  terminate` and `servers delete`.** By default a server's volumes, snapshots
  and reserved IPs are deleted with it. Before asking for confirmation, both
  commands now show exactly what will be deleted and what will be kept (and
  that kept items keep billing).
- **`tarout wallet agree`.** Accepts the Compute Wallet agreement, which must be
  accepted before cloud servers can be created or the wallet topped up. It
  links to the full terms at https://tarout.sa/dashboard/wallet and asks for
  confirmation first (`--yes` skips it). Only the organization owner can
  accept.
- **`servers create --software <coolify|dokploy>` and `--no-ssh`.** Pre-install
  Coolify or Dokploy, or create the server with SSH disabled.
- **`servers alerts set --comparison <gt|lt|gte|lte>` and `--duration
  <minutes>`.**
- **`servers volumes create --type <balanced|ssd|standard>` and `--attach`.**

### Changed

- **`servers alerts set` no longer offers a memory alert, and `servers metrics`
  shows memory as "not collected".** Cloud servers run no agent that can report
  memory, so a memory alert could never fire; the platform now refuses it, and
  the CLI says so and suggests `free -m` over SSH.

- **`tarout wallet topup --amount` now takes SAR, not halalas.** The prompt
  already asked for SAR, so the flag and the prompt disagreed by a factor of
  100. `--amount 50` now means 50 SAR. Scripts that pass halalas can switch to
  the hidden `--halalas <n>` flag. Amounts below the 5 SAR minimum are refused
  instead of being silently raised to 5 SAR by the platform.

### Fixed

- **`tarout servers metrics` shows real numbers.** It read fields the platform
  never sends, so it printed nothing. It now shows the latest, average and peak
  CPU and memory (percent) and disk and network rates (per second) for the
  chosen range, and says "no data yet" for an empty series.
- **`servers volumes list` reads the real volume fields:** size, disk type,
  status and device name, with the full volume id. `servers volumes create` no
  longer claims the new volume is attached; it is created detached, and the
  command prints how to attach it. `servers volumes attach` no longer needs a
  server argument, because a volume only attaches to the server it was created
  for.
- **`servers ips list` and `servers ips reserve` show the IP address.** They
  read the wrong field and printed "-". Both also show the full id, and `ips
  reserve` defaults to the `me-central2` region with a unique name, so a second
  reservation no longer collides with the first.
- **`servers check-quota` shows the quota.** It printed "- / -" for every line.
  It now shows used and allowed servers in total and per CPU and GPU, whether
  another server can be created, and why not.
- **`servers os-images` lists the three supported images** with their name and
  description. The misleading `--provider hetzner` help is gone (the flag is
  still accepted and ignored).
- **`servers create` only offers what the platform accepts.** The OS prompt no
  longer offers Rocky Linux, which the platform rejects; the server type is
  derived from the sizes your account can create, so GPU is no longer offered
  when it is not available; the `--size` help shows real size ids (`cpu-xs`,
  `cpu-s`, `cpu-m`, ...); and an unknown OS, type or size fails before anything
  is created.
- **`servers delete` works on a server that is already terminated.** It looked
  the server up in a list that hides terminated servers, so it failed with "not
  found". It now looks up ids directly, skips terminating a server that is
  already gone, and explains clearly when the record cannot be deleted because
  volumes or snapshots kept from it still exist.
- **`servers info` no longer prints a Private IP line.** The platform never
  returns a private IP, so it always showed "-".
- **`servers snapshots create` builds a default name that fits.** The old
  default could pass the 50 character limit for long server names.
- **`servers firewall add` no longer fails on the second rule.** Every rule
  defaulted to the name "allow-port", and names are unique per server. The
  default is now `allow-<protocol>-<port>`.
- **`servers alerts set` uses the right unit.** CPU and memory thresholds are
  percentages; disk and network thresholds are now given in MB/s and converted
  to the bytes per second the platform stores, instead of every threshold being
  labelled "%". `servers alerts list` shows each threshold in its own unit.
- **`servers cancel-vm-subscription` explains itself.** Cloud servers are billed
  hourly and have no subscription, so the platform call always failed. The
  command now says so and exits with an error without calling the API.
- **`tarout wallet topup` prints the amount.** It read a field the platform does
  not send and always printed "Default"; it now prints the amount from the
  checkout in SAR.
- `servers snapshots list` and `servers firewall list` show the full id that
  `servers snapshots delete` and `servers firewall delete` need.

## [1.11.0]

### Added

- **`tarout ai keys create --expires <when>` and `ai keys update --expires`.**
  Takes a number of days (`30`), a future ISO date (`2026-12-31`), or `never`
  (which clears an expiry on update). The dashboard already offered expiry;
  the CLI could not set it.

### Fixed

- **`tarout ai models` lists the catalog.** It expected a flat array, but the
  platform returns the catalog per product (`{ global, saudi }`), so it printed
  "No AI models available" for every account. It now shows every model with
  its region, context window, USD price per million tokens (as the catalog
  reports it, markup included) and whether it is callable right now. `--quiet`
  prints only callable model ids.
- **`tarout ai usage` and `ai keys usage` report real spend in SAR.** They
  divided a USD amount by 100 and labelled it SAR, read totals from the wrong
  field, and mixed an all-time total with a windowed history. Both now read the
  same activity data as the dashboard: one window, SAR amounts, per-day rows.
- **`tarout ai keys list` shows the full key id.** It showed 8 characters,
  which no other command accepts.
- **`tarout ai keys create --quiet` prints the new key id.** It printed an
  empty line.
- **`tarout ai keys delete` says what happens.** The key stops working at once
  and its usage history is kept; it no longer claims the delete is permanent
  and cannot be undone. `ai keys revoke` now warns that a revoked key can never
  be re-enabled (the platform enforces this from this release on).

## [1.10.4]

### Fixed

- **`tarout domains link <app> <domain>` works again.** It sent every domain
  through a call the platform now reserves for subdomains of domains registered
  through Tarout, so it failed for every hostname, including the documented
  `domains add-external` -> `domains verify` -> `domains link` path. It now
  links a hostname you already added, creates a subdomain under your registered
  domain, and otherwise tells you exactly which commands to run first.
- **`tarout domains unlink` detaches instead of deleting.** It deleted the
  domain's route, which the platform refuses for external domains ("Remove it
  from the Domains page"). It now unlinks the domain from its app and keeps it,
  so `domains link` can attach it again; `tarout domains delete` removes a
  domain for good. JSON output is now `{ "unlinked": true, "domainId": ... }`.

## [1.10.3]

### Fixed

- **A dropped connection no longer aborts a deploy.** Read requests (every
  query) retry a transport failure twice with a short backoff; one bad socket
  right after sign-in used to end `tarout up` with "fetch failed". Writes are
  never retried, so nothing is sent twice.

## [1.10.2]

### Fixed

- **`tarout servers delete` deletes a running server.** It used to fail with a
  generic "Something went wrong" because the platform only removes a server
  record once the machine is terminated. It now terminates first, waits for the
  provider to confirm the machine is gone, then removes the record.
- **`tarout servers info` and `servers list` show the server's IP.** They read a
  field the API does not return and printed "Not assigned" for running servers.
- **A `TAROUT_TOKEN` alone works for every command.** `apps create`, `db create`,
  `storage create`, `link` and the `orgs` commands demanded a stored login and
  answered a valid CI token with "Not logged in". They now resolve the account
  from the token, the way `up` and `deploy` already did.
- **`tarout servers create` installs your default SSH key.** `tarout keys
  default` promised "the default for new servers", but create sent no key, so
  the platform generated a fresh pair and your own key could not log in. Create
  now installs your default key(s); `--key <name>` picks specific saved keys and
  `--generate-key` keeps the old one-time generated pair.
- **`tarout storage get` waits out a rate limit.** A burst of downloads hit HTTP
  429 and failed; it now honours `Retry-After` and retries.
- **Errors print a reason outside `--json` mode.** A plan-limit refusal (and a
  few other structured errors) only ever printed as JSON, so `tarout up --yes`
  on a full Free plan ended on "Creating application..." with exit 5 and no
  explanation. The reason and every option to continue now print to stderr.
- **A crash on boot is diagnosed as one.** An app that exits while starting was
  analysed as "Invalid Dockerfile syntax" because of a platform warning line; it
  now reads as a start failure and points at the container logs, env vars and
  port.

## [1.10.1]

### Fixed

- **A first `tarout up` no longer refuses the app it just created.** Every new
  app reads `sourceType: github` before any source is chosen, so the guard that
  protects push-to-deploy refused a brand-new app ("deploys from its connected
  github repository") and every new user's first deploy failed without
  `--source upload`. The guard now applies only to an app you reuse, and only
  when a repository is actually connected.
- **Deploy polling survives network blips.** A dropped connection or an HTML
  error page while waiting on a deploy used to end `tarout up` / `deploy --wait`
  with "fetch failed" although the server kept deploying. Transport failures
  are now retried for about two minutes.
- Isolate MCP credentials, API clients, and project selection for concurrent tool calls.
- Persist MCP project switches and respect organization- and project-bound API keys.
- Accept environment-only authentication in `build` and `dev`.
- Align MCP application-log filters and line limits with the cloud API contract.
- Update vulnerable dependencies and verify the locked release package.

## [1.10.0]

### Added

- **`tarout login --commit-token` shares a project's login through git.** It
  adds `!auth.json` to `.tarout/.gitignore`, so everyone who clones the repo is
  signed in as that account; `--no-commit-token` undoes it. Both flags also work
  on `tarout token <key>` and on a project that is already signed in, with no new
  sign-in. The CLI warns that anyone with the repo can act as the account, that
  a browser-login token expires after 30 days (use a dashboard key instead), when
  a `.gitignore` higher up still hides `.tarout/`, and when git keeps tracking
  `auth.json` after opting out (`git rm --cached`, then revoke the key). Refused
  with `--global`, since only a project credential lives in the repo.

### Changed

- **`.tarout/.gitignore` now tells a fresh clone how to sign in.** It is the only
  file in `.tarout/` that reaches a clone, and it used to say only "Ignore local
  tarout config". It now explains `tarout login`, `tarout deploy`, `TAROUT_TOKEN`
  for CI, and the `--commit-token` option. An existing file that still has the
  old first line is upgraded in place with every other line kept; a file you
  wrote yourself is never rewritten. Login and link now write the same file, so
  a login-created one no longer misses `!config.json`.

- **Project sign-in says whether the token is committed.** The Account box reads
  "kept out of git" or "committed with the repo", followed by one line on what a
  teammate who clones the repo gets. `--json` output carries `tokenCommitted`.

- **`tarout ai keys create` no longer asks for a model.** AI Gateway keys are
  no longer pinned to one model: one key calls every model in the catalog, and
  each request picks its model with the `model` field. `-m, --model` and
  `-p, --provider` are still accepted so existing scripts keep running, but
  they print a one-line deprecation warning and are not sent. The success box
  now shows the monthly credit limit (when `--monthly-cap` is set) and points
  at `tarout ai models` instead of printing a model and provider.

- **`tarout ai keys list` drops the MODEL column.** `tarout ai keys info`
  prints Model and Provider only for older keys that still carry a value,
  marked as legacy and not enforced, and shows a key's monthly credit limit
  when it has one.

- **Key management now points at `https://tarout.sa/dashboard/ai-models/keys`.**
  An empty `tarout ai keys list` also suggests `tarout ai keys create`, which
  works over API-key sessions.

## [1.9.2]

### Added

- **`tarout upgrade` explicitly upgrades the CLI.** It bypasses the background
  check throttle, needs no authentication or linked project, reports an
  already-current installation clearly, and returns structured JSON plus a
  non-zero exit code when the registry check or npm installation fails.

### Fixed

- **Protocol-v2 browser login and Agent handoffs now complete.** The platform
  correctly issues 22-character v2 authorization codes, but the localhost
  browser callback still accepted only the legacy 43-character width. The API
  also correctly returns an account-scoped profile with no project, while the
  CLI's runtime response validator still required project fields that its type
  already marked optional. Both validation boundaries now accept the v2
  contract while retaining legacy v1 compatibility. A malformed callback with
  the correct state rejects the waiting command immediately instead of hanging
  until the five-minute timeout.

- **Rejected-credential diagnostics no longer guess the credential type or
  recurse into `whoami`.** A generic `UNAUTHORIZED` can describe a browser CLI
  credential, Agent key, project file, machine profile, or environment token.
  The error now stays neutral and reports the active scope, non-secret account,
  and credential path when available.

## [1.9.1]

### Fixed

- **`tarout up` silently ended push-to-deploy.** `deploy` binds a project's
  GitHub remote when it can; `up` never did — it always uploaded. So reusing a
  Git-connected app through `up` (via `--app`, a linked directory, or the
  picker) replaced the connection with a folder upload. The app kept deploying,
  pushes just stopped shipping, and the person who found out was whoever pushed
  a fix that never went live. `up` now binds the remote exactly as `deploy`
  does, and **refuses** to upload over an app that deploys from a repo, naming
  `tarout deploy <app> --wait` instead. `--source upload` still forces it; the
  guard only stops a *default* from doing something destructive. Because the
  flag's default is also `upload`, the two are told apart by where the value
  came from, not by its value.

- **`agent connect` connected the whole machine when run in the wrong place.**
  In `$HOME` or a filesystem root it fell back to the machine-wide store and
  printed why — inverting the one guarantee the command exists for, that
  connecting project B cannot re-point project A. It now stops with an error
  naming `--global`, and leaves the handoff unspent for the corrected run.

### Changed

- **The dashboard handoff went from 176 characters to 25.** The setup prompt now
  carries `Handoff: t2.<22 chars>` instead of
  `t1.<code>.<verifier>.<userId>.<orgId>.<projectId>.<expiry>`. Two thirds of
  the old string did no work:

  - The **PKCE verifier** bound nothing. PKCE ties a code to the client that
    requested it across a channel where the code is exposed and the verifier is
    not — an OAuth browser redirect. This flow has no redirect: the dashboard
    minted both halves and put them in the one string the user copies, so
    anyone holding it held both. The property it looked like it was providing —
    a dump of the authorization store cannot yield a usable code — comes from
    storing the code as its SHA-256, which is unchanged.
  - The **user, org and project ids** were a client-side assertion that the
    exchange returned the expected account. That response is authoritative under
    TLS, and the CLI prints the account it connected to.
  - The **code** is 16 random bytes rather than 32. It is single-use, expires
    in minutes, and is guessed only through a rate-limited endpoint.

  `t1.` handoffs are still parsed and still accepted by the server, so a command
  copied before the change keeps working until it expires. One behaviour
  follows from the smaller payload: with no ids to match a stored credential
  against, `agent connect` can no longer skip the exchange by recognising an
  equivalent local profile, so a repeat setup mints a fresh key instead of
  reusing one.

- **`agent connect` always checks for a CLI update first**, in machine mode too.
  It is the one command handed a payload minted by a newer dashboard than the
  CLI reading it, and it runs once per project — so the throttled check that
  suits every other command is exactly wrong here. An unrecognised `t<n>.`
  envelope now also says "this handoff needs a newer CLI" instead of reporting a
  valid handoff as invalid.

- **New API keys are 38 characters, not 70** (`agent_` plus 32 base62, ~190
  bits). Keys are pasted into chat prompts, agent config files and terminal
  commands, where the other 32 characters bought nothing. Existing keys are
  untouched and keep working.

- **`tarout whoami` leads with the account and says where it came from.** With
  per-project credentials, "who am I" and "why am I that" are the same question:
  the same directory can resolve to a different org than the machine-wide login,
  and the path of the `.tarout/auth.json` in effect is the only thing that
  explains it. It was a `Scope:` line below the fold; it is now the first line.

## [1.8.0]

### Added

- **`.tarout/config.json` — a declared deploy contract.** Health check path and
  expected status, `smokePaths`, `releaseCommand`, build overrides, which
  resources to provision, and secrets to generate once. Committed to the repo,
  so a teammate, an agent and CI all get the same deploy instead of whatever the
  dependency scan happened to infer. Precedence is manifest > app settings >
  detection, and a declaration wins in both directions — `"postgres": false` in
  a repo that depends on `pg` means no database. A malformed manifest fails the
  command and names the field rather than silently falling back to guessing.
- **`tarout deploy:retry <app>`** re-runs only the deploy step of a *failed*
  deployment, reusing the image it already built. For the case where the build
  succeeded and everything after it did not — image pull failed, registry token
  stale, target host unavailable — where redeploying from scratch rebuilds an
  identical image for nothing. Also exposed as the `deployment_retry` MCP tool.
- **`tarout env list` reports build visibility.** A new `AVAILABLE` column shows
  `build + runtime` or `runtime only`, and `tarout env set` says so when a key
  is runtime-only. Only public-prefixed keys reach the build; everything else
  exists only in the running container, which is why a build reading
  `DATABASE_URL` sees nothing however correctly it was set. `tarout up` prints
  the runtime-only variables it just injected.

### Changed

- **`tarout whoami` no longer signs you in.** It was covered by the root
  preAction hook's auto-authentication, so a logged-out `tarout whoami --json`
  opened a browser and blocked there instead of answering the question. That
  made it useless as the thing it is supposed to be — the cheap first check that
  separates "not signed in" from every other failure — and it dragged an agent
  holding a pasted API key into a browser sign-in before it could store the key
  it already had. It now reports `AUTH_ERROR` (exit 3) and changes nothing,
  like `gh auth status` or `vercel whoami`. Sign in with `tarout login`.

- **`tarout agent init` and the `AI.md` identity block lead with that check.**
  Both now tell an agent to run `tarout whoami --json` first and authenticate
  only when it fails, and they map the two credential shapes a pasted Tarout
  prompt can carry: `Key: …` → `tarout login --token`, `Handoff: t1.…` →
  `tarout agent connect --handoff`. A handoff is single use and expires five
  minutes after it was copied, so they also say not to retry a dead one.

- **Credentials are now project-scoped by default.** Every authentication path —
  `tarout login`, `tarout login --token`, `tarout token`, `tarout register`, and
  the sign-in that `deploy`/`up`/`init` trigger — writes `./.tarout/auth.json`
  instead of a machine-wide profile. `--local` was the opt-in for this on the
  token paths only, and browser `login` could not do it at all; `--local` is now
  the default and stays accepted as a no-op alias.

  A credential handed to an agent is a credential for *one* project. Storing it
  machine-wide meant connecting project B silently re-pointed project A at
  another account.

  Machine-wide is still available with `--global` on `login` / `token` /
  `register` / `logout` / `agent connect`, and `--global-auth` ignores the
  project layer for a single command. Running `tarout login` somewhere that is
  not a project (no `.tarout`, `.git`, or package manifest above it) falls back
  to the machine-wide profile and says so, so a scratch shell does not get a
  stray `.tarout/`. Every login now prints the path it wrote.

- **`TAROUT_TOKEN` is no longer documented.** It still works, unchanged, as the
  lowest-precedence fallback — but it was always ignored whenever a stored
  profile existed, which made it a misleading thing to recommend. Docs, CLI
  hints, and MCP error messages now point at `tarout login --token <key>`.

### Fixed

- **`--json` deploys printed TWO terminal envelopes on failure and timeout.**
  The stream emitted a full envelope and then threw, so the global handler
  printed a second, lossier one that dropped `errorAnalysis`, `logs` and
  `deploymentId`. An agent parsing stdout as one JSON document failed outright;
  one taking last-line-wins silently lost the suggested fixes its own
  instructions told it to read. There is now exactly one terminal envelope, and
  a test asserts it.
- **A Docker build failure reported `DEPLOYMENT_FAILED` while exiting `12`
  (`BUILD_FAILED`).** The envelope code and the exit code were computed from two
  different category lists; they now come from one.
- **`tarout agent init` broke Biome in the project it set up.**
  `.claude/settings.local.json` was always written with two-space indent, and
  Biome's default is tab, so `biome ci` failed on a file the user never wrote.
  Indentation is now detected from `biome.json`/`biome.jsonc`, `.editorconfig`,
  Prettier config, or the existing file. `agent init --json` also emits the
  documented `{success, data}` envelope instead of a bespoke shape.
- **`.tarout/project.json` was written without a trailing newline.**
- **Credential rejections now say why, when the server knows.** The server
  supplies a reason (`key_revoked`, `key_frozen`, `insufficient_tier`,
  `needs_approval`, `no_project`, …) and the CLI maps it to specific guidance.
  Without one it stays deliberately vague rather than guessing — an earlier
  version guessed "revoked", was wrong, and sent an agent looking for a
  different credential, which deployed into another organization.
- **"Invalid or expired Tarout credential"** no longer says "expired": agent
  keys have no expiry, and an agent told otherwise concludes the key aged out
  and stops.
- **The `deploy` MCP tool reported a wait-window timeout as success.** It now
  returns `DEPLOYMENT_TIMEOUT` with `stillRunning: true`, so an agent resumes
  polling instead of treating an unfinished deployment as shipped.

- **`deploy` / `up` / `init` no longer copy a project credential into the
  machine-wide store.** `ensureAuthenticatedForDeploy` re-resolved the active
  token on every run and persisted the result with `setProfile("default", …)`.
  Inside a project-scoped directory the token being refreshed was the
  *project's*, so each deploy overwrote the user's global login and re-pointed
  every unrelated directory at this project's account — surfacing later as "my
  login changed by itself". It now refreshes whichever layer is actually in
  effect.

- **`tarout-mcp` resolves credentials from the project it is asked to act on.**
  Credential lookup started from the MCP server's own `process.cwd()`, which is
  set by the editor that launched it — often not the project. A server started
  outside the project reported `AUTH_ERROR` for a project that was perfectly
  well authenticated. Tools that take a `path` argument now resolve from it.

## [1.7.0]

### Added

- **Compact dashboard handoff (`t1.…`).** The one-command agent setup copied from
  the dashboard was ~475 characters, because the payload was JSON-encoded and then
  base64-encoded whole — the key names and base64 inflation dominated, not the
  values. The new positional format carries the **same** fields (code, PKCE
  verifier, expected identity, expiry, and a non-default API origin) in **~58%
  fewer characters**. `decodeAgentHandoff` still accepts the old v1 blob, so a
  command copied from an older dashboard keeps working.

## [1.6.0]

### Added

- **Scheduled tasks (cron) in the CLI and for agents.** The platform's
  `scheduledJob` router now has a dedicated command namespace and curated MCP
  tools, so neither a human nor an agent has to fall back to `tarout call`.
  - CLI `tarout jobs`: `list`, `info`, `create`, `update`, `delete` (alias
    `rm`), `enable`, `disable`, `run`, `runs`. `--app` defaults to the linked
    application (like `tarout dev` / `build`); `jobs list` without a link shows
    every task in the organization.
  - Both task kinds are covered: `--type http` fires a signed request at the
    app's own URL, `--type command` runs a shell command inside the app's
    running container (which requires a deployed app and a `--command`).
  - `tarout jobs run <id> --wait` handles the asymmetry between them: HTTP runs
    return their outcome inline, command runs are queued, so `--wait` polls the
    run history until the new run lands and then prints its exit code and
    captured output.
  - Rejections come back actionable: not-yet-deployed app, the 60s HTTP timeout
    cap, plan task limits and minimum interval, and bad cron/timezone all carry
    the next command to run.
- **7 MCP tools**: `job_list`, `job_info`, `job_create`, `job_update`,
  `job_delete`, `job_run`, `job_runs` — with descriptions that spell out the
  HTTP-vs-COMMAND split and that a queued command run must be collected via
  `job_runs`.
- **Deploy progress is no longer a black box.** `tarout deploy`/`up --wait` now
  emits a forward-progress signal on every server-side phase change and at least
  every 15s — a structured `{ "event": "deploy_progress", "phase", "status",
  "elapsedSec" }` NDJSON line under `--json` (so an agent can tell *queued* from
  *building* from *activating* instead of blind-polling), and a dim status line
  interactively when the live log stream isn't already narrating. Reads the new
  `phase` field the platform now returns on `deployment.one`.
- **DB-TLS failures are now a categorized error with the exact fix.** The deploy
  error classifier recognizes managed-Postgres TLS mismatches (`no pg_hba…no
  encryption`, `SSL … required`, `sslmode`, self-signed cert) as a new
  `database_tls` category — ranked ahead of the generic `network` pattern — and
  returns the concrete node-postgres / Prisma-adapter ssl remedy instead of a
  generic "unknown".
- **`tarout deploy` inspection now flags backend vs static.** The pre-deploy
  project inspection detects whether the project ships a backend server (Express/
  Fastify/Nest/Hono/etc., a non-JS runtime, a Dockerfile, or a serverless
  function directory) versus a pure static front-end, and surfaces it in the
  inspection summary (`Backend: server detected` / `Static site`).

### Changed

- **`deploy`/`up --wait` client window raised 10 → 20 min, and a client-side
  timeout no longer reads as a failure.** It now reports the deploy as *still
  running* server-side with the last phase and a `tarout deploy:status` resume
  command (`stillRunning: true` in the JSON envelope), so a slow-but-healthy
  deploy stops surfacing as a false `DEPLOYMENT_TIMEOUT`.
- **Self-update no longer forces an npm-registry round-trip on every automated
  deploy.** In machine mode (`--json` or a non-TTY agent/CI run) `up`/`deploy`
  fall back to the throttled self-update (still at most once per few hours)
  instead of forcing an immediate check, removing up to ~2.5s from every deploy
  in a tight agent edit→deploy loop. Interactive human deploys still force the
  check (always-latest). Opt-outs unchanged.

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
