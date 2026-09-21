import { AuthError } from "./errors.js";

export interface ProjectSummary {
	description?: string | null;
	isDefault?: boolean;
	name: string;
	projectId: string;
	slug: string;
}

/** Project-pinned credentials cannot be moved by changing local selection. */
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
