import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError, NotFoundError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerTicketsCommands(program: Command) {
	const tickets = program
		.command("tickets")
		.description("Manage support tickets");

	// List tickets
	tickets
		.command("list")
		.alias("ls")
		.description("List support tickets")
		.option(
			"-s, --status <status>",
			"Filter by status: open, in_progress, resolved, closed",
		)
		.option("-n, --limit <n>", "Number of tickets to show", Number.parseInt)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching tickets...");

				const result = await client.supportTicket.list.query({
					status: options.status,
					limit: options.limit || 20,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				const ticketList = result?.tickets || result?.items || result || [];

				if (!Array.isArray(ticketList) || ticketList.length === 0) {
					log("");
					log("No support tickets found.");
					log("");
					log(`Create one with: ${colors.dim("tarout tickets create")}`);
					return;
				}

				// Show unread count if available
				try {
					const unread = await client.supportTicket.unreadCount.query();
					if (unread && unread.count > 0) {
						log(
							`\n${colors.warn(`${unread.count} unread ticket${unread.count === 1 ? "" : "s"}`)}`,
						);
					}
				} catch {
					// ignore
				}

				log("");
				table(
					["ID", "SUBJECT", "STATUS", "PRIORITY", "CATEGORY", "CREATED"],
					ticketList.map((t: any) => [
						colors.cyan((t.ticketId || t.id || "").slice(0, 8)),
						truncate(t.subject || "", 35),
						formatStatus(t.status),
						formatPriority(t.priority),
						t.category || colors.dim("-"),
						formatDate(t.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${ticketList.length} ticket${ticketList.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Create a ticket
	tickets
		.command("create")
		.description("Create a new support ticket")
		.option("-s, --subject <subject>", "Ticket subject")
		.option(
			"-p, --priority <priority>",
			"Priority: low, medium, high, critical",
		)
		.option(
			"-c, --category <category>",
			"Category: billing, technical, account, feature_request",
		)
		.option("-d, --description <description>", "Ticket description")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let subject = options.subject;
				let priority = options.priority;
				let category = options.category;

				if (!subject) {
					subject = await input("Subject:", undefined, {
						field: "ticket_subject",
						flag: "--subject",
					});
				}

				if (!priority) {
					priority = await select(
						"Priority:",
						[
							{ name: "Low", value: "low" },
							{ name: "Medium", value: "medium" },
							{ name: "High", value: "high" },
							{ name: "Critical - Production is down!", value: "critical" },
						],
						{ field: "ticket_priority", flag: "--priority" },
					);
				}

				if (!category) {
					category = await select(
						"Category:",
						[
							{ name: "Technical issue", value: "technical" },
							{ name: "Billing question", value: "billing" },
							{ name: "Account management", value: "account" },
							{ name: "Feature request", value: "feature_request" },
						],
						{ field: "ticket_category", flag: "--category" },
					);
				}

				log("");
				const description =
					options.description ||
					(await input(
						"Description (press Enter twice when done):",
						undefined,
						{ field: "ticket_description", flag: "--description" },
					));

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Subject: ${colors.bold(subject)}`);
					log(`Priority: ${formatPriority(priority)}`);
					log(`Category: ${category}`);
					log("");

					const confirmed = await confirm("Submit this ticket?", true, {
						field: "confirm_submit_ticket",
						flag: "--yes",
						context: { subject, priority, category },
					});
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Creating ticket...");

				const ticket = await client.supportTicket.create.mutate({
					subject,
					description,
					priority,
					category,
				});

				succeedSpinner("Ticket created!");

				const ticketId = ticket.ticketId || ticket.id;

				if (isJsonMode()) {
					outputData(ticket);
					return;
				}

				quietOutput(ticketId || subject);

				box("Support Ticket Created", [
					`ID: ${colors.cyan(ticketId || "")}`,
					`Subject: ${subject}`,
					`Priority: ${formatPriority(priority)}`,
					`Status: ${formatStatus("open")}`,
				]);

				log(
					`View: ${colors.dim(`tarout tickets view ${(ticketId || "").slice(0, 8)}`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// View a ticket
	tickets
		.command("view")
		.argument("<ticket>", "Ticket ID")
		.description("View a support ticket and its messages")
		.action(async (ticketIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching ticket...");

				// First try to find by partial ID
				let ticketId = ticketIdentifier;
				if (ticketIdentifier.length < 36) {
					// Partial ID — fetch list and match
					const result = await client.supportTicket.list.query({ limit: 50 });
					const list = result?.tickets || result?.items || result || [];
					const found = list.find((t: any) =>
						(t.ticketId || t.id || "").startsWith(ticketIdentifier),
					);
					if (!found) {
						failSpinner();
						throw new NotFoundError("Ticket", ticketIdentifier);
					}
					ticketId = found.ticketId || found.id;
				}

				const ticket = await client.supportTicket.getById.query({ ticketId });

				succeedSpinner();

				if (isJsonMode()) {
					outputData(ticket);
					return;
				}

				log("");
				log(colors.bold(ticket.subject));
				log(colors.dim(ticket.ticketId || ticket.id));
				log("");
				log(`  Status: ${formatStatus(ticket.status)}`);
				log(`  Priority: ${formatPriority(ticket.priority)}`);
				log(`  Category: ${ticket.category || colors.dim("-")}`);
				log(`  Created: ${formatDate(ticket.createdAt)}`);
				log("");

				if (ticket.description) {
					log(colors.bold("Description"));
					log(`  ${ticket.description}`);
					log("");
				}

				const messages = ticket.messages || ticket.replies || [];

				if (messages.length > 0) {
					log(colors.bold(`Messages (${messages.length})`));
					log(colors.dim("─".repeat(50)));

					for (const msg of messages) {
						log("");
						const author = msg.author?.name || msg.isStaff ? "Support" : "You";
						const timestamp = formatDateTime(msg.createdAt);
						log(`  ${colors.bold(author)} ${colors.dim(`· ${timestamp}`)}`);
						log(`  ${msg.content}`);
					}
					log(colors.dim("─".repeat(50)));
				}

				log("");
				log(
					`Reply: ${colors.dim(`tarout tickets reply ${(ticket.ticketId || ticket.id || "").slice(0, 8)}`)}`,
				);
				if (ticket.status !== "closed") {
					log(
						`Close: ${colors.dim(`tarout tickets close ${(ticket.ticketId || ticket.id || "").slice(0, 8)}`)}`,
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Reply to a ticket
	tickets
		.command("reply")
		.argument("<ticket>", "Ticket ID")
		.description("Add a reply to a support ticket")
		.option("-m, --message <message>", "Reply message")
		.action(async (ticketIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let message = options.message;

				if (!message) {
					message = await input("Your reply:", undefined, {
						field: "reply_message",
						flag: "--message",
					});
				}

				// Resolve ticket ID
				const client = getApiClient();
				let ticketId = ticketIdentifier;

				if (ticketIdentifier.length < 36) {
					const _spinner = startSpinner("Finding ticket...");
					const result = await client.supportTicket.list.query({ limit: 50 });
					const list = result?.tickets || result?.items || result || [];
					const found = list.find((t: any) =>
						(t.ticketId || t.id || "").startsWith(ticketIdentifier),
					);
					if (!found) {
						failSpinner();
						throw new NotFoundError("Ticket", ticketIdentifier);
					}
					ticketId = found.ticketId || found.id;
					succeedSpinner();
				}

				const _spinner = startSpinner("Sending reply...");

				await client.supportTicket.addMessage.mutate({
					ticketId,
					content: message,
				});

				succeedSpinner("Reply sent!");

				if (isJsonMode()) {
					outputData({ replied: true, ticketId });
				} else {
					log("");
					log(colors.success("Reply sent successfully."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get upload URL for a ticket attachment
	tickets
		.command("upload-url")
		.argument("<ticket>", "Ticket ID")
		.argument("<filename>", "File name to upload")
		.description("Get a pre-signed URL to upload a file attachment to a ticket")
		.action(async (ticketIdentifier, filename) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				let ticketId = ticketIdentifier;
				if (ticketIdentifier.length < 36) {
					const _spinner = startSpinner("Finding ticket...");
					const result = await client.supportTicket.list.query({ limit: 50 });
					const list = result?.tickets || result?.items || result || [];
					const found = list.find((t: any) =>
						(t.ticketId || t.id || "").startsWith(ticketIdentifier),
					);
					if (!found) {
						failSpinner();
						throw new NotFoundError("Ticket", ticketIdentifier);
					}
					ticketId = found.ticketId || found.id;
					succeedSpinner();
				}
				const _spinner = startSpinner("Getting upload URL...");
				const data = await client.supportTicket.getUploadUrl.query({
					ticketId,
					fileName: filename,
				} as any);
				succeedSpinner();
				if (isJsonMode()) outputData(data);
				else {
					log("");
					log(colors.bold("Upload URL"));
					log(`  URL: ${colors.cyan((data as any).uploadUrl || "-")}`);
					log(`  Expires: ${(data as any).expiresAt || "-"}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Register an uploaded attachment on a ticket
	tickets
		.command("attach")
		.argument("<ticket>", "Ticket ID")
		.argument("<filename>", "File name that was uploaded")
		.option("--file-key <key>", "Storage file key returned by the upload")
		.option("--size <bytes>", "File size in bytes", Number.parseInt)
		.description("Register an uploaded file as a ticket attachment")
		.action(async (ticketIdentifier, filename, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				let ticketId = ticketIdentifier;
				if (ticketIdentifier.length < 36) {
					const _spinner = startSpinner("Finding ticket...");
					const result = await client.supportTicket.list.query({ limit: 50 });
					const list = result?.tickets || result?.items || result || [];
					const found = list.find((t: any) =>
						(t.ticketId || t.id || "").startsWith(ticketIdentifier),
					);
					if (!found) {
						failSpinner();
						throw new NotFoundError("Ticket", ticketIdentifier);
					}
					ticketId = found.ticketId || found.id;
					succeedSpinner();
				}
				const _spinner = startSpinner("Creating attachment record...");
				const result = await client.supportTicket.createAttachment.mutate({
					ticketId,
					fileName: filename,
					fileKey: options.fileKey,
					fileSize: options.size,
				} as any);
				succeedSpinner("Attachment created!");
				if (isJsonMode()) outputData(result);
				else {
					quietOutput((result as any)?.attachmentId || filename);
					log(`\n${colors.success("File attached to ticket.")}\n`);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get download URL for a ticket attachment
	tickets
		.command("download-url")
		.argument("<ticket>", "Ticket ID")
		.argument("<attachment-id>", "Attachment ID")
		.description("Get a pre-signed download URL for a ticket attachment")
		.action(async (ticketIdentifier, attachmentId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				let ticketId = ticketIdentifier;
				if (ticketIdentifier.length < 36) {
					const _spinner = startSpinner("Finding ticket...");
					const result = await client.supportTicket.list.query({ limit: 50 });
					const list = result?.tickets || result?.items || result || [];
					const found = list.find((t: any) =>
						(t.ticketId || t.id || "").startsWith(ticketIdentifier),
					);
					if (!found) {
						failSpinner();
						throw new NotFoundError("Ticket", ticketIdentifier);
					}
					ticketId = found.ticketId || found.id;
					succeedSpinner();
				}
				const _spinner = startSpinner("Getting download URL...");
				const data = await client.supportTicket.getDownloadUrl.query({
					ticketId,
					attachmentId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) outputData(data);
				else {
					log("");
					log(colors.bold("Download URL"));
					log(`  URL: ${colors.cyan((data as any).downloadUrl || "-")}`);
					log(`  Expires: ${(data as any).expiresAt || "-"}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Close a ticket
	tickets
		.command("close")
		.argument("<ticket>", "Ticket ID to close")
		.description("Close a support ticket")
		.action(async (ticketIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Close ticket "${ticketIdentifier}"?`,
						false,
						{
							field: "confirm_close_ticket",
							flag: "--yes",
							context: { ticket: ticketIdentifier },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				// Resolve ticket ID
				const client = getApiClient();
				let ticketId = ticketIdentifier;

				if (ticketIdentifier.length < 36) {
					const _spinner = startSpinner("Finding ticket...");
					const result = await client.supportTicket.list.query({ limit: 50 });
					const list = result?.tickets || result?.items || result || [];
					const found = list.find((t: any) =>
						(t.ticketId || t.id || "").startsWith(ticketIdentifier),
					);
					if (!found) {
						failSpinner();
						throw new NotFoundError("Ticket", ticketIdentifier);
					}
					ticketId = found.ticketId || found.id;
					succeedSpinner();
				}

				const _spinner = startSpinner("Closing ticket...");

				await client.supportTicket.close.mutate({ ticketId });

				succeedSpinner("Ticket closed!");

				if (isJsonMode()) {
					outputData({ closed: true, ticketId });
				}
			} catch (err) {
				handleError(err);
			}
		});
}

function formatStatus(status: string): string {
	const map: Record<string, string> = {
		open: colors.info("● open"),
		in_progress: colors.warn("◐ in progress"),
		resolved: colors.success("✓ resolved"),
		closed: colors.dim("○ closed"),
	};
	return map[status] || status;
}

function formatPriority(priority: string): string {
	const map: Record<string, string> = {
		low: colors.dim("low"),
		medium: colors.info("medium"),
		high: colors.warn("high"),
		critical: colors.error("critical"),
	};
	return map[priority] || priority;
}

function formatDate(date: Date | string | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function formatDateTime(date: Date | string | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 3)}...`;
}
