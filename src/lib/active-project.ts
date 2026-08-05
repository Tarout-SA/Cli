/**
 * @fileoverview Active-project resolution. Login authorizes the account and
 * organization only, so the project a command acts on is chosen here and
 * travels per request in the x-tarout-project header.
 * @module lib/active-project
 */

import { select } from "../utils/prompts.js";
import { getApiClient, setRequestProjectId } from "./api.js";
import { getCurrentProfile, updateProfile } from "./config.js";
import { NotFoundError } from "./errors.js";

export interface ProjectChoice {
	projectId: string;
	name: string;
	slug: string;
}

export function findProject(
	all: ProjectChoice[],
	slugOrId: string,
): ProjectChoice | undefined {
	return all.find(
		(p) =>
			p.projectId === slugOrId ||
			p.slug === slugOrId ||
			p.name.toLowerCase() === slugOrId.toLowerCase(),
	);
}

function activate(project: ProjectChoice): string {
	updateProfile({
		projectId: project.projectId,
		projectName: project.name,
		projectSlug: project.slug,
	});
	setRequestProjectId(project.projectId);
	return project.projectId;
}

/**
 * Resolve the project this invocation acts on: `--project`, else the saved
 * profile, else the org's only project, else an interactive pick.
 *
 * Returns null only when the organization owns no project yet — the caller
 * decides whether that is fatal or an invitation to create one.
 */
export async function resolveActiveProject(opts?: {
	projectFlag?: string;
}): Promise<string | null> {
	const flag = opts?.projectFlag;

	if (!flag) {
		const saved = getCurrentProfile()?.projectId;
		if (saved) {
			setRequestProjectId(saved);
			return saved;
		}
	}

	const client = getApiClient();
	const all: ProjectChoice[] = await client.project.all.query();

	if (flag) {
		const target = findProject(all, flag);
		if (!target) {
			throw new NotFoundError("Project", flag, [
				"Run `tarout projects list` to see available projects.",
				"Run `tarout projects create <name>` to make a new one.",
			]);
		}
		return activate(target);
	}

	if (all.length === 0) return null;
	if (all.length === 1) return activate(all[0] as ProjectChoice);

	// The descriptor makes --json and non-TTY runs emit a structured
	// needs_input and exit 6 rather than blocking on a prompt nobody can answer.
	const chosen = await select(
		"Select a project",
		all.map((p) => ({ name: `${p.name} (${p.slug})`, value: p.projectId })),
		{ field: "project", flag: "--project" },
	);
	const target = all.find((p) => p.projectId === chosen);
	if (!target) {
		throw new NotFoundError("Project", chosen);
	}
	return activate(target);
}
