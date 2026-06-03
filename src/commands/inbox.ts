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
import { confirm } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerInboxCommands(program: Command) {
	const inbox = program
		.command("inbox")
		.description("Manage in-app notifications");

	// ── List notifications ────────────────────────────────────────────────────────
	inbox
		.command("list")
		.alias("ls")
		.description("List in-app notifications")
		.option("-n, --limit <n>", "Number of notifications to show", "20")
		.option("--unread", "Show only unread notifications")
		.action(async (options: { limit?: string; unread?: boolean }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching notifications...");
				const result = await client.appNotification.list.query({
					limit: Number.parseInt(options.limit || "20"),
					unreadOnly: options.unread || false,
				} as any);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				const list = Array.isArray(result)
					? result
					: (result as any)?.items || [];
				if (list.length === 0) {
					log("");
					log("No notifications.");
					return;
				}

				log("");
				table(
					["READ", "TITLE", "MESSAGE", "DATE"],
					list.map((n: any) => [
						n.readAt ? colors.dim("●") : colors.cyan("●"),
						n.title || "-",
						(n.message || "-").slice(0, 50),
						n.createdAt ? new Date(n.createdAt).toLocaleDateString() : "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Unread count ─────────────────────────────────────────────────────────────
	inbox
		.command("count")
		.description("Show unread notification count")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching count...");
				const result = await client.appNotification.unreadCount.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const count = (result as any)?.count ?? result;
				log(`Unread notifications: ${colors.cyan(String(count))}`);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Mark as read ─────────────────────────────────────────────────────────────
	inbox
		.command("read <notification-id>")
		.description("Mark a notification as read")
		.action(async (notificationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Marking as read...");
				await client.appNotification.markRead.mutate({ notificationId } as any);
				succeedSpinner("Marked as read.");
				if (isJsonMode()) outputData({ read: true, notificationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Mark all as read ─────────────────────────────────────────────────────────
	inbox
		.command("read-all")
		.description("Mark all notifications as read")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Marking all as read...");
				await client.appNotification.markAllRead.mutate();
				succeedSpinner("All notifications marked as read.");
				if (isJsonMode()) outputData({ allRead: true });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Delete notification ──────────────────────────────────────────────────────
	inbox
		.command("delete <notification-id>")
		.alias("rm")
		.description("Delete a notification")
		.action(async (notificationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Deleting notification...");
				await client.appNotification.delete.mutate({ notificationId } as any);
				succeedSpinner("Notification deleted.");
				if (isJsonMode()) outputData({ deleted: true, notificationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Clear all ────────────────────────────────────────────────────────────────
	inbox
		.command("clear")
		.description("Delete all notifications")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						"Clear all notifications? This cannot be undone.",
						false,
						{
							field: "confirm_clear_notifications",
							flag: "--yes",
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Clearing notifications...");
				await client.appNotification.clearAll.mutate();
				succeedSpinner("All notifications cleared.");
				if (isJsonMode()) outputData({ cleared: true });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
