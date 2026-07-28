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
	colors,
	isJsonMode,
	isQuietMode,
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

				if (isQuietMode()) {
					for (const org of organizations as any[]) {
						if (org.id) quietOutput(org.id);
					}
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
				} else {
					quietOutput(profile.organizationId);
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
					quietOutput(profile.organizationId);
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

				// Server derives the org from the session and takes only the new
				// owner's id (`{ newOwnerId }`).
				await client.organization.transferOwnership.mutate({
					newOwnerId: userId,
				});

				succeedSpinner("Ownership transferred!");

				if (isJsonMode()) {
					outputData({ transferred: true, newOwnerId: userId });
				} else {
					quietOutput(userId);
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
				} else {
					quietOutput(invitationId);
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

				// Local-profile switch only. Scope is org -> project -> resources;
				// the platform dropped the environment layer entirely (migration
				// 20260722150000_environment_removal_phase_b), so there is nothing
				// else to resolve here. This used to call a phantom
				// `client.environment.all` and failed at runtime for every user.
				updateProfile({
					organizationId: org.id,
					organizationName: org.name,
				});

				succeedSpinner(`Switched to ${org.name}`);

				if (isJsonMode()) {
					outputData({
						organizationId: org.id,
						organizationName: org.name,
					});
				} else {
					quietOutput(org.id);
					log("");
					log(`Organization: ${colors.bold(org.name)}`);
					log(
						colors.dim(
							"Note: this updates local CLI defaults only — your API key stays bound to its organization server-side, so resource commands still target that org.",
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get organization-level billing status. NOTE: subscription PLANS are
	// per-project (see `tarout billing status`); this only reports the org-wide
	// billing opt-in / trial state (`organization.getSubscription` returns just
	// `{ status, trialEndsAt }` — no plan).
	orgs
		.command("subscription")
		.description(
			"Show org-level billing status (trial/opt-in). For your plan, use `tarout billing status`.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching billing status...");
				const sub = await client.organization.getSubscription.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(sub);
					return;
				}
				const s = sub as { status?: string; trialEndsAt?: string | null };
				quietOutput(s?.status || "none");
				log("");
				log(colors.bold("Organization Billing Status"));
				log(`  Status: ${s?.status ? colors.cyan(s.status) : colors.dim("none")}`);
				if (s?.trialEndsAt) {
					log(`  Trial ends: ${new Date(s.trialEndsAt).toLocaleDateString()}`);
				}
				log("");
				log(
					colors.dim(
						"Plans are per-project — see your plan with: tarout billing status",
					),
				);
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
				else quietOutput(org.id);
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
