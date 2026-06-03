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
import { confirm, input } from "../utils/prompts.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerNotificationsCommands(program: Command) {
	const notifications = program
		.command("notifications")
		.alias("notifs")
		.description("Manage notification preferences");

	// List notifications
	notifications
		.command("list")
		.alias("ls")
		.description("List notification configurations")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching notifications...");

				const items = await client.notification.all.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(items);
					return;
				}

				const list = Array.isArray(items) ? items : [];

				if (!list.length) {
					log("");
					log("No notification configurations found.");
					log("");
					log(
						`Set up notifications: ${colors.dim("tarout notifications setup")}`,
					);
					return;
				}

				log("");
				table(
					["ID", "NAME", "DEPLOY", "ERRORS", "BACKUPS", "UPTIME"],
					list.map((n: any) => [
						colors.cyan((n.notificationId || n.id || "").slice(0, 8)),
						n.name || "-",
						n.appDeploy ? colors.success("✓") : colors.dim("✗"),
						n.appBuildError ? colors.success("✓") : colors.dim("✗"),
						n.databaseBackup ? colors.success("✓") : colors.dim("✗"),
						n.uptimeAlert ? colors.success("✓") : colors.dim("✗"),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get or create default notification preferences
	notifications
		.command("get")
		.description(
			"Show current notification preferences (creates defaults if none)",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching preferences...");

				const notif = await client.notification.getOrCreate.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(notif);
					return;
				}

				const n = notif as any;

				log("");
				log(colors.bold(n.name || "Notification Preferences"));
				log(colors.dim(n.notificationId || n.id || ""));
				log("");
				log(
					`  App deploys:    ${n.appDeploy ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log(
					`  Build errors:   ${n.appBuildError ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log(
					`  DB backups:     ${n.databaseBackup ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log(
					`  Uptime alerts:  ${n.uptimeAlert ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log(
					`  Server alerts:  ${n.serverThreshold ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				if (n.additionalEmails && n.additionalEmails.length > 0) {
					log(`  Extra emails:   ${n.additionalEmails.join(", ")}`);
				}
				log("");
				log(
					`Edit: ${colors.dim(`tarout notifications setup --id ${(n.notificationId || n.id || "").slice(0, 8)}`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Setup / save preferences (create or update)
	notifications
		.command("setup")
		.description("Configure notification preferences (interactive)")
		.option("-n, --name <name>", "Configuration name")
		.option("--deploy", "Enable deploy notifications")
		.option("--no-deploy", "Disable deploy notifications")
		.option("--errors", "Enable build error notifications")
		.option("--no-errors", "Disable build error notifications")
		.option("--backups", "Enable database backup notifications")
		.option("--no-backups", "Disable database backup notifications")
		.option("--uptime", "Enable uptime alert notifications")
		.option("--no-uptime", "Disable uptime alert notifications")
		.option("--server-threshold", "Enable server threshold alerts")
		.option("--emails <emails>", "Comma-separated additional email addresses")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Build payload from flags or prompt interactively
				const name =
					options.name ||
					(await input("Name (press Enter for default):", undefined, {
						field: "name",
						flag: "--name",
					})) ||
					"Email Notifications";

				const payload: Record<string, unknown> = {
					name,
					appDeploy: options.deploy ?? false,
					appBuildError: options.errors ?? true,
					databaseBackup: options.backups ?? false,
					uptimeAlert: options.uptime ?? true,
					serverThreshold: options.serverThreshold ?? false,
					additionalEmails: options.emails
						? options.emails.split(",").map((e: string) => e.trim())
						: [],
				};

				const _spinner = startSpinner("Saving preferences...");

				const result = await client.notification.save.mutate(payload as any);

				succeedSpinner("Preferences saved!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");
				log(colors.success("Notification preferences saved."));
				log(`Run ${colors.dim("tarout notifications get")} to review.`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Delete a notification configuration
	notifications
		.command("delete")
		.argument("<id>", "Notification ID")
		.description("Delete a notification configuration")
		.action(async (notificationId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete notification configuration "${notificationId}"?`,
						false,
						{
							field: "confirm_delete_notification",
							flag: "--yes",
							context: { notificationId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting...");

				await client.notification.remove.mutate({ notificationId });

				succeedSpinner("Deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, notificationId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get a single notification config by ID
	notifications
		.command("view")
		.argument("<id>", "Notification configuration ID")
		.description("View a single notification configuration")
		.action(async (notificationId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching notification...");
				const notif = await client.notification.one.query({
					notificationId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(notif);
					return;
				}
				const n = notif as any;
				log("");
				log(colors.bold(n.name || "Notification Configuration"));
				log(colors.dim(n.notificationId || n.id || ""));
				log("");
				log(
					`  App deploys:    ${n.appDeploy ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log(
					`  Build errors:   ${n.appBuildError ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log(
					`  DB backups:     ${n.databaseBackup ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log(
					`  Uptime alerts:  ${n.uptimeAlert ? colors.success("enabled") : colors.dim("disabled")}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get available email providers
	notifications
		.command("email-providers")
		.description("List available email providers for notifications")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching email providers...");
				const providers = await client.notification.getEmailProviders.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(providers);
					return;
				}
				const list = Array.isArray(providers)
					? providers
					: (providers as any)?.providers || [];
				if (!list.length) {
					log("\nNo email providers configured.\n");
					return;
				}
				log("");
				table(
					["PROVIDER", "STATUS", "FROM"],
					list.map((p: any) => [
						p.provider || p.name || "-",
						p.isActive ? colors.success("active") : colors.dim("inactive"),
						p.fromEmail || p.from || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Send message to admin
	notifications
		.command("contact-support")
		.description("Send a message to the Tarout support team")
		.option("-t, --title <title>", "Message title")
		.option("-m, --message <message>", "Message body")
		.option("--type <type>", "Message type: info, warning, error", "info")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let title = options.title;
				let message = options.message;

				if (!title) {
					title = await input("Subject:", undefined, {
						field: "title",
						flag: "--title",
					});
				}
				if (!message) {
					message = await input("Message:", undefined, {
						field: "message",
						flag: "--message",
					});
				}

				const client = getApiClient();
				const _spinner = startSpinner("Sending message...");

				await client.notification.sendToAdmin.mutate({
					title,
					message,
					type: options.type || "info",
				});

				succeedSpinner("Message sent!");

				if (isJsonMode()) {
					outputData({ sent: true, title });
				} else {
					log("");
					log(colors.success("Message sent to Tarout support."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Create a notification configuration (org owner)
	notifications
		.command("create")
		.description("Create a new notification configuration (org owner only)")
		.option("-n, --name <name>", "Configuration name")
		.option("--deploy", "Enable deploy notifications")
		.option("--errors", "Enable build error notifications")
		.option("--backups", "Enable backup notifications")
		.option("--uptime", "Enable uptime alert notifications")
		.option("--emails <emails>", "Comma-separated additional email addresses")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const name =
					options.name ||
					(await input("Name:", undefined, {
						field: "name",
						flag: "--name",
					})) ||
					"Notifications";
				const client = getApiClient();
				const _spinner = startSpinner("Creating notification config...");
				const result = await client.notification.create.mutate({
					name,
					appDeploy: options.deploy ?? false,
					appBuildError: options.errors ?? false,
					databaseBackup: options.backups ?? false,
					uptimeAlert: options.uptime ?? false,
					additionalEmails: options.emails
						? options.emails.split(",").map((e: string) => e.trim())
						: [],
				} as any);
				succeedSpinner("Notification config created!");
				if (isJsonMode()) outputData(result);
				else {
					log("");
					log(colors.success(`Notification configuration "${name}" created.`));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Update a notification configuration (org owner)
	notifications
		.command("update")
		.argument("<id>", "Notification configuration ID")
		.description("Update a notification configuration (org owner only)")
		.option("-n, --name <name>", "New name")
		.option("--deploy", "Enable deploy notifications")
		.option("--no-deploy", "Disable deploy notifications")
		.option("--errors", "Enable error notifications")
		.option("--no-errors", "Disable error notifications")
		.option("--uptime", "Enable uptime alerts")
		.option("--no-uptime", "Disable uptime alerts")
		.action(async (notificationId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Updating notification config...");
				await client.notification.update.mutate({
					notificationId,
					name: options.name,
					appDeploy: options.deploy,
					appBuildError: options.errors,
					uptimeAlert: options.uptime,
				} as any);
				succeedSpinner("Notification config updated!");
				if (isJsonMode()) outputData({ updated: true, notificationId });
			} catch (err) {
				handleError(err);
			}
		});
}
