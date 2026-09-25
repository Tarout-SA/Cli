import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Command, Option } from "commander";
import { getApiClient } from "../lib/api.js";
import { toAppNameSlug } from "../lib/app-name.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	findSimilar,
	handleError,
	NotFoundError,
} from "../lib/errors.js";
import {
	type BillingChangeResult,
	emitBillingResult,
	finalizeBillingMutation,
	resolveCheckoutAmountDisplay,
} from "../lib/billing-upgrade.js";
import { paymentBrowserOpener, shouldAutoConfirmPaidCheckout } from "../lib/browser.js";
import {
	box,
	colors,
	getStatusBadge,
	isJsonMode,
	isNonInteractiveMode,
	isQuietMode,
	log,
	outputData,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { confirm, input } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";
import {
	emitNeedsUpgrade,
	isEntitlementError,
	promptEntitlementRemedy,
	type ResourcePlan,
	resolveDatabasePlanOrExit,
} from "./deploy.js";
import { requireProfile } from "../lib/auth-profile.js";
import {
	consoleSqlProblem,
	EXTERNAL_ACCESS_MAX_CIDRS,
	EXTERNAL_ACCESS_TLS_MESSAGE,
	EXTERNAL_POOLER_DEFAULT_PORT,
	formatBytes,
	MANAGED_DB_LIFECYCLE_MESSAGE,
	MYSQL_CREATE_UNAVAILABLE_MESSAGE,
} from "../lib/managed-db.js";

type DatabaseType = "postgres" | "mysql";

function normalizeDbPlan(value: string | undefined): ResourcePlan | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toUpperCase();
	if (
		normalized === "FREE" ||
		normalized === "STARTER" ||
		normalized === "STANDARD" ||
		normalized === "PRO"
	) {
		return normalized as ResourcePlan;
	}
	throw new CliError(
		`Invalid database plan "${value}". Use free, starter, standard, or pro.`,
		ExitCode.INVALID_ARGUMENTS,
	);
}

export function assertPostgresTierChange(dbSummary: {
	type: DatabaseType;
	name: string;
}): void {
	if (dbSummary.type !== "postgres") {
		throw new CliError(
			`Tier changes are available for PostgreSQL databases only. "${dbSummary.name}" is a ${dbSummary.type} database; MySQL tier changes aren't supported yet.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
}

export function resolveDbTierTarget(
	direction: "upgrade" | "downgrade",
	raw: string | undefined,
): "STARTER" | "STANDARD" | "PRO" {
	const plan = normalizeDbPlan(raw);
	if (!plan) {
		throw new CliError("A target tier is required (--plan).", ExitCode.INVALID_ARGUMENTS);
	}
	if (plan === "FREE") {
		throw new CliError(
			"FREE is not a paid tier. To stop billing for a database, delete it instead.",
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	if (direction === "downgrade" && plan === "PRO") {
		throw new CliError(
			"PRO is the highest tier — use `tarout db upgrade` to move up.",
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	return plan as "STARTER" | "STANDARD" | "PRO";
}

/**
 * Amount due now for a database tier upgrade, read from the server preview.
 * `previewDatabaseUpgrade` returns `totalProratedHalalas`; an older preview
 * shape used `proratedChargeHalalas`, so prefer the current field and fall back
 * for compatibility. This value decides whether an agent checkout auto-confirms
 * (`shouldAutoConfirmPaidCheckout`) — reading the wrong field left it
 * permanently `undefined`, so auto-confirm never fired for db upgrades.
 */
export function resolveDatabaseUpgradeDueHalalas(
	preview:
		| { totalProratedHalalas?: unknown; proratedChargeHalalas?: unknown }
		| null
		| undefined,
): number | undefined {
	if (typeof preview?.totalProratedHalalas === "number") {
		return preview.totalProratedHalalas;
	}
	if (typeof preview?.proratedChargeHalalas === "number") {
		return preview.proratedChargeHalalas;
	}
	return undefined;
}

export interface DatabaseTierChangeInput {
	direction: "upgrade" | "downgrade";
	postgresId: string;
	targetPlan: "STARTER" | "STANDARD" | "PRO";
	wait?: boolean;
	timeoutMs?: number;
	openBrowser?: (url: string) => Promise<void>;
	onCheckoutOpened?: (info: { orderId: string; paymentUrl: string }) => void;
}

export async function runDatabaseTierChange(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	input: DatabaseTierChangeInput,
): Promise<BillingChangeResult> {
	const result =
		input.direction === "upgrade"
			? await client.subscription.purchaseDatabaseUpgrade.mutate({
					postgresId: input.postgresId,
					targetPlan: input.targetPlan,
				})
			: await client.subscription.purchaseDatabaseDowngrade.mutate({
					postgresId: input.postgresId,
					targetPlan: input.targetPlan,
				});
	return finalizeBillingMutation(client, result, {
		kind: "database",
		target: input.targetPlan,
		wait: input.wait,
		timeoutMs: input.timeoutMs,
		openBrowser: input.openBrowser,
		onCheckoutOpened: input.onCheckoutOpened,
	});
}

// An explicit --plan wins; otherwise default to the project's subscribed tier and
// auto-buy the plan-matched managed db add-on when there's no open slot (the
// shared resolver handles Free/Starter/Pro + the Dedicated bundled-slot case).
async function resolveDbPlan(
	client: any,
	explicit: string | undefined,
): Promise<ResourcePlan> {
	return resolveDatabasePlanOrExit(client, normalizeDbPlan(explicit));
}

export function registerDbCommands(program: Command) {
	const db = program.command("db").description("Manage databases");

	// List databases
	db.command("list")
		.alias("ls")
		.description("List all databases")
		.option("-t, --type <type>", "Filter by type (postgres, mysql)")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching databases...");

				// Fetch all database types
				const [postgres, mysql] = await Promise.all([
					client.postgres.allByOrganization.query(),
					client.mysql.allByOrganization.query(),
				]);

				succeedSpinner();

				// Combine and filter
				let databases: Array<{
					id: string;
					name: string;
					type: DatabaseType;
					status: string;
					created: Date | string;
				}> = [];

				if (!options.type || options.type === "postgres") {
					databases = databases.concat(
						postgres.map((db: any) => ({
							id: db.postgresId,
							name: db.name,
							type: "postgres" as DatabaseType,
							status: db.applicationStatus,
							created: db.createdAt,
						})),
					);
				}

				if (!options.type || options.type === "mysql") {
					databases = databases.concat(
						mysql.map((db: any) => ({
							id: db.mysqlId,
							name: db.name,
							type: "mysql" as DatabaseType,
							status: db.applicationStatus,
							created: db.createdAt,
						})),
					);
				}

				if (isJsonMode()) {
					outputData(databases);
					return;
				}

				if (isQuietMode()) {
					for (const db of databases) {
						if (db.id) quietOutput(db.id);
					}
					return;
				}

				if (databases.length === 0) {
					log("");
					log("No databases found.");
					log("");
					log(`Create one with: ${colors.dim("tarout db create <name>")}`);
					return;
				}

				log("");
				table(
					["ID", "NAME", "TYPE", "STATUS", "CREATED"],
					databases.map((db) => [
						// The full id: every other command (and MCP's exact-match
						// resolveDbRef) needs it, and a prefix can be ambiguous.
						colors.cyan(db.id),
						db.name,
						getTypeLabel(db.type),
						getStatusBadge(db.status),
						formatDate(db.created),
					]),
				);
				log("");
				log(
					colors.dim(
						`${databases.length} database${databases.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Create database
	db.command("create")
		.argument("[name]", "Database name")
		.description("Create a new PostgreSQL database")
		.option(
			"-t, --type <type>",
			"Database engine (only postgres is available)",
			"postgres",
		)
		.option(
			"-p, --plan <plan>",
			"Database plan: free, starter, standard, or pro (defaults to this project's entitled tier)",
		)
		.option("-d, --description <description>", "Database description")
		.option(
			"--name <name>",
			"Database name (alternative to positional argument)",
		)
		.action(async (name, options) => {
			try {
				// Only PostgreSQL can be created: mysql.create always throws
				// PRECONDITION_FAILED on the platform. Refuse before any auth or
				// API call so the answer is the same logged in or not.
				const dbType = String(options.type ?? "postgres")
					.trim()
					.toLowerCase();
				if (dbType === "mysql") {
					throw new CliError(
						`${MYSQL_CREATE_UNAVAILABLE_MESSAGE} Create one with \`tarout db create <name>\`.`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				if (dbType !== "postgres") {
					throw new CliError(
						`Unsupported database type "${options.type}". Only postgres is available.`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}

				if (!isLoggedIn()) throw new AuthError();

				const profile = await requireProfile();

				// Interactive mode if no name provided
				let dbName = name || options.name;

				if (!dbName) {
					dbName = await input("Database name:", undefined, {
						field: "db_name",
						flag: "--name",
					});
				}

				// Generate appName (URL-safe slug)
				const slug = toAppNameSlug(dbName);

				const client = getApiClient();

				// Resolve the tier from the connected org's entitlements instead of
				// letting the server fall back to its STARTER default — that default
				// produced `db.starter.slots: 1/0` for orgs that actually hold a
				// db.standard (or other) slot. An explicit --plan always wins.
				const plan = await resolveDbPlan(client, options.plan);

				const _spinner = startSpinner("Creating PostgreSQL database...");

				const database: any = await client.postgres.create.mutate({
					name: dbName,
					appName: slug,
					dockerImage: "postgres:17",
					organizationId: profile.organizationId,
					description: options.description,
					plan,
				});

				succeedSpinner("Database created!");

				// create returns postgresId (plus project). Guard against an
				// unexpectedly missing id rather than printing "undefined".
				const dbId: string | undefined = database.postgresId;

				if (isJsonMode()) {
					outputData(database);
					return;
				}

				if (dbId) quietOutput(dbId);

				box("Database Created", [
					`ID: ${colors.cyan(dbId ?? "(pending)")}`,
					`Name: ${database.name ?? dbName}`,
					`Type: ${getTypeLabel("postgres")}`,
				]);

				log("Next steps:");
				if (dbId) {
					log(
						`  View connection info: ${colors.dim(`tarout db info ${dbId}`)}`,
					);
				}
				log("");
			} catch (err) {
				// A db.*.slots entitlement gate has two ways out: buy just the
				// database addon, or upgrade the plan. `requestedPlan` stays undefined
				// — the db gate maps to an addon (or the current-plan upgrade ladder),
				// not a requested tier.
				if (isEntitlementError(err)) {
					// Non-interactive (JSON / no TTY / --yes): hand the agent the
					// structured NEEDS_UPGRADE envelope, which lists BOTH the buy-addon
					// and upgrade-plan options so it asks the user which to run.
					if (
						isJsonMode() ||
						isNonInteractiveMode() ||
						shouldSkipConfirmation()
					) {
						await emitNeedsUpgrade(
							getApiClient(),
							err,
							undefined,
							"tarout db create",
						);
						exit(ExitCode.PERMISSION_DENIED);
					}

					const message =
						err instanceof Error ? err.message : "Plan upgrade required";
					log("");
					log(colors.warn(message));

					// Interactive TTY: offer the same upgrade-vs-buy-addon chooser the
					// deploy flow uses, and apply the chosen change inline.
					const upgraded = await promptEntitlementRemedy(
						getApiClient(),
						err,
						undefined,
					);

					if (!upgraded) {
						await emitNeedsUpgrade(
							getApiClient(),
							err,
							undefined,
							"tarout db create",
						);
						exit(ExitCode.PERMISSION_DENIED);
					}

					box("Billing updated", [
						colors.success("Subscription updated."),
						`Run ${colors.cyan("tarout db create")} again to create the database.`,
					]);
					return;
				}
				handleError(err);
			}
		});

	// Delete database
	db.command("delete")
		.alias("rm")
		.argument("<db>", "Database ID or name")
		.description("Delete a database")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the database
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbInfo = findDatabase(allDbs, dbIdentifier);

				if (!dbInfo) {
					failSpinner();
					const suggestions = findSimilar(
						dbIdentifier,
						allDbs.map((d) => d.name),
					);
					throw new NotFoundError("Database", dbIdentifier, suggestions);
				}

				succeedSpinner();

				// Confirm deletion
				if (!shouldSkipConfirmation()) {
					log("");
					log(`Database: ${colors.bold(dbInfo.name)}`);
					log(`Type: ${getTypeLabel(dbInfo.type)}`);
					log(`ID: ${colors.dim(dbInfo.id)}`);
					log("");

					const confirmed = await confirm(
						`Are you sure you want to delete "${dbInfo.name}"? This cannot be undone.`,
						false,
						{
							field: "confirm_delete_db",
							flag: "--yes",
							context: { id: dbInfo.id, name: dbInfo.name, type: dbInfo.type },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting database...");

				switch (dbInfo.type) {
					case "postgres":
						await client.postgres.remove.mutate({ postgresId: dbInfo.id });
						break;
					case "mysql":
						await client.mysql.remove.mutate({ mysqlId: dbInfo.id });
						break;
				}

				succeedSpinner("Database deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, id: dbInfo.id });
				} else {
					quietOutput(dbInfo.id);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get database info
	db.command("info")
		.argument("<db>", "Database ID or name")
		.description("Show database details and connection info")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the database
				const _spinner = startSpinner("Fetching database info...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);

				if (!dbSummary) {
					failSpinner();
					const suggestions = findSimilar(
						dbIdentifier,
						allDbs.map((d) => d.name),
					);
					throw new NotFoundError("Database", dbIdentifier, suggestions);
				}

				// Get full details
				let dbDetails: any;
				switch (dbSummary.type) {
					case "postgres":
						dbDetails = await client.postgres.one.query({
							postgresId: dbSummary.id,
						});
						break;
					case "mysql":
						dbDetails = await client.mysql.one.query({ mysqlId: dbSummary.id });
						break;
				}

				succeedSpinner();

				if (isJsonMode()) {
					outputData(dbDetails);
					return;
				}

				log("");
				log(colors.bold(dbDetails.name));
				log(colors.dim(dbSummary.id));
				log("");

				// Status
				log(`${colors.bold("Status")}`);
				log(`  ${getStatusBadge(dbDetails.applicationStatus)}`);
				log(`  Type: ${getTypeLabel(dbSummary.type)}`);
				log("");

				const externalEndpoint = getExternalDatabaseEndpoint(
					dbSummary.type,
					dbDetails,
				);

				// Customer connection info. Provider-private routing is deliberately
				// never presented as a workstation fallback.
				log(`${colors.bold("Connection")}`);
				if (externalEndpoint && dbDetails.databaseName) {
					log(`  Host: ${colors.cyan(externalEndpoint.host)}`);
					log(`  Port: ${externalEndpoint.port}`);
					log(`  Database: ${dbDetails.databaseName}`);
					log(`  Username: ${dbDetails.databaseUser}`);
					log(`  Password: ${colors.dim("********")}`);
				} else {
					log(
						`  ${colors.dim("External access is disabled or unavailable. Private infrastructure addresses are not exposed.")}`,
					);
					if (dbSummary.type === "postgres") {
						log(
							`  ${colors.dim(`Enable it with: tarout db external-access ${dbSummary.id} --enable --public (or --cidrs <ip>/32)`)}`,
						);
					}
				}
				log("");

				// External access (Postgres) — surface current state so
				// `external-access` edits are informed (it preserves unspecified
				// fields; without this the allowlist is invisible).
				if (dbSummary.type === "postgres") {
					const cidrs: string[] = dbDetails.externalAllowedCidrs || [];
					log(`${colors.bold("External Access")}`);
					log(
						`  Enabled: ${dbDetails.externalAccessEnabled ? colors.success("yes") : "no"}`,
					);
					log(
						`  Public (0.0.0.0/0): ${dbDetails.externalPublicAccess ? colors.warn("yes") : "no"}`,
					);
					log(`  Require SSL: ${dbDetails.externalSslRequired ? "yes" : "no"}`);
					log(`  Allowed CIDRs: ${cidrs.length ? cidrs.join(", ") : colors.dim("none")}`);
					log("");
				}

				// Connection string
				if (externalEndpoint && dbDetails.databaseName) {
					log(`${colors.bold("Connection String")}`);
					const connStr = getConnectionString(dbSummary.type, dbDetails);
					log(`  ${colors.cyan(connStr)}`);
					log("");
				}

				// Created
				log(`${colors.bold("Created")}`);
				log(`  ${new Date(dbDetails.createdAt).toLocaleString()}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Restart / stop a database. Both used to call changeStatus, which only
	// writes a status column: nothing is stopped or restarted, FREE databases
	// are refused, and a paid database would read "stopped" while it keeps
	// running. Keep the commands so old scripts get a clear answer, and never
	// touch the API (same pattern as `servers cancel-vm-subscription`).
	for (const verb of ["restart", "stop"] as const) {
		db.command(verb)
			.argument("[db]", "Database ID or name")
			.description(
				"No longer applies: managed databases cannot be stopped, started or restarted",
			)
			.action(() => {
				handleError(new CliError(MANAGED_DB_LIFECYCLE_MESSAGE));
			});
	}

	// List database backups
	db.command("backups")
		.argument("<db>", "Database ID or name")
		.description("List database backups")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching backups...");
				const allDbs = await getAllDatabases(client);
				const dbInfo = findDatabase(allDbs, dbIdentifier);

				if (!dbInfo) {
					failSpinner();
					const suggestions = findSimilar(
						dbIdentifier,
						allDbs.map((d) => d.name),
					);
					throw new NotFoundError("Database", dbIdentifier, suggestions);
				}

				let backups: any[] = [];
				switch (dbInfo.type) {
					case "postgres":
						backups = await client.backup.listByDatabase.query({
							postgresId: dbInfo.id,
						});
						break;
					case "mysql":
						backups = await client.backup.listByDatabase.query({
							mysqlId: dbInfo.id,
						});
						break;
				}

				succeedSpinner();

				if (isJsonMode()) {
					outputData(backups);
					return;
				}

				if (!backups || backups.length === 0) {
					log("");
					log(`No backups found for ${colors.cyan(dbInfo.name)}.`);
					return;
				}

				log("");
				log(`Backup schedules for ${colors.cyan(dbInfo.name)}:`);
				log("");
				// listByDatabase returns { backupId, schedule, enabled } only.
				// Print the full id: `tarout backups <cmd> <backup-id>` needs it.
				table(
					["ID", "SCHEDULE", "ENABLED"],
					backups.map((b: any) => [
						colors.cyan(String(b.backupId ?? "-")),
						b.schedule || colors.dim("-"),
						b.enabled ? colors.success("yes") : colors.dim("no"),
					]),
				);
				log("");
				log(
					colors.dim(
						`${backups.length} schedule${backups.length === 1 ? "" : "s"}`,
					),
				);
				log(
					colors.dim(
						"Details: tarout backups info <id>   Files: tarout backups files <id>",
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Connect to database shell
	db.command("connect")
		.argument("<db>", "Database ID or name")
		.description("Open interactive database shell")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the database
				const _spinner = startSpinner("Connecting to database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);

				if (!dbSummary) {
					failSpinner();
					const suggestions = findSimilar(
						dbIdentifier,
						allDbs.map((d) => d.name),
					);
					throw new NotFoundError("Database", dbIdentifier, suggestions);
				}

				// Get full details
				let dbDetails: any;
				switch (dbSummary.type) {
					case "postgres":
						dbDetails = await client.postgres.one.query({
							postgresId: dbSummary.id,
						});
						break;
					case "mysql":
						dbDetails = await client.mysql.one.query({ mysqlId: dbSummary.id });
						break;
				}

				succeedSpinner();

				// Build connection command
				const { command, args, env } = getConnectCommand(
					dbSummary.type,
					dbDetails,
				);

				log("");
				log(`Connecting to ${colors.bold(dbDetails.name)}...`);
				log(colors.dim("Press Ctrl+D to exit"));
				log("");

				// Spawn the shell
				const child = spawn(command, args, {
					stdio: "inherit",
					env: { ...process.env, ...env },
				});

				child.on("exit", (code) => {
					process.exit(code || 0);
				});
			} catch (err) {
				handleError(err);
			}
		});

	// ── Update database ──────────────────────────────────────────────────────────
	db.command("update")
		.argument("<db>", "Database ID or name")
		.description("Update database settings")
		.option("-n, --name <name>", "New name")
		.option("--description <text>", "New description")
		.action(async (dbIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				const _updateSpinner = startSpinner("Updating database...");
				if (dbSummary.type === "postgres") {
					await client.postgres.update.mutate({
						postgresId: dbSummary.id,
						name: options.name,
						description: options.description,
					} as any);
				} else {
					await client.mysql.update.mutate({
						mysqlId: dbSummary.id,
						name: options.name,
						description: options.description,
					} as any);
				}
				succeedSpinner("Database updated.");
				if (isJsonMode()) outputData({ updated: true, id: dbSummary.id });
			} catch (err) {
				handleError(err);
			}
		});

	// ── Reactivate database ──────────────────────────────────────────────────────
	db.command("reactivate")
		.argument("<db>", "Database ID or name")
		.description("Reactivate a suspended database")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				const _reactivateSpinner = startSpinner("Reactivating database...");
				if (dbSummary.type === "postgres") {
					await client.postgres.reactivate.mutate({
						postgresId: dbSummary.id,
					} as any);
				} else {
					await client.mysql.reactivate.mutate({
						mysqlId: dbSummary.id,
					} as any);
				}
				succeedSpinner("Database reactivated.");
				if (isJsonMode()) outputData({ reactivated: true, id: dbSummary.id });
			} catch (err) {
				handleError(err);
			}
		});

	// ── Upgrade database ─────────────────────────────────────────────────────────
	db.command("upgrade")
		.argument("<db>", "Database ID or name")
		.description("Upgrade a managed PostgreSQL database to a higher tier")
		.option("--plan <plan>", "Target tier (starter, standard, pro)")
		.option("--wait", "Wait/poll until the hosted checkout is confirmed (default)")
		.option("--no-wait", "Return as soon as the hosted checkout opens")
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 600)",
			(v) => Number.parseInt(v, 10),
			600,
		)
		.option("--no-open", "Do not auto-open the payment URL in the browser")
		.action(async (dbIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				succeedSpinner();
				assertPostgresTierChange(dbSummary);
				const rawPlan =
					options.plan ||
					(await input("Target tier (starter, standard, pro):", undefined, {
						field: "target_plan",
						flag: "--plan",
						context: { id: dbSummary.id, name: dbSummary.name, type: dbSummary.type },
					}));
				const targetPlan = resolveDbTierTarget("upgrade", rawPlan);

				// Preview + confirm — mirrors `billing upgrade`. `--json` and `--yes`
				// still go straight to the mutation, but a non-interactive agent run
				// now ENTERS this block so a paid checkout with a launchable browser
				// reaches `shouldAutoConfirmPaidCheckout` below and auto-confirms (the
				// hosted Moyasar page is the real consent surface). Gating this on
				// `!isNonInteractiveMode()` too made that auto-confirm branch
				// structurally unreachable. Interactive TTY runs still get the y/n.
				if (!isJsonMode() && !shouldSkipConfirmation()) {
					const _p = startSpinner("Calculating change...");
					// biome-ignore lint/suspicious/noExplicitAny: server preview shape varies.
					let preview: any = null;
					try {
						preview = await client.subscription.previewDatabaseUpgrade.query({
							postgresId: dbSummary.id,
							targetPlan,
						});
						succeedSpinner();
					} catch {
						failSpinner();
					}
					const dueHalalas = resolveDatabaseUpgradeDueHalalas(preview);
					// Show the grossed-up total the gateway actually charges and the
					// ACTUAL VAT rate from the preview (0 while Tarout isn't VAT-
					// registered → no VAT shown), never a hardcoded 15%.
					const { amountHalalas: displayDueHalalas, vatNote } =
						resolveCheckoutAmountDisplay(preview?.tax, dueHalalas);
					if (displayDueHalalas !== undefined) {
						log(
							`Amount due now: ${colors.bold(`${(displayDueHalalas / 100).toFixed(2)} SAR`)}${vatNote ? ` ${vatNote}` : ""}`,
						);
					}
					// Branch on what actually gates consent:
					//   • payable + launchable browser → the hosted Moyasar page IS the
					//     consent surface, so auto-confirm and open it.
					//   • non-interactive + nothing payable (a free / already-entitled
					//     upgrade, dueHalalas 0 or undefined) → there's no payment page to
					//     gate and no TTY to confirm at, so apply immediately. This
					//     restores the pre-guard behavior instead of dead-ending at the
					//     annotated confirm's needs_input/exit 6.
					//   • everything else (payable+headless, or an interactive TTY) →
					//     require the explicit confirm.
					const isPayable =
						typeof dueHalalas === "number" && dueHalalas > 0;
					const skipConfirmForFreeChange =
						isNonInteractiveMode() && !isPayable;
					if (shouldAutoConfirmPaidCheckout(dueHalalas)) {
						log("Opening the secure payment page in your browser to complete the upgrade...");
					} else if (!skipConfirmForFreeChange) {
						const confirmed = await confirm(
							`Upgrade "${dbSummary.name}" to ${targetPlan}?`,
							false,
							{
								field: "confirm_db_upgrade",
								flag: "--yes",
								context: { id: dbSummary.id, name: dbSummary.name, targetPlan, amountDueHalalas: dueHalalas },
							},
						);
						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}
				}

				const _u = startSpinner(`Upgrading ${dbSummary.name} to ${targetPlan}...`);
				const result = await runDatabaseTierChange(client, {
					direction: "upgrade",
					postgresId: dbSummary.id,
					targetPlan,
					wait: options.wait,
					timeoutMs: options.timeout * 1000,
					openBrowser: paymentBrowserOpener({ noOpen: options.open === false }),
					onCheckoutOpened: ({ orderId, paymentUrl }) => {
						if (isJsonMode()) {
							outputJsonLine({ type: "event", event: "checkout_started", orderId, paymentUrl });
						} else {
							log("");
							log("Open this URL to complete payment:");
							log(`  ${colors.cyan(paymentUrl)}`);
							log(`Order ID: ${colors.dim(orderId)}`);
							log(`Polling for confirmation (up to ${options.timeout}s)...`);
						}
					},
				});
				succeedSpinner("Upgrade processed.");
				const code = emitBillingResult(result, {
					label: `Database ${dbSummary.name} → ${targetPlan}`,
				});
				if (code !== ExitCode.SUCCESS) exit(code);
			} catch (err) {
				handleError(err);
			}
		});

	// ── Downgrade database ───────────────────────────────────────────────────────
	db.command("downgrade")
		.argument("<db>", "Database ID or name")
		.description("Downgrade a managed PostgreSQL database to a lower tier (applies immediately, no refund)")
		.option("--plan <plan>", "Target tier (starter, standard)")
		.action(async (dbIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				succeedSpinner();
				assertPostgresTierChange(dbSummary);
				const rawPlan =
					options.plan ||
					(await input("Target tier (starter, standard):", undefined, {
						field: "target_plan",
						flag: "--plan",
						context: { id: dbSummary.id, name: dbSummary.name, type: dbSummary.type },
					}));
				const targetPlan = resolveDbTierTarget("downgrade", rawPlan);

				// Interactive-only preview + confirm. Preview errors are swallowed —
				// the mutation enforces the same guards and surfaces the real message.
				if (!isJsonMode() && !isNonInteractiveMode() && !shouldSkipConfirmation()) {
					const _p = startSpinner("Checking downgrade...");
					try {
						await client.subscription.previewDatabaseDowngrade.query({
							postgresId: dbSummary.id,
							targetPlan,
						});
						succeedSpinner();
					} catch {
						failSpinner();
					}
					const confirmed = await confirm(
						`Downgrade "${dbSummary.name}" to ${targetPlan}? Applies immediately; no refund.`,
						false,
						{
							field: "confirm_db_downgrade",
							flag: "--yes",
							context: { id: dbSummary.id, name: dbSummary.name, targetPlan },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _d = startSpinner(`Downgrading ${dbSummary.name} to ${targetPlan}...`);
				const result = await runDatabaseTierChange(client, {
					direction: "downgrade",
					postgresId: dbSummary.id,
					targetPlan,
				});
				succeedSpinner("Downgrade processed.");
				const code = emitBillingResult(result, {
					label: `Database ${dbSummary.name} → ${targetPlan}`,
				});
				if (code !== ExitCode.SUCCESS) exit(code);
			} catch (err) {
				handleError(err);
			}
		});

	// ── Attach to application ────────────────────────────────────────────────────
	db.command("attach")
		.argument("<db>", "Database ID or name")
		.argument("<app-id>", "Application ID")
		.description("Attach database to an application")
		.action(async (dbIdentifier, applicationId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				const _attachSpinner = startSpinner("Attaching database...");
				if (dbSummary.type === "postgres") {
					await client.postgres.attachToApplication.mutate({
						postgresId: dbSummary.id,
						applicationId,
					} as any);
				} else {
					await client.mysql.attachToApplication.mutate({
						mysqlId: dbSummary.id,
						applicationId,
					} as any);
				}
				succeedSpinner("Database attached to application.");
				if (isJsonMode())
					outputData({ attached: true, id: dbSummary.id, applicationId });
			} catch (err) {
				handleError(err);
			}
		});

	// ── Detach from application ──────────────────────────────────────────────────
	db.command("detach")
		.argument("<db>", "Database ID or name")
		.argument("<app-id>", "Application ID")
		.description("Detach database from an application")
		.action(async (dbIdentifier, applicationId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				const _detachSpinner = startSpinner("Detaching database...");
				if (dbSummary.type === "postgres") {
					await client.postgres.detachFromApplication.mutate({
						postgresId: dbSummary.id,
						applicationId,
					} as any);
				} else {
					await client.mysql.detachFromApplication.mutate({
						mysqlId: dbSummary.id,
						applicationId,
					} as any);
				}
				succeedSpinner("Database detached from application.");
				if (isJsonMode())
					outputData({ detached: true, id: dbSummary.id, applicationId });
			} catch (err) {
				handleError(err);
			}
		});

	// ── External access (Postgres) ────────────────────────────────────────────────
	db.command("external-access")
		.argument("<db>", "Postgres database ID or name")
		.description("Configure external access for a Postgres database")
		.option("--enable", "Enable external access")
		.option("--disable", "Disable external access")
		.option(
			"--cidrs <list>",
			"Comma-separated allowlist (REPLACES the current list)",
		)
		.option("--public", "Allow the whole internet (0.0.0.0/0)")
		.option("--private", "Restrict to the CIDR allowlist (disable public)")
		// TLS is always required for external access (the platform refuses
		// enabled without it). --require-ssl is accepted as a no-op so old
		// scripts keep working; --allow-insecure fails with an explanation.
		.addOption(new Option("--require-ssl").hideHelp())
		.addOption(new Option("--allow-insecure").hideHelp())
		.action(async (dbIdentifier, options) => {
			try {
				const requestedCidrs: string[] | undefined = options.cidrs
					? String(options.cidrs)
							.split(",")
							.map((c: string) => c.trim())
							.filter(Boolean)
					: undefined;
				if (
					requestedCidrs &&
					requestedCidrs.length > EXTERNAL_ACCESS_MAX_CIDRS
				) {
					throw new CliError(
						`External access takes at most ${EXTERNAL_ACCESS_MAX_CIDRS} CIDRs; got ${requestedCidrs.length}. Use --public to allow every address instead.`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				if (options.allowInsecure && !options.disable) {
					throw new CliError(
						EXTERNAL_ACCESS_TLS_MESSAGE,
						ExitCode.INVALID_ARGUMENTS,
					);
				}

				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				if (dbSummary.type !== "postgres") {
					throw new CliError(
						"External access is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				// The server REPLACES the stored allowlist/public/ssl with whatever
				// this call sends (an omitted field is wiped to its default). Load the
				// current state and preserve every field the user didn't explicitly
				// change — matching the dashboard, which edits the loaded values in
				// place instead of clearing them.
				const current: any = await client.postgres.one.query({
					postgresId: dbSummary.id,
				});
				const enabled = options.enable
					? true
					: options.disable
						? false
						: (current.externalAccessEnabled ?? false);
				const allowedCidrs =
					requestedCidrs ?? current.externalAllowedCidrs ?? [];
				const isPublic = options.public
					? true
					: options.private
						? false
						: (current.externalPublicAccess ?? false);
				// Never preserve a stored `externalSslRequired: false`: rows created
				// before the always-on rollout carry it, and the platform refuses
				// enabled && !requireSsl. When disabling, the flag is ignored.
				if (enabled && options.allowInsecure) {
					throw new CliError(
						EXTERNAL_ACCESS_TLS_MESSAGE,
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const requireSsl = true;
				const _updateSpinner = startSpinner("Updating external access...");
				await client.postgres.updateExternalAccess.mutate({
					postgresId: dbSummary.id,
					enabled,
					allowedCidrs,
					public: isPublic,
					requireSsl,
				});
				succeedSpinner("External access updated.");
				if (isJsonMode())
					outputData({
						updated: true,
						id: dbSummary.id,
						enabled,
						public: isPublic,
						requireSsl,
						allowedCidrs,
					});
			} catch (err) {
				handleError(err);
			}
		});

	// ── List tables (Postgres) ────────────────────────────────────────────────────
	db.command("tables")
		.argument("<db>", "Postgres database ID or name")
		.description("List tables in a PostgreSQL database")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				if (dbSummary.type !== "postgres") {
					throw new CliError(
						"Table listing is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const _tablesSpinner = startSpinner("Fetching tables...");
				const tables = await client.postgres.listTables.query({
					postgresId: dbSummary.id,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(tables);
					return;
				}
				const list = Array.isArray(tables) ? tables : [];
				if (list.length === 0) {
					log("No tables found.");
					return;
				}
				log("");
				// listTables returns { schema, name, estimatedRows, totalBytes }.
				// estimatedRows is the planner estimate (pg_class.reltuples): -1
				// means the table was never analyzed, so the count is unknown.
				table(
					["SCHEMA", "TABLE", "ROWS", "SIZE"],
					list.map((t: any) => [
						t.schema || "public",
						colors.cyan(t.name || "-"),
						formatEstimatedRows(t.estimatedRows),
						typeof t.totalBytes === "number" ? formatBytes(t.totalBytes) : "-",
					]),
				);
				log("");
				log(colors.dim("ROWS is the planner's estimate; '-' means not analyzed yet."));
			} catch (err) {
				handleError(err);
			}
		});

	// ── Preview table (Postgres) ──────────────────────────────────────────────────
	db.command("preview")
		.argument("<db>", "Postgres database ID or name")
		.argument("<table>", "Table name")
		.description("Preview rows from a PostgreSQL table")
		.option("--schema <schema>", "Schema name", "public")
		.option("-n, --limit <n>", "Number of rows to preview (1-100)", "20")
		.action(async (dbIdentifier, tableName, options) => {
			try {
				// previewTable takes an integer limit of 1-100.
				const rawLimit = String(options.limit ?? "20").trim();
				const limit = Number(rawLimit);
				if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > 100) {
					throw new CliError(
						`--limit must be a whole number from 1 to 100; got "${rawLimit}".`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				if (dbSummary.type !== "postgres") {
					throw new CliError(
						"Table preview is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const _previewSpinner = startSpinner(`Previewing ${tableName}...`);
				const result = await client.postgres.previewTable.mutate({
					postgresId: dbSummary.id,
					schema: options.schema || "public",
					table: tableName,
					limit,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const rows = Array.isArray(result)
					? result
					: (result as any)?.rows || [];
				if (rows.length === 0) {
					log("No rows found.");
					return;
				}
				const cols = Object.keys(rows[0]);
				log("");
				table(
					cols,
					rows.map((row: any) =>
						cols.map((c) => String(row[c] ?? "-").slice(0, 30)),
					),
				);
				log("");
				log(colors.dim(`${rows.length} row${rows.length === 1 ? "" : "s"}`));
			} catch (err) {
				handleError(err);
			}
		});

	// ── Execute SQL (Postgres) ─────────────────────────────────────────────────────
	db.command("sql")
		.argument("<db>", "Postgres database ID or name")
		.argument("<query>", "SQL query to execute")
		.description(
			"Execute a SQL query on a PostgreSQL database (at most 10,000 characters)",
		)
		.action(async (dbIdentifier, sql) => {
			try {
				const problem = consoleSqlProblem(sql);
				if (problem) {
					throw new CliError(problem, ExitCode.INVALID_ARGUMENTS);
				}
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				if (dbSummary.type !== "postgres") {
					throw new CliError(
						"SQL execution is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const _sqlSpinner = startSpinner("Executing SQL...");
				const result = await client.postgres.executeSql.mutate({
					postgresId: dbSummary.id,
					sql: sql.trim(),
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const rows = Array.isArray(result)
					? result
					: (result as any)?.rows || [];
				if (rows.length === 0) {
					log("Query executed (no rows returned).");
					return;
				}
				const cols = Object.keys(rows[0]);
				log("");
				table(
					cols,
					rows.map((row: any) =>
						cols.map((c) => String(row[c] ?? "NULL").slice(0, 40)),
					),
				);
				log("");
				log(colors.dim(`${rows.length} row${rows.length === 1 ? "" : "s"}`));
			} catch (err) {
				handleError(err);
			}
		});

	// ── Import SQL dump (Postgres) ─────────────────────────────────────────────────
	db.command("import")
		.argument("<db>", "Postgres database ID or name")
		.argument("<file>", "Path to a local .sql file to execute")
		.description(
			"Run a local .sql file against a PostgreSQL database through the SQL console (at most 10,000 characters; no COPY ... FROM stdin, GRANT, REVOKE or role statements)",
		)
		.action(async (dbIdentifier, filePath) => {
			try {
				// Read and check the file before touching the API. The whole file
				// goes to postgres.executeSql in one call, and the console caps it
				// at 10,000 characters, blocks GRANT/REVOKE/role/database-level
				// statements and cannot feed COPY ... FROM stdin. Explain those
				// here instead of surfacing an opaque server error.
				let rawSql: string;
				try {
					rawSql = readFileSync(filePath, "utf8");
				} catch (readErr) {
					throw new CliError(
						`Could not read SQL file "${filePath}": ${
							readErr instanceof Error ? readErr.message : String(readErr)
						}`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const sql = rawSql.trim();
				if (!sql) {
					throw new CliError(
						`SQL file "${filePath}" is empty.`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const problem = consoleSqlProblem(sql);
				if (problem) {
					throw new CliError(
						`Cannot import "${filePath}". ${problem}`,
						ExitCode.INVALID_ARGUMENTS,
					);
				}

				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					const suggestions = findSimilar(
						dbIdentifier,
						allDbs.map((d) => d.name),
					);
					throw new NotFoundError("Database", dbIdentifier, suggestions);
				}
				if (dbSummary.type !== "postgres") {
					failSpinner();
					throw new CliError(
						"SQL import is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				succeedSpinner();
				const _importSpinner = startSpinner("Importing SQL...");
				const result = await client.postgres.executeSql.mutate({
					postgresId: dbSummary.id,
					sql,
				});
				succeedSpinner("SQL imported.");
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				const rows = Array.isArray(result) ? result : r?.rows || [];
				if (rows.length > 0) {
					const cols = Object.keys(rows[0]);
					log("");
					table(
						cols,
						rows.map((row: any) =>
							cols.map((c) => String(row[c] ?? "NULL").slice(0, 40)),
						),
					);
					log("");
					log(colors.dim(`${rows.length} row${rows.length === 1 ? "" : "s"}`));
				} else {
					const affected = r?.rowCount;
					const command = r?.command;
					log("");
					log(
						`Import complete${command ? ` (${command})` : ""}${
							typeof affected === "number"
								? `, ${affected} row${affected === 1 ? "" : "s"} affected`
								: ""
						}.`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// ── Analytics (Postgres) ──────────────────────────────────────────────────────
	db.command("analytics")
		.argument("<db>", "Postgres database ID or name")
		.description("Show analytics and metrics for a PostgreSQL database")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				if (dbSummary.type !== "postgres") {
					throw new CliError(
						"Analytics are only available for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const _analyticsSpinner = startSpinner("Fetching analytics...");
				// getAnalytics returns { databaseSize, tableCount, connectionCount,
				// rowCount, cacheHitRate, tables[{ name, rowCount, size }] }, or
				// null when the tenant could not be read (the platform logs why).
				const data: any = await client.postgres.getAnalytics.query({
					postgresId: dbSummary.id,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				if (!data) {
					log("");
					log("Analytics are not available for this database right now. Try again in a minute.");
					log("");
					return;
				}
				log("");
				log(colors.bold("Database Analytics"));
				log(`  Size:            ${data.databaseSize ?? "-"}`);
				log(`  Tables:          ${formatCount(data.tableCount)}`);
				log(`  Rows (approx.):  ${formatCount(data.rowCount)}`);
				log(`  Connections:     ${formatCount(data.connectionCount)}`);
				log(
					`  Cache hit rate:  ${typeof data.cacheHitRate === "number" ? `${data.cacheHitRate}%` : "-"}`,
				);
				const tables: any[] = Array.isArray(data.tables) ? data.tables : [];
				if (tables.length > 0) {
					log("");
					log(colors.bold("Largest tables"));
					table(
						["TABLE", "ROWS", "SIZE"],
						tables.map((t) => [
							colors.cyan(String(t.name ?? "-")),
							formatCount(t.rowCount),
							String(t.size ?? "-"),
						]),
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── Shared stats ───────────────────────────────────────────────────────────────
	db.command("stats")
		.argument("<db>", "Database ID or name")
		.description("Show shared database pool statistics")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding database...");
				const allDbs = await getAllDatabases(client);
				const dbSummary = findDatabase(allDbs, dbIdentifier);
				if (!dbSummary) {
					failSpinner();
					throw new NotFoundError("Database", dbIdentifier);
				}
				const _statsSpinner = startSpinner("Fetching stats...");
				// sharedStats returns { activeConnections, maxConnections,
				// storageUsedBytes, storageLimitBytes, storageGb, plan, isReadOnly,
				// readOnlyReason }, or null for a database it cannot measure.
				let data: any;
				if (dbSummary.type === "postgres") {
					data = await client.postgres.sharedStats.query({
						postgresId: dbSummary.id,
					});
				} else {
					data = await client.mysql.sharedStats.query({
						mysqlId: dbSummary.id,
					});
				}
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				if (!data) {
					log("");
					log("Stats are not available for this database right now.");
					log("");
					return;
				}
				const used =
					typeof data.storageUsedBytes === "number"
						? formatBytes(data.storageUsedBytes)
						: "-";
				const limit =
					typeof data.storageLimitBytes === "number" &&
					data.storageLimitBytes > 0
						? ` / ${formatBytes(data.storageLimitBytes)}`
						: "";
				const maxConnections =
					typeof data.maxConnections === "number" && data.maxConnections > 0
						? ` / ${data.maxConnections}`
						: "";
				log("");
				log(colors.bold("Database Stats"));
				log(`  Plan:          ${data.plan ?? "-"}`);
				log(`  Connections:   ${formatCount(data.activeConnections)}${maxConnections}`);
				log(`  Storage:       ${used}${limit}`);
				log(
					`  Read-only:     ${
						data.isReadOnly
							? colors.warn(
									`yes${data.readOnlyReason ? ` (${data.readOnlyReason})` : ""}`,
								)
							: "no"
					}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}

// Helper functions
async function getAllDatabases(client: ReturnType<typeof getApiClient>) {
	const [postgres, mysql] = await Promise.all([
		client.postgres.allByOrganization.query(),
		client.mysql.allByOrganization.query(),
	]);

	const databases: Array<{
		id: string;
		name: string;
		type: DatabaseType;
		status: string;
	}> = [];

	for (const db of postgres as any[]) {
		databases.push({
			id: db.postgresId,
			name: db.name,
			type: "postgres",
			status: db.applicationStatus,
		});
	}

	for (const db of mysql as any[]) {
		databases.push({
			id: db.mysqlId,
			name: db.name,
			type: "mysql",
			status: db.applicationStatus,
		});
	}

	return databases;
}

function findDatabase(
	databases: Array<{ id: string; name: string; type: DatabaseType }>,
	identifier: string,
) {
	const lowerIdentifier = identifier.toLowerCase();

	return databases.find(
		(db) =>
			db.id === identifier ||
			db.id.startsWith(identifier) ||
			db.name.toLowerCase() === lowerIdentifier,
	);
}

function formatDate(date: Date | string): string {
	const d = new Date(date);
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getTypeLabel(type: DatabaseType): string {
	const labels: Record<DatabaseType, string> = {
		postgres: colors.info("PostgreSQL"),
		mysql: colors.warn("MySQL"),
	};
	return labels[type] || type;
}

/** A count with thousands separators, or "-" when the platform sent none. */
function formatCount(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value)
		? value.toLocaleString("en-US")
		: "-";
}

/**
 * `listTables` rows carry `estimatedRows` from pg_class.reltuples, which is -1
 * when the table has never been analyzed: the count is unknown, not negative.
 */
function formatEstimatedRows(value: unknown): string {
	return typeof value === "number" && value >= 0 ? formatCount(value) : "-";
}

/** host / port parsed from the platform's `externalConnectionString`. */
function parseExternalConnectionString(
	value: unknown,
): { host: string; port: number | null } | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		if (!url.hostname) return null;
		const port = url.port ? Number(url.port) : null;
		return { host: url.hostname, port: Number.isInteger(port) ? port : null };
	} catch {
		return null;
	}
}

/**
 * The customer-reachable endpoint, read from what `postgres.one` returns:
 * `externalPoolerHost` / `externalPoolerPort`, falling back to the host and
 * port inside `externalConnectionString`. The default port is the pooler's
 * 6432; external clients never reach a backend on 5432.
 */
function getExternalDatabaseEndpoint(
	type: DatabaseType,
	details: any,
): { host: string; port: number } | null {
	if (type !== "postgres" || details.externalAccessEnabled !== true) {
		return null;
	}
	const parsed = parseExternalConnectionString(details.externalConnectionString);
	const host = details.externalPoolerHost || parsed?.host;
	if (!host) return null;

	return {
		host,
		port:
			details.externalPoolerPort || parsed?.port || EXTERNAL_POOLER_DEFAULT_PORT,
	};
}

function requireExternalDatabaseEndpoint(
	type: DatabaseType,
	details: any,
): { host: string; port: number } {
	const endpoint = getExternalDatabaseEndpoint(type, details);
	if (endpoint) return endpoint;

	throw new CliError(
		type === "postgres"
			? "External access is disabled or unavailable. Enable it with `tarout db external-access <db> --enable --cidrs <this-machine-ip>/32` (or --public), then connect again."
			: "External access is not available for MySQL databases.",
		ExitCode.GENERAL_ERROR,
	);
}

export function getConnectionString(type: DatabaseType, details: any): string {
	const endpoint = requireExternalDatabaseEndpoint(type, details);
	const user = details.databaseUser || "user";
	const dbName = details.databaseName || "db";

	switch (type) {
		case "postgres": {
			// Same shape as the platform's externalConnectionString, which always
			// carries sslmode=require: external access is TLS-only.
			return `postgresql://${user}:****@${endpoint.host}:${endpoint.port}/${dbName}?sslmode=require`;
		}
		case "mysql": {
			return `mysql://${user}:****@${endpoint.host}:${endpoint.port}/${dbName}`;
		}
		default:
			return "";
	}
}

export function getConnectCommand(
	type: DatabaseType,
	details: any,
): { command: string; args: string[]; env: Record<string, string> } {
	// A CLI always runs outside Tarout's private network. Never guess or fall
	// back to an internal provider route that the customer cannot reach.
	const endpoint = requireExternalDatabaseEndpoint(type, details);
	const user = details.databaseUser || "user";
	const password = details.databasePassword || "";
	const dbName = details.databaseName || "db";

	switch (type) {
		case "postgres":
			return {
				command: "psql",
				args: [
					"-h",
					endpoint.host,
					"-p",
					String(endpoint.port),
					"-U",
					user,
					"-d",
					dbName,
				],
				// The external pooler never accepts plaintext, whatever a legacy
				// row's externalSslRequired says, so TLS is always required.
				env: {
					PGPASSWORD: password,
					PGSSLMODE: "require",
				},
			};
		case "mysql":
			return {
				command: "mysql",
				args: [
					"-h",
					endpoint.host,
					"-P",
					String(endpoint.port),
					"-u",
					user,
					`-p${password}`,
					dbName,
				],
				env: {},
			};
		default:
			throw new CliError(
				`Unsupported database type: ${type}`,
				ExitCode.INVALID_ARGUMENTS,
			);
	}
}
