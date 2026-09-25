import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError } from "../lib/errors.js";
import { formatBytes } from "../lib/managed-db.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import { confirm, input, select } from "../utils/prompts.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

/**
 * The platform requires a prefix on every backup schedule (validations/
 * backup.ts: `prefix: z.string().min(1)`). Files land at
 * `<prefix>/<database>/<database>-<timestamp>.<ext>` in the destination.
 */
export const DEFAULT_BACKUP_PREFIX = "tarout-backups";

// One cron field: digits, names (mon, jan), and the * / , - ? L W # operators.
const CRON_FIELD_RE = /^[0-9A-Za-z*/,?#-]+$/;

/**
 * Shape check for a backup cron schedule. The platform stores any string and
 * evaluates it later with cron-parser; an unparseable one never fires and is
 * only logged server-side. Accept the 5-field form (and cron-parser's 6-field
 * form with a leading seconds field) so a typo fails here, loudly.
 */
export function assertCronSchedule(raw: unknown): string {
	const value = String(raw ?? "").trim();
	const fields = value.split(/\s+/).filter(Boolean);
	if (
		value.length > 120 ||
		(fields.length !== 5 && fields.length !== 6) ||
		!fields.every((field) => CRON_FIELD_RE.test(field))
	) {
		throw new CliError(
			`"${value}" is not a valid cron schedule. Use five fields (minute hour day-of-month month day-of-week), for example "0 2 * * *" for 02:00 every day or "0 */6 * * *" for every 6 hours.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	return fields.join(" ");
}

/** `keepLatestCount` must be a positive integer (`z.number().int().min(1)`). */
export function parseKeepCount(raw: unknown): number {
	const value = String(raw ?? "").trim();
	const count = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) {
		throw new CliError(
			`--keep must be a positive whole number (the number of backups to keep); got "${value}".`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	return count;
}

type BackupDatabaseType = "postgres" | "mysql";

/** The engine a sanitized `backup.one` record belongs to. */
function backupDatabaseType(backup: any): BackupDatabaseType {
	if (backup?.databaseType === "mysql" || backup?.databaseType === "postgres") {
		return backup.databaseType;
	}
	return backup?.mysqlId || backup?.mysql ? "mysql" : "postgres";
}

/**
 * `backup.listBackupFiles` and `backup.getBackupDownloadUrl` need the
 * database id, its engine and the destination, and the platform only serves
 * files that a schedule for that database + destination covers. A schedule
 * carries all three, so resolve them from `backup.one`.
 */
async function resolveBackupFileScope(
	client: ReturnType<typeof getApiClient>,
	backupId: string,
): Promise<{
	databaseId: string;
	databaseType: BackupDatabaseType;
	destinationId: string;
}> {
	const backup: any = await client.backup.one.query({ backupId });
	const databaseType = backupDatabaseType(backup);
	const databaseId =
		databaseType === "mysql" ? backup?.mysqlId : backup?.postgresId;
	if (!databaseId) {
		throw new CliError(
			`Backup schedule "${backupId}" is not linked to a database.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	if (!backup?.destinationId) {
		throw new CliError(
			`Backup schedule "${backupId}" has no destination, so it has no files. Set one with \`tarout backups update ${backupId} --destination-id <id>\`.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	return { databaseId, databaseType, destinationId: backup.destinationId };
}

export function registerBackupsCommands(program: Command) {
	const backups = program
		.command("backups")
		.description("Manage database backup configurations");

	// Create a backup schedule
	backups
		.command("create")
		.description("Create a new backup schedule for a database")
		.option("--postgres-id <id>", "PostgreSQL database ID")
		.option("--mysql-id <id>", "MySQL database ID")
		.option("--destination-id <id>", "Backup destination ID")
		.option("--schedule <cron>", "Cron schedule (e.g., 0 2 * * *)", "0 2 * * *")
		.option(
			"--database <name>",
			"Database name to back up (defaults to the database's own name)",
		)
		.option(
			"--prefix <prefix>",
			`Folder for backup files in the destination (default: ${DEFAULT_BACKUP_PREFIX})`,
		)
		.option("--keep <n>", "Number of backups to keep", "7")
		.option("--enabled", "Enable the backup schedule", true)
		.action(async (options) => {
			try {
				// Validate what the user typed before any prompt or API call.
				const schedule = assertCronSchedule(options.schedule || "0 2 * * *");
				const keepLatestCount = parseKeepCount(options.keep ?? "7");
				const prefix =
					String(options.prefix ?? "").trim() || DEFAULT_BACKUP_PREFIX;

				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				let dbType: BackupDatabaseType;
				let dbId: string;

				if (options.postgresId) {
					dbType = "postgres";
					dbId = options.postgresId;
				} else if (options.mysqlId) {
					dbType = "mysql";
					dbId = options.mysqlId;
				} else {
					dbType = await select(
						"Database type:",
						[
							{ name: "PostgreSQL", value: "postgres" },
							{ name: "MySQL", value: "mysql" },
						],
						{
							field: "database_type",
							flag: "--postgres-id|--mysql-id",
						},
					);
					dbId = await input(
						`${dbType === "postgres" ? "PostgreSQL" : "MySQL"} database ID:`,
						undefined,
						{
							field: "database_id",
							flag: dbType === "postgres" ? "--postgres-id" : "--mysql-id",
							context: { dbType },
						},
					);
				}

				let destinationId = options.destinationId;
				if (!destinationId) {
					destinationId = await input("Backup destination ID:", undefined, {
						field: "destination_id",
						flag: "--destination-id",
					});
				}

				// Default to the database's real name, as the dashboard does,
				// instead of prompting for something the platform already knows.
				let database: string | undefined = options.database;
				if (!database) {
					const details: any =
						dbType === "postgres"
							? await client.postgres.one.query({ postgresId: dbId })
							: await client.mysql.one.query({ mysqlId: dbId });
					database =
						details?.databaseName ||
						(await input("Database name to back up:", undefined, {
							field: "database",
							flag: "--database",
						}));
				}

				const _spinner = startSpinner("Creating backup schedule...");

				const common = {
					database: database as string,
					destinationId,
					schedule,
					prefix,
					keepLatestCount,
					enabled: options.enabled !== false,
				};
				await client.backup.create.mutate(
					dbType === "postgres"
						? { ...common, databaseType: "postgres", postgresId: dbId }
						: { ...common, databaseType: "mysql", mysqlId: dbId },
				);

				succeedSpinner("Backup schedule created!");

				if (isJsonMode()) {
					outputData({ created: true });
				} else {
					log("");
					log(colors.success("Backup schedule created."));
					log(
						`View: ${colors.dim("tarout db backups <db>")} for your database.`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get backup by ID
	backups
		.command("info")
		.argument("<backup-id>", "Backup ID")
		.description("Show backup configuration details")
		.action(async (backupId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching backup...");

				const backup = await client.backup.one.query({ backupId });

				succeedSpinner();

				if (isJsonMode()) {
					outputData(backup);
					return;
				}

				// A sanitized backup record: schedule fields, the database it
				// belongs to (postgresId / mysqlId + relation) and its destination.
				// It has no createdAt.
				const b = backup as any;
				const type = backupDatabaseType(b);
				const databaseId = type === "mysql" ? b.mysqlId : b.postgresId;
				const databaseName = (type === "mysql" ? b.mysql : b.postgres)?.name;
				quietOutput(String(b.backupId || backupId));
				log("");
				log(colors.bold(`Backup: ${b.backupId || backupId}`));
				log("");
				log(
					`  Database: ${databaseName ? `${databaseName} ` : ""}${colors.dim(
						`(${type === "mysql" ? "MySQL" : "PostgreSQL"} ${databaseId || "-"})`,
					)}`,
				);
				log(`  Backs up: ${b.database || "-"}`);
				log(
					`  Destination: ${
						b.destination?.name ? `${b.destination.name} ` : ""
					}${colors.dim(`(${b.destinationId || "none"})`)}`,
				);
				log(`  Schedule: ${b.schedule || "-"}`);
				log(
					`  Keep: ${b.keepLatestCount ? `${b.keepLatestCount} backups` : "all backups"}`,
				);
				log(
					`  Enabled: ${b.enabled ? colors.success("yes") : colors.dim("no")}`,
				);
				log(`  Prefix: ${b.prefix || "-"}`);
				log("");
				log(colors.dim(`Files: tarout backups files ${b.backupId || backupId}`));
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Update backup schedule
	backups
		.command("update")
		.argument("<backup-id>", "Backup ID to update")
		.description("Update a backup schedule configuration")
		.option("--schedule <cron>", "New cron schedule")
		.option("--keep <n>", "Number of backups to keep")
		.option("--enable", "Enable the backup schedule")
		.option("--disable", "Disable the backup schedule")
		.option("--destination-id <id>", "New destination ID")
		.action(async (backupId, options) => {
			try {
				// backup.update is a partial update: send backupId plus only the
				// fields the user asked to change. Echoing the stored row back sent
				// nulls (keepLatestCount, enabled, destinationId are nullable
				// columns) that the update schema rejects.
				if (options.enable && options.disable) {
					throw new CliError(
						"Pass either --enable or --disable, not both.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const updates: {
					backupId: string;
					schedule?: string;
					keepLatestCount?: number;
					enabled?: boolean;
					destinationId?: string;
				} = { backupId };
				if (options.schedule !== undefined) {
					updates.schedule = assertCronSchedule(options.schedule);
				}
				if (options.keep !== undefined) {
					updates.keepLatestCount = parseKeepCount(options.keep);
				}
				if (options.enable) updates.enabled = true;
				if (options.disable) updates.enabled = false;
				if (options.destinationId) {
					updates.destinationId = String(options.destinationId);
				}
				if (Object.keys(updates).length === 1) {
					throw new CliError(
						"Nothing to update. Pass --schedule, --keep, --enable, --disable or --destination-id.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}

				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _updateSpinner = startSpinner("Updating backup...");

				await client.backup.update.mutate(updates);

				succeedSpinner("Backup updated!");

				if (isJsonMode()) {
					outputData({ updated: true, backupId });
				} else {
					log("");
					log(colors.success("Backup schedule updated."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Delete backup schedule
	backups
		.command("delete")
		.argument("<backup-id>", "Backup ID to delete")
		.description("Delete a backup schedule")
		.action(async (backupId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete backup schedule "${backupId}"?`,
						false,
						{
							field: "confirm_delete_backup",
							flag: "--yes",
							context: { backupId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting backup...");

				await client.backup.remove.mutate({ backupId });

				succeedSpinner("Backup schedule deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, backupId });
				} else {
					quietOutput(backupId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Trigger a manual backup
	backups
		.command("run")
		.argument("<backup-id>", "Backup ID to run now")
		.description("Trigger an immediate backup")
		.option("--mysql", "Force MySQL backup")
		.action(async (backupId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				let dbType: BackupDatabaseType = "postgres";
				if (!options.mysql) {
					try {
						const b = await client.backup.one.query({ backupId });
						// databaseType is the authoritative engine on the record.
						dbType = backupDatabaseType(b);
					} catch {
						// default to postgres
					}
				} else {
					dbType = "mysql";
				}

				const _spinner = startSpinner("Running backup...");

				if (dbType === "mysql") {
					await client.backup.manualBackupMySql.mutate({ backupId });
				} else {
					await client.backup.manualBackupPostgres.mutate({ backupId });
				}

				succeedSpinner("Backup completed!");

				if (isJsonMode()) {
					outputData({ success: true, backupId });
				} else {
					log("");
					log(colors.success("Manual backup completed successfully."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// List the files a backup schedule has written
	backups
		.command("files")
		.argument("<backup-id>", "Backup schedule ID (from `tarout db backups <db>`)")
		.description("List the backup files a backup schedule has written")
		.option("-s, --search <path>", "Only files whose path contains this", "")
		.action(async (backupId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Listing backup files...");

				const scope = await resolveBackupFileScope(client, backupId);
				const files = await client.backup.listBackupFiles.query({
					...scope,
					search: options.search || "",
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(files);
					return;
				}

				const list: any[] = Array.isArray(files) ? files : [];

				if (!list.length) {
					log("");
					log("No backup files found.");
					return;
				}

				log("");
				// Path is the full object key: `download-url` needs it verbatim.
				table(
					["PATH", "SIZE", "TYPE"],
					list.map((f: any) => [
						f.Path || f.Name || "",
						f.IsDir ? colors.dim("DIR") : formatBytes(f.Size || 0),
						f.IsDir ? colors.dim("directory") : "file",
					]),
				);
				log("");
				log(
					colors.dim(
						`Download one with: tarout backups download-url ${backupId} <path>`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Get download URL for a backup file
	backups
		.command("download-url")
		.argument("<backup-id>", "Backup schedule ID (from `tarout db backups <db>`)")
		.argument("<backup-file>", "Backup file path (from `tarout backups files`)")
		.description("Get a signed download URL for a backup file")
		.action(async (backupId, backupFile) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Generating download URL...");

				const scope = await resolveBackupFileScope(client, backupId);
				const result = await client.backup.getBackupDownloadUrl.mutate({
					...scope,
					backupFile,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				// Quiet mode: emit the bare signed download URL for scripting/piping.
				quietOutput(String((result as any)?.url || result));

				log("");
				log(`Download URL for ${colors.cyan(backupFile)}:`);
				log("");
				log(`  ${colors.cyan((result as any).url || String(result))}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Web server backups. `backup.manualBackupWebServer` always throws ("not
	// supported in cloud-native mode"), so answer here instead of sending a
	// request that can only fail with an opaque server error.
	backups
		.command("backup-web")
		.argument("[backup-id]", "Backup configuration ID")
		.description("No longer applies: web server backups are not supported")
		.action(() => {
			handleError(
				new CliError(
					"Web server backups are not supported on Tarout. To back up a database now, run `tarout backups run <backup-id>`.",
				),
			);
		});

	// Restore a backup.
	//
	// The platform exposes restore ONLY as a tRPC subscription
	// (`backup.restoreBackupWithLogs`, streamed for live logs). The CLI talks to
	// the API over `httpBatchLink`, which cannot consume subscriptions, so there
	// is no transport that can drive a restore from here today. Rather than emit
	// a cryptic "no mutation procedure" error, fail with clear guidance.
	//
	// TODO(platform): expose a non-subscription restore endpoint (mutation that
	// enqueues the job and returns a jobId) so the CLI can offer restore.
	backups
		.command("restore")
		.argument("<backup-id>", "Backup configuration ID")
		.argument("<backup-file>", "Backup file name to restore")
		.description("Restore a backup (from the dashboard's Backups tab)")
		.action(async (_backupId, _backupFile) => {
			handleError(
				new CliError(
					"Backup restore is not available from the CLI: the platform runs it as a streaming job this client cannot drive. Restore from the Backups tab of the database in the Tarout dashboard.",
					ExitCode.GENERAL_ERROR,
				),
			);
		});
}
