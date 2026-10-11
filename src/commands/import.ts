import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError, InvalidArgumentError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	shouldSkipConfirmation,
	warn,
} from "../lib/output.js";
import {
	buildSourceInput,
	countEnvSources,
	DEFAULT_TOKEN_ENV,
	detectImportProvider,
	IMPORT_PROVIDERS,
	type ImportPlanResponse,
	type ImportProvider,
	type ImportReport,
	type ImportRunResult,
	type ImportStatus,
	readDatabaseUrls,
	readSourceToken,
	waitForImport,
} from "../lib/platform-import.js";
import { confirm, password } from "../utils/prompts.js";
import { startSpinner, stopSpinner, succeedSpinner, updateSpinner } from "../utils/spinner.js";

const DATABASE_MODES = ["copy", "empty", "keep"] as const;
const DATABASE_PLANS = ["STARTER", "STANDARD", "PRO"] as const;
const DEFAULT_WAIT_MINUTES = 30;

const PROVIDER_LABEL: Record<ImportProvider, string> = { vercel: "Vercel", render: "Render" };

interface ImportOptions {
	from?: string;
	project?: string;
	team?: string;
	service?: string[];
	only?: string[];
	database?: string;
	databasePlan?: string;
	databaseUrlEnv?: string[];
	tokenEnv?: string;
	deploy: boolean;
	wait: boolean;
	waitMinutes?: string;
	dryRun?: boolean;
}

function collect(value: string, previous: string[] = []): string[] {
	return [...previous, ...value.split(",").map((part) => part.trim()).filter(Boolean)];
}

export function printPlan({ plan, repoAccess }: ImportPlanResponse): void {
	log("");
	log(colors.bold(`Import from ${PROVIDER_LABEL[plan.provider]}: ${plan.sourceName}`));
	log("");
	for (const service of plan.services) {
		const counts = countEnvSources(service.env);
		const access = repoAccess[service.key];
		log(
			`  ${colors.cyan(service.key)}  ${service.kind} app${service.repo ? `  ${colors.dim(`${service.repo.owner}/${service.repo.repository}${service.repo.branch ? `@${service.repo.branch}` : ""}`)}` : ""}${access === false ? `  ${colors.error("no repo access")}` : ""}`,
		);
		const parts = Object.entries(counts).map(([source, count]) => `${count} ${source}`);
		log(colors.dim(`      variables: ${service.env.length}${parts.length ? ` (${parts.join(", ")})` : ""}`));
	}
	for (const database of plan.databases) {
		log(`  ${colors.cyan(database.key)}  ${database.engine} database "${database.name}"`);
	}
	for (const job of plan.jobs) {
		log(`  ${colors.cyan(job.key)}  ${job.jobType} job ${job.cron} on ${job.serviceKey}`);
	}
	if (plan.domains.length > 0) {
		log(`  domains: ${plan.domains.map((domain) => domain.host).join(", ")}`);
	}
	if (plan.issues.length > 0) {
		log("");
		for (const issue of plan.issues) {
			const tag =
				issue.severity === "blocker"
					? colors.error("blocker")
					: issue.severity === "warning"
						? colors.warn("warning")
						: colors.dim("note");
			log(`  ${tag}  ${issue.message}`);
			log(colors.dim(`           ${issue.fix}`));
		}
	}
	log("");
}

export function printReport(report: ImportReport): void {
	log("");
	log(colors.bold(report.complete ? "Import complete" : "Import in progress"));
	log("");
	for (const item of report.moved) {
		log(`  ${colors.success("✓")} ${item.name}: ${item.detail}`);
	}
	if (report.notMoved.length > 0) {
		log("");
		log(colors.bold("Needs your attention"));
		for (const item of report.notMoved) {
			log(`  ${colors.warn("!")} ${item.name}: ${item.message}`);
			log(colors.dim(`      ${item.fix}`));
		}
	}
	if (report.domains.length > 0) {
		log("");
		log(colors.bold("Domains"));
		for (const domain of report.domains) {
			log(`  ${domain.host}`);
			log(colors.dim(`      ${domain.steps}`));
			log(`      ${colors.cyan(domain.command)}`);
		}
	}
	if (report.notes.length > 0) {
		log("");
		for (const note of report.notes) log(colors.dim(`  ${note.message} ${note.fix}`));
	}
	log("");
}

export function registerImportCommands(program: Command) {
	program
		.command("import")
		.description(
			"Move a project from Vercel or Render: apps, env vars, the database with its data, jobs and a domain plan",
		)
		.option("--from <platform>", `Source platform: ${IMPORT_PROVIDERS.join(" | ")} (default: detected from the repo)`)
		.option("--project <name>", "Vercel project name or prj_ id (default: .vercel/project.json)")
		.option("--team <id>", "Vercel team id for a team project")
		.option("--service <names>", "Render service name(s) to read (repeatable or comma-separated)", collect)
		.option("--only <keys>", "Import only these services from the plan (repeatable or comma-separated)", collect)
		.option("--database <mode>", `copy | empty | keep (default: copy)`)
		.option("--database-plan <plan>", "STARTER | STANDARD | PRO (default: STARTER)")
		.option(
			"--database-url-env <db=ENV_VAR>",
			"Read a source database URL from an environment variable (repeatable)",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option(
			"--token-env <ENV_VAR>",
			`Environment variable holding the source token (default: ${DEFAULT_TOKEN_ENV.vercel} / ${DEFAULT_TOKEN_ENV.render})`,
		)
		.option("--no-deploy", "Create everything but do not deploy")
		.option("--no-wait", "Return once the import started instead of waiting for the database copy")
		.option("--wait-minutes <n>", `How long to wait for the database copy (default: ${DEFAULT_WAIT_MINUTES})`)
		.option("--dry-run", "Show what would be created, then stop")
		.addHelpText(
			"after",
			`
The source token is read from ${DEFAULT_TOKEN_ENV.vercel} (Vercel) or ${DEFAULT_TOKEN_ENV.render} (Render),
or asked for without echo. It is used for this import only and never stored.

Examples:
  $ VERCEL_TOKEN=... tarout import --dry-run
  $ tarout import --from render --service api --service worker
  $ tarout import --database keep           # keep using the current database
`,
		)
		.action(async (options: ImportOptions) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const cwd = process.cwd();
				const provider = (options.from ?? detectImportProvider(cwd)) as ImportProvider | null;
				if (!provider) {
					throw new InvalidArgumentError(
						"Could not tell which platform this repo is on. Pass --from vercel or --from render.",
					);
				}
				if (!IMPORT_PROVIDERS.includes(provider)) {
					throw new InvalidArgumentError(
						`Unsupported source "${provider}". Supported: ${IMPORT_PROVIDERS.join(", ")}.`,
					);
				}
				const databaseMode = (options.database ?? "copy") as (typeof DATABASE_MODES)[number];
				if (!DATABASE_MODES.includes(databaseMode)) {
					throw new InvalidArgumentError(`--database must be one of ${DATABASE_MODES.join(", ")}.`);
				}
				const databasePlan = (options.databasePlan ?? "STARTER").toUpperCase() as (typeof DATABASE_PLANS)[number];
				if (!DATABASE_PLANS.includes(databasePlan)) {
					throw new InvalidArgumentError(`--database-plan must be one of ${DATABASE_PLANS.join(", ")}.`);
				}
				const waitMinutes = options.waitMinutes ? Number(options.waitMinutes) : DEFAULT_WAIT_MINUTES;
				if (!Number.isFinite(waitMinutes) || waitMinutes <= 0) {
					throw new InvalidArgumentError("--wait-minutes must be a positive number.");
				}

				let token = readSourceToken(provider, options.tokenEnv);
				if (!token) {
					const variable = options.tokenEnv || DEFAULT_TOKEN_ENV[provider];
					token =
						(
							await password(`${PROVIDER_LABEL[provider]} token (or set ${variable}):`, {
								field: "source_token",
								flag: "--token-env",
								sensitive: true,
								context: {
									hint: `Set ${variable} in the environment so the token never passes through a prompt or chat.`,
								},
							})
						).trim() || undefined;
				}
				const databaseUrls = readDatabaseUrls(options.databaseUrlEnv);

				const client = getApiClient();
				const source = buildSourceInput({
					provider,
					cwd,
					token,
					project: options.project,
					teamId: options.team,
					services: options.service,
				});

				startSpinner(`Reading the ${PROVIDER_LABEL[provider]} project...`);
				const planned: ImportPlanResponse = await client.platformImport.plan.mutate(source);
				succeedSpinner();

				if (options.dryRun) {
					if (isJsonMode()) {
						outputData(planned);
						return;
					}
					printPlan(planned);
					log(colors.dim("Dry run: nothing was created. Run again without --dry-run to import."));
					return;
				}
				if (!isJsonMode()) printPlan(planned);

				const selected = options.only?.length
					? planned.plan.services.filter((service) => options.only?.includes(service.key))
					: planned.plan.services;
				const noAccess = selected.filter((service) => planned.repoAccess[service.key] === false);
				if (noAccess.length > 0) {
					throw new InvalidArgumentError(
						`Tarout cannot read ${noAccess.map((service) => `${service.repo?.owner}/${service.repo?.repository}`).join(", ")} yet. Install the Tarout GitHub App on it (run \`tarout deploy\` once in that repo), then import again.`,
					);
				}

				if (!shouldSkipConfirmation() && !isJsonMode()) {
					const ok = await confirm(
						`Create ${selected.length} app(s) on Tarout${databaseMode === "keep" ? "" : ` and ${planned.plan.databases.length} database(s)`}?`,
						true,
						{ field: "confirm_import", flag: "--yes" },
					);
					if (!ok) {
						log("Cancelled. Nothing was created.");
						return;
					}
				}

				startSpinner("Creating apps, variables and databases...");
				const result: ImportRunResult = await client.platformImport.start.mutate({
					...source,
					selection: {
						...(options.only?.length ? { services: options.only } : {}),
						databaseMode,
						databasePlan,
						deploy: options.deploy,
						...(databaseUrls ? { databaseUrls } : {}),
					},
				});
				succeedSpinner(`Created ${result.apps.length} app(s)`);

				let status: ImportStatus | null = null;
				let timedOut = false;
				if (options.wait) {
					startSpinner(result.next === "wait_for_copy" ? "Copying the database..." : "Finishing...");
					const waited = await waitForImport(client, result.runId, {
						deploy: options.deploy,
						timeoutMs: waitMinutes * 60_000,
						onProgress: (current) => {
							const running = Object.values(current.copies).find((copy) => copy.status === "copying");
							if (running?.message) updateSpinner(`Copying the database: ${running.message}`);
						},
					});
					stopSpinner();
					status = waited.status;
					timedOut = waited.timedOut;
				} else {
					status = await client.platformImport.status.query({ runId: result.runId });
				}

				if (isJsonMode()) {
					outputData({ result, status, timedOut });
					return;
				}
				if (status) printReport(status.report);
				for (const app of result.apps) {
					log(`  ${colors.cyan(app.appName)}${app.url ? `  ${app.url}` : ""}`);
				}
				log("");
				if (timedOut || status?.state === "copying") {
					warn(
						`The database copy is still running. Check it with \`tarout import status ${result.runId}\`.`,
					);
				} else if (status?.state === "ready" && !options.deploy) {
					log(`Deploy when ready: ${colors.dim(`tarout import status ${result.runId} --deploy`)}`);
				}
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		})
		.command("status")
		.argument("<runId>", "Import run id")
		.option("--deploy", "Deploy the apps if the copy has finished")
		.description("Show an import's database copy progress and report")
		.action(async (runId: string, options: { deploy?: boolean }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				let status: ImportStatus = await client.platformImport.status.query({ runId });
				if (options.deploy && status.state === "ready") {
					await client.platformImport.finish.mutate({ runId });
					status = await client.platformImport.status.query({ runId });
				}
				if (isJsonMode()) {
					outputData(status);
					return;
				}
				printReport(status.report);
				if (status.state === "copying") log(colors.dim("The database copy is still running."));
			} catch (err) {
				handleError(err);
			}
		});
}
