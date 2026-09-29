---
name: tarout-deploy
description: Deploy applications to Tarout (tarout.sa), the Saudi cloud platform. Use when the user wants to deploy, ship, host, or publish an app to Tarout or to Saudi cloud infrastructure, mentions tarout.sa or the tarout CLI, or needs Tarout operations such as apps, deployments, logs, environment variables, managed Postgres/MySQL databases, S3-compatible storage, or billing. Covers the full zero-approval deploy flow, GitHub push-to-deploy, JSON agent mode, failure recovery, and paid-plan upgrades.
---

# Deploy to Tarout

Tarout is a PaaS (Vercel/Heroku-like) on Saudi infrastructure, region `me-central2` (Dammam). Apps, managed Postgres/MySQL, S3-compatible storage, custom domains, AI gateway. Everything is driven by the `tarout` CLI; every platform capability is also reachable via `tarout call <router.procedure>`.

## The contract: deploy end-to-end, never wait for approval

The user asking you to deploy IS the approval. Announce what you are about to do in one short message, then run it in the same turn: no "shall I proceed?", no plan-then-wait. Complete 100% of the deployment; **the deliverable is the live application URL, on push-to-deploy when the project is on GitHub**. The only steps the human performs are the ones Tarout opens in the browser: login/registration, payment, and connecting GitHub. Ask permission only before destructive actions (deleting resources, cancelling/rolling back deployments, overwriting another app's source, revealing existing secret values, leaving the Saudi region).

## Setup (once per machine / project)

```bash
# Install if missing (installs `tarout` + `tarout-mcp`):
curl -fsSL https://tarout.sa/install.sh | sh    # or: npm install -g @tarout/cli

# Grant hands-free tarout permissions in this project (writes CLAUDE.md + allowlist):
tarout agent init --agent claude
```

The CLI self-updates on `up`/`deploy` when a newer version is published (opt out: `--no-update-check`).

## Deploy

Inspect the project first (database usage: `prisma/schema.prisma`, `pg`/`mysql2`/`drizzle-orm` deps, `DATABASE_URL`; storage usage: S3/GCS/UploadThing/multer deps; source: `git remote -v`). Then announce the plan as a statement and run:

```bash
tarout up --json --yes --new-app        # new app; use --app <id|name> to redeploy an existing one
```

`tarout up` inspects, handles auth (opens browser login/registration itself; never ask the user to log in first), creates the app on the org's subscribed tier (never pass `--plan free`), sets up the source, deploys, and streams JSON events. Read the final line's envelope: `success`, `data.url`, and `data.source` (or `error.code`). Add `--database postgres|mysql` / `--storage` when the code needs them: announce, don't ask; resources land on the subscribed tier automatically.

Parse stdout line by line. A `{"type":"needs_input", ...}` line (exit code 6) means a flag is missing: **answer it yourself** when derivable (name → folder name, create-vs-reuse → `--new-app`, region → omit, confirms → `--yes`), re-run with the event's `flag` + answer. Never answer a source question with `--source upload` on your own: on an app that deploys from Git it replaces the repo with this folder and ends push-to-deploy. Relay to the human only what you cannot know: a sign-in on a headless machine (run `tarout login --device --json` and relay the code and URL from its first line, or ask for an API token for `tarout login --token <key>` / `TAROUT_TOKEN`) or a payment.

Exit codes: 0 success · 1 general · 2 invalid args · 3 auth · 4 not found · 5 permission denied · 6 needs input · 10 deployment failed · 11 deployment timeout · 12 build failed · 13 checkout pending.

## A project on GitHub deploys from GitHub

If `git remote -v` shows a github.com remote, the app must build from that repo so every push deploys. An uploaded folder only changes when someone reruns the CLI, so it goes stale the moment work is pushed instead of deployed.

- `up` and `deploy` bind the repo themselves when the org's GitHub connection can read it. **Never pass `--source upload`** unless the user asked for an upload: it switches that bind off.
- When the org has no GitHub connection, or its connection cannot read the repo, the deploy still uploads so the user gets their deploy, and the final envelope says so: `data.source.pushToDeploy` is `false` and `data.source.next` holds the fix. **Run it in the same turn**, don't just mention it:

  ```bash
  tarout providers github connect --wait --app <app-id>
  ```

  It opens Tarout's GitHub setup in the browser, waits until GitHub can read the repo, and binds the app. Tell the user to finish the GitHub step in that tab, exactly as they finish login or payment. It waits up to 8 minutes (`--timeout <seconds>`); on a timeout, tell the user what is left and rerun it when they are done.
- An existing app on upload (`sourceType: "drop"` in `tarout apps info <app> --json`) whose folder has a GitHub remote is the same gap: close it with the same command.
- A GitHub build ships what is **pushed**, not this folder. For such an app, pushing IS deploying; a request to deploy covers pushing the commits it needs, unless your instructions require separate approval to push, in which case ask for that one approval. When local commits or edits are not on the built branch, the envelope lists them in `data.warnings`: relay them and never report unpushed work as live.

## When a deploy fails: fix and redeploy

Never stop at the first failure and never retry unchanged. Read `error.details.errorAnalysis.suggestedFixes` and `tarout deploy:logs <deployment-id>`, fix the project yourself (missing start script, app not listening on `PORT`, missing lockfile/dependency, missing env var via `tarout env <app> set KEY=value`, oversized upload: prune `node_modules`/build output), then redeploy. For a GitHub-sourced app, commit and push the fix. Up to 3 fix attempts; stop only when the same error survives a fix with nothing left to change, or the fix needs something only the user has.

## Paid plans (`NEEDS_UPGRADE` / plan limit reached)

Don't pre-ask in chat. Tell the user you're opening Tarout checkout and run:

```bash
tarout billing upgrade --json --yes --plan <planKey> --billing-period monthly
```

It opens the payment page and polls to completion: completing payment IS the user's approval; closing checkout is refusal. Then retry the blocked command.

## Env vars & secrets

Setting the variables the app needs to run (generated auth secrets, `DATABASE_URL` wiring) is part of the deploy: do it and say so (`tarout env <app> set KEY=value`). Ask only before revealing existing secret values (`tarout env <app> reveal KEY`).

## Report the result

End with a compact block: app name + live URL (`data.url`), source (`GitHub owner/repo (branch), pushes deploy` or `uploaded folder`, from `data.source`), database (type or none), storage, region `me-central2 (Dammam)`, dashboard link `https://tarout.sa/dashboard`. Never end a deploy of a GitHub project with the app still on upload and no connect attempt. Offer next steps: env vars, custom domain (see the tarout-domains skill), `tarout dev` for local dev with cloud env vars.

## Full references (raw markdown, agent-friendly)

- Complete onboarding guide: https://tarout.sa/docs/for-ai/onboarding.md
- CLI reference: https://tarout.sa/docs/for-ai/cli-reference.md
- JSON envelope schema: https://tarout.sa/docs/for-ai/cli-json-schema.md
- Everything else: https://tarout.sa/llms.txt (any docs page + `.md` serves raw markdown)
