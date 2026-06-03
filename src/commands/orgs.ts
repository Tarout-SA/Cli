import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn, updateProfile } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	NotFoundError,
} from "../lib/errors.js";
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
import { confirm, input } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerOrgsCommands(program: Command) {
	const orgs = program.command("orgs").description("Manage organizations");

	// List organizations
	orgs
		.command("list")
		.alias("ls")
		.description("List your organizations")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const profile = getCurrentProfile();
				const _spinner = startSpinner("Fetching organizations...");

				const organizations = await client.organization.all.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(organizations);
					return;
				}

				if (organizations.length === 0) {
					log("");
					log("No organizations found.");
					return;
				}

				log("");
				table(
					["ID", "NAME", "ACTIVE"],
					organizations.map((org: any) => [
						colors.cyan(org.id.slice(0, 8)),
						org.name,
						org.id === profile?.organizationId ? colors.success("*") : "",
					]),
				);
				log("");
				log(
					colors.dim(
						`${organizations.length} organization${organizations.length === 1 ? "" : "s"}`,
					),
				);
				log("");
				log(`Current: ${colors.bold(profile?.organizationName || "None")}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Update organization name
	orgs
		.command("update")
		.description("Update organization settings")
		.option("-n, --name <name>", "New organization name")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				let name = options.name;
				if (!name) {
					name = await input(
						`New name (current: ${profile.organizationName}):`,
						undefined,
						{
							field: "organization_name",
							flag: "--name",
							context: { currentName: profile.organizationName },
						},
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Updating organization...");

				await client.organization.update.mutate({ name });

				updateProfile({ organizationName: name });

				succeedSpinner(`Organization renamed to "${name}"`);

				if (isJsonMode()) {
					outputData({ updated: true, name });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Delete organization
	orgs
		.command("delete")
		.description("Delete the current organization (owner only)")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					log("");
					log(
						colors.warn(
							`Warning: This will permanently delete organization "${profile.organizationName}" and ALL its resources.`,
						),
					);
					log("");
					const confirmed = await confirm(
						`Type the organization name "${profile.organizationName}" to confirm deletion:`,
						false,
						{
							field: "confirm_delete_organization",
							flag: "--yes",
							context: {
								organizationId: profile.organizationId,
								organizationName: profile.organizationName,
							},
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting organization...");

				await client.organization.delete.mutate({
					organizationId: profile.organizationId,
				});

				succeedSpinner("Organization deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, organizationId: profile.organizationId });
				} else {
					log("");
					log(
						colors.success(
							"Organization deleted. Run `tarout logout` to clear session.",
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Transfer organization ownership
	orgs
		.command("transfer")
		.argument("<user-id>", "User ID to transfer ownership to")
		.description("Transfer organization ownership to another member")
		.action(async (userId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					log("");
					log(
						colors.warn(
							`Warning: You will lose owner access to "${profile.organizationName}" after this transfer.`,
						),
					);
					log("");
					const confirmed = await confirm(
						`Transfer ownership to user "${userId}"?`,
						false,
						{
							field: "confirm_transfer_ownership",
							flag: "--yes",
							context: {
								organizationId: profile.organizationId,
								newOwnerUserId: userId,
							},
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Transferring ownership...");

				await client.organization.transferOwnership.mutate({
					organizationId: profile.organizationId,
					userId,
				});

				succeedSpinner("Ownership transferred!");

				if (isJsonMode()) {
					outputData({ transferred: true, newOwnerId: userId });
				} else {
					log("");
					log(colors.success("Ownership transferred successfully."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Org members subcommand group
	const members = orgs
		.command("members")
		.description("Manage organization members");

	// List members
	members
		.command("list")
		.alias("ls")
		.description("List organization members")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching members...");

				const org = await client.organization.one.query({
					organizationId: getCurrentProfile()?.organizationId || "",
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(org?.members || []);
					return;
				}

				const memberList = org?.members || [];

				if (memberList.length === 0) {
					log("");
					log("No members found.");
					return;
				}

				log("");
				table(
					["NAME", "EMAIL", "ROLE", "JOINED"],
					memberList.map((m: any) => [
						m.user?.name || m.name || colors.dim("-"),
						m.user?.email || m.email || colors.dim("-"),
						formatRole(m.role),
						formatDate(m.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${memberList.length} member${memberList.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// List invitations
	members
		.command("invitations")
		.description("List pending member invitations")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching invitations...");

				const invitations = await client.organization.allInvitations.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(invitations);
					return;
				}

				if (!invitations || invitations.length === 0) {
					log("");
					log("No pending invitations.");
					return;
				}

				log("");
				table(
					["EMAIL", "ROLE", "STATUS", "INVITED"],
					invitations.map((inv: any) => [
						inv.email,
						formatRole(inv.role),
						inv.status || "pending",
						formatDate(inv.createdAt),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Revoke invitation
	members
		.command("revoke")
		.argument("<invitation-id>", "Invitation ID to revoke")
		.description("Revoke a pending member invitation")
		.action(async (invitationId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Revoke invitation "${invitationId}"?`,
						false,
						{
							field: "confirm_revoke_invitation",
							flag: "--yes",
							context: { invitationId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Revoking invitation...");

				await client.organization.removeInvitation.mutate({ invitationId });

				succeedSpinner("Invitation revoked!");

				if (isJsonMode()) {
					outputData({ revoked: true, invitationId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Switch organization
	orgs
		.command("switch")
		.argument("<org>", "Organization ID or name")
		.description("Switch to a different organization")
		.action(async (orgIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Switching organization...");

				const organizations = await client.organization.all.query();
				const org = findOrg(organizations, orgIdentifier);

				if (!org) {
					failSpinner();
					const suggestions = findSimilar(
						orgIdentifier,
						organizations.map((o: any) => o.name),
					);
					throw new NotFoundError("Organization", orgIdentifier, suggestions);
				}

				// Get environments for the new org
				// Note: This requires a server-side endpoint to switch org context
				// For now, we update the local profile
				// In full implementation, this would call a tRPC endpoint to update session

				// Get first environment for the new org
				const envs = await client.environment.all.query();
				const defaultEnv =
					envs.find((e: any) => e.organizationId === org.id) || envs[0];

				updateProfile({
					organizationId: org.id,
					organizationName: org.name,
					environmentId: defaultEnv?.environmentId,
					environmentName: defaultEnv?.name || "production",
				});

				succeedSpinner(`Switched to ${org.name}`);

				if (isJsonMode()) {
					outputData({
						organizationId: org.id,
						organizationName: org.name,
						environmentId: defaultEnv?.environmentId,
						environmentName: defaultEnv?.name,
					});
				} else {
					quietOutput(org.id);
					log("");
					log(`Organization: ${colors.bold(org.name)}`);
					log(`Environment: ${colors.bold(defaultEnv?.name || "production")}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get organization subscription
	orgs
		.command("subscription")
		.description("Show subscription details for the current organization")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching subscription...");
				const sub = await client.organization.getSubscription.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(sub);
					return;
				}
				const s = sub as any;
				log("");
				log(colors.bold("Organization Subscription"));
				log(
					`  Plan:   ${s?.planKey ? colors.cyan(s.planKey) : colors.dim("free")}`,
				);
				log(`  Status: ${s?.status || colors.dim("active")}`);
				if (s?.currentPeriodEnd) {
					log(`  Renews: ${new Date(s.currentPeriodEnd).toLocaleDateString()}`);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Set active organization (switches session context)
	orgs
		.command("activate")
		.argument("<org>", "Organization ID or name")
		.description("Set the active organization for the current session")
		.action(async (orgIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding organization...");
				const organizations = await client.organization.all.query();
				const org = findOrg(organizations, orgIdentifier);
				if (!org) {
					failSpinner();
					throw new NotFoundError("Organization", orgIdentifier);
				}
				const _activeSpinner = startSpinner("Activating organization...");
				await client.organization.setActive.mutate({
					organizationId: org.id,
				} as any);
				succeedSpinner(`Organization "${org.name}" is now active!`);
				if (isJsonMode())
					outputData({ organizationId: org.id, organizationName: org.name });
			} catch (err) {
				handleError(err);
			}
		});
}

export function registerEnvsCommands(program: Command) {
	const envs = program
		.command("envs")
		.description("Manage environments (production/staging)");

	// List environments
	envs
		.command("list")
		.alias("ls")
		.description("List environments")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const profile = getCurrentProfile();
				const _spinner = startSpinner("Fetching environments...");

				const environments = await client.environment.all.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(environments);
					return;
				}

				if (environments.length === 0) {
					log("");
					log("No environments found.");
					return;
				}

				log("");
				table(
					["ID", "NAME", "ACTIVE"],
					environments.map((env: any) => [
						colors.cyan(env.environmentId.slice(0, 8)),
						env.name,
						env.environmentId === profile?.environmentId
							? colors.success("*")
							: "",
					]),
				);
				log("");
				log(`Current: ${colors.bold(profile?.environmentName || "None")}`);
			} catch (err) {
				handleError(err);
			}
		});

	// Create environment
	envs
		.command("create")
		.argument("[name]", "Environment name")
		.description("Create a new environment")
		.option("-d, --description <text>", "Environment description")
		.action(async (name) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let envName = name;
				if (!envName) {
					envName = await input(
						"Environment name (e.g., staging):",
						undefined,
						{ field: "environment_name", flag: "name" },
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Creating environment...");

				const env = await client.environment.create.mutate({
					name: envName,
				});

				succeedSpinner(`Environment "${envName}" created!`);

				if (isJsonMode()) {
					outputData(env);
					return;
				}

				box("Environment Created", [
					`ID: ${colors.cyan(env.environmentId)}`,
					`Name: ${env.name}`,
				]);

				log(`Switch to it: ${colors.dim(`tarout envs switch ${env.name}`)}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Delete environment
	envs
		.command("delete")
		.alias("rm")
		.argument("<env>", "Environment ID or name")
		.description("Delete an environment")
		.action(async (envIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding environment...");
				const environments = await client.environment.all.query();
				const env = findEnv(environments, envIdentifier);

				if (!env) {
					failSpinner();
					const suggestions = findSimilar(
						envIdentifier,
						environments.map((e: any) => e.name),
					);
					throw new NotFoundError("Environment", envIdentifier, suggestions);
				}

				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Environment: ${colors.bold(env.name)}`);
					log(`ID: ${colors.dim(env.environmentId)}`);
					log("");
					log(
						colors.warn("All resources in this environment will be deleted."),
					);
					log("");

					const confirmed = await confirm(
						`Delete environment "${env.name}"?`,
						false,
						{
							field: "confirm_delete_environment",
							flag: "--yes",
							context: {
								environmentId: env.environmentId,
								environmentName: env.name,
							},
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting environment...");

				await client.environment.delete.mutate({
					environmentId: env.environmentId,
				});

				succeedSpinner("Environment deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, environmentId: env.environmentId });
				} else {
					quietOutput(env.environmentId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Switch environment
	envs
		.command("switch")
		.argument("<env>", "Environment ID or name")
		.description("Switch to a different environment")
		.action(async (envIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Switching environment...");

				const environments = await client.environment.all.query();
				const env = findEnv(environments, envIdentifier);

				if (!env) {
					failSpinner();
					const suggestions = findSimilar(
						envIdentifier,
						environments.map((e: any) => e.name),
					);
					throw new NotFoundError("Environment", envIdentifier, suggestions);
				}

				// Update local profile
				// In full implementation, this would call a tRPC endpoint to update session
				updateProfile({
					environmentId: env.environmentId,
					environmentName: env.name,
				});

				succeedSpinner(`Switched to ${env.name}`);

				if (isJsonMode()) {
					outputData({
						environmentId: env.environmentId,
						environmentName: env.name,
					});
				} else {
					quietOutput(env.environmentId);
					log("");
					log(`Environment: ${colors.bold(env.name)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Info
	envs
		.command("info")
		.argument("<env>", "Environment ID or name")
		.description("Show environment details")
		.action(async (envIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching environment...");
				const environments = await client.environment.all.query();
				const env = findEnv(environments, envIdentifier);
				if (!env) {
					failSpinner();
					throw new NotFoundError("Environment", envIdentifier);
				}
				const data = await client.environment.one.query({
					environmentId: env.environmentId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const e = data as any;
				log("");
				log(colors.bold(e.name || envIdentifier));
				log(`  Slug:       ${e.slug || "-"}`);
				log(`  Protected:  ${e.isProtected ? colors.warn("yes") : "no"}`);
				log(`  Default:    ${e.isDefault ? colors.success("yes") : "no"}`);
				log(`  Project:    ${e.projectId || "-"}`);
				log(`  ID:         ${colors.dim(e.environmentId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// Update environment
	envs
		.command("update")
		.argument("<env>", "Environment ID or name")
		.description("Update an environment name or protection")
		.option("-n, --name <name>", "New display name")
		.option("--protect", "Mark as protected")
		.option("--unprotect", "Remove protection")
		.action(async (envIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching environment...");
				const environments = await client.environment.all.query();
				const env = findEnv(environments, envIdentifier);
				if (!env) {
					failSpinner();
					throw new NotFoundError("Environment", envIdentifier);
				}
				const isProtected = options.protect
					? true
					: options.unprotect
						? false
						: undefined;
				const _updateSpinner = startSpinner("Updating environment...");
				await client.environment.update.mutate({
					environmentId: env.environmentId,
					displayName: options.name,
					isProtected,
				});
				succeedSpinner("Environment updated.");
				if (isJsonMode()) {
					outputData({ updated: true, environmentId: env.environmentId });
				} else {
					quietOutput(env.environmentId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Set default environment
	envs
		.command("set-default")
		.argument("<env>", "Environment ID or name")
		.description("Set environment as the project default")
		.action(async (envIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching environment...");
				const environments = await client.environment.all.query();
				const env = findEnv(environments, envIdentifier);
				if (!env) {
					failSpinner();
					throw new NotFoundError("Environment", envIdentifier);
				}
				const _setSpinner = startSpinner("Setting default...");
				await client.environment.setDefault.mutate({
					environmentId: env.environmentId,
				});
				succeedSpinner(`${env.name} is now the default environment.`);
				if (isJsonMode()) {
					outputData({ default: true, environmentId: env.environmentId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Environment stats
	envs
		.command("stats")
		.argument("<env>", "Environment ID or name")
		.description("Show resource counts for an environment")
		.action(async (envIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching environment...");
				const environments = await client.environment.all.query();
				const env = findEnv(environments, envIdentifier);
				if (!env) {
					failSpinner();
					throw new NotFoundError("Environment", envIdentifier);
				}
				const data = await client.environment.stats.query({
					environmentId: env.environmentId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const s = data as any;
				log("");
				log(colors.bold(env.name));
				log(`  Applications: ${colors.cyan(String(s.applications || 0))}`);
				log(`  Databases:    ${colors.cyan(String(s.databases || 0))}`);
				log(`  Domains:      ${colors.cyan(String(s.domains || 0))}`);
				log(`  Storage:      ${colors.cyan(String(s.storage || 0))}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get active environment
	envs
		.command("active")
		.description("Show the currently active environment")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching active environment...");
				const data = await client.environment.getActive.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const e = data as any;
				log("");
				log(colors.bold("Active Environment"));
				log(`  Name: ${e.name || "-"}`);
				log(`  Slug: ${e.slug || "-"}`);
				log(`  ID:   ${colors.dim(e.environmentId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// List environments filtered by project
	envs
		.command("by-project")
		.argument("<project-id>", "Project ID")
		.description("List environments for a specific project")
		.action(async (projectId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching environments...");
				const result = await client.environment.byProject.query({
					projectId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const envList = Array.isArray(result)
					? result
					: (result as any)?.environments || [];
				if (!envList.length) {
					log("\nNo environments found for this project.\n");
					return;
				}
				log("");
				table(
					["ID", "NAME", "TYPE"],
					envList.map((e: any) => [
						colors.cyan((e.environmentId || "").slice(0, 8)),
						e.name || "-",
						e.type || e.slug || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Set active environment (server-side session switch)
	envs
		.command("activate")
		.argument("<env>", "Environment ID or name")
		.description("Set the active environment in the current session")
		.action(async (envIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding environment...");
				const envList = await client.environment.all.query();
				const env = findEnv(
					Array.isArray(envList) ? envList : [],
					envIdentifier,
				);
				if (!env) {
					failSpinner();
					throw new NotFoundError("Environment", envIdentifier);
				}
				const _activeSpinner = startSpinner("Activating environment...");
				await client.environment.setActive.mutate({
					environmentId: env.environmentId,
				} as any);
				succeedSpinner(`Environment "${env.name}" is now active!`);
				if (isJsonMode())
					outputData({ environmentId: env.environmentId, name: env.name });
			} catch (err) {
				handleError(err);
			}
		});
}

function formatRole(role: string): string {
	const map: Record<string, string> = {
		owner: colors.success("owner"),
		admin: colors.info("admin"),
		member: "member",
	};
	return map[role] || role;
}

function formatDate(date: Date | string | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

// Helper functions
function findOrg(orgs: any[], identifier: string) {
	const lowerIdentifier = identifier.toLowerCase();

	return orgs.find(
		(org) =>
			org.id === identifier ||
			org.id.startsWith(identifier) ||
			org.name.toLowerCase() === lowerIdentifier,
	);
}

function findEnv(envs: any[], identifier: string) {
	const lowerIdentifier = identifier.toLowerCase();

	return envs.find(
		(env) =>
			env.environmentId === identifier ||
			env.environmentId.startsWith(identifier) ||
			env.name.toLowerCase() === lowerIdentifier,
	);
}
