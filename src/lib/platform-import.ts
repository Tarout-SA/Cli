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

export const IMPORT_PROVIDERS = ["vercel", "render", "railway", "heroku", "netlify", "fly"] as const;
export type ImportProvider = (typeof IMPORT_PROVIDERS)[number];

export const PROVIDER_LABEL: Record<ImportProvider, string> = {
	vercel: "Vercel",
	render: "Render",
	railway: "Railway",
	heroku: "Heroku",
	netlify: "Netlify",
	fly: "Fly.io",
};

/** Env vars read for the source token, by provider (first one set wins). */
export const TOKEN_ENVS: Record<ImportProvider, string[]> = {
	vercel: ["VERCEL_TOKEN"],
	render: ["RENDER_API_KEY"],
	railway: ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"],
	heroku: ["HEROKU_API_KEY"],
	netlify: ["NETLIFY_AUTH_TOKEN"],
	fly: ["FLY_API_TOKEN", "FLY_ACCESS_TOKEN"],
};

/** The variable named in help and prompts. */
export const DEFAULT_TOKEN_ENV: Record<ImportProvider, string> = Object.fromEntries(
	IMPORT_PROVIDERS.map((provider) => [provider, TOKEN_ENVS[provider][0]]),
) as Record<ImportProvider, string>;

const CONFIG_FILES: Record<ImportProvider, string[]> = {
	vercel: ["vercel.json", ".vercel/project.json"],
	render: ["render.yaml", "render.yml"],
	railway: ["railway.json", "railway.toml"],
	heroku: ["Procfile", "app.json"],
	netlify: ["netlify.toml"],
	fly: ["fly.toml"],
};

// Most specific first: a Procfile also appears in Railway and Render repos.
const DETECT_ORDER: ImportProvider[] = ["render", "fly", "railway", "netlify", "vercel", "heroku"];

const MAX_FILE_BYTES = 256_000;
const MAX_REPO_PATHS = 500;

export interface ImportFile {
	path: string;
	content: string;
}

/** The platform the repo in `cwd` is set up for, from its config files. */
export function detectImportProvider(cwd: string): ImportProvider | null {
	for (const provider of DETECT_ORDER) {
		if (CONFIG_FILES[provider].some((file) => existsSync(path.join(cwd, file)))) return provider;
	}
	return null;
}

/**
 * The GitHub repo and branch of the local clone, from `.git` (worktrees too).
 * Heroku and Fly do not say which repo an app builds from, so this is sent.
 */
export function readGitHubRemote(
	cwd: string,
): { owner: string; repository: string; branch?: string } | undefined {
	try {
		const dotGit = path.join(cwd, ".git");
		if (!existsSync(dotGit)) return undefined;
		// A worktree's `.git` is a file pointing at its own dir (HEAD lives
		// there); its config lives in the common dir.
		let headDir = dotGit;
		let configDir = dotGit;
		if (statSync(dotGit).isFile()) {
			const pointer = readFileSync(dotGit, "utf8").match(/gitdir:\s*(.+)/i)?.[1]?.trim();
			if (!pointer) return undefined;
			headDir = path.resolve(cwd, pointer);
			const common = path.join(headDir, "commondir");
			configDir = existsSync(common)
				? path.resolve(headDir, readFileSync(common, "utf8").trim())
				: headDir;
		}
		const config = readFileSync(path.join(configDir, "config"), "utf8");
		const url =
			config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ??
			config.match(/url\s*=\s*(\S+)/)?.[1];
		const match = url?.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
		if (!match?.[1] || !match[2]) return undefined;
		let branch: string | undefined;
		try {
			branch = readFileSync(path.join(headDir, "HEAD"), "utf8")
				.match(/ref:\s*refs\/heads\/(.+)/)?.[1]
				?.trim();
		} catch {}
		return { owner: match[1], repository: match[2], ...(branch ? { branch } : {}) };
	} catch {
		return undefined;
	}
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
	for (const name of tokenEnv ? [tokenEnv] : TOKEN_ENVS[provider]) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
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
	/** Vercel project, Railway project id, Heroku app, Netlify site, Fly app. */
	project?: string;
	teamId?: string;
	/** Railway environment name. */
	environment?: string;
	services?: string[];
	/** `owner/repo` override; default the local git remote. */
	repo?: string;
	branch?: string;
}

export function parseRepoArg(value: string): { owner: string; repository: string } {
	const [owner, repository, ...rest] = value
		.trim()
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/\.git$/, "")
		.split("/");
	if (!owner || !repository || rest.length > 0) {
		throw new Error(`--repo expects owner/repository, got "${value}".`);
	}
	return { owner, repository };
}

export function buildSourceInput(options: ImportSourceOptions) {
	const local = readGitHubRemote(options.cwd);
	const override = options.repo ? parseRepoArg(options.repo) : undefined;
	const repoBase = override ?? local;
	const branch = options.branch ?? (override ? undefined : local?.branch);
	const repo = repoBase
		? { owner: repoBase.owner, repository: repoBase.repository, ...(branch ? { branch } : {}) }
		: undefined;
	const { provider } = options;
	return {
		provider,
		files: readImportFiles(options.cwd, provider),
		repoPaths: readRepoPaths(options.cwd),
		...(options.token ? { token: options.token } : {}),
		...(provider !== "render" && options.project ? { project: options.project } : {}),
		...(provider === "vercel" && options.teamId ? { teamId: options.teamId } : {}),
		...(provider === "railway" && options.environment ? { environment: options.environment } : {}),
		...((provider === "render" || provider === "railway") && options.services?.length
			? { services: options.services }
			: {}),
		...(repo ? { repo } : {}),
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
	domains: Array<{ host: string; app: string; onTarout: boolean; moved?: boolean; command: string; steps: string }>;
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

export interface MoveDomainsResult {
	moved: string[];
	skipped: Array<{ host: string; reason: string }>;
}

const NOT_LIVE = /not live yet/i;

/**
 * platformImport.moveDomains refuses until every import deploy is live; keep
 * asking until it answers or the deadline passes. `null` = still not live.
 */
export async function moveDomainsWhenLive(
	client: Client,
	runId: string,
	options: { timeoutMs: number; sleepFn?: (ms: number) => Promise<void>; onWait?: () => void },
): Promise<MoveDomainsResult | null> {
	const wait = options.sleepFn ?? sleep;
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		try {
			return await client.platformImport.moveDomains.mutate({ runId });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!NOT_LIVE.test(message) || Date.now() >= deadline) {
				if (NOT_LIVE.test(message)) return null;
				throw error;
			}
			options.onWait?.();
			await wait(POLL_INTERVAL_MS * 2);
		}
	}
}
