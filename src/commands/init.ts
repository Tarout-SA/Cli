/**
 * `tarout init [path]` — the scaffold/auto-provision half of the
 * `init → dev → deploy` agent loop.
 *
 * Unlike `tarout up` (which creates → uploads → deploys in one shot), `init`
 * sets up the project's BACKEND and a ready local dev environment WITHOUT
 * shipping: it inspects the project, creates (or reuses) the Tarout app, links
 * the directory, provisions the database/storage the project needs, and writes
 * the resulting connection strings to a local `.env` so `tarout dev` works
 * immediately. The agent then writes code and runs `tarout deploy` (or `up`).
 *
 * Agent-first: FREE plan, source-less, non-interactive, JSON event stream.
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Command } from "commander";
import { ensureAgentSetup } from "../lib/agent-setup.js";
import { getApiClient } from "../lib/api.js";
import { getProjectConfig } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputJsonLine,
} from "../lib/output.js";
import { envVarsToObject } from "../lib/process.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { formatAppUrl } from "../utils/url.js";
import {
	type AppSummary,
	configureOptionalResources,
	createAppFromCurrentDirectory,
	emitNeedsUpgrade,
	ensureAuthenticatedForDeploy,
	findApp,
	inspectCurrentProject,
	isEntitlementError,
} from "./deploy.js";

const DEFAULT_REGION = "me-central2";

interface InitOptions {
	apiUrl?: string;
	database?: string;
	databasePlan?: string;
	description?: string;
	envWrite?: boolean; // commander sets false for --no-env-write
	name?: string;
	plan?: string;
	region?: string;
	scaffold?: boolean;
	storage?: boolean;
	storagePlan?: string;
	token?: string;
	agentSetup?: boolean; // commander sets false for --no-agent-setup
}

const STARTER_INDEX_JS = `import { createServer } from "node:http";

const port = process.env.PORT || 3000;

createServer((_req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ ok: true, message: "Hello from Tarout" }));
}).listen(port, () => {
	console.log(\`Listening on http://localhost:\${port}\`);
});
`;

function toPackageName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "tarout-app"
	);
}

/** Write a minimal Node starter ONLY when the directory has no package.json. */
function scaffoldStarter(cwd: string): string[] {
	const written: string[] = [];
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) return written; // never overwrite an existing project
	const pkg = {
		name: toPackageName(basename(cwd) || "tarout-app"),
		version: "0.1.0",
		private: true,
		type: "module",
		scripts: { start: "node index.js", dev: "node index.js" },
	};
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
	written.push("package.json");
	const indexPath = join(cwd, "index.js");
	if (!existsSync(indexPath)) {
		writeFileSync(indexPath, STARTER_INDEX_JS);
		written.push("index.js");
	}
	return written;
}

function envValueNeedsQuote(value: string): boolean {
	return /\s|#|"|'/.test(value);
}

/**
 * Write provisioned env vars (DATABASE_URL, storage creds, …) to a local file.
 * Never clobbers an existing `.env` — falls back to `.env.tarout` so the agent
 * can merge intentionally.
 */
function writeEnvFile(cwd: string, vars: Record<string, string>): string {
	const lines = Object.entries(vars).map(
		([k, v]) => `${k}=${envValueNeedsQuote(v) ? JSON.stringify(v) : v}`,
	);
	const primary = join(cwd, ".env");
	const target = existsSync(primary) ? join(cwd, ".env.tarout") : primary;
	writeFileSync(target, `${lines.join("\n")}\n`, { mode: 0o600 });
	return target;
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.argument("[path]", "Project directory (defaults to current)")
		.description(
			"Provision a project backend (app, database, storage, env) and link it — the start of init → dev → deploy",
		)
		.option(
			"--api-url <url>",
			"Custom API URL (defaults to saved profile or https://tarout.sa)",
		)
		.option("--token <token>", "API token for this run")
		.option("--name <name>", "Application name (defaults to directory name)")
		.option(
			"--plan <plan>",
			"App hosting plan: free, shared, or dedicated (defaults to your org's subscribed tier)",
		)
		.option("-r, --region <region>", "Deployment region", DEFAULT_REGION)
		.option("--description <text>", "Description for the newly created app")
		.option(
			"--database <type>",
			"Provision a database: none, postgres, or mysql (defaults to auto-detected)",
		)
		.option("--database-plan <plan>", "Database plan (e.g. free, starter)")
		.option("--storage", "Provision file storage")
		.option("--storage-plan <plan>", "Storage plan (e.g. free, starter)")
		.option("--scaffold", "Write a minimal starter app if the directory is empty")
		.option("--no-env-write", "Do not write a local .env file with connection strings")
		.option(
			"--no-agent-setup",
			"Don't auto-write the agent permission allowlist (CLAUDE.md / .claude/settings.local.json) on first run",
		)
		.action(async (cwdArg: string | undefined, options: InitOptions) => {
			try {
				const cwd = cwdArg ? resolve(cwdArg) : process.cwd();
				if (cwdArg) process.chdir(cwd);

				// Onboarding step 0: in agent mode, grant the agent permission to run
				// tarout commands (idempotent) before provisioning anything.
				ensureAgentSetup(cwd, options.agentSetup === false);

				if (options.scaffold) {
					const files = scaffoldStarter(cwd);
					emitEvent({ event: "scaffold_done", files });
				}

				emitEvent({ event: "inspect_started", cwd });
				const inspection = inspectCurrentProject(cwd);
				emitEvent({
					event: "inspect_done",
					database: inspection.database,
					storage: inspection.storage,
					git: inspection.git,
				});

				emitEvent({ event: "auth_check_started" });
				const profile = await ensureAuthenticatedForDeploy({
					apiUrl: options.apiUrl,
					token: options.token,
					region: options.region,
				});
				emitEvent({
					event: "auth_check_done",
					userEmail: profile.userEmail,
					organization: profile.organizationName,
				});

				const client = getApiClient();

				// Reuse the linked app if present (idempotent re-init), else create.
				let app: AppSummary | undefined;
				let createdApp = false;
				const linked = getProjectConfig();
				if (linked) {
					const apps =
						(await client.application.allByOrganization.query()) as AppSummary[];
					const existing =
						findApp(apps, linked.applicationId) ?? findApp(apps, linked.name);
					if (existing) {
						app = existing;
						emitEvent({
							event: "app_reused",
							applicationId: app.applicationId,
							name: app.name,
						});
					}
				}

				if (!app) {
					try {
						emitEvent({ event: "app_create_started" });
						app = await createAppFromCurrentDirectory(client, profile, {
							name: options.name,
							plan: options.plan,
							region: options.region,
							description: options.description,
						});
						createdApp = true;
						emitEvent({
							event: "app_create_done",
							applicationId: app.applicationId,
							name: app.name,
							plan: app.plan ?? options.plan ?? "free",
						});
					} catch (err) {
						// `init` is agent-first/non-interactive: hand back the structured
						// NEEDS_UPGRADE envelope (both buy-addon and upgrade-plan options,
						// current-plan-aware) so the agent asks the user which to run, then
						// retries `tarout init`.
						if (isEntitlementError(err)) {
							await emitNeedsUpgrade(
								getApiClient(),
								err,
								options.plan,
								"tarout init",
							);
							exit(ExitCode.PERMISSION_DENIED);
						}
						throw err;
					}
				}

				if (!app) {
					throw new AuthError();
				}

				// Provision the detected/requested backend on first creation only.
				if (createdApp) {
					emitEvent({
						event: "provision_started",
						database: inspection.database,
						storage: inspection.storage,
					});
					await configureOptionalResources(
						client,
						profile,
						app,
						{
							database: options.database,
							databasePlan: options.databasePlan,
							storage: options.storage,
							storagePlan: options.storagePlan,
						},
						inspection,
					);
					emitEvent({ event: "provision_done" });
				}

				// Pull the env vars the provisioning injected (DATABASE_URL, storage
				// creds, …) and write them locally so `tarout dev` works immediately.
				let envFile: string | null = null;
				let envCount = 0;
				if (options.envWrite !== false) {
					try {
						const variables = await client.envVariable.list.query({
							applicationId: app.applicationId,
							includeValues: true,
						});
						const vars = envVarsToObject(variables);
						envCount = Object.keys(vars).length;
						if (envCount > 0) {
							envFile = writeEnvFile(cwd, vars);
							emitEvent({ event: "env_written", file: envFile, count: envCount });
						}
					} catch (err) {
						emitEvent({
							event: "env_write_skipped",
							reason: err instanceof Error ? err.message : "unknown",
						});
					}
				}

				const url = formatAppUrl((app as { appSubdomain?: string }).appSubdomain);

				if (isJsonMode()) {
					outputJsonLine({
						type: "result",
						ok: true,
						applicationId: app.applicationId,
						name: app.name,
						url,
						envFile,
						envCount,
						nextSteps: ["tarout dev", "tarout deploy --wait"],
					});
					return;
				}

				box("Project initialized", [
					`Application: ${colors.cyan(app.name)}`,
					`ID: ${colors.dim(app.applicationId)}`,
					...(envFile ? [`Env file: ${colors.dim(envFile)} (${envCount} vars)`] : []),
				]);
				log("Next steps:");
				log(`  ${colors.dim("tarout dev")}            - Run locally with cloud env vars`);
				log(`  ${colors.dim("tarout deploy --wait")}  - Ship to production`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}

function emitEvent(payload: Record<string, unknown>): void {
	if (isJsonMode()) {
		outputJsonLine({ type: "event", ...payload });
	}
}
