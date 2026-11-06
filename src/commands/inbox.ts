import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

/** How many notifications `get` / `unread` page in to resolve an id prefix. */
const ID_RESOLUTION_PAGE_SIZE = 100;

interface NotificationSummary {
	createdAt?: Date | string | null;
	id: string;
	message?: string | null;
	read?: boolean;
	title?: string | null;
	type?: string | null;
}

/**
 * Resolve a notification reference the way every other group in this CLI
 * resolves a resource: the full id, or an unambiguous prefix of one.
 * Notification ids are cuids, so retyping one from `inbox list` in full is
 * exactly the step a human gets wrong — but a prefix that matches two rows has
 * to be an error rather than a coin toss, because `unread` and `read` write.
 */
export function resolveNotificationId(
	notifications: NotificationSummary[],
	identifier: string,
): NotificationSummary {
	const exact = notifications.find((item) => item.id === identifier);
	if (exact) return exact;

	const matches = notifications.filter((item) =>
		item.id.startsWith(identifier),
	);
	if (matches.length === 1 && matches[0]) return matches[0];
	if (matches.length > 1) {
		throw new InvalidArgumentError(
			`"${identifier}" matches ${matches.length} notifications (${matches
				.slice(0, 3)
				.map((item) => item.id)
				.join(", ")}${matches.length > 3 ? ", ..." : ""}). Pass more of the id.`,
		);
	}
	throw new NotFoundError("Notification", identifier);
}

/**
 * One page of the inbox is enough to turn a reference into an id: the two
 * commands that need it act on something the caller just saw in `inbox list`.
 */
async function resolveNotificationRef(
	client: ReturnType<typeof getApiClient>,
	identifier: string,
): Promise<NotificationSummary> {
	const page = (await client.appNotification.list.query({
		limit: ID_RESOLUTION_PAGE_SIZE,
		unreadOnly: false,
	} as any)) as
		| NotificationSummary[]
		| { notifications?: NotificationSummary[] };
	const notifications = Array.isArray(page) ? page : (page?.notifications ?? []);
	return resolveNotificationId(notifications, identifier);
}

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

				// appNotification.list returns { notifications, nextCursor }.
				const list = Array.isArray(result)
					? result
					: (result as any)?.notifications || [];
				if (list.length === 0) {
					log("");
					log("No notifications.");
					return;
				}

				log("");
				table(
					["READ", "TITLE", "MESSAGE", "DATE"],
					list.map((n: any) => [
						// `read` is a boolean on the model (not `readAt`).
						n.read ? colors.dim("●") : colors.cyan("●"),
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
				quietOutput(String(count));
				log(`Unread notifications: ${colors.cyan(String(count))}`);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Show one notification ────────────────────────────────────────────────────
	inbox
		.command("get <notification-id>")
		.description(
			"Show one notification in full: its type, title, whole message, read state and the structured payload the platform attached to it (deployment or application ids, for example), which `inbox list` truncates to 50 characters. Accepts the full id or an unambiguous prefix of one, and does not change the read state.",
		)
		.action(async (notificationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching notification...");
				const target = await resolveNotificationRef(client, notificationId);
				const notification = (await client.appNotification.getById.query({
					notificationId: target.id,
				} as any)) as NotificationSummary & {
					data?: unknown;
					organizationName?: string | null;
				};
				succeedSpinner();

				if (isJsonMode()) {
					outputData(notification);
					return;
				}

				quietOutput(notification.id);
				log("");
				log(colors.bold(notification.title || "(untitled)"));
				log(colors.dim(notification.id));
				log("");
				log(`  Type:    ${notification.type ?? colors.dim("-")}`);
				log(
					`  State:   ${notification.read ? colors.dim("read") : colors.cyan("unread")}`,
				);
				log(
					`  Date:    ${
						notification.createdAt
							? new Date(notification.createdAt).toLocaleString()
							: colors.dim("-")
					}`,
				);
				log("");
				log(notification.message || colors.dim("(no message)"));
				if (notification.data !== null && notification.data !== undefined) {
					log("");
					log(colors.bold("Payload"));
					log(colors.dim(JSON.stringify(notification.data, null, 2)));
				}
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Mark as unread ───────────────────────────────────────────────────────────
	inbox
		.command("unread <notification-id>")
		.description(
			"Put a notification back into the unread state, so it counts towards `inbox count` again and shows as unread in the dashboard. The inverse of `inbox read`; useful to re-flag something you opened but have not dealt with. Accepts the full id or an unambiguous prefix.",
		)
		.action(async (notificationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Marking as unread...");
				const target = await resolveNotificationRef(client, notificationId);
				await client.appNotification.markUnread.mutate({
					notificationId: target.id,
				} as any);
				succeedSpinner("Marked as unread.");
				if (isJsonMode()) outputData({ unread: true, notificationId: target.id });
				else quietOutput(target.id);
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
				else quietOutput(notificationId);
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
				else quietOutput(notificationId);
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
