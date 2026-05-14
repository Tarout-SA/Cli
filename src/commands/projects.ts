import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn, updateProfile } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, table } from "../lib/output.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

interface ProjectSummary {
	description?: string | null;
	isDefault?: boolean;
	name: string;
	projectId: string;
	slug: string;
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

				await client.project.setActive.mutate({
					projectId: target.projectId,
				});

				updateProfile({
					projectId: target.projectId,
					projectName: target.name,
					projectSlug: target.slug,
					// Switching project clears env on the server too — drop our cached env.
					environmentId: "",
					environmentName: "",
				});

				succeedSpinner(
					`Switched to project ${colors.success(target.name)} (${target.slug})`,
				);
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
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);
}
