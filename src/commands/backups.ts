import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

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
		.option("--database <name>", "Database name to back up")
		.option("--prefix <prefix>", "Backup file prefix")
		.option("--keep <n>", "Number of backups to keep", "7")
		.option("--enabled", "Enable the backup schedule", true)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				let dbType: string;
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

				const database =
					options.database ||
					(await input("Database name to back up:", undefined, {
						field: "database",
						flag: "--database",
					}));

				const _spinner = startSpinner("Creating backup schedule...");

				const payload: Record<string, unknown> = {
					databaseType: dbType,
					database,
					destinationId,
					schedule: options.schedule || "0 2 * * *",
					prefix: options.prefix,
					keepLatestCount: Number.parseInt(options.keep) || 7,
					enabled: options.enabled !== false,
				};
				if (dbType === "postgres") payload.postgresId = dbId;
				else payload.mysqlId = dbId;

				await client.backup.create.mutate(payload as any);

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

				const b = backup as any;
				log("");
				log(colors.bold(`Backup: ${b.backupId || backupId}`));
				log("");
				log(`  Database: ${b.database || "-"}`);
				log(`  Schedule: ${b.schedule || "-"}`);
				log(`  Keep: ${b.keepLatestCount || "-"} backups`);
				log(
					`  Enabled: ${b.enabled ? colors.success("yes") : colors.dim("no")}`,
				);
				if (b.prefix) log(`  Prefix: ${b.prefix}`);
				log(`  Created: ${formatDate(b.createdAt)}`);
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
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching backup...");

				const existing = await client.backup.one.query({ backupId });
				const e = existing as any;

				const updates: Record<string, unknown> = {
					backupId,
					databaseType: e.postgres ? "postgres" : "mysql",
					database: e.database,
					destinationId: options.destinationId || e.destinationId,
					schedule: options.schedule || e.schedule,
					prefix: e.prefix,
					keepLatestCount: options.keep
						? Number.parseInt(options.keep)
						: e.keepLatestCount,
					enabled: options.enable ? true : options.disable ? false : e.enabled,
				};
				if (e.postgresId) updates.postgresId = e.postgresId;
				if (e.mysqlId) updates.mysqlId = e.mysqlId;

				const _updateSpinner = startSpinner("Updating backup...");

				await client.backup.update.mutate(updates as any);

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
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Trigger manual backup — PostgreSQL
	backups
		.command("run")
		.argument("<backup-id>", "Backup ID to run now")
		.description("Trigger an immediate backup")
		.option("--mysql", "Force MySQL backup")
		.action(async (backupId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				let dbType = "postgres";
				if (!options.mysql) {
					try {
						const b = await client.backup.one.query({ backupId });
						dbType = (b as any).mysql ? "mysql" : "postgres";
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

	// List backup files in a destination
	backups
		.command("files")
		.argument("<destination-id>", "Backup destination ID")
		.description("List backup files in a destination")
		.option("-s, --search <path>", "Search path or prefix", "")
		.action(async (destinationId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Listing backup files...");

				const files = await client.backup.listBackupFiles.query({
					destinationId,
					search: options.search || "",
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(files);
					return;
				}

				const list = Array.isArray(files) ? files : [];

				if (!list.length) {
					log("");
					log("No backup files found.");
					return;
				}

				log("");
				table(
					["NAME", "SIZE", "TYPE"],
					list.map((f: any) => [
						f.Name || f.Path || "",
						f.IsDir ? colors.dim("DIR") : formatBytes(f.Size || 0),
						f.IsDir ? colors.dim("directory") : "file",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get download URL for a backup file
	backups
		.command("download-url")
		.argument("<destination-id>", "Backup destination ID")
		.argument("<backup-file>", "Backup file path")
		.description("Get a signed download URL for a backup file")
		.action(async (destinationId, backupFile) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Generating download URL...");

				const result = await client.backup.getBackupDownloadUrl.mutate({
					destinationId,
					backupFile,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");
				log(`Download URL for ${colors.cyan(backupFile)}:`);
				log("");
				log(`  ${colors.cyan((result as any).url || String(result))}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Trigger web server backup
	backups
		.command("backup-web")
		.argument("<backup-id>", "Backup configuration ID")
		.description("Manually trigger a web server / app backup")
		.action(async (backupId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Triggering web server backup...");
				const result = await client.backup.manualBackupWebServer.mutate({
					backupId,
				} as any);
				succeedSpinner("Web server backup triggered!");
				if (isJsonMode()) outputData(result);
				else {
					log("");
					log(colors.success("Backup job started. Check logs for progress."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Restore a backup with real-time logs
	backups
		.command("restore")
		.argument("<backup-id>", "Backup configuration ID")
		.argument("<backup-file>", "Backup file name to restore")
		.description("Restore a backup with streaming log output")
		.action(async (backupId, backupFile) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const { confirm: confirmFn } = await import("../utils/prompts.js");
					const ok = await confirmFn(
						`Restore backup file "${backupFile}"? This will overwrite current data.`,
						false,
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Starting restore...");
				const result = await client.backup.restoreBackupWithLogs.mutate({
					backupId,
					backupFile,
				} as any);
				succeedSpinner("Restore initiated!");
				if (isJsonMode()) outputData(result);
				else {
					log("");
					log(
						colors.success("Restore job started. Monitor logs for progress."),
					);
					if ((result as any)?.jobId)
						log(`  Job ID: ${colors.dim((result as any).jobId)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});
}

function formatDate(date: string | Date | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function formatBytes(bytes: number): string {
	if (!bytes || bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
