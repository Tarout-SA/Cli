import { spawn } from "node:child_process";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	findSimilar,
	handleError,
	NotFoundError,
} from "../lib/errors.js";
import {
	box,
	colors,
	getStatusBadge,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

type DatabaseType = "postgres" | "mysql";

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
						colors.cyan(db.id.slice(0, 8)),
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
		.description("Create a new database")
		.option("-t, --type <type>", "Database type (postgres, mysql)", "postgres")
		.option("-d, --description <description>", "Database description")
		.option("--name <name>", "Database name (alternative to positional argument)")
		.action(async (name, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				// Interactive mode if no name provided
				let dbName = name || options.name;
				let dbType = options.type as DatabaseType;

				if (!dbName) {
					dbName = await input("Database name:", undefined, {
						field: "db_name",
						flag: "--name",
					});
				}

				if (!options.type && !shouldSkipConfirmation()) {
					dbType = await select(
						"Database type:",
						[
							{ name: "PostgreSQL", value: "postgres" },
							{ name: "MySQL", value: "mysql" },
						],
						{
							field: "db_type",
							flag: "--type",
							context: { name: dbName },
						},
					);
				}

				// Generate appName (URL-safe slug)
				const slug = generateSlug(dbName);

				const client = getApiClient();
				const _spinner = startSpinner(`Creating ${dbType} database...`);

				let database: any;

				switch (dbType) {
					case "postgres":
						database = await client.postgres.create.mutate({
							name: dbName,
							appName: slug,
							dockerImage: "postgres:17",
							organizationId: profile.organizationId,
							description: options.description,
						});
						break;
					case "mysql":
						database = await client.mysql.create.mutate({
							name: dbName,
							appName: slug,
							dockerImage: "mysql:8",
							organizationId: profile.organizationId,
							description: options.description,
						});
						break;
					default:
						throw new CliError(
							`Unsupported database type: ${dbType}`,
							ExitCode.INVALID_ARGUMENTS,
						);
				}

				succeedSpinner("Database created!");

				const dbId = database.postgresId || database.mysqlId;

				if (isJsonMode()) {
					outputData(database);
					return;
				}

				quietOutput(dbId);

				box("Database Created", [
					`ID: ${colors.cyan(dbId)}`,
					`Name: ${database.name}`,
					`Type: ${getTypeLabel(dbType)}`,
				]);

				log("Next steps:");
				log(
					`  View connection info: ${colors.dim(`tarout db info ${dbId.slice(0, 8)}`)}`,
				);
				log("");
			} catch (err) {
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

				// Connection info
				log(`${colors.bold("Connection")}`);
				if (
					dbDetails.directHost ||
					dbDetails.poolerHost ||
					dbDetails.databaseName
				) {
					const host =
						dbDetails.poolerHost || dbDetails.directHost || "localhost";
					const port =
						dbDetails.poolerPort ||
						dbDetails.directPort ||
						(dbSummary.type === "postgres" ? 5432 : 3306);
					log(`  Host: ${colors.cyan(host)}`);
					log(`  Port: ${port}`);
					log(`  Database: ${dbDetails.databaseName}`);
					log(`  Username: ${dbDetails.databaseUser}`);
					log(`  Password: ${colors.dim("********")}`);
				} else {
					log(`  ${colors.dim("Not yet deployed")}`);
				}
				log("");

				// Connection string
				if (
					dbDetails.directHost ||
					dbDetails.poolerHost ||
					dbDetails.databaseName
				) {
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

	// Restart database
	db.command("restart")
		.argument("<db>", "Database ID or name")
		.description("Restart a database")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

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

				const _restartSpinner = startSpinner(`Restarting ${dbInfo.name}...`);

				switch (dbInfo.type) {
					case "postgres":
						await client.postgres.changeStatus.mutate({
							postgresId: dbInfo.id,
							applicationStatus: "running",
						});
						break;
					case "mysql":
						await client.mysql.changeStatus.mutate({
							mysqlId: dbInfo.id,
							applicationStatus: "running",
						});
						break;
				}

				succeedSpinner(`${dbInfo.name} restarting`);

				if (isJsonMode()) {
					outputData({ restarted: true, id: dbInfo.id });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Stop database
	db.command("stop")
		.argument("<db>", "Database ID or name")
		.description("Stop a database")
		.action(async (dbIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

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

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Stop database "${dbInfo.name}"?`,
						false,
						{
							field: "confirm_stop_db",
							flag: "--yes",
							context: { id: dbInfo.id, name: dbInfo.name, type: dbInfo.type },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _stopSpinner = startSpinner(`Stopping ${dbInfo.name}...`);

				switch (dbInfo.type) {
					case "postgres":
						await client.postgres.changeStatus.mutate({
							postgresId: dbInfo.id,
							applicationStatus: "stopped",
						});
						break;
					case "mysql":
						await client.mysql.changeStatus.mutate({
							mysqlId: dbInfo.id,
							applicationStatus: "stopped",
						});
						break;
				}

				succeedSpinner(`${dbInfo.name} stopped`);

				if (isJsonMode()) {
					outputData({ stopped: true, id: dbInfo.id });
				}
			} catch (err) {
				handleError(err);
			}
		});

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
				table(
					["ID", "SCHEDULE", "ENABLED"],
					backups.map((b: any) => [
						colors.cyan((b.backupId || b.id || "").slice(0, 8)),
						b.schedule || colors.dim("-"),
						b.enabled ? colors.green("yes") : colors.dim("no"),
					]),
				);
				log("");
				log(
					colors.dim(
						`${backups.length} schedule${backups.length === 1 ? "" : "s"}`,
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

				// Check if database is deployed
				if (
					!dbDetails.directHost &&
					!dbDetails.poolerHost &&
					!dbDetails.databaseName
				) {
					throw new CliError(
						"Database not deployed yet. Deploy first.",
						ExitCode.GENERAL_ERROR,
					);
				}

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
		.description("Upgrade database to a higher plan")
		.option("--plan <plan>", "Target plan (standard, pro)")
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
				const targetPlan =
					options.plan ||
					(await input("Target plan:", undefined, {
						field: "target_plan",
						flag: "--plan",
						context: {
							id: dbSummary.id,
							name: dbSummary.name,
							type: dbSummary.type,
						},
					}));
				const _upgradeSpinner = startSpinner(`Upgrading to ${targetPlan}...`);
				if (dbSummary.type === "postgres") {
					await client.postgres.upgrade.mutate({
						postgresId: dbSummary.id,
						targetPlan,
					} as any);
				} else {
					await client.mysql.upgrade.mutate({
						mysqlId: dbSummary.id,
						targetPlan,
					} as any);
				}
				succeedSpinner(`Database upgraded to ${targetPlan}.`);
				if (isJsonMode())
					outputData({ upgraded: true, id: dbSummary.id, targetPlan });
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
		.description("Configure external access CIDRs (Postgres only)")
		.option("--enable", "Enable external access")
		.option("--disable", "Disable external access")
		.option("--cidrs <list>", "Comma-separated list of allowed CIDRs")
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
				if (dbSummary.type !== "postgres") {
					throw new CliError(
						"External access is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const enabled = options.enable ? true : !options.disable;
				const allowedCidrs = options.cidrs
					? options.cidrs.split(",").map((c: string) => c.trim())
					: undefined;
				const _updateSpinner = startSpinner("Updating external access...");
				await client.postgres.updateExternalAccess.mutate({
					postgresId: dbSummary.id,
					enabled,
					allowedCidrs,
				} as any);
				succeedSpinner("External access updated.");
				if (isJsonMode())
					outputData({ updated: true, id: dbSummary.id, enabled });
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
				table(
					["SCHEMA", "TABLE", "ROWS"],
					list.map((t: any) => [
						t.schema || "public",
						colors.cyan(t.name || t.table || "-"),
						String(t.rowCount || t.rows || "-"),
					]),
				);
				log("");
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
		.option("-n, --limit <n>", "Number of rows to preview", "20")
		.action(async (dbIdentifier, tableName, options) => {
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
						"Table preview is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const _previewSpinner = startSpinner(`Previewing ${tableName}...`);
				const result = await client.postgres.previewTable.mutate({
					postgresId: dbSummary.id,
					schema: options.schema || "public",
					table: tableName,
					limit: Number.parseInt(options.limit || "20"),
				} as any);
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
		.description("Execute a SQL query on a PostgreSQL database")
		.action(async (dbIdentifier, sql) => {
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
						"SQL execution is only supported for PostgreSQL databases.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const _sqlSpinner = startSpinner("Executing SQL...");
				const result = await client.postgres.executeSql.mutate({
					postgresId: dbSummary.id,
					sql,
				} as any);
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
				const data = await client.postgres.getAnalytics.query({
					postgresId: dbSummary.id,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold("Database Analytics"));
				if (d.connections !== undefined)
					log(`  Connections:     ${colors.cyan(String(d.connections))}`);
				if (d.dbSize) log(`  Size:            ${d.dbSize}`);
				if (d.cacheHitRatio !== undefined)
					log(`  Cache Hit Ratio: ${d.cacheHitRatio}%`);
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
				let data: any;
				if (dbSummary.type === "postgres") {
					data = await client.postgres.sharedStats.query({
						postgresId: dbSummary.id,
					} as any);
				} else {
					data = await client.mysql.sharedStats.query({
						mysqlId: dbSummary.id,
					} as any);
				}
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const s = data as any;
				log("");
				log(colors.bold("Database Stats"));
				if (s.usedStorage !== undefined)
					log(`  Used Storage:  ${s.usedStorage}`);
				if (s.storageLimit !== undefined)
					log(`  Storage Limit: ${s.storageLimit}`);
				if (s.connections !== undefined)
					log(`  Connections:   ${s.connections}`);
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

function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);
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

function getConnectionString(type: DatabaseType, details: any): string {
	const host = details.poolerHost || details.directHost || "localhost";
	const user = details.databaseUser || "user";
	const dbName = details.databaseName || "db";

	switch (type) {
		case "postgres": {
			const pgPort = details.poolerPort || details.directPort || 5432;
			return `postgresql://${user}:****@${host}:${pgPort}/${dbName}`;
		}
		case "mysql": {
			const myPort = details.poolerPort || details.directPort || 3306;
			return `mysql://${user}:****@${host}:${myPort}/${dbName}`;
		}
		default:
			return "";
	}
}

function getConnectCommand(
	type: DatabaseType,
	details: any,
): { command: string; args: string[]; env: Record<string, string> } {
	const host = details.poolerHost || details.directHost || "localhost";
	const user = details.databaseUser || "user";
	const password = details.databasePassword || "";
	const dbName = details.databaseName || "db";

	switch (type) {
		case "postgres":
			return {
				command: "psql",
				args: [
					"-h",
					host,
					"-p",
					String(details.poolerPort || details.directPort || 5432),
					"-U",
					user,
					"-d",
					dbName,
				],
				env: { PGPASSWORD: password },
			};
		case "mysql":
			return {
				command: "mysql",
				args: [
					"-h",
					host,
					"-P",
					String(details.poolerPort || details.directPort || 3306),
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
