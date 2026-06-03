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
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerAccountCommands(program: Command) {
	const account = program
		.command("account")
		.description("Manage your user account");

	// ── Get current user profile ─────────────────────────────────────────────────
	account
		.command("info")
		.alias("whoami")
		.description("Show current user profile")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching profile...");
				const user = await client.user.get.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(user);
					return;
				}
				const u = user as any;
				log("");
				log(colors.bold(u.name || u.email || "-"));
				log(`  Email:  ${u.email || "-"}`);
				log(`  Role:   ${u.role || "-"}`);
				log(`  ID:     ${colors.dim(u.id || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Update account ────────────────────────────────────────────────────────────
	account
		.command("update")
		.description("Update your profile (name, email, or password)")
		.option("-n, --name <name>", "New display name")
		.option("-e, --email <email>", "New email address")
		.option("-p, --password <password>", "New password")
		.option(
			"--current-password <password>",
			"Current password (required for email/password change)",
		)
		.action(
			async (options: {
				name?: string;
				email?: string;
				password?: string;
				currentPassword?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const updates: Record<string, string> = {};
					if (options.name) updates.name = options.name;
					if (options.email) updates.email = options.email;
					if (options.password) {
						updates.password = options.password;
						updates.currentPassword =
							options.currentPassword ||
							(await input("Current password:", undefined, {
								field: "currentPassword",
								flag: "--current-password",
								sensitive: true,
							}));
					}

					if (Object.keys(updates).length === 0) {
						log("No changes specified.");
						return;
					}

					const client = getApiClient();
					const _spinner = startSpinner("Updating account...");
					await client.user.update.mutate(updates as any);
					succeedSpinner("Account updated.");
					if (isJsonMode()) outputData({ updated: true });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Delete account ────────────────────────────────────────────────────────────
	account
		.command("delete")
		.description("Permanently delete your account")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					log("");
					log(
						colors.error(
							"Warning: This will permanently delete your account and all associated data.",
						),
					);
					log("");
					const confirmed = await confirm(
						"Delete your account? This cannot be undone.",
						false,
						{ field: "confirm_delete_account", flag: "--yes" },
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const confirmEmail = await input(
					"Type your email address to confirm:",
					undefined,
					{ field: "confirm_email", flag: "--confirm-email" },
				);
				const client = getApiClient();
				const _spinner = startSpinner("Deleting account...");
				await client.user.deleteSelf.mutate({ confirmEmail } as any);
				succeedSpinner("Account deleted.");
				if (isJsonMode()) outputData({ deleted: true });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Invitations ────────────────────────────────────────────────────────────────
	account
		.command("invitations")
		.description("List pending organization invitations")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching invitations...");
				const invitations = await client.user.getInvitations.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(invitations);
					return;
				}
				const list = Array.isArray(invitations) ? invitations : [];
				if (list.length === 0) {
					log("");
					log("No pending invitations.");
					return;
				}
				log("");
				table(
					["ORGANIZATION", "ROLE", "INVITED BY", "EXPIRES"],
					list.map((inv: any) => [
						inv.organization?.name || inv.organizationId || "-",
						inv.role || "-",
						inv.invitedBy?.email || "-",
						inv.expiresAt ? new Date(inv.expiresAt).toLocaleDateString() : "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── API Keys ───────────────────────────────────────────────────────────────────
	const apiKeys = account
		.command("api-keys")
		.description("Manage personal API keys");

	apiKeys
		.command("create")
		.description("Create a personal API key")
		.option("-n, --name <name>", "Key name")
		.option("--prefix <prefix>", "Key prefix")
		.option("--expires <days>", "Expiry in days (leave blank for no expiry)")
		.option("--rate-limit", "Enable rate limiting")
		.option("--rate-limit-window <ms>", "Rate limit time window in ms", "60000")
		.option("--rate-limit-max <n>", "Max requests per window", "100")
		.action(
			async (options: {
				name?: string;
				prefix?: string;
				expires?: string;
				rateLimit?: boolean;
				rateLimitWindow?: string;
				rateLimitMax?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const name =
						options.name ||
						(await input("API key name:", undefined, {
							field: "name",
							flag: "--name",
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Creating API key...");
					const result = await client.user.createApiKey.mutate({
						name,
						prefix: options.prefix,
						expiresIn: options.expires
							? Number.parseInt(options.expires) * 86400
							: undefined,
						rateLimitEnabled: options.rateLimit || false,
						rateLimitTimeWindow: Number.parseInt(
							options.rateLimitWindow || "60000",
						),
						rateLimitMax: Number.parseInt(options.rateLimitMax || "100"),
					} as any);
					succeedSpinner("API key created.");
					if (isJsonMode()) {
						outputData(result);
						return;
					}
					const r = result as any;
					log("");
					log(colors.bold("API Key Created"));
					log(colors.warn("Save this key — it won't be shown again!"));
					log("");
					log(`  Key:    ${colors.cyan(r.token || r.key || "-")}`);
					log(`  Name:   ${name}`);
					log(`  ID:     ${colors.dim(r.id || "-")}`);
					log("");
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	apiKeys
		.command("delete <api-key-id>")
		.alias("rm")
		.description("Delete a personal API key")
		.action(async (apiKeyId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete API key "${apiKeyId}"?`,
						false,
						{
							field: "confirm_delete_api_key",
							flag: "--yes",
							context: { apiKeyId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Deleting API key...");
				await client.user.deleteApiKey.mutate({ apiKeyId } as any);
				succeedSpinner("API key deleted.");
				if (isJsonMode()) outputData({ deleted: true, apiKeyId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Generate auth token ────────────────────────────────────────────────────────
	account
		.command("generate-token")
		.description("Generate a one-time metrics/auth token")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Generating token...");
				const result = await client.user.generateToken.mutate();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				log("");
				log(`Token: ${colors.cyan(r.token || String(result))}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Metrics token ──────────────────────────────────────────────────────────────
	account
		.command("metrics-token")
		.description("Get the organization metrics token")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching metrics token...");
				const result = await client.user.getMetricsToken.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				log("");
				log(`Metrics token: ${colors.cyan(r.token || String(result))}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// Get user by ID
	account
		.command("user")
		.argument("<user-id>", "User ID")
		.description("Get public info about a user by ID")
		.action(async (userId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching user...");
				const u = await client.user.one.query({ userId } as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(u);
					return;
				}
				const user = u as any;
				log("");
				log(colors.bold(user.name || user.email || userId));
				log(`  Email: ${user.email || "-"}`);
				log(`  Role:  ${user.role || "-"}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Check root access
	account
		.command("root-access")
		.description("Check if the current user has root/admin access")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking access...");
				const result = await client.user.haveRootAccess.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const hasAccess = (result as any)?.hasAccess ?? result;
				log(
					`\nRoot access: ${hasAccess ? colors.success("yes") : colors.error("no")}\n`,
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Get server metrics
	account
		.command("server-metrics")
		.description("Get server performance metrics for the organization")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching server metrics...");
				const metrics = await client.user.getServerMetrics.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(metrics);
					return;
				}
				const m = metrics as any;
				log("");
				log(colors.bold("Server Metrics"));
				log(`  CPU:    ${m.cpu ?? "-"}%`);
				log(`  Memory: ${m.memory ?? "-"}%`);
				log(`  Disk:   ${m.disk ?? "-"}%`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get container metrics
	account
		.command("container-metrics")
		.argument("<app-id>", "Application ID")
		.description("Get container metrics for an application")
		.action(async (appId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching container metrics...");
				const metrics = await client.user.getContainerMetrics.query({
					applicationId: appId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(metrics);
					return;
				}
				const m = metrics as any;
				log("");
				log(colors.bold("Container Metrics"));
				log(`  CPU:    ${m.cpu ?? "-"}%`);
				log(`  Memory: ${m.memory ?? "-"} MB`);
				log(`  Net In: ${m.networkIn ?? "-"}`);
				log(`  Net Out:${m.networkOut ?? "-"}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Check user organizations
	account
		.command("check-orgs")
		.description("Check which organizations the current user belongs to")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking organizations...");
				const result = await client.user.checkUserOrganizations.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const list = Array.isArray(result)
					? result
					: (result as any)?.organizations || [];
				log("");
				table(
					["ORG ID", "NAME", "ROLE"],
					list.map((o: any) => [
						colors.cyan((o.id || o.organizationId || "").slice(0, 8)),
						o.name || o.organizationName || "-",
						o.role || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// List all org members (org owner)
	account
		.command("members")
		.description(
			"List all members of the current organization (org owner only)",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching members...");
				const members = await client.user.all.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(members);
					return;
				}
				const list = Array.isArray(members)
					? members
					: (members as any)?.users || [];
				if (!list.length) {
					log("\nNo members found.\n");
					return;
				}
				log("");
				table(
					["ID", "NAME", "EMAIL", "ROLE"],
					list.map((m: any) => [
						colors.cyan((m.id || m.userId || "").slice(0, 8)),
						m.name || "-",
						m.email || "-",
						m.role || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Remove a member (org owner)
	account
		.command("remove-member")
		.argument("<user-id>", "User ID to remove from the organization")
		.description("Remove a member from the organization (org owner only)")
		.action(async (userId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const { confirm: confirmFn } = await import("../utils/prompts.js");
					const ok = await confirmFn(
						`Remove user "${userId}" from the organization?`,
						false,
						{
							field: "confirm_remove_member",
							flag: "--yes",
							context: { userId },
						},
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Removing member...");
				await client.user.remove.mutate({ userId } as any);
				succeedSpinner("Member removed!");
				if (isJsonMode()) outputData({ removed: true, userId });
			} catch (err) {
				handleError(err);
			}
		});

	// Assign member permissions (org owner)
	account
		.command("assign-permissions")
		.argument("<user-id>", "User ID")
		.option("--role <role>", "Role: admin, member")
		.description("Assign permissions/role to a member (org owner only)")
		.action(async (userId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const { select: selectFn } = await import("../utils/prompts.js");
				const role =
					options.role ||
					(await selectFn(
						"Role:",
						[
							{ name: "Admin", value: "admin" },
							{ name: "Member", value: "member" },
						],
						{ field: "role", flag: "--role" },
					));
				const client = getApiClient();
				const _spinner = startSpinner("Assigning permissions...");
				await client.user.assignPermissions.mutate({ userId, role } as any);
				succeedSpinner("Permissions updated!");
				if (isJsonMode()) outputData({ userId, role });
			} catch (err) {
				handleError(err);
			}
		});

	// Send org invitation (org owner)
	account
		.command("invite")
		.argument("<email>", "Email address to invite")
		.option(
			"--role <role>",
			"Role for the invited user: admin, member",
			"member",
		)
		.description("Send an organization invitation (org owner only)")
		.action(async (email, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Sending invitation...");
				await client.user.sendInvitation.mutate({
					email,
					role: options.role,
				} as any);
				succeedSpinner("Invitation sent!");
				if (isJsonMode())
					outputData({ invited: true, email, role: options.role });
				else {
					log("");
					log(colors.success(`Invitation sent to ${email}.`));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get user backups (org owner)
	account
		.command("user-backups")
		.description(
			"Get backup configuration for the organization (org owner only)",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching backup info...");
				const result = await client.user.getBackups.query();
				succeedSpinner();
				if (isJsonMode()) outputData(result);
				else {
					log("");
					log(colors.bold("User Backup Information"));
					log(JSON.stringify(result, null, 2));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});
}
