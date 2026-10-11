/**
 * Shared by `tarout import` and the `import_project` MCP tool: read the source
 * platform's config files from a local repo, find the source token in the
 * environment, and drive the platform's `platformImport` procedures
 * (plan → start → status → finish).
 *
 * The token and any database URL go from the environment straight into the
 * request. They are never printed, never put in argv, and never returned.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const IMPORT_PROVIDERS = ["vercel", "render"] as const;
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

/** Env vars read for the source token, by provider. */
export const DEFAULT_TOKEN_ENV: Record<ImportProvider, string> = {
	vercel: "VERCEL_TOKEN",
	render: "RENDER_API_KEY",
};

const CONFIG_FILES: Record<ImportProvider, string[]> = {
	vercel: ["vercel.json", ".vercel/project.json"],
	render: ["render.yaml", "render.yml"],
};

const MAX_FILE_BYTES = 256_000;
const MAX_REPO_PATHS = 500;

export interface ImportFile {
	path: string;
	content: string;
}

/** The platform the repo in `cwd` is set up for, from its config files. */
export function detectImportProvider(cwd: string): ImportProvider | null {
	if (CONFIG_FILES.render.some((file) => existsSync(path.join(cwd, file)))) return "render";
	if (CONFIG_FILES.vercel.some((file) => existsSync(path.join(cwd, file)))) return "vercel";
	return null;
}

export function readImportFiles(cwd: string, provider: ImportProvider): ImportFile[] {
	const files: ImportFile[] = [];
	for (const file of CONFIG_FILES[provider]) {
		const full = path.join(cwd, file);
		if (!existsSync(full)) continue;
		if (statSync(full).size > MAX_FILE_BYTES) {
			throw new Error(`${file} is larger than ${MAX_FILE_BYTES / 1000} KB.`);
		}
		files.push({ path: file, content: readFileSync(full, "utf8") });
	}
	return files;
}

/** Top-level entries of the repo (names only), for the `api/` heuristic. */
export function readRepoPaths(cwd: string): string[] {
	try {
		return readdirSync(cwd)
			.filter((name) => name !== ".git" && name !== "node_modules")
			.slice(0, MAX_REPO_PATHS);
	} catch {
		return [];
	}
}

export function readSourceToken(
	provider: ImportProvider,
	tokenEnv?: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const value = env[tokenEnv || DEFAULT_TOKEN_ENV[provider]]?.trim();
	return value || undefined;
}

/** `db=SOURCE_DATABASE_URL` pairs → plan database key → URL from that env var. */
export function readDatabaseUrls(
	pairs: readonly string[] | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
	if (!pairs?.length) return undefined;
	const urls: Record<string, string> = {};
	for (const pair of pairs) {
		const [key, variable] = pair.split("=", 2).map((part) => part?.trim());
		if (!key || !variable) {
			throw new Error(`--database-url-env expects <database>=<ENV_VAR>, got "${pair}".`);
		}
		const value = env[variable]?.trim();
		if (!value) throw new Error(`Environment variable ${variable} is empty or not set.`);
		urls[key] = value;
	}
	return urls;
}

export interface ImportSourceOptions {
	provider: ImportProvider;
	cwd: string;
	token?: string;
	project?: string;
	teamId?: string;
	services?: string[];
}

export function buildSourceInput(options: ImportSourceOptions) {
	return {
		provider: options.provider,
		files: readImportFiles(options.cwd, options.provider),
		repoPaths: readRepoPaths(options.cwd),
		...(options.token ? { token: options.token } : {}),
		...(options.provider === "vercel"
			? {
					...(options.project ? { project: options.project } : {}),
					...(options.teamId ? { teamId: options.teamId } : {}),
				}
			: options.services?.length
				? { services: options.services }
				: {}),
	};
}

// ---------------------------------------------------------------------------
// Platform shapes (only the fields the CLI reads)
// ---------------------------------------------------------------------------

export interface ImportIssue {
	severity: "info" | "warning" | "blocker";
	code: string;
	serviceKey?: string;
	message: string;
	fix: string;
}

export interface ImportPlan {
	provider: ImportProvider;
	sourceName: string;
	services: Array<{
		key: string;
		name: string;
		kind: "web" | "worker" | "static";
		repo: { owner: string; repository: string; branch: string | null } | null;
		env: Array<{ key: string; source: string }>;
	}>;
	jobs: Array<{ key: string; name: string; serviceKey: string; cron: string; jobType: string }>;
	databases: Array<{ key: string; name: string; engine: string; serviceKeys: string[] }>;
	domains: Array<{ host: string; serviceKey: string; onTarout: boolean }>;
	issues: ImportIssue[];
}

export interface ImportPlanResponse {
	plan: ImportPlan;
	repoAccess: Record<string, boolean>;
}

export interface ImportRunResult {
	runId: string;
	apps: Array<{ serviceKey: string; name: string; kind: string; applicationId: string; appName: string; url: string | null }>;
	databases: Array<{ databaseKey: string; name: string; postgresId: string; copy: string }>;
	next: "wait_for_copy" | "deployed" | "deploy";
}

export interface ImportReport {
	moved: Array<{ kind: string; name: string; detail: string }>;
	notMoved: Array<{ name: string; message: string; fix: string }>;
	notes: Array<{ message: string; fix: string }>;
	domains: Array<{ host: string; app: string; onTarout: boolean; command: string; steps: string }>;
	complete: boolean;
}

export interface ImportStatus {
	runId: string;
	state: "copying" | "ready" | "finished";
	result: ImportRunResult;
	copies: Record<string, { status: string; message?: string }>;
	deployments: Array<{ applicationId: string; deploymentId: string }>;
	report: ImportReport;
}

// biome-ignore lint/suspicious/noExplicitAny: the tRPC client is untyped
type Client = any;

const POLL_INTERVAL_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll the run until the copy ends, then deploy when asked. Returns the last
 * status; `timedOut` when the copy is still running after `timeoutMs`.
 */
export async function waitForImport(
	client: Client,
	runId: string,
	options: {
		deploy: boolean;
		timeoutMs: number;
		onProgress?: (status: ImportStatus) => void;
		sleepFn?: (ms: number) => Promise<void>;
	},
): Promise<{ status: ImportStatus; timedOut: boolean }> {
	const wait = options.sleepFn ?? sleep;
	const deadline = Date.now() + options.timeoutMs;
	let status: ImportStatus = await client.platformImport.status.query({ runId });
	while (status.state === "copying") {
		options.onProgress?.(status);
		if (Date.now() >= deadline) return { status, timedOut: true };
		await wait(POLL_INTERVAL_MS);
		status = await client.platformImport.status.query({ runId });
	}
	if (status.state === "ready" && options.deploy) {
		await client.platformImport.finish.mutate({ runId });
		status = await client.platformImport.status.query({ runId });
	}
	return { status, timedOut: false };
}

/** Variable counts per source for one service, for the plan summary. */
export function countEnvSources(env: ReadonlyArray<{ source: string }>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of env) counts[entry.source] = (counts[entry.source] ?? 0) + 1;
	return counts;
}
