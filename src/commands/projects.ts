import type { Command } from "commander";
import { getApiClient, setRequestProjectId } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn, updateProfile } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
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

interface ProjectSummary {
	description?: string | null;
	isDefault?: boolean;
	name: string;
	projectId: string;
	slug: string;
}

/**
 * A legacy project-scoped key has its project baked into the credential, so it
 * cannot be moved by mutating session state — switching to a different target
 * needs browser reauthorization. An account-scoped key carries no pinned
 * project (the active one travels per request), so for it switching is purely a
 * local change and is always allowed.
 */
export async function verifyProjectCredentialScope(
	client: any,
	target: ProjectSummary,
): Promise<ProjectSummary> {
	const effective = await client.project.credentialScope.query();
	if (effective?.accountScoped === true) return target;
	if (effective?.projectId !== target.projectId) {
		throw new AuthError(
			`Cannot switch to ${target.name} with the current project-scoped credential. Run \`tarout login\` and select that project in the browser.`,
		);
	}
	return target;
}

/**
 * `tarout projects ...` commands.
 *
 * Projects were introduced in the May-2026 environment redesign. Each
 * organization can hold multiple projects (Vercel/Railway-style); each project
 * holds its own set of environments and resources. Profiles persist a
 * `projectId` to scope subsequent commands.
 */
export function registerProjectsCommands(program: Command) {
	const projects = program
		.command("projects")
		.description("Manage projects within the active organization");

	projects
		.command("list")
		.alias("ls")
		.description("List projects in the active organization")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const profile = getCurrentProfile();
				const _spinner = startSpinner("Fetching projects...");

				const all: ProjectSummary[] = await client.project.all.query();
				succeedSpinner();

				if (isJsonMode()) {
					outputData(all);
					return;
				}

				if (isQuietMode()) {
					for (const p of all) {
						if (p.projectId) quietOutput(p.projectId);
					}
					return;
				}

				if (all.length === 0) {
					log("");
					log("No projects found in this organization.");
					return;
				}

				table(
					["NAME", "SLUG", "DEFAULT", "ACTIVE"],
					all.map((p) => [
						p.name,
						p.slug,
						p.isDefault ? "yes" : "",
						p.projectId === profile?.projectId
							? colors.success("● active")
							: "",
					]),
				);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	projects
		.command("use <slugOrId>")
		.description("Switch the active project for this profile")
		.action(async (slugOrId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Switching project...");

				const all: ProjectSummary[] = await client.project.all.query();
				const target = all.find(
					(p) =>
						p.projectId === slugOrId ||
						p.slug === slugOrId ||
						p.name.toLowerCase() === slugOrId.toLowerCase(),
				);
				if (!target) {
					failSpinner();
					log(`Project "${slugOrId}" not found.`);
					return;
				}

				await verifyProjectCredentialScope(client, target);

				updateProfile({
					projectId: target.projectId,
					projectName: target.name,
					projectSlug: target.slug,
					// Switching project clears env on the server too — drop our cached env.
				});

				succeedSpinner(
					`Switched to project ${colors.success(target.name)} (${target.slug})`,
				);
				if (isJsonMode()) {
					outputData({
						projectId: target.projectId,
						name: target.name,
						slug: target.slug,
						verified: true,
					});
				} else {
					quietOutput(target.projectId);
				}
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	projects
		.command("create <name>")
		.description("Create a new project in the active organization")
		.option("-s, --slug <slug>", "URL-safe slug (auto-generated if omitted)")
		.option("-d, --description <text>", "Optional description")
		.action(
			async (
				name: string,
				options: { slug?: string; description?: string },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Creating project...");

					const created = await client.project.create.mutate({
						name,
						slug: options.slug,
						description: options.description,
					});

					succeedSpinner(
						`Created project ${colors.success(created.name)} (${created.slug})`,
					);

					// After an account-only login nothing is selected yet, so the
					// project the user just created is the obvious one to act on —
					// otherwise the very next command would stop to ask.
					if (!getCurrentProfile()?.projectId) {
						updateProfile({
							projectId: created.projectId,
							projectName: created.name,
							projectSlug: created.slug,
						});
						setRequestProjectId(created.projectId);
						if (!isJsonMode()) {
							log(`Active project set to ${colors.success(created.name)}.`);
						}
					}

					if (isJsonMode()) {
						outputData(created);
					} else {
						quietOutput(created.projectId);
					}
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// Update project
	projects
		.command("update")
		.argument("<project-id>", "Project ID or slug")
		.description("Update project name or description")
		.option("-n, --name <name>", "New project name")
		.option("-d, --description <text>", "New project description")
		.action(async (projectId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let name = options.name;
				if (!name) {
					name = await input("New name (leave blank to keep):", undefined, {
						field: "project_name",
						flag: "--name",
						context: { projectId },
					});
				}

				const client = getApiClient();
				const _spinner = startSpinner("Updating project...");

				await client.project.update.mutate({
					projectId,
					name: name || undefined,
					description: options.description,
				} as any);

				succeedSpinner("Project updated!");

				if (isJsonMode()) {
					outputData({ updated: true, projectId });
				} else {
					quietOutput(projectId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Delete project
	projects
		.command("delete")
		.argument("<project-id>", "Project ID or slug")
		.description("Delete a project and all its resources")
		.action(async (projectId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					log("");
					log(
						colors.warn(
							`Warning: Deleting project "${projectId}" will remove all its apps, databases, and environments.`,
						),
					);
					log("");
					const confirmed = await confirm(
						`Delete project "${projectId}"? This cannot be undone.`,
						false,
						{
							field: "confirm_delete_project",
							flag: "--yes",
							context: { projectId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting project...");

				await client.project.delete.mutate({ projectId } as any);

				succeedSpinner("Project deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, projectId });
				} else {
					quietOutput(projectId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Show project stats
	projects
		.command("stats")
		.argument("<project-id>", "Project ID or slug")
		.description("Show resource counts for a project")
		.action(async (projectId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching project stats...");

				const data = await client.project.stats.query({ projectId } as any);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				const p = (data as any).project;
				const c = (data as any).counts;

				quietOutput(p?.projectId || projectId);

				log("");
				log(colors.bold(p?.name || projectId));
				log(colors.dim(p?.projectId || projectId));
				log("");
				if (c) {
					log(`  Applications: ${colors.cyan(String(c.applications || 0))}`);
					log(`  Databases: ${colors.cyan(String(c.databases || 0))}`);
					log(`  Environments: ${colors.cyan(String(c.environments || 0))}`);
					log(`  Domains: ${colors.cyan(String(c.domains || 0))}`);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Set project as default
	projects
		.command("set-default")
		.argument("<project-id>", "Project ID or slug")
		.description("Set a project as the organization default")
		.action(async (projectId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Setting default project...");

				await client.project.setDefault.mutate({ projectId } as any);

				succeedSpinner("Default project updated!");

				if (isJsonMode()) {
					outputData({ default: true, projectId });
				} else {
					quietOutput(projectId);
					log("");
					log(
						`${colors.success("Default project set.")} New resources will be created in this project.`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get a single project by ID
	projects
		.command("get")
		.argument("<project>", "Project ID or name")
		.description("Get details of a specific project")
		.action(async (projectIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching project...");
				const all = await client.project.all.query();
				const proj = Array.isArray(all)
					? all.find(
							(p: any) =>
								(p.projectId || p.id) === projectIdentifier ||
								(p.projectId || p.id || "").startsWith(projectIdentifier) ||
								(p.name || "").toLowerCase() ===
									projectIdentifier.toLowerCase(),
						)
					: null;
				if (!proj) {
					failSpinner();
					log(`Project "${projectIdentifier}" not found.`);
					return;
				}
				const full = await client.project.one.query({
					projectId: proj.projectId || proj.id,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(full);
					return;
				}
				const p = full as any;
				quietOutput(p.projectId || p.id || projectIdentifier);
				log("");
				log(colors.bold(p.name || "Project"));
				log(colors.dim(p.projectId || p.id || ""));
				log(`  Apps: ${p.applicationCount ?? "-"}`);
				log(
					`  Created: ${p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "-"}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get the currently active project
	projects
		.command("active")
		.description("Show the currently active project")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching active project...");
				const proj = await client.project.getActive.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(proj);
					return;
				}
				const p = proj as any;
				if (!p) {
					log("\nNo active project set.\n");
					return;
				}
				const activeProjectId = p.projectId || p.id;
				if (activeProjectId) quietOutput(activeProjectId);
				log("");
				log(colors.bold("Active Project"));
				log(`  Name: ${colors.cyan(p.name || "-")}`);
				log(`  ID:   ${colors.dim(p.projectId || p.id || "-")}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}
