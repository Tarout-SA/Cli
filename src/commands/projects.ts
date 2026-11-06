import type { Command } from "commander";
import { getApiClient, setRequestProjectId } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn, updateProfile } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	InvalidArgumentError,
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
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
} from "../utils/spinner.js";

import {
	type ProjectSummary,
	verifyProjectCredentialScope,
} from "../lib/project-context.js";
export { verifyProjectCredentialScope } from "../lib/project-context.js";

/**
 * `tarout projects ...` commands.
 *
 * Projects were introduced in the May-2026 environment redesign. Each
 * organization can hold multiple projects (Vercel/Railway-style); each project
 * holds its own set of environments and resources. Profiles persist a
 * `projectId` to scope subsequent commands.
 */

/** One row of `project.autofixRuns`. */
interface AutofixRun {
	application?: { appName?: string; name?: string } | null;
	branch?: string | null;
	commitSha?: string | null;
	createdAt?: Date | string | null;
	id: string;
	pullRequestNumber?: number | null;
	pullRequestUrl?: string | null;
	reason?: string | null;
	status?: string | null;
	summary?: string | null;
	trigger?: string | null;
}

/** The run states `services/autofix.ts` writes, in the operator's vocabulary. */
function formatAutofixStatus(status: string | null | undefined): string {
	switch (status) {
		case "succeeded":
			return colors.success("succeeded");
		case "failed":
			return colors.error("failed");
		case "no_fix":
			return colors.warn("no_fix");
		case "skipped":
			return colors.dim("skipped");
		case "queued":
		case "analyzing":
		case "deploying":
			return colors.cyan(status);
		default:
			return status ?? colors.dim("-");
	}
}

/** Default page size of `project.autofixRuns` (the server's own default). */
export const DEFAULT_AUTOFIX_RUNS_LIMIT = 20;
/** `project.autofixRuns` validates `limit` as an int in [1, 50]. */
export const MAX_AUTOFIX_RUNS_LIMIT = 50;

/**
 * Clamp `--limit` into the window `project.autofixRuns` accepts instead of
 * letting zod reject the call: an agent that asks for 500 runs wants "as many
 * as you have", not a BAD_REQUEST. A value that is not a number at all falls
 * back to the server's default rather than being silently read as 0.
 */
export function parseAutofixRunsLimit(raw: string | undefined): number {
	if (raw === undefined) return DEFAULT_AUTOFIX_RUNS_LIMIT;
	const parsed = Number.parseInt(String(raw).trim(), 10);
	if (!Number.isFinite(parsed)) return DEFAULT_AUTOFIX_RUNS_LIMIT;
	return Math.min(Math.max(parsed, 1), MAX_AUTOFIX_RUNS_LIMIT);
}

/**
 * The single place the Autofix on/off vocabulary is turned into the boolean
 * `project.setAutofix` wants, so `on`, `enable` and `true` cannot drift apart.
 */
export function parseAutofixState(raw: string): boolean {
	const value = String(raw).trim().toLowerCase();
	if (value === "on" || value === "enable" || value === "true") return true;
	if (value === "off" || value === "disable" || value === "false") return false;
	throw new InvalidArgumentError(
		`Invalid Autofix state "${raw}". Use "on" or "off".`,
	);
}

/**
 * Match a project the way `projects use` and `projects get` already do: exact
 * id, id prefix, exact slug, or case-insensitive name. The server's
 * `projectId` inputs are real ids only (`getProjectById` does not look up
 * slugs), so every command that advertises "ID or slug" has to resolve the
 * reference locally first.
 */
export function resolveProjectRef(
	projects: ProjectSummary[],
	identifier: string,
): ProjectSummary | undefined {
	const lower = identifier.toLowerCase();
	return projects.find(
		(project) =>
			project.projectId === identifier ||
			project.projectId.startsWith(identifier) ||
			project.slug === identifier ||
			project.name.toLowerCase() === lower,
	);
}

/**
 * Resolve the project a command should act on: the reference the caller
 * passed, or the profile's active project when they passed nothing. Keeps the
 * existing selection mechanism (`tarout projects use`) as the only source of
 * "which project" — these commands add no `--project` flag of their own.
 */
async function resolveProjectId(
	client: ReturnType<typeof getApiClient>,
	identifier?: string,
): Promise<{ projectId: string; label: string }> {
	if (!identifier) {
		const profile = getCurrentProfile();
		if (!profile?.projectId) {
			throw new InvalidArgumentError(
				"No active project. Select one with `tarout projects use <slug>`, or name the project as an argument.",
			);
		}
		return {
			projectId: profile.projectId,
			label: profile.projectName ?? profile.projectId,
		};
	}
	const all: ProjectSummary[] = await client.project.all.query();
	const target = resolveProjectRef(all, identifier);
	if (!target) {
		throw new NotFoundError(
			"Project",
			identifier,
			findSimilar(
				identifier,
				all.flatMap((project) => [project.name, project.slug]).filter(Boolean),
			),
		);
	}
	return { projectId: target.projectId, label: target.name };
}

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
				setRequestProjectId(target.projectId);

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

	// ── Autofix (beta) ───────────────────────────────────────────────────────────
	// Autofix is a per-PROJECT switch (`project.autofixEnabled`) that the AI
	// build-repair pipeline reads before it reacts to anything, so it is managed
	// here and not under `tarout apps`.
	const autofix = projects
		.command("autofix")
		.description(
			"Show or change Autofix (beta) for a project, and read its run history. When Autofix is on, a failed deployment or an app whose uptime monitor goes down makes the platform read the build log and the repository at the failing commit, commit the fix it verified to an autofix/* branch, open a pull request, and deploy that commit immediately — so an agent should check here before diagnosing a broken build itself.",
		);

	autofix
		.command("status", { isDefault: true })
		.argument(
			"[project]",
			"Project ID or slug (default: the active project from `tarout projects use`)",
		)
		.description(
			"Report whether Autofix is currently on for the project. This is the switch the pipeline reads, so `off` means no failed deployment in this project will ever be repaired automatically.",
		)
		.action(async (projectRef?: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching Autofix state...");
				const { projectId } = await resolveProjectId(client, projectRef);
				const project = (await client.project.one.query({
					projectId,
				} as any)) as { name?: string; autofixEnabled?: boolean };
				succeedSpinner();

				const enabled = project?.autofixEnabled === true;
				if (isJsonMode()) {
					outputData({ projectId, autofixEnabled: enabled });
					return;
				}
				quietOutput(enabled ? "on" : "off");
				log("");
				log(colors.bold(`Autofix: ${project?.name ?? projectId}`));
				log(
					`  State: ${enabled ? colors.success("on") : colors.dim("off")} ${colors.dim("(beta)")}`,
				);
				log("");
				if (enabled) {
					log(
						colors.dim(
							"A failed deployment, or an app going down, opens a pull request with the fix and deploys that commit. Merge the PR to keep it — until then your next push to the deploy branch redeploys code without the fix.",
						),
					);
					log(
						colors.dim(
							`Recent runs: tarout projects autofix runs ${projectRef ?? ""}`.trimEnd(),
						),
					);
				} else {
					log(
						colors.dim(
							`Turn it on with: tarout projects autofix on ${projectRef ?? ""}`.trimEnd(),
						),
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	/**
	 * `on` and `off` share one body so the word the user typed is the only
	 * difference, and `parseAutofixState` is the single mapping to the boolean
	 * `project.setAutofix` takes.
	 */
	const toggleAutofix =
		(word: "on" | "off") =>
		async (projectRef?: string): Promise<void> => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const enabled = parseAutofixState(word);
				const client = getApiClient();
				const _spinner = startSpinner(
					enabled ? "Enabling Autofix..." : "Disabling Autofix...",
				);
				const { projectId, label } = await resolveProjectId(client, projectRef);
				const result = (await client.project.setAutofix.mutate({
					projectId,
					enabled,
				} as any)) as { autofixEnabled?: boolean };
				const applied = result?.autofixEnabled === true;
				succeedSpinner(
					applied
						? `Autofix enabled for ${label}.`
						: `Autofix disabled for ${label}.`,
				);

				if (isJsonMode()) {
					outputData({ projectId, autofixEnabled: applied });
					return;
				}
				quietOutput(applied ? "on" : "off");
				if (applied) {
					log("");
					log(
						colors.dim(
							"Autofix only writes to GitHub sources whose installation granted contents:write; anything else records the diagnosis and stops. It never applies environment variable changes, and it is capped at 3 attempts per app per day.",
						),
					);
					log("");
				}
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		};

	autofix
		.command("on")
		.alias("enable")
		.argument(
			"[project]",
			"Project ID or slug (default: the active project from `tarout projects use`)",
		)
		.description(
			"Turn Autofix on for the project. From then on a failed deployment or a downed app lets the platform commit a verified fix to an autofix/* branch, open a pull request and deploy that commit. Only GitHub sources with contents:write are written to; secrets are never guessed, and low-confidence diagnoses are reported instead of applied.",
		)
		.action(toggleAutofix("on"));

	autofix
		.command("off")
		.alias("disable")
		.argument(
			"[project]",
			"Project ID or slug (default: the active project from `tarout projects use`)",
		)
		.description(
			"Turn Autofix off for the project. Failed deployments are then left exactly as they are, and no branch, pull request or deployment is created on your behalf. Runs already recorded stay readable with `tarout projects autofix runs`.",
		)
		.action(toggleAutofix("off"));

	autofix
		.command("runs")
		.argument(
			"[project]",
			"Project ID or slug (default: the active project from `tarout projects use`)",
		)
		.description(
			"List recent Autofix runs for the project, newest first. Each run records what triggered it (build, deploy or runtime), where it got to (queued, analyzing, skipped, no_fix, deploying, succeeded, failed), the diagnosis summary, and the branch and pull request it opened — which is how an agent tells 'the platform is already fixing this' from 'nobody is looking at it'.",
		)
		.option(
			"-n, --limit <n>",
			`Number of runs to show, 1-${MAX_AUTOFIX_RUNS_LIMIT} (values outside the range are clamped)`,
			String(DEFAULT_AUTOFIX_RUNS_LIMIT),
		)
		.action(async (projectRef: string | undefined, options: { limit?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const limit = parseAutofixRunsLimit(options.limit);
				const _spinner = startSpinner("Fetching Autofix runs...");
				const { projectId, label } = await resolveProjectId(client, projectRef);
				const runs = (await client.project.autofixRuns.query({
					projectId,
					limit,
				} as any)) as AutofixRun[];
				succeedSpinner();

				if (isJsonMode()) {
					outputData(runs);
					return;
				}

				if (isQuietMode()) {
					for (const run of runs) {
						if (run.id) quietOutput(run.id);
					}
					return;
				}

				if (!runs || runs.length === 0) {
					log("");
					log(`No Autofix runs recorded for ${label}.`);
					log(
						colors.dim(
							"Nothing has failed since Autofix was turned on, or it is off — check with: tarout projects autofix",
						),
					);
					log("");
					return;
				}

				log("");
				log(colors.bold(`Autofix runs: ${label}`));
				table(
					["WHEN", "APP", "TRIGGER", "STATUS", "PR", "SUMMARY"],
					runs.map((run) => [
						run.createdAt
							? new Date(run.createdAt).toLocaleString("en-US", {
									month: "short",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
								})
							: colors.dim("-"),
						run.application?.name ?? colors.dim("-"),
						run.trigger ?? colors.dim("-"),
						formatAutofixStatus(run.status),
						run.pullRequestNumber
							? `#${run.pullRequestNumber}`
							: colors.dim("-"),
						(run.summary ?? run.reason ?? "-").slice(0, 48),
					]),
				);
				log("");
				const pending = runs.find(
					(run) =>
						run.status === "queued" ||
						run.status === "analyzing" ||
						run.status === "deploying",
				);
				if (pending) {
					log(
						colors.warn(
							`A run is still in progress (${pending.status}) — wait for it before pushing a fix of your own.`,
						),
					);
					log("");
				}
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Free-plan project slot (this organization) ───────────────────────────────
	// `project.freeSlotStatus` resolves the slot through the ACTIVE
	// ORGANIZATION's owner. `orgs free-slot` answers the other question — the
	// calling user's own slot — and the two differ for any member of someone
	// else's organization.
	projects
		.command("free-slot")
		.description(
			"Report whether this organization's one Free-plan project slot is already taken. The slot belongs to the organization's OWNER and is shared by every project here, so `occupied` means the next project you create in this organization has to be on a paid plan. For the slot on your own account — the one that decides whether a NEW organization you create can hold a free project — use `tarout orgs free-slot`.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking free project slot...");
				const status = (await client.project.freeSlotStatus.query()) as {
					occupied?: boolean;
				};
				succeedSpinner();

				const occupied = status?.occupied === true;
				if (isJsonMode()) {
					outputData({ scope: "organization", occupied });
					return;
				}
				quietOutput(occupied ? "occupied" : "free");
				log("");
				log(colors.bold("Free project slot (this organization)"));
				log(
					`  ${occupied ? colors.warn("occupied") : colors.success("free")} ${colors.dim("— owner's account-wide slot")}`,
				);
				log("");
				log(
					colors.dim(
						occupied
							? "The owner's free project is already in use, so `tarout projects create` here lands on a paid plan."
							: "The next project created in this organization can be on the Free plan.",
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
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
