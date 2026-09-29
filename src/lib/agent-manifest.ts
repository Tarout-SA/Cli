/**
 * @fileoverview The project manifest (`project.manifest`): one read that maps a
 * whole project for an agent, its apps with status, URL, source, domains,
 * linked databases, env var NAMES and job counts, plus its databases, buckets
 * and domains. Shared by `tarout agent manifest` and the `agent_manifest` MCP
 * tool.
 *
 * Not to be confused with `project-manifest.ts`, the committed
 * `.tarout/config.json` deploy contract.
 * @module lib/agent-manifest
 */

import { CliError, isMissingProcedureError } from "./errors.js";
import { colors } from "./output.js";
import { ExitCode } from "../utils/exit-codes.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export interface AgentManifestApplication {
	id: string;
	name: string;
	appName: string;
	status: string;
	url: string | null;
	buildType: string | null;
	source: {
		type: string;
		repository: string | null;
		branch: string | null;
	} | null;
	customDomains: string[];
	databaseIds: string[];
	envVarNames: string[];
	scheduledJobCount: number;
}

export interface AgentManifestDatabase {
	id: string;
	name: string;
	engine: "postgres" | "mysql";
	status: string | null;
	plan: string | null;
	linkedApplicationIds: string[];
	externalAccess: boolean;
}

export interface AgentManifest {
	project: {
		id: string;
		name: string;
		description: string | null;
		region: string | null;
	};
	applications: AgentManifestApplication[];
	databases: AgentManifestDatabase[];
	buckets: Array<{ id: string; name: string; status: string | null }>;
	domains: Array<{
		id: string;
		host: string;
		applicationId: string | null;
		status: string | null;
	}>;
	generatedAt: string;
}

/**
 * Fetches the manifest of `projectId`, or of the session's active project when
 * omitted. A server without `project.manifest` (an older platform release)
 * fails with NOT_FOUND and a pointer at the per-resource commands.
 */
export async function fetchAgentManifest(
	client: TrpcClient,
	projectId?: string,
): Promise<AgentManifest> {
	try {
		return (await client.project.manifest.query(
			projectId ? { projectId } : {},
		)) as AgentManifest;
	} catch (err) {
		if (!isMissingProcedureError(err)) throw err;
		throw new CliError(
			"This Tarout server does not serve project manifests yet (project.manifest is missing; it ships in a newer platform release). Until then, `tarout apps list`, `tarout db list`, `tarout storage list` and `tarout domains list` show the same resources.",
			ExitCode.NOT_FOUND,
			undefined,
			{ procedure: "project.manifest", reason: "procedure_unavailable" },
		);
	}
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describeSource(source: AgentManifestApplication["source"]): string {
	if (!source) return "none";
	const where = source.repository
		? `${source.repository}${source.branch ? `@${source.branch}` : ""}`
		: "";
	return where ? `${source.type} ${where}` : source.type;
}

/**
 * The manifest as a compact tree for a terminal. Env var names are summarized
 * as a count unless `envNames` is set; values are never part of the manifest.
 */
export function renderAgentManifest(
	manifest: AgentManifest,
	options: { envNames?: boolean } = {},
): string[] {
	const { project } = manifest;
	const applications = manifest.applications ?? [];
	const databases = manifest.databases ?? [];
	const buckets = manifest.buckets ?? [];
	const domains = manifest.domains ?? [];
	const appNames = new Map(applications.map((app) => [app.id, app.name]));
	const dbNames = new Map(databases.map((db) => [db.id, db.name]));
	const nameOf = (names: Map<string, string>, id: string) =>
		names.get(id) ?? id;

	const lines: string[] = [];
	const header = [
		`${colors.bold(project.name)} ${colors.dim(`(${project.id})`)}`,
	];
	if (project.region) header.push(`region ${project.region}`);
	lines.push(header.join(" · "));
	if (project.description) lines.push(`│  ${colors.dim(project.description)}`);

	const sections: Array<{ title: string; items: string[][] }> = [
		{
			title: `apps (${applications.length})`,
			items: applications.map((app) => {
				const env = options.envNames
					? `env: ${app.envVarNames.length > 0 ? app.envVarNames.join(", ") : "none"}`
					: `env: ${plural(app.envVarNames.length, "var")}`;
				const details = [
					`source: ${describeSource(app.source)}`,
					app.buildType ? `build: ${app.buildType}` : null,
					`id ${app.id}`,
				];
				const links = [
					app.customDomains.length > 0
						? `domains: ${app.customDomains.join(", ")}`
						: null,
					app.databaseIds.length > 0
						? `databases: ${app.databaseIds.map((id) => nameOf(dbNames, id)).join(", ")}`
						: null,
					env,
					`jobs: ${app.scheduledJobCount}`,
				];
				return [
					`${colors.cyan(app.name)} · ${app.status} · ${app.url ?? colors.dim("no url")}`,
					details.filter(Boolean).join(" · "),
					links.filter(Boolean).join(" · "),
				];
			}),
		},
		{
			title: `databases (${databases.length})`,
			items: databases.map((db) => {
				const linked = db.linkedApplicationIds.map((id) =>
					nameOf(appNames, id),
				);
				return [
					[
						colors.cyan(db.name),
						db.engine,
						db.status ?? "unknown",
						db.plan ? `plan ${db.plan}` : null,
						`external access ${db.externalAccess ? "on" : "off"}`,
					]
						.filter(Boolean)
						.join(" · "),
					`${linked.length > 0 ? `linked: ${linked.join(", ")}` : "not linked"} · id ${db.id}`,
				];
			}),
		},
		{
			title: `buckets (${buckets.length})`,
			items: buckets.map((bucket) => [
				[colors.cyan(bucket.name), bucket.status ?? "unknown", `id ${bucket.id}`].join(
					" · ",
				),
			]),
		},
		{
			title: `domains (${domains.length})`,
			items: domains.map((domain) => [
				[
					`${colors.cyan(domain.host)} → ${domain.applicationId ? nameOf(appNames, domain.applicationId) : "unattached"}`,
					domain.status ?? "unknown",
				].join(" · "),
			]),
		},
	];

	sections.forEach((section, sectionIndex) => {
		const lastSection = sectionIndex === sections.length - 1;
		lines.push(`${lastSection ? "└─" : "├─"} ${colors.bold(section.title)}`);
		const stem = lastSection ? "   " : "│  ";
		section.items.forEach(([first, ...rest], itemIndex) => {
			const lastItem = itemIndex === section.items.length - 1;
			lines.push(`${stem}${lastItem ? "└─" : "├─"} ${first}`);
			for (const line of rest) {
				lines.push(`${stem}${lastItem ? "   " : "│  "}  ${colors.dim(line)}`);
			}
		});
	});
	return lines;
}
