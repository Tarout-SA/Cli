import { execFile } from "node:child_process";
import {
	createReadStream,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import open from "open";
import { ensureAgentSetup } from "../lib/agent-setup.js";
import { getApiClient, resetApiClient } from "../lib/api.js";
import { startAuthServer } from "../lib/auth-server.js";
import { openInBrowser, paymentBrowserOpener } from "../lib/browser.js";
import {
	type Catalog,
	type EntitlementRemedy,
	nextPlanForRequested,
	resolveEntitlementRemedy,
	upgradeTargetPlan,
} from "../lib/entitlement-remedy.js";
import {
	AGENT_BILLING_PERMISSION_HINT,
	type BillingChangeResult,
	emitBillingResult,
	type PerformBillingChangeInput,
	performBillingChange,
} from "../lib/billing-upgrade.js";
import { dbAddonKeyForPlanFamily } from "../lib/plan-cart.js";
import {
	isCredentialError,
	resolveProfileFromCredential,
} from "../lib/auth-profile.js";
import {
	type Profile,
	getApiUrl,
	getCurrentProfile,
	getProjectConfig,
	getToken,
	isLoggedIn,
	setCurrentProfile,
	setProfile,
	setProjectConfig,
} from "../lib/config.js";
import {
	AuthError,
	analyzeDeploymentError,
	BuildFailedError,
	DeploymentFailedError,
	DeploymentTimeoutError,
	findSimilar,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
import {
	box,
	colors,
	getStatusBadge,
	isJsonMode,
	isNonInteractiveMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	success,
	table,
} from "../lib/output.js";
import { streamDeploymentLogs } from "../lib/websocket.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { formatAppUrl } from "../utils/url.js";
import {
	confirm,
	input,
	password,
	promptOrEmit,
	select,
} from "../utils/prompts.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
} from "../utils/spinner.js";

const DEFAULT_REGION = "me-central2";
const DROP_UPLOAD_CONTENT_TYPE = "application/zip";

const execFileAsync = promisify(execFile);

export interface AppSummary {
	appName?: string;
	applicationId: string;
	name: string;
	plan?: string | null;
	sourceType?: string | null;
}

interface DeploymentSummary {
	createdAt: Date | string;
	deploymentId: string;
	status: string;
	title?: string | null;
}

interface DeployOptions {
	apiUrl?: string;
	buildCommand?: string;
	database?: string;
	databasePlan?: string;
	description?: string;
	frameworkPreset?: string;
	installCommand?: string;
	name?: string;
	newApp?: boolean;
	outputDirectory?: string;
	plan?: string;
	region?: string;
	reuseDatabase?: string;
	reuseStorage?: string;
	rootDirectory?: string;
	source?: string;
	startCommand?: string;
	storage?: boolean;
	storagePlan?: string;
	token?: string;
	wait?: boolean;
	watch?: boolean;
	agentSetup?: boolean; // commander sets false for --no-agent-setup
}

type AppPlan = "FREE" | "SHARED" | "DEDICATED";
export type ResourcePlan = "FREE" | "STARTER" | "STANDARD" | "PRO";
type DatabaseKind = "none" | "postgres" | "mysql";
type SourcePreference = "auto" | "upload" | "configured" | "connect";

interface ProjectInspection {
	database: DatabaseKind;
	databaseReasons: string[];
	git: {
		hasGit: boolean;
		provider?: string;
		remoteUrl?: string;
	};
	storage: boolean;
	storageReasons: string[];
}

interface DeploymentTarget {
	app: AppSummary;
	createdApp: boolean;
	hasConfiguredSource: boolean;
	shouldUploadSource: boolean;
}

export async function ensureAuthenticatedForDeploy(
	options: DeployOptions,
): Promise<Profile> {
	const apiUrl = (options.apiUrl || getApiUrl()).replace(/\/+$/, "");
	const optionToken = options.token?.trim();
	if (optionToken) {
		return authenticateViaApiToken(optionToken, apiUrl, {
			showSuccess: true,
			persist: true,
		});
	}

	if (!isLoggedIn()) {
		if (isJsonMode()) {
			await promptOrEmit<never>(
				{
					field: "token",
					kind: "password",
					question:
						`Paste a Tarout API token. Generate one at ${apiUrl}/dashboard/settings/profile`,
					flag: "--token",
					sensitive: true,
					context: {
						step: "auth",
						reason: "not_logged_in",
						generateUrl: `${apiUrl}/dashboard/settings/profile`,
					},
				},
				// Unreachable: promptOrEmit exits the process in JSON mode.
				async () => {
					throw new AuthError();
				},
			);
		}
		return promptForCredentials(
			apiUrl,
			"Tarout needs an authenticated account before deploying.",
		);
	}

	const token = getToken();
	if (!token) throw new AuthError();

	const existingProfile = getCurrentProfile();
	try {
		const profile = await resolveProfileFromCredential({
			token,
			apiUrl,
			fallback: existingProfile,
		});
		if (existingProfile) {
			setProfile("default", profile);
			setCurrentProfile("default");
			resetApiClient();
		}
		return profile;
	} catch (err) {
		if (!isCredentialError(err)) throw err;
		if (isJsonMode()) {
			await promptOrEmit<never>(
				{
					field: "token",
					kind: "password",
					question:
						`Stored credentials are invalid or expired. Paste a new Tarout API token from ${apiUrl}/dashboard/settings/profile`,
					flag: "--token",
					sensitive: true,
					context: {
						step: "auth",
						reason: "expired_credentials",
						generateUrl: `${apiUrl}/dashboard/settings/profile`,
					},
				},
				async () => {
					throw new AuthError();
				},
			);
		}
		return promptForCredentials(
			apiUrl,
			"Your Tarout credentials are invalid or expired.",
		);
	}
	// Unreachable: both branches above either return or exit via promptOrEmit.
	throw new AuthError();
}

async function promptForCredentials(
	apiUrl: string,
	message: string,
): Promise<Profile> {
	if (isJsonMode()) {
		throw new AuthError();
	}

	log("");
	log(message);
	const authAction = await select<"login" | "token" | "register">(
		"Continue with:",
		[
			{ name: "Log in to an existing account", value: "login" },
			{ name: "Paste an API token", value: "token" },
			{ name: "Create a free Tarout account", value: "register" },
		],
		{ field: "auth_method", flag: "--token" },
	);

	if (authAction === "token") {
		const apiToken = await password("Tarout API token:", {
			field: "token",
			flag: "--token",
		});
		return authenticateViaApiToken(apiToken.trim(), apiUrl, {
			showSuccess: true,
			persist: true,
		});
	}

	return authenticateViaBrowser(authAction, apiUrl);
}

async function authenticateViaBrowser(
	action: "login" | "register",
	apiUrl: string,
): Promise<Profile> {
	const authServer = await startAuthServer();
	const callbackUrl = `http://localhost:${authServer.port}/callback?state=${encodeURIComponent(authServer.state)}`;
	const authUrl =
		action === "register"
			? `${apiUrl}/cli-authorize?action=register&callback=${encodeURIComponent(callbackUrl)}`
			: `${apiUrl}/cli-authorize?callback=${encodeURIComponent(callbackUrl)}`;

	log("");
	log(
		action === "register"
			? "Opening browser to create your account..."
			: "Opening browser to authenticate...",
	);
	await openInBrowser(authUrl, {
		hint:
			action === "register"
				? "If the browser didn't open, visit this URL to create your account:"
				: "If the browser didn't open, visit this URL to authenticate:",
	});

	const _spinner = startSpinner(
		action === "register"
			? "Waiting for account creation..."
			: "Waiting for authentication...",
	);

	try {
			const authData = await authServer.waitForCallback();
			succeedSpinner(
				action === "register"
					? "Account created and CLI authorized."
					: "CLI authorized.",
			);
		authServer.close();

		const fallbackProfile = {
			token: authData.token,
			apiUrl,
			userId: authData.userId,
			userEmail: authData.userEmail,
			userName: authData.userName,
			organizationId: authData.organizationId,
			organizationName: authData.organizationName,
			projectId: authData.projectId,
			projectName: authData.projectName,
			projectSlug: authData.projectSlug,
			environmentId: authData.environmentId,
			environmentName: authData.environmentName,
		};
		const profile = await resolveProfileFromCredential({
			token: authData.token,
			apiUrl,
			fallback: fallbackProfile,
		}).catch(() => fallbackProfile);
		setProfile("default", profile);
		setCurrentProfile("default");
		resetApiClient();

		log("");
		success(`Logged in as ${colors.cyan(profile.userEmail)}`);
		box("Account", [
			`Organization: ${colors.bold(profile.organizationName)}`,
			`Environment: ${colors.bold(profile.environmentName)}`,
		]);
		return profile;
	} catch (err) {
		failSpinner(
			action === "register"
				? "Account creation failed"
				: "Authentication failed",
		);
		authServer.close();
		throw err;
	}
}

async function authenticateViaApiToken(
	apiToken: string,
	apiUrl: string,
	options: { persist: boolean; showSuccess: boolean },
): Promise<Profile> {
	if (!apiToken) throw new AuthError("An API token is required.");

	const _spinner = startSpinner("Verifying token...");
	try {
		const profile = await resolveProfileFromCredential({
			token: apiToken,
			apiUrl,
			fallback: getCurrentProfile(),
		});
		succeedSpinner("Token verified!");

		if (options.persist) {
			setProfile("default", profile);
			setCurrentProfile("default");
			resetApiClient();
		}

		if (options.showSuccess && !isJsonMode()) {
			log("");
			success(`Authenticated as ${colors.cyan(profile.userEmail)}`);
			box("Account", [
				`Organization: ${colors.bold(profile.organizationName)}`,
				`Environment: ${colors.bold(profile.environmentName)}`,
			]);
		}

		return profile;
	} catch (err) {
		failSpinner("Token verification failed");
		if (isCredentialError(err)) {
			throw new AuthError("Invalid or expired Tarout credential.");
		}
		throw err;
	}
}

async function confirmRegion(region: string | undefined): Promise<void> {
	const requestedRegion = region || DEFAULT_REGION;
	if (requestedRegion === DEFAULT_REGION) return;

	const message = `Tarout currently deploys only to ${DEFAULT_REGION} (Dammam, Saudi Arabia). The requested region "${requestedRegion}" would move workloads outside the active Saudi region when additional regions are enabled.`;

	if (shouldSkipConfirmation()) {
		if (!isJsonMode()) {
			log("");
			log(colors.warn(message));
			log(colors.dim(`Continuing with ${DEFAULT_REGION}.`));
		}
		return;
	}

	if (!isJsonMode()) {
		log("");
		log(colors.warn(message));
	}

	const proceed = await promptOrEmit<boolean>(
		{
			field: "region",
			kind: "confirm",
			question: `${message} Continue with ${DEFAULT_REGION}?`,
			default: false,
			flag: "--yes",
			context: {
				step: "region_confirmation",
				requestedRegion,
				activeRegion: DEFAULT_REGION,
			},
		},
		() => confirm(`Continue with ${DEFAULT_REGION}?`, false),
	);
	if (!proceed) {
		throw new InvalidArgumentError("Deployment cancelled.");
	}
}

export function inspectCurrentProject(cwd = process.cwd()): ProjectInspection {
	const packageJson = readJsonFile(join(cwd, "package.json"));
	const dependencies = new Set(
		Object.keys({
			...(packageJson?.dependencies ?? {}),
			...(packageJson?.devDependencies ?? {}),
			...(packageJson?.optionalDependencies ?? {}),
			...(packageJson?.peerDependencies ?? {}),
		}).map((dependency) => dependency.toLowerCase()),
	);
	const files = collectInspectableFiles(cwd);
	const snippets = files.map((file) => ({
		file,
		content: readTextFile(file, 256 * 1024),
	}));
	const database = detectDatabase(dependencies, snippets, cwd);
	const storage = detectStorage(dependencies, snippets);

	return {
		database: database.kind,
		databaseReasons: database.reasons,
		git: detectGitSource(cwd),
		storage: storage.detected,
		storageReasons: storage.reasons,
	};
}

function printProjectInspection(inspection: ProjectInspection): void {
	if (isJsonMode()) return;

	const lines: string[] = [];
	if (inspection.database !== "none") {
		lines.push(
			`Database: ${colors.cyan(formatDatabaseKind(inspection.database))} detected (${inspection.databaseReasons.slice(0, 3).join("; ")})`,
		);
	}
	if (inspection.storage) {
		lines.push(
			`File storage: ${colors.cyan("detected")} (${inspection.storageReasons.slice(0, 3).join("; ")})`,
		);
	}
	if (inspection.git.hasGit) {
		lines.push(
			inspection.git.provider
				? `Git: ${colors.cyan(inspection.git.provider)} repository detected`
				: "Git: repository detected",
		);
	}
	if (lines.length > 0) {
		box("Project Inspection", lines);
	}
}

function readJsonFile(path: string): any | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function readTextFile(path: string, maxBytes: number): string {
	try {
		const stat = statSync(path);
		if (stat.size > maxBytes) return "";
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function collectInspectableFiles(root: string): string[] {
	const files: string[] = [];
	const excludedDirs = new Set([
		".git",
		".next",
		".nuxt",
		".svelte-kit",
		"build",
		"coverage",
		"dist",
		"node_modules",
		"out",
		"target",
		"vendor",
	]);
	const includedNames = new Set([
		".env.example",
		".env.sample",
		"drizzle.config.js",
		"drizzle.config.mjs",
		"drizzle.config.ts",
		"package.json",
		"schema.prisma",
	]);
	const includedExtensions = [
		".cjs",
		".go",
		".js",
		".jsx",
		".json",
		".mjs",
		".php",
		".prisma",
		".py",
		".rb",
		".ts",
		".tsx",
		".yml",
		".yaml",
	];

	const walk = (dir: string, depth: number) => {
		if (files.length >= 400 || depth > 5) return;

		let entries: Array<{
			name: string;
			isDirectory(): boolean;
			isFile(): boolean;
		}>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (files.length >= 400) return;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!excludedDirs.has(entry.name)) walk(fullPath, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;

			const lowerName = entry.name.toLowerCase();
			if (
				includedNames.has(lowerName) ||
				includedExtensions.some((extension) =>
					lowerName.endsWith(extension),
				)
			) {
				files.push(fullPath);
			}
		}
	};

	walk(root, 0);
	return files;
}

function detectDatabase(
	dependencies: Set<string>,
	files: Array<{ file: string; content: string }>,
	cwd: string,
): { kind: DatabaseKind; reasons: string[] } {
	const postgresReasons: string[] = [];
	const mysqlReasons: string[] = [];
	const genericReasons: string[] = [];

	for (const dependency of [
		"@neondatabase/serverless",
		"@supabase/supabase-js",
		"pg",
		"postgres",
		"postgres.js",
	]) {
		if (dependencies.has(dependency)) {
			postgresReasons.push(`dependency ${dependency}`);
			break;
		}
	}

	for (const dependency of ["mariadb", "mysql", "mysql2"]) {
		if (dependencies.has(dependency)) {
			mysqlReasons.push(`dependency ${dependency}`);
			break;
		}
	}

	for (const dependency of [
		"@prisma/client",
		"drizzle-orm",
		"knex",
		"sequelize",
		"typeorm",
	]) {
		if (dependencies.has(dependency)) {
			genericReasons.push(`database ORM dependency ${dependency}`);
			break;
		}
	}

	const prismaSchema = readTextFile(
		join(cwd, "prisma", "schema.prisma"),
		256 * 1024,
	);
	if (/provider\s*=\s*"postgresql"/i.test(prismaSchema)) {
		postgresReasons.push("Prisma provider postgresql");
	}
	if (/provider\s*=\s*"mysql"/i.test(prismaSchema)) {
		mysqlReasons.push("Prisma provider mysql");
	}

	for (const { file, content } of files) {
		if (!content) continue;
		const label = basename(file);
		if (/dialect\s*:\s*["']postgres(?:ql)?["']/i.test(content)) {
			postgresReasons.push(`${label} postgres dialect`);
		}
		if (/dialect\s*:\s*["']mysql["']/i.test(content)) {
			mysqlReasons.push(`${label} mysql dialect`);
		}
		if (/postgres(?:ql)?:\/\/|PGHOST|POSTGRES_/i.test(content)) {
			postgresReasons.push(`${label} postgres connection`);
		}
		if (/mysql:\/\/|MYSQL_HOST|MYSQL_/i.test(content)) {
			mysqlReasons.push(`${label} mysql connection`);
		}
		if (/DATABASE_URL/i.test(content)) {
			postgresReasons.push(`${label} DATABASE_URL`);
		}
	}

	if (mysqlReasons.length > postgresReasons.length) {
		return { kind: "mysql", reasons: uniqueReasons(mysqlReasons) };
	}
	if (postgresReasons.length > 0 || mysqlReasons.length > 0) {
		return {
			kind:
				postgresReasons.length >= mysqlReasons.length ? "postgres" : "mysql",
			reasons: uniqueReasons(
				postgresReasons.length >= mysqlReasons.length
					? postgresReasons
					: mysqlReasons,
			),
		};
	}
	if (genericReasons.length > 0) {
		return { kind: "postgres", reasons: uniqueReasons(genericReasons) };
	}

	return { kind: "none", reasons: [] };
}

function detectStorage(
	dependencies: Set<string>,
	files: Array<{ file: string; content: string }>,
): { detected: boolean; reasons: string[] } {
	const reasons: string[] = [];

	for (const dependency of [
		"@aws-sdk/client-s3",
		"@google-cloud/storage",
		"@uploadthing/react",
		"aws-sdk",
		"busboy",
		"firebase",
		"firebase-admin",
		"formidable",
		"minio",
		"multer",
		"uploadthing",
	]) {
		if (dependencies.has(dependency)) {
			reasons.push(`dependency ${dependency}`);
			break;
		}
	}

	for (const { file, content } of files) {
		if (!content) continue;
		const label = basename(file);
		if (
			/S3Client|PutObjectCommand|GetObjectCommand|AWS_S3|S3_BUCKET|STORAGE_BUCKET|FIREBASE_STORAGE_BUCKET|UploadThing|getStorage\(/i.test(
				content,
			)
		) {
			reasons.push(`${label} object storage usage`);
		}
		if (
			/multer|diskStorage|upload\.single|upload\.array|multipart\/form-data/i.test(
				content,
			)
		) {
			reasons.push(`${label} file upload handling`);
		}
	}

	return { detected: reasons.length > 0, reasons: uniqueReasons(reasons) };
}

function detectGitSource(cwd: string): ProjectInspection["git"] {
	const gitPath = join(cwd, ".git");
	if (!existsSync(gitPath)) return { hasGit: false };

	let configPath = join(gitPath, "config");
	try {
		const stat = statSync(gitPath);
		if (stat.isFile()) {
			const content = readTextFile(gitPath, 4096);
			const match = content.match(/gitdir:\s*(.+)/i);
			if (match?.[1]) configPath = join(cwd, match[1].trim(), "config");
		}
	} catch {}

	const config = readTextFile(configPath, 64 * 1024);
	const remoteUrl = config.match(/url\s*=\s*(.+)/)?.[1]?.trim();
	const provider = remoteUrl?.includes("github.com")
		? "GitHub"
		: remoteUrl?.includes("gitlab.com")
			? "GitLab"
			: remoteUrl?.includes("bitbucket.org")
				? "Bitbucket"
				: remoteUrl
					? "Git"
					: undefined;

	return { hasGit: true, provider, remoteUrl };
}

function uniqueReasons(reasons: string[]): string[] {
	return Array.from(new Set(reasons)).slice(0, 5);
}

function formatDatabaseKind(kind: DatabaseKind): string {
	if (kind === "postgres") return "Postgres";
	if (kind === "mysql") return "MySQL";
	return "none";
}

export async function resolveDeploymentTarget(
	client: any,
	profile: Profile,
	appIdentifier?: string,
	options: DeployOptions = {},
	sourcePreference: SourcePreference = "auto",
): Promise<DeploymentTarget> {
	const _spinner = startSpinner("Finding application...");
	const apps: AppSummary[] = await client.application.allByOrganization.query();
	succeedSpinner();

	if (appIdentifier) {
		const app = findApp(apps, appIdentifier);
		if (!app) {
			const suggestions = findSimilar(
				appIdentifier,
				apps.map((a) => a.name),
			);
			throw new NotFoundError("Application", appIdentifier, suggestions);
		}

		const details = await getApplicationDetails(client, app.applicationId);
		return {
			app,
			createdApp: false,
			hasConfiguredSource: hasConfiguredSource(details),
			shouldUploadSource: shouldUseLocalSource(details, {
				explicitApp: true,
			}),
		};
	}

	// Explicit "create a new app" — skip the picker entirely.
	if (options.newApp) {
		assertConfiguredSourceAllowsCreate(sourcePreference);
		return createNewAppTarget(client, profile, options);
	}

	// Resolve the linked app (a prior `tarout link` or deploy wrote
	// `.tarout/project.json`). A linked app is an explicit prior choice, so a
	// bare redeploy targets it WITHOUT prompting — the documented "redeploy just
	// works" path agents depend on for a deterministic redeploy. `--new-app`
	// (handled above) overrides it; `--source upload` is honored downstream by
	// resolveShouldUploadSource. `promptForSource: false` suppresses the
	// source-override needs_input so the redeploy stays non-interactive.
	const linkedProject = getProjectConfig();
	const linkedApp = linkedProject
		? findApp(apps, linkedProject.applicationId) ??
			findApp(apps, linkedProject.name)
		: undefined;
	if (linkedApp) {
		return reuseAppTarget(client, profile, linkedApp, {
			promptForSource: false,
		});
	}
	if (linkedProject && !isJsonMode()) {
		log("");
		log(
			colors.warn(
				`Linked application "${linkedProject.name}" was not found in this organization.`,
			),
		);
	}

	// No linked app. Nothing else to reuse — creating is the only path.
	if (apps.length === 0) {
		assertConfiguredSourceAllowsCreate(sourcePreference, true);
		return createNewAppTarget(client, profile, options);
	}

	// `--yes` with no linked app: accept the default (create a new app).
	if (shouldSkipConfirmation()) {
		assertConfiguredSourceAllowsCreate(sourcePreference, true);
		return createNewAppTarget(client, profile, options);
	}

	// Apps exist but none is linked — ASK which to use. Interactive shows the
	// menu; agent mode (--json / no TTY) emits a structured needs_input naming
	// the exact re-invoke mechanisms so the human decides through the agent.
	const createValue = "__create__";
	const selected = await select<string>(
		"Create a new app or reuse an existing one?",
		[
			{
				name: `Create a new app from ${colors.cyan(basename(process.cwd()) || "this directory")}`,
				value: createValue,
			},
			...apps.map((app) => ({
				name: `Reuse ${app.name} ${colors.dim(`(${app.applicationId.slice(0, 8)})`)}`,
				value: app.applicationId,
			})),
		],
		{
			field: "deploy_app",
			flag: "--new-app to create a new app, or pass the app id or name as the positional argument (tarout deploy <id|name>) to reuse an existing one",
			context: {
				apps: apps.map((a) => ({
					id: a.applicationId,
					name: a.name,
				})),
			},
		},
	);

	if (selected === createValue) {
		assertConfiguredSourceAllowsCreate(sourcePreference);
		return createNewAppTarget(client, profile, options);
	}

	const app = findApp(apps, selected);
	if (!app) {
		throw new NotFoundError("Application", selected);
	}
	return reuseAppTarget(client, profile, app);
}

/** Guard: a brand-new app has no configured Git provider, so `--source
 * configured` can't apply to it. */
function assertConfiguredSourceAllowsCreate(
	sourcePreference: SourcePreference,
	noAppsExist = false,
): void {
	if (sourcePreference !== "configured") return;
	throw new InvalidArgumentError(
		noAppsExist
			? 'No Tarout app exists to deploy from a configured source. Create or select an app with a configured Git provider first, or rerun with "--source upload".'
			: 'New apps do not have a configured Git provider source yet. Connect a Git provider first, or rerun with "--source upload".',
	);
}

async function createNewAppTarget(
	client: any,
	profile: Profile,
	options: DeployOptions,
): Promise<DeploymentTarget> {
	const app = await createAppFromCurrentDirectory(client, profile, options);
	return {
		app,
		createdApp: true,
		hasConfiguredSource: false,
		shouldUploadSource: true,
	};
}

async function reuseAppTarget(
	client: any,
	profile: Profile,
	app: AppSummary,
	opts: { promptForSource?: boolean } = {},
): Promise<DeploymentTarget> {
	setProjectConfig({
		applicationId: app.applicationId,
		name: app.name,
		organizationId: profile.organizationId,
		linkedAt: new Date().toISOString(),
	});
	const details = await getApplicationDetails(client, app.applicationId);
	return {
		app,
		createdApp: false,
		hasConfiguredSource: hasConfiguredSource(details),
		// A deterministic redeploy (linked app) must not prompt for a source
		// override — it silently reuses the app's existing source, or the current
		// folder when `--source upload` is set downstream. Only an interactive
		// menu reuse offers the override.
		shouldUploadSource:
			opts.promptForSource === false
				? shouldUseLocalSource(details, { linkedProject: true })
				: await promptForLocalSourceIfNeeded(details),
	};
}

export async function createAppFromCurrentDirectory(
	client: any,
	profile: Profile,
	options: DeployOptions = {},
): Promise<AppSummary> {
	const defaultName = basename(process.cwd()) || "tarout-app";
	const providedName = options.name?.trim();
	let appName = providedName || defaultName;

	// In JSON/agent mode, auto-apply the directory-name default instead of
	// emitting a needs_input round-trip — `--name` is documented as defaulting to
	// the directory name, and the agent already has no TTY to answer.
	if (!providedName && !shouldSkipConfirmation() && !isJsonMode()) {
		appName = await promptOrEmit<string>(
			{
				field: "name",
				kind: "input",
				question: "Application name:",
				default: defaultName,
				flag: "--name",
				context: { step: "app_name", defaultName },
			},
			() => input("Application name:", defaultName),
		);
	}

	const slug = generateSlug(appName);
	const plan = await resolveAppPlanForCreate(client, options);
	const buildConfig = buildConfigFromOptions(options);
	const _spinner = startSpinner("Creating application...");
	const application = await client.application.create.mutate({
		name: appName,
		appName: slug,
		organizationId: profile.organizationId,
		region: options.region ?? DEFAULT_REGION,
		...(options.description ? { description: options.description } : {}),
		...(plan ? { plan } : {}),
		...(buildConfig ? { buildConfig } : {}),
	});
	succeedSpinner("Application created!");

	setProjectConfig({
		applicationId: application.applicationId,
		name: application.name,
		organizationId: profile.organizationId,
		linkedAt: new Date().toISOString(),
	});

	if (!isJsonMode()) {
		box("Project Linked", [
			`Application: ${colors.cyan(application.name)}`,
			`Plan: ${colors.bold(application.plan ?? plan ?? "auto")}`,
			"Source: current directory upload (no GitHub required)",
			`ID: ${colors.dim(application.applicationId)}`,
			`Directory: ${colors.dim(process.cwd())}`,
		]);
	}

	return {
		applicationId: application.applicationId,
		name: application.name,
		appName: application.appName,
		plan: application.plan,
		sourceType: application.sourceType,
	};
}

/** Best-effort "is this org on a paid subscription?" — drives the FREE→paid
 * tier reconciliation. A failed lookup is treated as free (the server still
 * enforces the real rule, so we never wrongly suppress a valid FREE create). */
async function isOrgPaidSafely(client: any): Promise<boolean> {
	try {
		const opts = await client.application.getCreateOptions.query();
		return opts?.isPaid === true;
	} catch {
		return false;
	}
}

async function resolveAppPlanForCreate(
	client: any,
	options: DeployOptions,
): Promise<AppPlan | undefined> {
	const explicitPlan = normalizeAppPlan(options.plan);

	// A non-FREE explicit tier is honored as-is.
	if (explicitPlan && explicitPlan !== "FREE") return explicitPlan;

	// FREE is only valid on a free org — the server rejects `plan: FREE` for a
	// paid org with FREE_NOT_ALLOWED_ON_PAID_PLAN. So whenever the resolved tier
	// is FREE (explicit `--plan free`, or `tarout up`'s historical default), we
	// confirm the org is actually free; if it's paid we send no plan and let the
	// server auto-pick the org's real (paid) tier instead of erroring.
	if (explicitPlan === "FREE") {
		if (await isOrgPaidSafely(client)) {
			if (!isJsonMode()) {
				log(
					colors.dim(
						"Your org is on a paid plan — free apps aren't available, so this app will use your paid tier.",
					),
				);
			}
			return undefined;
		}
		return "FREE";
	}

	if (isJsonMode() || shouldSkipConfirmation()) return undefined;

	// Free-tier subscriptions get an extra upsell step: continue with FREE,
	// or upgrade to a paid plan inline (checkout → confirmation) before the
	// deploy proceeds. This matches the dashboard's planned upsell on the
	// `applications/new` page so both flows offer the same path.
	let createOptions: any;
	try {
		createOptions = await client.application.getCreateOptions.query();
	} catch {
		createOptions = null;
	}

	if (createOptions && createOptions.isPaid === false) {
		const upgraded = await promptFreeTierUpsell(client, createOptions);
		if (upgraded) return upgraded;
	}

	const choices = await getAppPlanChoices(client, createOptions);
	if (choices.length === 0) return undefined;

	return select<AppPlan>("Application hosting plan:", choices);
}

/**
 * Free-tier upsell: shown when the org's subscription is `free` (i.e.
 * `isPaid === false`). User picks one of:
 *   - "Continue with Free"           → returns "FREE", deploy continues on free
 *   - "Upgrade to Shared and deploy" → runs inline billing upgrade, returns SHARED on success
 *   - "Upgrade to Dedicated …"       → same, returns DEDICATED on success
 *
 * Returns `undefined` when the user picks "Continue with Free" (so the
 * caller falls through to the existing tier picker which will return FREE)
 * OR when the upgrade is cancelled/fails (caller should NOT proceed in that
 * case — `promptFreeTierUpsell` throws `InvalidArgumentError` on cancel).
 */
async function promptFreeTierUpsell(
	client: any,
	createOptions: any,
): Promise<AppPlan | undefined> {
	const catalog = await fetchCatalogSafely(client);
	const planByKey = new Map<string, { priceHalalas?: number }>();
	if (catalog) {
		for (const p of catalog.plans ?? []) {
			const key = (p?.planKey || p?.key) as string | undefined;
			if (key) planByKey.set(key, p);
		}
	}

	const sharedPrice = formatPlanPrice(planByKey.get("shared")?.priceHalalas);
	const dedicatedPrice = formatPlanPrice(
		planByKey.get("dedicated_small")?.priceHalalas,
	);

	const choice = await select<"free" | "shared" | "dedicated_small">(
		"You're on the Free plan. How do you want to deploy?",
		[
			{ name: "Continue with Free (no upgrade)", value: "free" },
			{
				name: `Upgrade to Shared and deploy${sharedPrice ? ` (${sharedPrice})` : ""}`,
				value: "shared",
			},
			{
				name: `Upgrade to Dedicated Small and deploy${dedicatedPrice ? ` (${dedicatedPrice})` : ""}`,
				value: "dedicated_small",
			},
		],
	);

	if (choice === "free") {
		return undefined;
	}

	const upgradeOk = await runInlineUpgrade(client, choice);
	if (!upgradeOk) {
		// User abandoned checkout, payment failed, or polling timed out.
		// Abort the deploy so we don't silently land them on FREE after
		// they explicitly asked to upgrade.
		throw new InvalidArgumentError(
			`Deploy cancelled — the ${choice} upgrade did not complete. Re-run \`tarout deploy\` once payment is confirmed, or run \`tarout billing wait <orderId> --timeout 600\` to resume polling.`,
		);
	}

	return choice === "shared" ? "SHARED" : "DEDICATED";
}

async function fetchCatalogSafely(
	client: any,
): Promise<{ plans?: Array<{ planKey?: string; key?: string; priceHalalas?: number }> } | null> {
	try {
		return await client.subscription.getCatalog.query();
	} catch {
		return null;
	}
}

export function formatPlanPrice(priceHalalas: number | undefined): string {
	if (!priceHalalas || priceHalalas <= 0) return "";
	return `${(priceHalalas / 100).toFixed(2)} SAR/mo`;
}

/**
 * Inline plan upgrade: `subscription.changePlan` → if `applied`, return
 * true immediately; if `paymentUrl + orderId`, open the browser and poll
 * `pollCheckoutUntilTerminal` until PAID / FAILED / EXPIRED / timeout.
 *
 * Returns true only on PAID or applied-immediately. False (or throws via
 * the caller's InvalidArgumentError) means the upgrade did not complete
 * and the deploy should stop.
 */
export async function runInlineUpgrade(
	client: any,
	planKey: string,
): Promise<boolean> {
	// Interactive-only path (callers short-circuit to NEEDS_UPGRADE in JSON
	// mode). Delegate to the shared billing engine so the changePlan → branch →
	// poll behavior is identical to `tarout billing upgrade`.
	const _changing = startSpinner(`Switching to plan "${planKey}"...`);
	const result = await performBillingChange(client, {
		kind: "plan",
		planKey,
		wait: true,
		timeoutMs: 600_000,
		openBrowser: paymentBrowserOpener(),
		onCheckoutOpened: ({ orderId, paymentUrl }) => {
			log("");
			log("Open this URL to complete payment:");
			log(`  ${colors.cyan(paymentUrl)}`);
			log(`Order ID: ${colors.dim(orderId)}`);
		},
	});

	if (result.status === "applied" || result.status === "paid") {
		succeedSpinner("Plan applied.");
		return true;
	}

	failSpinner(
		result.status === "deferred"
			? "Plan change did not require an immediate payment."
			: result.status === "pending_timeout"
				? "Payment still pending after 10 minutes."
				: `Payment ${result.status}.`,
	);

	if (result.failureReason) log(colors.error(result.failureReason));
	if (result.orderId) {
		log(
			colors.dim(
				`Resume later with: tarout billing wait ${result.orderId.slice(0, 8)} --timeout 600`,
			),
		);
	}

	return false;
}

async function getCurrentPlanQuantitySafely(client: any): Promise<number> {
	try {
		const sub = await client.subscription.getCurrent.query();
		const q = Number(sub?.planQuantity);
		return Number.isFinite(q) && q > 0 ? q : 1;
	} catch {
		return 1;
	}
}

// The org's current plan key (e.g. "free", "shared", "dedicated_small"), used
// to compute the "upgrade the plan" ladder (free → shared → dedicated_*). A
// null subscription means the org is still on the implicit free tier. Never
// throws — a failed lookup yields undefined and callers fall back to the
// requested-plan heuristic.
async function getCurrentPlanKeySafely(
	client: any,
): Promise<string | undefined> {
	try {
		const sub = await client.subscription.getCurrent.query();
		return sub?.planKey ?? "free";
	} catch {
		return undefined;
	}
}

/**
 * Inline targeted remedy — the "add just the missing resource" counterpart to
 * {@link runInlineUpgrade}: buy a single resource addon, or bump the
 * quantity-aware plan by one app slot. `setPlanQuantity` is absolute, so the
 * quantity-bump path reads the current quantity and adds one. Returns true only
 * when the change applied immediately or the checkout was paid.
 */
export async function runInlineTargetedRemedy(
	client: any,
	remedy: EntitlementRemedy,
): Promise<boolean> {
	let input: PerformBillingChangeInput;
	let label: string;
	if (remedy.kind === "addon") {
		input = { kind: "addon", addonKey: remedy.targetKey, quantity: 1 };
		label = remedy.targetName ?? remedy.targetKey;
	} else {
		const next = (await getCurrentPlanQuantitySafely(client)) + 1;
		input = { kind: "plan_quantity", planKey: remedy.targetKey, quantity: next };
		label = `${remedy.targetName ?? remedy.targetKey} ×${next}`;
	}

	const _spinner = startSpinner(`Adding ${label}...`);
	const result = await performBillingChange(client, {
		...input,
		wait: true,
		timeoutMs: 600_000,
		openBrowser: paymentBrowserOpener(),
		onCheckoutOpened: ({ orderId, paymentUrl }) => {
			log("");
			log("Open this URL to complete payment:");
			log(`  ${colors.cyan(paymentUrl)}`);
			log(`Order ID: ${colors.dim(orderId)}`);
		},
	});

	if (result.status === "applied" || result.status === "paid") {
		succeedSpinner(`${label} added.`);
		return true;
	}

	failSpinner(
		result.status === "deferred"
			? "Change did not require an immediate payment."
			: result.status === "pending_timeout"
				? "Payment still pending after 10 minutes."
				: `Payment ${result.status}.`,
	);
	if (result.failureReason) log(colors.error(result.failureReason));
	if (result.orderId) {
		log(
			colors.dim(
				`Resume later with: tarout billing wait ${result.orderId.slice(0, 8)} --timeout 600`,
			),
		);
	}
	return false;
}

/**
 * Entitlement-gate chooser. When a FORBIDDEN entitlement error can be cleared
 * by buying a single resource (a db / storage / domain addon, or one more app
 * slot on the quantity-aware plan), offer two paths — add just that resource,
 * or upgrade the whole plan — and apply the chosen one inline. When the only
 * remedy is a plan change (free-tier slot caps, dedicated host) there is no
 * cheaper targeted option, so fall straight through to the plan-upgrade picker.
 *
 * Interactive-only: callers short-circuit to `emitNeedsUpgrade` in JSON / agent
 * mode before reaching here. Returns true when a billing change applied or was
 * paid (caller should retry), false on cancel or non-completion.
 */
export async function promptEntitlementRemedy(
	client: any,
	err: unknown,
	requestedPlan?: string,
): Promise<boolean> {
	const failedKey = extractEntitlementKeyFromError(err);
	const [catalog, currentPlanKey] = await Promise.all([
		fetchCatalogSafely(client) as Promise<Catalog | null>,
		getCurrentPlanKeySafely(client),
	]);
	const remedy = resolveEntitlementRemedy(failedKey, catalog, {
		requestedPlan,
		currentPlanKey,
	});

	// No cheaper targeted action — only a full plan change unlocks these.
	if (remedy.kind === "plan") {
		return promptUpgradeFromEntitlementError(
			client,
			err,
			requestedPlan,
			currentPlanKey,
		);
	}

	const price =
		remedy.priceHalalas !== undefined
			? ` (${formatPlanPrice(remedy.priceHalalas)})`
			: "";
	const targetedLabel =
		remedy.kind === "plan_quantity"
			? `Add one more app slot${price}`
			: `Add just the ${remedy.targetName ?? remedy.targetKey}${price}`;
	// Name the upgrade target (free → Starter, shared → Pro Small, …) so the
	// choice reads as a concrete tier change rather than a vague "upgrade".
	const upgradePlanKey = upgradeTargetPlan({ currentPlanKey, requestedPlan });
	const upgradePlanDef = (catalog?.plans ?? []).find(
		(p) => (p.planKey ?? p.key) === upgradePlanKey,
	);
	const upgradeLabel = `Upgrade to ${upgradePlanDef?.name ?? upgradePlanKey}`;

	log("");
	log(colors.warn("That resource isn't included in your current plan."));
	log("");

	const UPGRADE = "__upgrade__";
	const TARGETED = "__targeted__";
	const CANCEL = "__cancel__";
	// "Upgrade the plan" is listed first so it is the highlighted default.
	const choice = await select<string>(
		"How would you like to add it?",
		[
			{ name: upgradeLabel, value: UPGRADE },
			{ name: targetedLabel, value: TARGETED },
			{ name: "Cancel", value: CANCEL },
		],
		{
			field: "entitlement_remedy",
			flag: "--plan <key> (upgrade) | tarout billing addon:buy <key> (addon)",
			context: {
				failedEntitlementKey: failedKey,
				remedyKind: remedy.kind,
				targetKey: remedy.targetKey,
				command: remedy.command,
				upgradePlanKey,
			},
		},
	);

	if (choice === CANCEL) return false;
	if (choice === UPGRADE) {
		return promptUpgradeFromEntitlementError(
			client,
			err,
			requestedPlan,
			currentPlanKey,
		);
	}
	return runInlineTargetedRemedy(client, remedy);
}

async function getAppPlanChoices(
	client: any,
	preloadedOptions?: any,
): Promise<Array<{ name: string; value: AppPlan }>> {
	try {
		const options =
			preloadedOptions ?? (await client.application.getCreateOptions.query());
		const tiers = Array.isArray(options?.tiers) ? options.tiers : [];
		const defaultTier = options?.defaultTier as AppPlan | null | undefined;
		const availableChoices = tiers
			.filter((tier: any) => tier && Number(tier.available ?? 0) > 0)
			.map((tier: any) => ({
				name: formatAppPlanChoice(tier.tier, tier, tier.tier === defaultTier),
				value: tier.tier as AppPlan,
			}));

		if (defaultTier) {
			availableChoices.sort(
				(
					a: { name: string; value: AppPlan },
					b: { name: string; value: AppPlan },
				) => {
					if (a.value === defaultTier) return -1;
					if (b.value === defaultTier) return 1;
					return 0;
				},
			);
		}

		return availableChoices;
	} catch {
		return [
			{ name: "Free app", value: "FREE" },
			{ name: "Shared app", value: "SHARED" },
			{ name: "Dedicated app", value: "DEDICATED" },
		];
	}
}

function formatAppPlanChoice(
	plan: AppPlan,
	tier: { available?: number; total?: number },
	isDefault: boolean,
): string {
	const label =
		plan === "FREE"
			? "Free app"
			: plan === "SHARED"
				? "Shared app"
				: "Dedicated app";
	const availability =
		typeof tier.available === "number" && typeof tier.total === "number"
			? ` ${colors.dim(`(${tier.available}/${tier.total} slots available)`)}`
			: "";
	const suffix = isDefault ? ` ${colors.dim("recommended")}` : "";
	return `${label}${availability}${suffix}`;
}

function normalizeAppPlan(value: string | undefined): AppPlan | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toUpperCase();
	if (
		normalized === "FREE" ||
		normalized === "SHARED" ||
		normalized === "DEDICATED"
	) {
		return normalized;
	}

	throw new InvalidArgumentError(
		'Invalid app plan. Use "free", "shared", or "dedicated".',
	);
}

// Recognizes the structured FORBIDDEN reasons raised by `application.create`
// in `src/server/api/routers/application.ts` (entitlement caps,
// "no active subscription", "FREE_NOT_ALLOWED_ON_PAID_PLAN", etc.) so the
// dashboard and CLI surface the same upgrade signal.
export function isEntitlementError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	// tRPC v10 wraps server `TRPCError` into `TRPCClientError`, putting the
	// real code on `.data.code`. Accept either shape.
	const e = err as {
		code?: string;
		message?: string;
		data?: { code?: string };
	};
	const code = e.code ?? e.data?.code;
	if (code !== "FORBIDDEN") return false;
	const msg = (e.message ?? "").toLowerCase();
	return (
		msg.includes("plan limit reached") ||
		msg.includes("entitlement") ||
		msg.includes("upgrade to add more") ||
		msg.includes("active subscription") ||
		msg.includes("free_not_allowed_on_paid_plan")
	);
}

// Best-effort upgrade suggestion when the entitlement gate rejects the
// requested plan. Returns the next tier so an agent has something concrete
// to ask for: "free" → "shared" → "dedicated_small".
export function inferSuggestedPlan(requested?: string): string {
	return nextPlanForRequested(requested);
}

// Short human labels for entitlement keys used in the plan-includes summary.
// Mirrors the stable set in `src/server/constants/billing-pricing.ts`
// `ENTITLEMENT_KEYS`. If a new key is added server-side without an entry
// here, we fall back to the raw key — degraded but not broken.
const ENTITLEMENT_LABELS: Record<string, string> = {
	"app.free.slots": "Free app slot",
	"app.shared.slots": "Starter app slot",
	"app.dedicated.slots": "Dedicated app slot",
	"host.small.slots": "Small Pro host",
	"host.medium.slots": "Medium Pro host",
	"host.large.slots": "Large Pro host",
	"db.free.slots": "Free database",
	"db.starter.slots": "Starter database",
	"db.standard.slots": "Standard database",
	"db.pro.slots": "Pro database",
	"storage.free.slots": "Free storage bucket",
	"storage.starter.slots": "Starter storage bucket",
	"storage.standard.slots": "Standard storage bucket",
	"storage.pro.slots": "Pro storage bucket",
	"domain.slots": "Custom domain",
	"email_service.slots": "Email service",
	"cloud_server.cpu.slots": "CPU cloud server",
	"cloud_server.gpu.slots": "GPU cloud server",
	"feature.custom_domain": "Custom domains feature",
};

function humanizeGrant(g: {
	entitlementKey: string;
	quantity: number;
}): string {
	const label = ENTITLEMENT_LABELS[g.entitlementKey] ?? g.entitlementKey;
	if (g.entitlementKey.startsWith("feature.")) return label;
	return g.quantity > 1 ? `${g.quantity}× ${label}s` : `${g.quantity}× ${label}`;
}

function summarizePlanGrants(plan: {
	grants?: Array<{ entitlementKey: string; quantity: number }>;
}): string {
	const grants = Array.isArray(plan?.grants) ? plan.grants : [];
	if (!grants.length) return "";
	return grants.map(humanizeGrant).join(" · ");
}

// Parses the failed entitlement key from a server-side `assertEntitlement`
// message of the form `Plan limit reached for <key>: <used>/<limit>.`.
// Used to mark the matching plan as "recommended" in the upgrade picker
// and surface it on JSON-mode output for agents.
export function extractEntitlementKeyFromError(
	err: unknown,
): string | undefined {
	const msg = err instanceof Error ? err.message : "";
	const m = msg.match(/Plan limit reached for ([\w.]+)/i);
	return m?.[1];
}

/**
 * Emit the structured NEEDS_UPGRADE envelope for an entitlement gate. When a
 * cheaper targeted action exists (buy a single addon, or add one app slot), the
 * envelope carries BOTH that option AND the full plan upgrade in an `options`
 * array — so the agent presents the choice to the human instead of committing
 * to one on its own. Plan-only gates (free-tier caps, dedicated host) carry the
 * single upgrade option. Pairs with ExitCode.PERMISSION_DENIED at the call site.
 */
export interface RemedyOption {
	action: "buy_addon" | "add_app_slot" | "upgrade_plan";
	label: string;
	command: string;
}

/**
 * The list of concrete actions that clear an entitlement gate. A targeted
 * remedy (addon / app-slot) is paired with the full plan upgrade so the caller
 * can present BOTH and let the human choose; a plan-only remedy yields the
 * single upgrade action.
 */
export function buildRemedyOptions(
	remedy: EntitlementRemedy,
	requestedPlan: string | undefined,
	catalog: Catalog | null,
	currentPlanKey?: string,
): RemedyOption[] {
	if (remedy.kind === "addon" || remedy.kind === "plan_quantity") {
		// The "upgrade the plan" alternative follows the current-plan ladder
		// (free → shared, shared → dedicated_small, …) when we know the org's
		// plan; otherwise it falls back to the requested-plan heuristic.
		const upgradePlan = upgradeTargetPlan({ currentPlanKey, requestedPlan });
		const planDef = (catalog?.plans ?? []).find(
			(p) => (p.planKey ?? p.key) === upgradePlan,
		);
		return [
			{
				action: remedy.kind === "addon" ? "buy_addon" : "add_app_slot",
				label:
					remedy.kind === "addon"
						? `Buy just the ${remedy.targetName ?? remedy.targetKey}`
						: "Add one more app slot",
				command: remedy.command,
			},
			{
				action: "upgrade_plan",
				label: `Upgrade to ${planDef?.name ?? upgradePlan}`,
				command: `tarout billing upgrade ${upgradePlan} --wait`,
			},
		];
	}
	return [
		{
			action: "upgrade_plan",
			label: `Upgrade to ${remedy.targetName ?? remedy.targetKey}`,
			command: remedy.command,
		},
	];
}

export async function emitNeedsUpgrade(
	client: any,
	err: unknown,
	requestedPlan: string | undefined,
	retryCommand: string,
): Promise<void> {
	const message = err instanceof Error ? err.message : "Plan upgrade required";
	const failedKey = extractEntitlementKeyFromError(err);
	const [catalog, currentPlanKey] = await Promise.all([
		fetchCatalogSafely(client) as Promise<Catalog | null>,
		getCurrentPlanKeySafely(client),
	]);
	const remedy = resolveEntitlementRemedy(failedKey, catalog, {
		requestedPlan,
		currentPlanKey,
	});
	const options = buildRemedyOptions(
		remedy,
		requestedPlan,
		catalog,
		currentPlanKey,
	);

	const hint =
		options.length > 1
			? `Two ways to resolve this — ask the user which they prefer, do not choose for them: (1) ${options[0]?.label}: \`${options[0]?.command}\`; (2) ${options[1]?.label}: \`${options[1]?.command}\`. The chosen command opens the payment page and waits until it's confirmed, then retry: ${retryCommand}.`
			: `${remedy.hint} That command opens the payment page and waits until it's confirmed, then retry: ${retryCommand}.`;

	outputError("NEEDS_UPGRADE", message, {
		failedEntitlementKey: failedKey,
		remedyKind: remedy.kind,
		// `suggestedPlan`/`nextCommand` retained for back-compat (the recommended
		// targeted action); `options` is the authoritative choice list.
		suggestedPlan: remedy.targetKey,
		suggestedTarget: remedy.targetKey,
		nextCommand: remedy.command,
		options,
		hint,
		permissionHint: AGENT_BILLING_PERMISSION_HINT,
	});
}

// Best-effort lookup of the free-tier databases already holding the single
// org-wide `db.free.slots` reservation, so the deploy error can name what's
// blocking instead of leaving the user to hunt for it. Never throws — a failed
// lookup just yields an empty list and a slightly less specific message.
// Note: `allByOrganization` is scoped to the active environment, so a free DB
// living in another environment won't appear here; that's surfaced in the hint.
async function listFreeDatabasesSafely(
	client: any,
): Promise<Array<{ kind: "postgres" | "mysql"; id: string; name: string }>> {
	try {
		const [pgRows, myRows] = await Promise.all([
			client.postgres.allByOrganization.query().catch(() => []),
			client.mysql.allByOrganization.query().catch(() => []),
		]);
		const out: Array<{ kind: "postgres" | "mysql"; id: string; name: string }> =
			[];
		for (const r of (pgRows ?? []) as any[]) {
			if ((r?.plan ?? "FREE") === "FREE" && r?.postgresId) {
				out.push({ kind: "postgres", id: r.postgresId, name: r.name });
			}
		}
		for (const r of (myRows ?? []) as any[]) {
			if ((r?.plan ?? "FREE") === "FREE" && r?.mysqlId) {
				out.push({ kind: "mysql", id: r.mysqlId, name: r.name });
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Explain an exhausted free-tier resource slot (`db.free.slots` /
 * `storage.free.slots`). The free plan grants exactly ONE database and ONE
 * storage bucket for the whole org (Postgres + MySQL combined, across every
 * environment), so the fix is almost never "buy an addon" — it's reuse the
 * existing one, delete it, or upgrade. Name the resource holding the slot and
 * list those three concrete paths.
 */
async function explainFreeResourceSlotExhaustion(
	client: any,
	failedKey: string,
): Promise<void> {
	const isDb = failedKey === "db.free.slots";
	const resource = isDb ? "database" : "storage bucket";
	log("");
	log(
		colors.warn(
			`The free plan includes one ${resource} for the whole organization (across all environments).`,
		),
	);

	if (isDb) {
		const existing = await listFreeDatabasesSafely(client);
		if (existing.length > 0) {
			log("You already have:");
			for (const d of existing) {
				log(
					`  • ${d.name} ${colors.dim(`(${d.kind} · ${d.id.slice(0, 8)})`)}`,
				);
			}
		} else {
			log(
				colors.dim(
					"Your existing free database may be in another environment — run `tarout db list`.",
				),
			);
		}
	}

	log("");
	log("To continue, pick one:");
	if (isDb) {
		log(`  • Reuse it:  ${colors.cyan("tarout deploy --reuse-database auto")}`);
		log(`  • Delete it: ${colors.cyan("tarout db delete <id>")}`);
	}
	log(`  • Upgrade:   ${colors.cyan("tarout billing upgrade shared --wait")}`);
	log("");
}

/**
 * Interactive plan picker shown when the deploy flow hits a FORBIDDEN
 * entitlement gate. Lists each upgrade-worthy plan with name, price, and
 * a human-readable summary of included entitlements, then delegates to
 * `runInlineUpgrade` for the actual `changePlan` + checkout poll.
 *
 * Returns true only if the upgrade reached PAID / applied-immediately.
 * False means the user cancelled, the catalog was empty, or the
 * checkout did not complete — caller should fall back to the static
 * NEEDS_UPGRADE error.
 */
export async function promptUpgradeFromEntitlementError(
	client: any,
	err: unknown,
	requestedPlan?: string,
	currentPlanKey?: string,
): Promise<boolean> {
	const catalog = await fetchCatalogSafely(client);
	const allPlans: any[] = catalog?.plans ?? [];

	// Drop "free" (nothing to upgrade *to*) and zero-priced plans.
	const upgradeable = allPlans.filter(
		(p) => (p.planKey || p.key) !== "free" && (p.priceHalalas ?? 0) > 0,
	);

	if (!upgradeable.length) {
		return false;
	}

	// Recommend the next tier up from the org's current plan (free → Starter,
	// shared → Pro Small, …). Only when that target isn't an upgradeable plan do
	// we fall back to a plan whose grants cover the failed entitlement key.
	const failedKey = extractEntitlementKeyFromError(err);
	const ladderKey = upgradeTargetPlan({ currentPlanKey, requestedPlan });
	const ladderPlan = upgradeable.find(
		(p) => (p.planKey || p.key) === ladderKey,
	);
	const matchingPlan = failedKey
		? upgradeable.find((p) =>
				p.grants?.some((g: any) => g.entitlementKey === failedKey),
			)
		: undefined;
	const recommendedKey: string | undefined = ladderPlan
		? ladderKey
		: matchingPlan
			? (matchingPlan.planKey || matchingPlan.key)
			: inferSuggestedPlan(requestedPlan);

	// Details block printed before the selector so users can read full
	// price + includes lines (inquirer's list collapses each choice to
	// a single line).
	log("");
	log(colors.bold("Available upgrade plans:"));
	log("");
	for (const p of upgradeable) {
		const key = p.planKey || p.key;
		const isRec = key === recommendedKey;
		const price = formatPlanPrice(p.priceHalalas) || "Free";
		const includes = summarizePlanGrants(p);
		const header = `  ${colors.cyan(p.name || key)}  ${colors.dim(`(${key})`)}  ${colors.bold(price)}${isRec ? `  ${colors.success("← recommended")}` : ""}`;
		log(header);
		if (p.description) log(`    ${colors.dim(p.description)}`);
		if (includes) log(`    Includes: ${includes}`);
		if (p.quantityAware) {
			log(
				`    ${colors.dim(`Quantity-aware (${p.minQuantity}–${p.maxQuantity} units)`)}`,
			);
		}
		log("");
	}

	// Surface the recommended plan at the top of the selector.
	const choices = upgradeable
		.slice()
		.sort((a, b) => {
			if ((a.planKey || a.key) === recommendedKey) return -1;
			if ((b.planKey || b.key) === recommendedKey) return 1;
			return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
		})
		.map((p) => {
			const key = (p.planKey || p.key) as string;
			const price = formatPlanPrice(p.priceHalalas);
			const tag = key === recommendedKey ? " — recommended" : "";
			return {
				name: `${p.name || key} ${price ? `(${price})` : ""}${tag}`,
				value: key,
			};
		});

	choices.push({
		name: "Cancel — exit without upgrading",
		value: "__cancel__",
	});

	const picked = await select<string>(
		"Select a plan to upgrade to:",
		choices,
	);

	if (picked === "__cancel__") return false;

	return runInlineUpgrade(client, picked);
}

// Mirrors the dashboard's "Advanced" section in
// `src/pages/dashboard/applications/new.tsx`: empty strings are collapsed so
// the server-side framework detector still wins when a flag is not provided.
export function buildConfigFromOptions(
	options: DeployOptions,
): Record<string, string> | undefined {
	const fields: Array<[keyof DeployOptions, string]> = [
		["frameworkPreset", "frameworkPreset"],
		["rootDirectory", "rootDirectory"],
		["installCommand", "installCommand"],
		["buildCommand", "buildCommand"],
		["outputDirectory", "outputDirectory"],
		["startCommand", "startCommand"],
	];

	const config: Record<string, string> = {};
	for (const [source, target] of fields) {
		const raw = options[source];
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (!trimmed) continue;
		config[target] = trimmed;
	}

	return Object.keys(config).length > 0 ? config : undefined;
}

async function resolveSourcePreference(
	options: DeployOptions,
	inspection: ProjectInspection,
): Promise<SourcePreference> {
	const explicitSource = normalizeSourcePreference(options.source);
	if (explicitSource !== "auto") return explicitSource;
	if (!inspection.git.hasGit || isJsonMode() || shouldSkipConfirmation()) {
		return "auto";
	}

	const label = inspection.git.provider
		? `${inspection.git.provider} Git repository detected. Deployment source:`
		: "Git repository detected. Deployment source:";
	return select<SourcePreference>(label, [
		{
			name: "Use current folder upload for this deploy (default, no GitHub required)",
			value: "upload",
		},
		{
			name: "Use an app source already connected in Tarout",
			value: "configured",
		},
		{
			name: "Open Tarout Git provider setup in the browser, then rerun deploy",
			value: "connect",
		},
	]);
}

function normalizeSourcePreference(
	value: string | undefined,
): SourcePreference {
	if (!value) return "auto";
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "auto" ||
		normalized === "upload" ||
		normalized === "configured" ||
		normalized === "connect"
	) {
		return normalized;
	}

	throw new InvalidArgumentError(
		'Invalid source choice. Use "auto", "upload", "configured", or "connect".',
	);
}

function resolveShouldUploadSource(
	target: DeploymentTarget,
	sourcePreference: SourcePreference,
): boolean {
	if (sourcePreference === "upload") return true;
	if (sourcePreference === "configured") {
		if (!target.hasConfiguredSource) {
			throw new InvalidArgumentError(
				'No configured Git/provider source exists for this app yet. Connect a Git provider first, or rerun with "--source upload" to deploy the current folder.',
			);
		}
		return false;
	}
	if (sourcePreference === "connect") {
		throw new InvalidArgumentError(
			'Connect a Git provider in Tarout first, then rerun with "--source configured" or "--source upload".',
		);
	}
	return target.shouldUploadSource;
}

async function openGitProviderSetup(): Promise<void> {
	const url = `${getApiUrl().replace(/\/+$/, "")}/dashboard/settings/git-providers`;

	if (isJsonMode()) {
		outputData({
			action: "connect_git_provider",
			url,
			next: 'After connecting GitHub or another Git provider, rerun "tarout deploy --source configured" or use "--source upload".',
		});
		return;
	}

	log("");
	log(`Opening Tarout Git provider setup: ${colors.cyan(url)}`);
	log(
		"Complete the GitHub or Git provider connection in the browser, then rerun deploy.",
	);
	log(
		`No GitHub account is required if you keep using ${colors.dim("--source upload")}.`,
	);
	await open(url);
}

export async function configureOptionalResources(
	client: any,
	profile: Profile,
	app: AppSummary,
	options: DeployOptions,
	inspection: ProjectInspection,
): Promise<void> {
	const database = await resolveDatabaseChoice(options, inspection);
	const createdResources: string[] = [];

	if (database !== "none") {
		const decision = await resolveDatabaseProvisioning(
			client,
			profile,
			app,
			database,
			options,
		);
		if (decision.action === "reuse") {
			await attachExistingDatabase(client, app, database, decision);
			createdResources.push(
				`${formatDatabaseKind(database)} reused — ${decision.name} (${decision.plan})`,
			);
		} else {
			await createAndAttachDatabase(client, profile, app, {
				kind: database,
				name: decision.name,
				plan: decision.plan,
			});
			createdResources.push(
				`${formatDatabaseKind(database)} (${decision.plan})`,
			);
		}
	}

	if (await resolveStorageChoice(options, inspection)) {
		const decision = await resolveStorageProvisioning(
			client,
			profile,
			app,
			options,
		);
		if (decision.action === "reuse") {
			await attachExistingStorage(client, app, decision);
			createdResources.push(
				`Storage reused — ${decision.name} (${decision.plan})`,
			);
		} else {
			await createAndAttachStorage(client, app, {
				name: decision.name,
				plan: decision.plan,
			});
			createdResources.push(`Storage (${decision.plan})`);
		}
	}

	if (createdResources.length > 0 && !isJsonMode()) {
		box("Provisioned Resources", createdResources);
	}
}

async function resolveDatabaseChoice(
	options: DeployOptions,
	inspection: ProjectInspection,
): Promise<DatabaseKind> {
	const explicitChoice = normalizeDatabaseKind(options.database);
	if (explicitChoice) return explicitChoice;
	if (isJsonMode() || shouldSkipConfirmation()) return inspection.database;

	if (inspection.database !== "none") {
		log("");
		log(
			`Detected ${colors.cyan(formatDatabaseKind(inspection.database))} usage: ${inspection.databaseReasons.slice(0, 3).join("; ")}`,
		);
		const alternate = inspection.database === "postgres" ? "mysql" : "postgres";
		return select<DatabaseKind>("Provision a database?", [
			{
				name: `Yes, create ${formatDatabaseKind(inspection.database)} (detected)`,
				value: inspection.database,
			},
			{ name: "No database", value: "none" },
			{ name: `Create ${formatDatabaseKind(alternate)}`, value: alternate },
		]);
	}

	return select<DatabaseKind>("Provision a database?", [
		{ name: "No database", value: "none" },
		{ name: "Postgres", value: "postgres" },
		{ name: "MySQL", value: "mysql" },
	]);
}

async function resolveStorageChoice(
	options: DeployOptions,
	inspection: ProjectInspection,
): Promise<boolean> {
	if (options.storage === true) return true;
	if (isJsonMode() || shouldSkipConfirmation()) return inspection.storage;

	if (inspection.storage) {
		log("");
		log(
			`Detected file storage usage: ${inspection.storageReasons.slice(0, 3).join("; ")}`,
		);
	}
	return confirm(
		"Provision file storage for this app?",
		inspection.storage,
	);
}

export type ResourceKind = "database" | "storage";

export interface ResourceTier {
	tier: ResourcePlan;
	canCreate: boolean;
	limit: number;
	available: number;
	monthlyHalalas: number;
}

const RESOURCE_TIER_LABEL: Record<ResourcePlan, string> = {
	FREE: "Free",
	STARTER: "Starter",
	STANDARD: "Standard",
	PRO: "Pro",
};

// Pull the connected org's per-tier availability for databases or storage.
// `postgres.getEntitlements` covers both Postgres and MySQL (they share the
// db.* keys). Best-effort: a failed lookup yields [] and the caller falls back.
export async function loadResourceTiers(
	client: any,
	kind: ResourceKind,
): Promise<ResourceTier[]> {
	try {
		const ent =
			kind === "database"
				? await client.postgres.getEntitlements.query()
				: await client.storage.getEntitlements.query();
		const tiers = Array.isArray(ent?.tiers) ? ent.tiers : [];
		return tiers
			.map((t: any) => ({
				tier: String(t?.tier) as ResourcePlan,
				canCreate: Boolean(t?.canCreate),
				limit: Number(t?.limit ?? 0),
				available: Number(t?.available ?? 0),
				monthlyHalalas: Number(t?.monthlyHalalas ?? 0),
			}))
			.filter((t: ResourceTier) =>
				["FREE", "STARTER", "STANDARD", "PRO"].includes(t.tier),
			);
	} catch {
		return [];
	}
}

/**
 * The tier a new resource should default to, derived from the connected org's
 * actual entitlements — so a paid org never silently lands on FREE, and the
 * server is never asked for a tier the org doesn't own (which is what produced
 * `db.starter.slots: 1/0` for an org that actually holds a db.standard slot).
 *
 *  1. Cheapest tier with an OPEN slot right now (a paid org's FREE tier has a 0
 *     limit, so it's never creatable and is skipped automatically).
 *  2. No open slot → the most capable tier the org actually OWNS (limit > 0), so
 *     the server gate + entitlement-remedy reflect the org's real plan instead
 *     of a tier it doesn't have.
 *  3. No entitlement at all (e.g. a paid org with no db/storage addon) → the
 *     entry paid tier, so the gate offers the cheapest addon to purchase.
 */
export function pickDefaultResourceTier(tiers: ResourceTier[]): ResourcePlan {
	const creatable = tiers
		.filter((t) => t.canCreate)
		.sort((a, b) => a.monthlyHalalas - b.monthlyHalalas);
	if (creatable.length > 0) return creatable[0]!.tier;

	const owned = tiers
		.filter((t) => t.limit > 0)
		.sort((a, b) => b.monthlyHalalas - a.monthlyHalalas);
	if (owned.length > 0) return owned[0]!.tier;

	return "STARTER";
}

async function resolveResourcePlan(
	client: any,
	kind: ResourceKind,
	value: string | undefined,
	message: string,
): Promise<ResourcePlan> {
	const explicitPlan = normalizeResourcePlan(value);
	if (explicitPlan) return explicitPlan;

	const tiers = await loadResourceTiers(client, kind);
	const def = pickDefaultResourceTier(tiers);

	// Non-interactive (JSON, no TTY, or --yes): auto-pick the plan-aware default
	// instead of hardcoding FREE. This is what keeps paid orgs off the free tier.
	if (isJsonMode() || isNonInteractiveMode() || shouldSkipConfirmation()) {
		return def;
	}

	// Interactive: list the tiers (default first / recommended) with price and
	// the org's real availability so the choice reflects the account's plan.
	const byTier = new Map(tiers.map((t) => [t.tier, t]));
	const order: ResourcePlan[] = [
		def,
		...(["FREE", "STARTER", "STANDARD", "PRO"] as ResourcePlan[]).filter(
			(t) => t !== def,
		),
	];
	const choices = order.map((t) => {
		const info = byTier.get(t);
		const price =
			info && info.monthlyHalalas > 0
				? ` — ${(info.monthlyHalalas / 100).toFixed(0)} SAR/mo`
				: t === "FREE"
					? " — Free"
					: "";
		const avail = info
			? info.canCreate
				? ` ${colors.dim(`(${info.available} available)`)}`
				: ` ${colors.dim("(needs an addon/upgrade)")}`
			: "";
		const rec = t === def ? colors.dim("  recommended") : "";
		return { name: `${RESOURCE_TIER_LABEL[t]}${price}${avail}${rec}`, value: t };
	});
	return select<ResourcePlan>(message, choices, {
		field: kind === "database" ? "database_plan" : "storage_plan",
		flag:
			kind === "database" ? "--database-plan <tier>" : "--storage-plan <tier>",
		context: {
			default: def,
			tiers: tiers.map((t) => ({ tier: t.tier, canCreate: t.canCreate })),
		},
	});
}

/** The DB tier a managed db addon grants once purchased. */
function dbTierForAddonKey(addonKey: string): ResourcePlan {
	if (addonKey === "db.pro") return "PRO";
	if (addonKey === "db.standard") return "STANDARD";
	return "STARTER";
}

export type DbPlanResolution =
	| { ok: true; plan: ResourcePlan }
	| { ok: false; result: BillingChangeResult };

/**
 * Decide the tier for a NEW database, defaulting to the org's subscribed tier
 * and AUTO-BUYING the plan-matched managed db add-on when the org has no open
 * slot (Starter→`db.standard`, Pro→`db.pro`). Decision-only and unit-testable:
 * never calls `process.exit`; returns `{ok:false, result}` when an auto-buy
 * checkout didn't complete so the caller can surface it.
 *
 * Resolution order:
 *  1. An explicit tier wins — except explicit `FREE` on a paid org (the server
 *     rejects it), which is dropped so we resolve the org's real tier.
 *  2. Any creatable/owned slot is used as-is via {@link pickDefaultResourceTier}
 *     — this is what makes a Dedicated org use its BUNDLED `db.standard` slots
 *     (→ STANDARD) with NO purchase, and keeps a free org on FREE.
 *  3. A paid org with NO creatable slot buys the plan-matched add-on (Shared→
 *     `db.standard`), then creates on the granted tier.
 */
export async function ensureDatabasePlan(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	requested: ResourcePlan | undefined,
): Promise<DbPlanResolution> {
	const currentPlanKey = await getCurrentPlanKeySafely(client);
	const addonKey = dbAddonKeyForPlanFamily(currentPlanKey);
	const orgIsPaid = addonKey !== null;

	// Explicit tier wins, except explicit FREE on a paid org → drop and resolve.
	if (requested && !(requested === "FREE" && orgIsPaid)) {
		return { ok: true, plan: requested };
	}

	const tiers = await loadResourceTiers(client, "database");
	const hasCreatable = tiers.some((t) => t.canCreate);
	if (hasCreatable || !orgIsPaid) {
		// Creatable/owned slot (incl. Dedicated's bundled db.standard) or a free
		// org → existing tier picker default; no purchase.
		return { ok: true, plan: pickDefaultResourceTier(tiers) };
	}

	// Paid org with no open DB slot → buy the plan-matched managed db add-on.
	if (!isJsonMode()) {
		log("");
		log(
			colors.dim(
				`Your plan has no open database slot — adding the ${addonKey} add-on. Complete payment in the browser to continue.`,
			),
		);
	}
	const result = await performBillingChange(client, {
		kind: "addon",
		addonKey: addonKey as string,
		quantity: 1,
		wait: true,
		timeoutMs: 600_000,
		openBrowser: paymentBrowserOpener(),
		onCheckoutOpened: ({ orderId, paymentUrl }) => {
			if (!isJsonMode()) {
				log("");
				log("Open this URL to complete payment:");
				log(`  ${colors.cyan(paymentUrl)}`);
				log(`Order ID: ${colors.dim(orderId)}`);
			}
		},
	});
	if (result.status === "applied" || result.status === "paid") {
		return { ok: true, plan: dbTierForAddonKey(addonKey as string) };
	}
	return { ok: false, result };
}

/**
 * {@link ensureDatabasePlan} + surface-and-exit glue for the create call sites:
 * on an incomplete auto-buy it emits the billing result and exits with the
 * matching code (resumable for a pending checkout, error for a hard failure) so
 * we never create a database the org couldn't pay for.
 */
export async function resolveDatabasePlanOrExit(
	// biome-ignore lint/suspicious/noExplicitAny: untyped tRPC proxy client.
	client: any,
	requested: ResourcePlan | undefined,
): Promise<ResourcePlan> {
	const resolution = await ensureDatabasePlan(client, requested);
	if (resolution.ok) return resolution.plan;
	exit(emitBillingResult(resolution.result, { label: "Database add-on" }));
}

async function createAndAttachDatabase(
	client: any,
	profile: Profile,
	app: AppSummary,
	input: { kind: "postgres" | "mysql"; name: string; plan: ResourcePlan },
): Promise<void> {
	const appName = generateResourceSlug(app.name, input.kind);
	const label = input.kind === "postgres" ? "Postgres" : "MySQL";
	const _createSpinner = startSpinner(`Creating ${label} database...`);

	let databaseId: string | undefined;
	try {
		if (input.kind === "postgres") {
			const created = await client.postgres.create.mutate({
				name: input.name,
				appName,
				dockerImage: "postgres:17",
				organizationId: profile.organizationId,
				environmentId: profile.environmentId,
				plan: input.plan,
				region: DEFAULT_REGION,
			});
			databaseId = created?.postgresId;
		} else {
			const created = await client.mysql.create.mutate({
				name: input.name,
				appName,
				dockerImage: "mysql:9.1",
				organizationId: profile.organizationId,
				environmentId: profile.environmentId,
				plan: input.plan,
				region: DEFAULT_REGION,
			});
			databaseId = created?.mysqlId;
		}
		succeedSpinner(`${label} database created.`);
	} catch (err) {
		failSpinner(`Failed to create ${label} database.`);
		throw err;
	}

	// create now returns the id directly; fall back to a name lookup only for
	// older servers that don't.
	if (!databaseId) {
		databaseId = await findDatabaseIdByAppName(client, input.kind, appName);
	}
	const _attachSpinner = startSpinner(`Attaching ${label} to ${app.name}...`);
	try {
		if (input.kind === "postgres") {
			await client.postgres.attachToApplication.mutate({
				postgresId: databaseId,
				applicationId: app.applicationId,
			});
		} else {
			await client.mysql.attachToApplication.mutate({
				mysqlId: databaseId,
				applicationId: app.applicationId,
			});
		}
		succeedSpinner(`${label} credentials attached.`);
	} catch (err) {
		failSpinner(`Failed to attach ${label} credentials.`);
		throw err;
	}
}

async function findDatabaseIdByAppName(
	client: any,
	kind: "postgres" | "mysql",
	appName: string,
): Promise<string> {
	const databases =
		kind === "postgres"
			? await client.postgres.allByOrganization.query()
			: await client.mysql.allByOrganization.query();
	const database = databases.find((item: any) => item.appName === appName);
	const id = kind === "postgres" ? database?.postgresId : database?.mysqlId;

	if (!id) {
		throw new Error(
			`Created ${kind === "postgres" ? "Postgres" : "MySQL"} database, but could not resolve its ID for attachment.`,
		);
	}

	return id;
}

async function createAndAttachStorage(
	client: any,
	app: AppSummary,
	input: { name: string; plan: ResourcePlan },
): Promise<void> {
	const _createSpinner = startSpinner("Creating storage bucket...");
	let bucketId: string;

	try {
		const bucket = await client.storage.create.mutate({
			name: input.name,
			publicAccess: false,
			plan: input.plan,
		});
		bucketId = bucket.bucketId;
		succeedSpinner("Storage bucket created.");
	} catch (err) {
		failSpinner("Failed to create storage bucket.");
		throw err;
	}

	const _attachSpinner = startSpinner(`Attaching storage to ${app.name}...`);
	try {
		await client.storage.attachToApplication.mutate({
			bucketId,
			applicationId: app.applicationId,
		});
		succeedSpinner("Storage credentials attached.");
	} catch (err) {
		failSpinner("Failed to attach storage credentials.");
		throw err;
	}
}

// --- Reuse-or-create resolution -----------------------------------------

type ProvisionDecision<TReuseFields> =
	| ({ action: "reuse"; plan: ResourcePlan; name: string } & TReuseFields)
	| { action: "create"; plan: ResourcePlan; name: string };

interface DatabaseCandidate {
	id: string;
	name: string;
	appName?: string | null;
	plan: ResourcePlan;
	region?: string | null;
	projectId?: string | null;
	environmentId?: string | null;
	applicationStatus?: string | null;
	isReadOnly?: boolean | null;
	createdAt?: string | Date | null;
}

interface StorageCandidate {
	bucketId: string;
	name: string;
	plan: ResourcePlan;
	region?: string | null;
	projectId?: string | null;
	environmentId?: string | null;
	applicationStatus?: string | null;
	isUploadBlocked?: boolean | null;
	createdAt?: string | Date | null;
}

type DatabaseDecision = ProvisionDecision<{
	databaseId: string;
	upgraded: boolean;
}>;
type StorageDecision = ProvisionDecision<{
	bucketId: string;
	upgraded: boolean;
}>;

async function resolveDatabaseProvisioning(
	client: any,
	profile: Profile,
	app: AppSummary,
	kind: "postgres" | "mysql",
	options: DeployOptions,
): Promise<DatabaseDecision> {
	const candidates = await listDatabaseCandidates(client, kind, profile);
	const requestedPlan = normalizeResourcePlan(options.databasePlan);
	const planExplicit = Boolean(options.databasePlan);

	if (options.reuseDatabase) {
		const picked = resolveExplicitDatabaseRef(
			candidates,
			options.reuseDatabase,
			kind,
		);
		return finalizeDatabaseReuse(
			client,
			picked,
			kind,
			requestedPlan,
			planExplicit,
		);
	}

	if (candidates.length === 0 || isJsonMode() || shouldSkipConfirmation()) {
		return buildDatabaseCreateDecision(client, app, kind, requestedPlan);
	}

	const label = formatDatabaseKind(kind);
	const choices = [
		{ name: `Create a new ${label} database`, value: "__create__" },
		...candidates.map((c) => ({
			name: formatDatabaseCandidateLine(c),
			value: c.id,
		})),
	];
	log("");
	log(
		`Found ${candidates.length} existing ${label} database${candidates.length === 1 ? "" : "s"} in this project.`,
	);
	const picked = await select<string>(
		`Reuse an existing ${label} database or create a new one?`,
		choices,
		{
			field: kind === "postgres" ? "reuse_postgres" : "reuse_mysql",
			flag:
				kind === "postgres"
					? "--reuse-database <id|name|auto>"
					: "--reuse-database <id|name|auto>",
			context: { kind },
		},
	);

	if (picked === "__create__") {
		const plan = await resolveDatabasePlanOrExit(client, requestedPlan);
		return {
			action: "create",
			plan,
			name: formatResourceName(app.name, label),
		};
	}

	const candidate = candidates.find((c) => c.id === picked);
	if (!candidate) {
		// Defensive: select returned an id not in our list.
		throw new Error(
			`Unable to resolve picked ${label} database (id=${picked}).`,
		);
	}
	return finalizeDatabaseReuse(
		client,
		candidate,
		kind,
		requestedPlan,
		planExplicit,
	);
}

async function resolveStorageProvisioning(
	client: any,
	profile: Profile,
	app: AppSummary,
	options: DeployOptions,
): Promise<StorageDecision> {
	const candidates = await listStorageCandidates(client, profile);
	const requestedPlan = normalizeResourcePlan(options.storagePlan);
	const planExplicit = Boolean(options.storagePlan);

	if (options.reuseStorage) {
		const picked = resolveExplicitStorageRef(candidates, options.reuseStorage);
		return finalizeStorageReuse(client, picked, requestedPlan, planExplicit);
	}

	if (candidates.length === 0 || isJsonMode() || shouldSkipConfirmation()) {
		return buildStorageCreateDecision(client, app, requestedPlan);
	}

	const choices = [
		{ name: "Create a new storage bucket", value: "__create__" },
		...candidates.map((c) => ({
			name: formatStorageCandidateLine(c),
			value: c.bucketId,
		})),
	];
	log("");
	log(
		`Found ${candidates.length} existing storage bucket${candidates.length === 1 ? "" : "s"} in this project.`,
	);
	const picked = await select<string>(
		"Reuse an existing storage bucket or create a new one?",
		choices,
		{
			field: "reuse_storage",
			flag: "--reuse-storage <id|name|auto>",
		},
	);

	if (picked === "__create__") {
		const plan =
			requestedPlan ??
			(await resolveResourcePlan(client, "storage", undefined, "Storage plan:"));
		return {
			action: "create",
			plan,
			name: formatResourceName(app.name, "files", 50),
		};
	}

	const candidate = candidates.find((c) => c.bucketId === picked);
	if (!candidate) {
		throw new Error(`Unable to resolve picked storage bucket (id=${picked}).`);
	}
	return finalizeStorageReuse(client, candidate, requestedPlan, planExplicit);
}

async function listDatabaseCandidates(
	client: any,
	kind: "postgres" | "mysql",
	profile: Profile,
): Promise<DatabaseCandidate[]> {
	const rows: any[] =
		kind === "postgres"
			? await client.postgres.allByOrganization.query()
			: await client.mysql.allByOrganization.query();

	return (rows ?? [])
		.filter((r) => {
			// Require projectId match. If the server is older and doesn't return
			// projectId, exclude the row — safer than risking a cross-project
			// attach that the server would reject anyway.
			if (!r?.projectId || !profile.projectId) return false;
			return r.projectId === profile.projectId;
		})
		.map<DatabaseCandidate>((r) => ({
			id: kind === "postgres" ? r.postgresId : r.mysqlId,
			name: r.name,
			appName: r.appName,
			plan: (r.plan as ResourcePlan) ?? "FREE",
			region: r.region ?? null,
			projectId: r.projectId ?? null,
			environmentId: r.environmentId ?? null,
			applicationStatus: r.applicationStatus ?? null,
			isReadOnly: r.isReadOnly ?? null,
			createdAt: r.createdAt ?? null,
		}))
		.filter((c) => Boolean(c.id));
}

async function listStorageCandidates(
	client: any,
	profile: Profile,
): Promise<StorageCandidate[]> {
	const rows: any[] = await client.storage.allByOrganization.query();
	return (rows ?? [])
		.filter((r) => {
			if (!r?.projectId || !profile.projectId) return false;
			return r.projectId === profile.projectId;
		})
		.map<StorageCandidate>((r) => ({
			bucketId: r.bucketId,
			name: r.name,
			plan: (r.plan as ResourcePlan) ?? "FREE",
			region: r.region ?? null,
			projectId: r.projectId ?? null,
			environmentId: r.environmentId ?? null,
			applicationStatus: r.applicationStatus ?? null,
			isUploadBlocked: r.isUploadBlocked ?? null,
			createdAt: r.createdAt ?? null,
		}))
		.filter((c) => Boolean(c.bucketId));
}

function resolveExplicitDatabaseRef(
	candidates: DatabaseCandidate[],
	ref: string,
	kind: "postgres" | "mysql",
): DatabaseCandidate {
	const label = formatDatabaseKind(kind);
	const normalized = ref.trim();

	if (normalized.toLowerCase() === "auto") {
		if (candidates.length === 0) {
			throw new InvalidArgumentError(
				`--reuse-database=auto: no existing ${label} databases in this project.`,
			);
		}
		if (candidates.length > 1) {
			const sample = candidates
				.slice(0, 5)
				.map((c) => `${c.name} (${c.id})`)
				.join(", ");
			throw new InvalidArgumentError(
				`--reuse-database=auto needs exactly one match, found ${candidates.length}. Candidates: ${sample}. Pick one by id or name.`,
			);
		}
		return candidates[0]!;
	}

	const lower = normalized.toLowerCase();
	const match =
		candidates.find((c) => c.id === normalized) ??
		candidates.find((c) => c.name.toLowerCase() === lower) ??
		candidates.find((c) => (c.appName ?? "").toLowerCase() === lower);

	if (!match) {
		const known = candidates.map((c) => `${c.name} (${c.id.slice(0, 8)})`);
		const suggestions = findSimilar(
			normalized,
			candidates.flatMap((c) => [c.name, c.id]),
		);
		throw new NotFoundError(
			`${label} database`,
			normalized,
			suggestions.length > 0
				? suggestions
				: known.length > 0
					? known.slice(0, 5)
					: [
							`No ${label} databases found in this project. Drop --reuse-database to create a new one.`,
						],
		);
	}
	return match;
}

function resolveExplicitStorageRef(
	candidates: StorageCandidate[],
	ref: string,
): StorageCandidate {
	const normalized = ref.trim();

	if (normalized.toLowerCase() === "auto") {
		if (candidates.length === 0) {
			throw new InvalidArgumentError(
				"--reuse-storage=auto: no existing storage buckets in this project.",
			);
		}
		if (candidates.length > 1) {
			const sample = candidates
				.slice(0, 5)
				.map((c) => `${c.name} (${c.bucketId})`)
				.join(", ");
			throw new InvalidArgumentError(
				`--reuse-storage=auto needs exactly one match, found ${candidates.length}. Candidates: ${sample}. Pick one by id or name.`,
			);
		}
		return candidates[0]!;
	}

	const lower = normalized.toLowerCase();
	const match =
		candidates.find((c) => c.bucketId === normalized) ??
		candidates.find((c) => c.name.toLowerCase() === lower);

	if (!match) {
		const known = candidates.map(
			(c) => `${c.name} (${c.bucketId.slice(0, 8)})`,
		);
		const suggestions = findSimilar(
			normalized,
			candidates.flatMap((c) => [c.name, c.bucketId]),
		);
		throw new NotFoundError(
			"Storage bucket",
			normalized,
			suggestions.length > 0
				? suggestions
				: known.length > 0
					? known.slice(0, 5)
					: [
							"No storage buckets found in this project. Drop --reuse-storage to create a new one.",
						],
		);
	}
	return match;
}

/**
 * Surface a reuse-plan decision that did NOT result in an automatic upgrade.
 * Replaces the old silent `return false` so an agent (JSON) — or a `--yes`
 * scripted run — always learns the reused resource stayed on its current plan
 * and gets the exact command to upgrade it. Plan upgrades are billing-mutating
 * (and may require a checkout), so they are never performed unprompted.
 */
function emitReuseNotice(payload: {
	event: string;
	humanMessage: string;
	humanHint?: string;
	details: Record<string, unknown>;
}): void {
	if (isJsonMode()) {
		outputJsonLine({ type: "event", event: payload.event, ...payload.details });
		return;
	}
	log(colors.warn(payload.humanMessage));
	if (payload.humanHint) log(colors.dim(`  ${payload.humanHint}`));
}

export async function finalizeDatabaseReuse(
	client: any,
	candidate: DatabaseCandidate,
	kind: "postgres" | "mysql",
	requestedPlan: ResourcePlan | undefined,
	planExplicit: boolean,
): Promise<DatabaseDecision> {
	let plan = candidate.plan;
	let upgraded = false;

	if (planExplicit && requestedPlan) {
		const cmp = compareResourcePlan(requestedPlan, candidate.plan);
		const upgradeCommand = `tarout db upgrade ${candidate.name} --plan ${requestedPlan.toLowerCase()}`;
		if (cmp > 0) {
			if (isJsonMode() || shouldSkipConfirmation()) {
				emitReuseNotice({
					event: "reuse_plan_unchanged",
					humanMessage: `${formatDatabaseKind(kind)} ${candidate.name} stays on ${candidate.plan}; requested ${requestedPlan} was not applied automatically.`,
					humanHint: `Upgrade explicitly with: ${upgradeCommand}`,
					details: {
						resourceType: "database",
						name: candidate.name,
						currentPlan: candidate.plan,
						requestedPlan,
						nextCommand: upgradeCommand,
						hint: "Database plan upgrades are billing-mutating and may require checkout; run the command above to upgrade.",
					},
				});
			} else {
				const ok = await confirmUpgrade(
					`${formatDatabaseKind(kind)} ${candidate.name} is on ${candidate.plan}. Upgrade to ${requestedPlan} before attaching?`,
					true,
					kind === "postgres" ? "upgrade_postgres" : "upgrade_mysql",
				);
				if (ok) {
					await runDatabaseUpgrade(client, kind, candidate.id, requestedPlan);
					plan = requestedPlan;
					upgraded = true;
				}
			}
		} else if (cmp < 0) {
			emitReuseNotice({
				event: "reuse_plan_lower",
				humanMessage: `Requested ${requestedPlan} is lower than existing ${candidate.plan}; attaching at current plan.`,
				details: {
					resourceType: "database",
					name: candidate.name,
					currentPlan: candidate.plan,
					requestedPlan,
				},
			});
		}
	}

	return {
		action: "reuse",
		databaseId: candidate.id,
		plan,
		name: candidate.name,
		upgraded,
	};
}

export async function finalizeStorageReuse(
	client: any,
	candidate: StorageCandidate,
	requestedPlan: ResourcePlan | undefined,
	planExplicit: boolean,
): Promise<StorageDecision> {
	let plan = candidate.plan;
	let upgraded = false;

	if (planExplicit && requestedPlan) {
		const cmp = compareResourcePlan(requestedPlan, candidate.plan);
		const upgradeCommand = `tarout storage upgrade ${candidate.name} --plan ${requestedPlan.toLowerCase()}`;
		if (cmp > 0) {
			const isPaidUpgradeable =
				requestedPlan === "STARTER" ||
				requestedPlan === "STANDARD" ||
				requestedPlan === "PRO";
			if (
				candidate.plan === "FREE" &&
				isPaidUpgradeable &&
				!isJsonMode() &&
				!shouldSkipConfirmation()
			) {
				const ok = await confirmUpgrade(
					`Storage bucket ${candidate.name} is on FREE. Upgrade to ${requestedPlan} before attaching?`,
					true,
					"upgrade_storage",
				);
				if (ok) {
					await runStorageUpgrade(client, candidate.bucketId, requestedPlan);
					plan = requestedPlan;
					upgraded = true;
				}
			} else {
				// Agent/--yes mode, or a paid→paid bump: never silent — tell the
				// caller it stayed put and how to upgrade.
				emitReuseNotice({
					event: "reuse_plan_unchanged",
					humanMessage: `Storage bucket ${candidate.name} stays on ${candidate.plan}; requested ${requestedPlan} was not applied automatically.`,
					humanHint: `Upgrade explicitly with: ${upgradeCommand}`,
					details: {
						resourceType: "storage",
						name: candidate.name,
						currentPlan: candidate.plan,
						requestedPlan,
						nextCommand: upgradeCommand,
						hint: "Storage plan upgrades are billing-mutating; run the command above to upgrade.",
					},
				});
			}
		} else if (cmp < 0) {
			emitReuseNotice({
				event: "reuse_plan_lower",
				humanMessage: `Requested ${requestedPlan} is lower than existing ${candidate.plan}; attaching at current plan.`,
				details: {
					resourceType: "storage",
					name: candidate.name,
					currentPlan: candidate.plan,
					requestedPlan,
				},
			});
		}
	}

	return {
		action: "reuse",
		bucketId: candidate.bucketId,
		plan,
		name: candidate.name,
		upgraded,
	};
}

async function confirmUpgrade(
	message: string,
	defaultValue: boolean,
	field: string,
): Promise<boolean> {
	// Only reached in interactive mode — agent/--yes paths emit a notice
	// instead (see finalizeDatabaseReuse / finalizeStorageReuse).
	return confirm(message, defaultValue, {
		field,
		flag: "--yes (default attaches at current plan; pass --database-plan/--storage-plan with --yes to force an upgrade)",
	});
}

async function runDatabaseUpgrade(
	client: any,
	kind: "postgres" | "mysql",
	id: string,
	targetPlan: ResourcePlan,
): Promise<void> {
	if (targetPlan === "FREE") return; // Server rejects downgrade-to-FREE anyway.
	const label = formatDatabaseKind(kind);
	const _spinner = startSpinner(`Upgrading ${label} to ${targetPlan}...`);
	try {
		if (kind === "postgres") {
			await client.postgres.upgrade.mutate({
				postgresId: id,
				targetPlan,
			});
		} else {
			await client.mysql.upgrade.mutate({
				mysqlId: id,
				targetPlan,
			});
		}
		succeedSpinner(`${label} upgraded to ${targetPlan}.`);
	} catch (err) {
		failSpinner(`Failed to upgrade ${label}.`);
		throw err;
	}
}

async function runStorageUpgrade(
	client: any,
	bucketId: string,
	targetPlan: ResourcePlan,
): Promise<void> {
	if (targetPlan === "FREE") return;
	const _spinner = startSpinner(`Upgrading storage to ${targetPlan}...`);
	try {
		await client.storage.upgrade.mutate({
			bucketId,
			targetPlan,
		});
		succeedSpinner(`Storage upgraded to ${targetPlan}.`);
	} catch (err) {
		failSpinner("Failed to upgrade storage.");
		throw err;
	}
}

async function attachExistingDatabase(
	client: any,
	app: AppSummary,
	kind: "postgres" | "mysql",
	decision: Extract<DatabaseDecision, { action: "reuse" }>,
): Promise<void> {
	const label = formatDatabaseKind(kind);
	const _spinner = startSpinner(`Attaching ${label} to ${app.name}...`);
	try {
		if (kind === "postgres") {
			await client.postgres.attachToApplication.mutate({
				postgresId: decision.databaseId,
				applicationId: app.applicationId,
			});
		} else {
			await client.mysql.attachToApplication.mutate({
				mysqlId: decision.databaseId,
				applicationId: app.applicationId,
			});
		}
		succeedSpinner(`${label} credentials attached.`);
	} catch (err) {
		failSpinner(`Failed to attach ${label} credentials.`);
		throw err;
	}
}

async function attachExistingStorage(
	client: any,
	app: AppSummary,
	decision: Extract<StorageDecision, { action: "reuse" }>,
): Promise<void> {
	const _spinner = startSpinner(`Attaching storage to ${app.name}...`);
	try {
		await client.storage.attachToApplication.mutate({
			bucketId: decision.bucketId,
			applicationId: app.applicationId,
		});
		succeedSpinner("Storage credentials attached.");
	} catch (err) {
		failSpinner("Failed to attach storage credentials.");
		throw err;
	}
}

async function buildDatabaseCreateDecision(
	client: any,
	app: AppSummary,
	kind: "postgres" | "mysql",
	requestedPlan: ResourcePlan | undefined,
): Promise<Extract<DatabaseDecision, { action: "create" }>> {
	const plan = await resolveDatabasePlanOrExit(client, requestedPlan);
	return {
		action: "create",
		plan,
		name: formatResourceName(app.name, formatDatabaseKind(kind)),
	};
}

async function buildStorageCreateDecision(
	client: any,
	app: AppSummary,
	requestedPlan: ResourcePlan | undefined,
): Promise<Extract<StorageDecision, { action: "create" }>> {
	const plan =
		requestedPlan ??
		(await resolveResourcePlan(client, "storage", undefined, "Storage plan:"));
	return {
		action: "create",
		plan,
		name: formatResourceName(app.name, "files", 50),
	};
}

function formatDatabaseCandidateLine(c: DatabaseCandidate): string {
	const parts: string[] = [c.name];
	const badges: string[] = [c.plan];
	if (c.region) badges.push(c.region);
	const ageBadge = describeAge(c.createdAt);
	if (ageBadge) badges.push(ageBadge);
	const status = describeApplicationStatus(c.applicationStatus);
	if (status) badges.push(status);
	if (c.isReadOnly) badges.push("read-only");
	parts.push(`(${badges.join(" · ")})`);
	parts.push(colors.dim(`[${c.id.slice(0, 8)}]`));
	return parts.join(" ");
}

function formatStorageCandidateLine(c: StorageCandidate): string {
	const parts: string[] = [c.name];
	const badges: string[] = [c.plan];
	if (c.region) badges.push(c.region);
	const ageBadge = describeAge(c.createdAt);
	if (ageBadge) badges.push(ageBadge);
	const status = describeApplicationStatus(c.applicationStatus);
	if (status) badges.push(status);
	if (c.isUploadBlocked) badges.push("upload blocked");
	parts.push(`(${badges.join(" · ")})`);
	parts.push(colors.dim(`[${c.bucketId.slice(0, 8)}]`));
	return parts.join(" ");
}

function describeAge(value: string | Date | null | undefined): string | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	const time = date.getTime();
	if (!Number.isFinite(time)) return null;
	const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
	if (days === 0) return "today";
	if (days === 1) return "1d ago";
	if (days < 30) return `${days}d ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

function describeApplicationStatus(
	status: string | null | undefined,
): string | null {
	if (!status) return null;
	const normalized = status.toLowerCase();
	if (normalized === "running" || normalized === "done") return null;
	return normalized;
}

const RESOURCE_PLAN_RANK: Record<ResourcePlan, number> = {
	FREE: 0,
	STARTER: 1,
	STANDARD: 2,
	PRO: 3,
};

function compareResourcePlan(a: ResourcePlan, b: ResourcePlan): number {
	return RESOURCE_PLAN_RANK[a] - RESOURCE_PLAN_RANK[b];
}

function normalizeDatabaseKind(
	value: string | undefined,
): DatabaseKind | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "none" || normalized === "no") return "none";
	if (
		normalized === "postgres" ||
		normalized === "postgresql" ||
		normalized === "pg"
	) {
		return "postgres";
	}
	if (normalized === "mysql") return "mysql";

	throw new InvalidArgumentError(
		'Invalid database choice. Use "none", "postgres", or "mysql".',
	);
}

function normalizeResourcePlan(
	value: string | undefined,
): ResourcePlan | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toUpperCase();
	if (
		normalized === "FREE" ||
		normalized === "STARTER" ||
		normalized === "STANDARD" ||
		normalized === "PRO"
	) {
		return normalized;
	}

	throw new InvalidArgumentError(
		'Invalid resource plan. Use "free", "starter", "standard", or "pro".',
	);
}

function formatResourceName(
	name: string,
	suffix: string,
	maxLength = 80,
): string {
	const value = `${name} ${suffix}`.trim();
	if (value.length <= maxLength) return value;

	const suffixWithSpace = ` ${suffix}`;
	const baseLength = Math.max(1, maxLength - suffixWithSpace.length);
	return `${name.slice(0, baseLength).trim()}${suffixWithSpace}`;
}

function generateResourceSlug(appName: string, suffix: string): string {
	return generateSlug(
		`${appName}-${suffix}-${Date.now().toString(36).slice(-6)}`,
	);
}

async function getApplicationDetails(client: any, applicationId: string) {
	return client.application.one.query({ applicationId });
}

function shouldUseLocalSource(
	app: any,
	context: { explicitApp?: boolean; linkedProject?: boolean },
): boolean {
	if (app?.sourceType === "drop") return true;
	if (!hasConfiguredSource(app)) return true;

	// Explicit app deployments should respect the app's configured source.
	if (context.explicitApp) return false;

	// Linked non-drop projects usually represent dashboard/git deployments.
	if (context.linkedProject) return false;

	return false;
}

async function promptForLocalSourceIfNeeded(app: any): Promise<boolean> {
	if (app?.sourceType === "drop" || !hasConfiguredSource(app)) return true;

	if (shouldSkipConfirmation()) return false;

	const message = `${app.name} already has a ${app.sourceType} source configured.`;
	if (!isJsonMode()) {
		log("");
		log(
			`${colors.bold(app.name)} already has a ${colors.cyan(app.sourceType)} source configured.`,
		);
	}
	return promptOrEmit<boolean>(
		{
			field: "source",
			kind: "confirm",
			question: `${message} Use the current directory as the deployment source instead?`,
			default: false,
			flag: "--source upload",
			context: {
				step: "source_override",
				appName: app.name,
				existingSourceType: app.sourceType,
			},
		},
		() =>
			confirm(
				"Use the current directory as the deployment source instead?",
				false,
			),
	);
}

function hasConfiguredSource(app: any): boolean {
	switch (app?.sourceType) {
		case "drop":
			return Boolean(app.dropSourceObjectName);
		case "github":
			return Boolean(
				(app.owner && app.repository) ||
					app.github?.repository ||
					app.github?.owner,
			);
		case "gitlab":
			return Boolean(app.gitlabRepository || app.gitlab?.gitlabRepository);
		case "bitbucket":
			return Boolean(
				app.bitbucketRepository || app.bitbucket?.bitbucketRepository,
			);
		case "gitea":
			return Boolean(app.giteaRepository || app.gitea?.giteaRepository);
		case "git":
			return Boolean(app.customGitUrl || app.gitUrl);
		case "dockerfileUpload":
			return Boolean(app.dockerfileContent);
		case "dockerhub":
			return Boolean(app.dockerHubImage);
		default:
			return false;
	}
}

export async function uploadCurrentDirectorySource(
	client: any,
	applicationId: string,
	appName: string,
): Promise<void> {
	const archivePath = await createSourceArchive();
	const archiveDir = dirname(archivePath);

	try {
		const { size } = statSync(archivePath);
		const fileName = `${generateSlug(appName)}.zip`;

		const _uploadUrlSpinner = startSpinner("Preparing source upload...");
		const upload = await client.application.getDropUploadUrl.mutate({
			applicationId,
			fileName,
			fileSize: size,
			contentType: DROP_UPLOAD_CONTENT_TYPE,
		});
		succeedSpinner();

		const _uploadSpinner = startSpinner(
			`Uploading source archive (${formatBytes(size)})...`,
		);
		const response = await fetch(upload.uploadUrl, {
			method: "PUT",
			body: createReadStream(archivePath) as any,
			headers: {
				"Content-Length": String(size),
			},
			duplex: "half",
		} as any);

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Upload failed (${response.status}): ${body}`);
		}
		succeedSpinner("Source uploaded!");

		const _completeSpinner = startSpinner("Finalizing source...");
		await client.application.completeDropUpload.mutate({
			applicationId,
			objectName: upload.objectName,
			fileName,
			fileSize: size,
			dropBuildPath: "/",
		});
		succeedSpinner("Source ready for deployment.");
	} finally {
		rmSync(archiveDir, { recursive: true, force: true });
	}
}

async function createSourceArchive(): Promise<string> {
	const tempDir = mkdtempSync(join(tmpdir(), "tarout-source-"));
	const archivePath = join(tempDir, "source.zip");

	const excludes = [
		".git/*",
		".tarout/*",
		".next/*",
		"dist/*",
		"build/*",
		"coverage/*",
		"node_modules/*",
		"*/node_modules/*",
		".env",
		".env.*",
		"*.log",
	];

	const _spinner = startSpinner("Packaging current directory...");
	try {
		await execFileAsync("zip", ["-qry", archivePath, ".", "-x", ...excludes], {
			cwd: process.cwd(),
			maxBuffer: 1024 * 1024,
		});
		succeedSpinner("Source packaged.");
		return archivePath;
	} catch (err) {
		failSpinner("Failed to package source.");
		rmSync(tempDir, { recursive: true, force: true });

		if (
			err instanceof Error &&
			("code" in err ? (err as { code?: string }).code === "ENOENT" : false)
		) {
			throw new InvalidArgumentError(
				"The 'zip' command is required to upload a local directory. Install zip or connect a Git source in the Tarout dashboard.",
			);
		}

		throw err;
	}
}

function generateSlug(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");

	if (/^[a-z][a-z0-9-]*[a-z0-9]$/.test(slug)) return slug;
	return `app-${slug || "tarout-app"}`.replace(/-+$/g, "");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerDeployCommands(program: Command) {
	// Deploy command
	program
		.command("deploy")
		.argument("[app]", "Application ID or name")
		.description("Deploy an application")
		.option("--api-url <url>", "Custom API URL", "https://tarout.sa")
		.option("--plan <plan>", "App hosting plan: free, shared, or dedicated")
		.option(
			"--source <source>",
			"Deployment source: auto, upload, configured, or connect",
		)
		.option("--database <type>", "Provision a database: none, postgres, or mysql")
		.option(
			"--database-plan <plan>",
			"Database plan: free, starter, standard, or pro",
		)
		.option("--storage", "Provision file storage and attach it to the app")
		.option(
			"--storage-plan <plan>",
			"Storage plan: free, starter, standard, or pro",
		)
		.option(
			"--reuse-database <ref>",
			"Reuse an existing database in this project: <id>, <name>, or 'auto' (exactly one match)",
		)
		.option(
			"--reuse-storage <ref>",
			"Reuse an existing storage bucket in this project: <id>, <name>, or 'auto' (exactly one match)",
		)
		.option(
			"--new-app",
			"Create a new app instead of being prompted to reuse an existing one",
		)
		.option(
			"--name <name>",
			"Name for a newly created app (defaults to the directory name)",
		)
		.option("--token <token>", "API token to use for this deployment")
		.option("-r, --region <region>", "Deployment region", DEFAULT_REGION)
		.option("--description <text>", "Description for a newly created app")
		.option(
			"--framework-preset <preset>",
			"Framework preset override (e.g. nextjs, vite, astro)",
		)
		.option(
			"--root-directory <path>",
			"Project root directory inside the source",
		)
		.option("--install-command <cmd>", "Custom install command")
		.option("--build-command <cmd>", "Custom build command")
		.option(
			"--output-directory <path>",
			"Build output directory (static assets)",
		)
		.option("--start-command <cmd>", "Custom start command")
		.option("-w, --wait", "Wait for deployment to complete and stream logs")
		.option("--watch", "Alias for --wait")
		.option(
			"--no-agent-setup",
			"Don't auto-write the agent permission allowlist (CLAUDE.md / .claude/settings.local.json) on first run",
		)
		.action(async (appIdentifier, options: DeployOptions) => {
			try {
				// Onboarding step 0: in agent mode, grant the agent permission to run
				// tarout commands (idempotent) before deploying.
				ensureAgentSetup(process.cwd(), options.agentSetup === false);

				const inspection = inspectCurrentProject();
				printProjectInspection(inspection);

				const profile = await ensureAuthenticatedForDeploy(options);
				await confirmRegion(options.region);

				const client = getApiClient();
				const sourcePreference = await resolveSourcePreference(
					options,
					inspection,
				);
				if (sourcePreference === "connect") {
					await openGitProviderSetup();
					return;
				}
				const target =
					await resolveDeploymentTarget(
						client,
						profile,
						appIdentifier,
						options,
						sourcePreference,
					);
				const { app, createdApp } = target;
				const shouldUploadSource = resolveShouldUploadSource(
					target,
					sourcePreference,
				);

				if (createdApp) {
					await configureOptionalResources(
						client,
						profile,
						app,
						options,
						inspection,
					);
				}

				if (shouldUploadSource) {
					await uploadCurrentDirectorySource(
						client,
						app.applicationId,
						app.name,
					);
				}

				const _deploySpinner = startSpinner(`Deploying ${app.name}...`);

				// Trigger deployment
				const result = await client.application.deployToCloud.mutate({
					applicationId: app.applicationId,
				});

				if (options.wait || options.watch) {
					// Stream logs and wait for completion
					await streamDeploymentWithLogs(
						client,
						result.deploymentId,
						app.name,
						app.applicationId,
					);
					return;
				}

				succeedSpinner("Deployment started!");

				if (isJsonMode()) {
					outputData({
						deploymentId: result.deploymentId,
						status: "deploying",
					});
				} else {
					quietOutput(result.deploymentId);
					log("");
					log(`Deployment ID: ${colors.cyan(result.deploymentId)}`);
					log("");
					log("Deployment is running in the background.");
					log(
						`Check status: ${colors.dim(`tarout deploy:status ${app.applicationId.slice(0, 8)}`)}`,
					);
					log(
						`View logs: ${colors.dim(`tarout deploy:logs ${result.deploymentId.slice(0, 8)}`)}`,
					);
					log("");
				}
			} catch (err) {
				if (isEntitlementError(err)) {
					const message =
						err instanceof Error ? err.message : "Plan upgrade required";

					// Any non-interactive context (JSON, no TTY, or --yes) gets the
					// machine-readable NEEDS_UPGRADE envelope — which now lists BOTH
					// the buy-addon and upgrade-plan options so the agent asks the
					// human which to run rather than deciding. Only a real interactive
					// TTY reaches the inline chooser below.
					if (
						isJsonMode() ||
						isNonInteractiveMode() ||
						shouldSkipConfirmation()
					) {
						await emitNeedsUpgrade(
							getApiClient(),
							err,
							options.plan,
							"tarout deploy",
						);
						exit(ExitCode.PERMISSION_DENIED);
					}

					log("");
					log(colors.warn(message));

					// Free DB/storage slots are 1-per-org and granted only by the free
					// plan, so "buy an addon" is a dead end. Name what's holding the
					// slot and steer to reuse/delete/upgrade before the plan picker.
					const failedKey = extractEntitlementKeyFromError(err);
					if (
						failedKey === "db.free.slots" ||
						failedKey === "storage.free.slots"
					) {
						await explainFreeResourceSlotExhaustion(getApiClient(), failedKey);
					}

					const upgraded = await promptEntitlementRemedy(
						getApiClient(),
						err,
						options.plan,
					);

					if (!upgraded) {
						await emitNeedsUpgrade(
							getApiClient(),
							err,
							options.plan,
							"tarout deploy",
						);
						exit(ExitCode.PERMISSION_DENIED);
					}

					// Don't resume from inside the catch — the deploy may have
					// created partial state (app row, source upload). Re-running
					// `tarout deploy` re-enters the resolver chain safely.
					box("Billing updated", [
						colors.success("Subscription updated."),
						`Run ${colors.cyan("tarout deploy")} again to deploy on the new plan.`,
					]);
					return;
				}
				handleError(err);
			}
		});

	// Deploy status command
	program
		.command("deploy:status")
		.argument("<app>", "Application ID or name")
		.description("Check deployment status")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Fetching status...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				const app = await client.application.one.query({
					applicationId: appSummary.applicationId,
				});

				const cloudStatus = await client.application.getDeploymentStatus.query({
					applicationId: appSummary.applicationId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData({
						applicationId: app.applicationId,
						name: app.name,
						status: app.applicationStatus,
						url:
							formatAppUrl(app.appSubdomain) ??
							formatAppUrl(app.domain?.[0]?.host),
						cloudStatus,
					});
					return;
				}

				log("");
				log(`${colors.bold(app.name)}`);
				log("");
				log(`Status: ${getStatusBadge(app.applicationStatus)}`);

				const appUrl =
					formatAppUrl(app.appSubdomain) ??
					formatAppUrl(app.domain?.[0]?.host);
				if (appUrl) {
					log(`URL: ${colors.cyan(appUrl)}`);
				}

				if (cloudStatus) {
					log(`Provider: ${cloudStatus.provider}`);
					log(`Region: ${cloudStatus.region}`);
					log(`Updated: ${new Date(cloudStatus.updatedAt).toLocaleString()}`);
				}

				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy cancel command
	program
		.command("deploy:cancel")
		.argument("<app>", "Application ID or name")
		.description("Cancel a running deployment")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Cancelling deployment...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				await client.application.cancelDeployment.mutate({
					applicationId: app.applicationId,
				});

				succeedSpinner("Deployment cancelled");

				if (isJsonMode()) {
					outputData({ cancelled: true, applicationId: app.applicationId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy list command
	program
		.command("deploy:list")
		.argument("<app>", "Application ID or name")
		.description("List recent deployments")
		.option("-n, --limit <number>", "Number of deployments to show", "10")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Fetching deployments...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				// Get deployments
				const deployments: DeploymentSummary[] =
					await client.deployment.all.query({
						applicationId: appSummary.applicationId,
					});

				succeedSpinner();

				const limitedDeployments = deployments.slice(
					0,
					Number.parseInt(options.limit, 10),
				);

				if (isJsonMode()) {
					outputData(limitedDeployments);
					return;
				}

				if (limitedDeployments.length === 0) {
					log("");
					log("No deployments found.");
					log("");
					log(
						`Deploy with: ${colors.dim(`tarout deploy ${appSummary.applicationId.slice(0, 8)}`)}`,
					);
					return;
				}

				log("");
				table(
					["ID", "STATUS", "TITLE", "CREATED"],
					limitedDeployments.map((d: any) => [
						colors.cyan(d.deploymentId.slice(0, 8)),
						getStatusBadge(d.status),
						d.title || colors.dim("-"),
						formatDate(d.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${limitedDeployments.length} deployment${limitedDeployments.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy logs command - view logs for a specific deployment
	program
		.command("deploy:logs")
		.argument("<deployment-id>", "Deployment ID")
		.description("View deployment logs")
		.option(
			"-f, --follow",
			"Stream logs in real-time (for running deployments)",
		)
		.option("--no-stream", "Fetch logs via HTTP instead of WebSocket")
		.action(async (deploymentId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Get deployment details
				const _spinner = startSpinner("Fetching deployment...");
				let deployment: any;
				try {
					deployment = await client.deployment.one.query({ deploymentId });
				} catch {
					// Deployment not found
					failSpinner();
					throw new NotFoundError("Deployment", deploymentId);
				}

				succeedSpinner();

				const isRunning = deployment.status === "running";

				// Determine whether to stream or fetch
				const shouldStream =
					options.follow || (isRunning && options.stream !== false);

				if (shouldStream && deployment.logPath) {
					// Stream logs via WebSocket
					log("");
					log(
						colors.dim(
							`Streaming logs for deployment ${colors.cyan(deployment.deploymentId.slice(0, 8))}...`,
						),
					);
					log(colors.dim("Press Ctrl+C to stop"));
					log("");

					const logLines: string[] = [];
					const errors: string[] = [];
					let finalStatus = deployment.status;

					const { cleanup, done } = streamDeploymentLogs(deployment.deploymentId, {
						onData: (line) => {
							logLines.push(line);
							if (isErrorLine(line)) {
								errors.push(line);
							}
							if (!isJsonMode()) {
								printLogLine(line);
							}
						},
						onError: (error) => {
							if (!isJsonMode()) {
								log(colors.error(`WebSocket error: ${error.message}`));
							}
						},
					});

					// Handle Ctrl+C gracefully
					process.on("SIGINT", () => {
						cleanup();
						if (!isJsonMode()) {
							log("");
							log(colors.dim("Log streaming stopped"));
						}
						process.exit(0);
					});

					// Wait for stream to end (deployment complete or error)
					await done;

					// Get final deployment status
					const finalDeployment = await client.deployment.one.query({
						deploymentId,
					});
					finalStatus = finalDeployment.status;

					// Output JSON result if in JSON mode
					if (isJsonMode()) {
						const analysis =
							finalStatus === "error"
								? analyzeDeploymentError(logLines, finalDeployment.errorMessage)
								: undefined;

						outputData({
							deploymentId: deployment.deploymentId,
							status: finalStatus,
							logs: logLines,
							errors: errors.length > 0 ? errors : undefined,
							errorAnalysis: analysis,
							application: deployment.application,
						});
					} else {
						log("");
						log(
							`Final status: ${getStatusBadge(finalStatus)} ${finalStatus === "error" && finalDeployment.errorMessage ? `- ${finalDeployment.errorMessage}` : ""}`,
						);
					}
				} else {
					// Fetch logs via HTTP
					const logsResult = await client.deployment.getDeploymentLogs.query({
						deploymentId,
						offset: 0,
						limit: 5000,
					});

					if (isJsonMode()) {
						const errors = logsResult.lines.filter(isErrorLine);
						const analysis =
							deployment.status === "error"
								? analyzeDeploymentError(
										logsResult.lines,
										deployment.errorMessage,
									)
								: undefined;

						outputData({
							deploymentId: deployment.deploymentId,
							status: deployment.status,
							logs: logsResult.lines,
							totalLines: logsResult.totalLines,
							errors: errors.length > 0 ? errors : undefined,
							errorAnalysis: analysis,
							application: deployment.application,
						});
						return;
					}

					if (logsResult.lines.length === 0) {
						log("");
						log("No logs available for this deployment.");
						return;
					}

					log("");
					log(
						colors.dim(
							`Logs for deployment ${colors.cyan(deployment.deploymentId.slice(0, 8))} (${logsResult.totalLines} lines):`,
						),
					);
					log("");

					for (const line of logsResult.lines) {
						printLogLine(line);
					}

					if (logsResult.hasMore) {
						log("");
						log(
							colors.dim(
								`Showing ${logsResult.lines.length} of ${logsResult.totalLines} lines`,
							),
						);
					}

					log("");
					log(`Status: ${getStatusBadge(deployment.status)}`);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy rollback command - rollback to a previous deployment
	program
		.command("deploy:rollback")
		.argument("<app>", "Application ID or name")
		.description("Rollback to a previous deployment")
		.option("--to <deployment-id>", "Specific deployment ID to rollback to")
		.option("--previous", "Rollback to the immediately previous deployment")
		.option("-w, --wait", "Wait for rollback to complete")
		.action(async (appIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Finding application...");
				const apps: AppSummary[] =
					await client.application.allByOrganization.query();
				const appSummary = findApp(apps, appIdentifier);

				if (!appSummary) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				// Get deployments
				const deployments: DeploymentSummary[] =
					await client.deployment.all.query({
						applicationId: appSummary.applicationId,
					});

				succeedSpinner();

				// Filter to only successful deployments
				const successfulDeployments = deployments.filter(
					(d) => d.status === "done",
				);

				if (successfulDeployments.length === 0) {
					log("");
					log("No successful deployments found to rollback to.");
					return;
				}

				let targetDeploymentId: string;

				if (options.to) {
					// Use specific deployment ID
					const targetDeployment = successfulDeployments.find(
						(d) =>
							d.deploymentId === options.to ||
							d.deploymentId.startsWith(options.to),
					);

					if (!targetDeployment) {
						throw new NotFoundError("Deployment", options.to);
					}

					targetDeploymentId = targetDeployment.deploymentId;
				} else if (options.previous) {
					// Use the second most recent successful deployment (first is current)
					if (successfulDeployments.length < 2) {
						log("");
						log("No previous deployment to rollback to.");
						log("There must be at least 2 successful deployments.");
						return;
					}

					targetDeploymentId = successfulDeployments[1].deploymentId;
				} else {
					// Interactive selection
					log("");
					log(
						`Select a deployment to rollback to for ${colors.cyan(appSummary.name)}:`,
					);
					log("");

					const choices = successfulDeployments
						.slice(0, 10)
						.map((d, index) => ({
							name: `${colors.cyan(d.deploymentId.slice(0, 8))} - ${d.title || "Deployment"} (${formatDate(d.createdAt)})${index === 0 ? colors.dim(" [current]") : ""}`,
							value: d.deploymentId,
						}));

					const { select } = await import("../utils/prompts.js");
					targetDeploymentId = await select(
						"Select deployment:",
						choices,
						{ field: "deployment", flag: "--to" },
					);
				}

				// Confirm rollback
				if (!options.yes) {
					const targetDeployment = successfulDeployments.find(
						(d) => d.deploymentId === targetDeploymentId,
					);

					log("");
					log(`Rolling back ${colors.cyan(appSummary.name)} to:`);
					log(`  Deployment: ${colors.cyan(targetDeploymentId.slice(0, 8))}`);
					log(`  Title: ${targetDeployment?.title || "Deployment"}`);
					log(
						`  Created: ${
							targetDeployment
								? formatDate(targetDeployment.createdAt)
								: colors.dim("unknown")
						}`,
					);
					log("");

					const { confirm } = await import("../utils/prompts.js");
					const confirmed = await confirm(
						"Are you sure you want to rollback?",
						false,
						{
							field: "confirm_rollback",
							flag: "--yes",
							context: {
								deploymentId: targetDeploymentId,
								app: appSummary.name,
							},
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				// Perform rollback
				const _rollbackSpinner = startSpinner("Initiating rollback...");

				const result = await client.deployment.rollback.mutate({
					applicationId: appSummary.applicationId,
					targetDeploymentId,
				});

				if (options.wait) {
					// Stream logs and wait for completion
					await streamDeploymentWithLogs(
						client,
						result.deploymentId,
						appSummary.name,
						appSummary.applicationId,
					);
					return;
				}

				succeedSpinner("Rollback initiated!");

				if (isJsonMode()) {
					outputData({
						deploymentId: result.deploymentId,
						rollbackFrom: targetDeploymentId,
						status: "running",
					});
				} else {
					quietOutput(result.deploymentId);
					log("");
					log(`Deployment ID: ${colors.cyan(result.deploymentId)}`);
					log(`Rolling back to: ${colors.dim(targetDeploymentId.slice(0, 8))}`);
					log("");
					log("Rollback is running in the background.");
					log(
						`Check status: ${colors.dim(`tarout deploy:status ${appSummary.applicationId.slice(0, 8)}`)}`,
					);
					log(
						`View logs: ${colors.dim(`tarout deploy:logs ${result.deploymentId.slice(0, 8)}`)}`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// List deployments filtered by type
	program
		.command("deploy:list-by-type")
		.argument("<app>", "App ID or name")
		.argument("<type>", "Deployment type: git, upload, docker")
		.option("-n, --limit <n>", "Number of deployments", "20")
		.description("List deployments filtered by source type")
		.action(async (appIdentifier, type, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching apps...");
				const apps = await client.application.allByOrganization.query();
				const appList = Array.isArray(apps)
					? apps
					: (apps as any)?.applications || [];
				const app = findApp(appList, appIdentifier);
				if (!app) {
					failSpinner();
					throw new NotFoundError("Application", appIdentifier);
				}
				const _depSpinner = startSpinner("Fetching deployments...");
				const result = await client.deployment.allByType.query({
					applicationId: app.applicationId,
					type,
					limit: Number.parseInt(options.limit || "20"),
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const list = Array.isArray(result)
					? result
					: (result as any)?.deployments || [];
				if (!list.length) {
					log(`\nNo ${type} deployments found.\n`);
					return;
				}
				log("");
				table(
					["ID", "STATUS", "BRANCH", "CREATED"],
					list.map((d: any) => [
						colors.cyan((d.deploymentId || d.id || "").slice(0, 8)),
						d.status === "done"
							? colors.success(d.status)
							: d.status === "error"
								? colors.error(d.status)
								: colors.warn(d.status || "-"),
						d.buildSourceBranch || d.branch || "-",
						d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}

// Register logs command separately
export function registerLogsCommand(program: Command) {
	program
		.command("logs")
		.argument("<app>", "Application ID or name")
		.description("View application logs")
		.option(
			"-l, --level <level>",
			"Log level (ALL, ERROR, WARN, INFO, DEBUG)",
			"ALL",
		)
		.option("-f, --follow", "Stream logs continuously")
		.option("-n, --limit <number>", "Number of logs to show", "100")
		.option("--since <duration>", "Show logs since (e.g., 1h, 30m, 2d)")
		.action(async () => {
			log("");
			log("Application logs are available in the dashboard.");
			log("CLI log streaming is not yet supported for Coolify deployments.");
			log("");
		});
}

// Helper functions
export function findApp(apps: AppSummary[], identifier: string) {
	const lowerIdentifier = identifier.toLowerCase();

	return apps.find(
		(app) =>
			app.applicationId === identifier ||
			app.applicationId.startsWith(identifier) ||
			app.name.toLowerCase() === lowerIdentifier ||
			app.appName?.toLowerCase() === lowerIdentifier,
	);
}

function formatDate(date: Date | string): string {
	const d = new Date(date);
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream deployment logs and wait for completion.
 * Used by `deploy --wait` to show real-time logs.
 */
export async function streamDeploymentWithLogs(
	client: any,
	deploymentId: string,
	appName: string,
	applicationId: string,
): Promise<void> {
	// Get deployment details to get logPath
	stopSpinner();

	let deployment: any;
	try {
		deployment = await client.deployment.one.query({ deploymentId });
	} catch {
		throw new NotFoundError("Deployment", deploymentId);
	}

	const logLines: string[] = [];
	const errors: string[] = [];
	const startTime = Date.now();
	let wsConnected = false;
	let lastStatus = deployment.status;

	// In environments where the WebSocket log stream can't connect (hosted MCP,
	// sandboxes/CI that block raw WS), `logLines` stays empty even though the
	// HTTP status poll works. Backfill the build logs over HTTP at terminal status
	// so the one-shot agent command always carries them (esp. for diagnosing a
	// failed deploy). No-op once any logs were already streamed.
	const backfillLogsIfEmpty = async () => {
		if (logLines.length > 0) return;
		try {
			const res = await client.deployment.getDeploymentLogs.query({
				deploymentId,
				offset: 0,
				limit: 5000,
			});
			if (Array.isArray(res?.lines)) {
				for (const line of res.lines) {
					logLines.push(line);
					if (isErrorLine(line)) errors.push(line);
				}
			}
		} catch {
			// Best-effort: if the HTTP log fetch also fails, emit whatever we have.
		}
	};

	if (!isJsonMode()) {
		log("");
		log(
			`${colors.bold(appName)} - Deployment ${colors.cyan(deploymentId.slice(0, 8))}`,
		);
		log(colors.dim("─".repeat(50)));
		log("");
	}

	// Start streaming logs if logPath is available
	let cleanup: (() => void) | null = null;

	if (deployment.logPath) {
		const stream = streamDeploymentLogs(deployment.deploymentId, {
			onData: (line) => {
				logLines.push(line);
				if (isErrorLine(line)) {
					errors.push(line);
				}
				if (!isJsonMode()) {
					printLogLine(line);
				}
			},
			onOpen: () => {
				wsConnected = true;
			},
			onError: () => {
				// WebSocket errors are not fatal - we'll fall back to polling
				if (!isJsonMode() && wsConnected) {
					log(colors.dim("[WebSocket reconnecting...]"));
				}
			},
		});
		cleanup = stream.cleanup;
	}

	// Poll for deployment status
	const maxWaitMs = 600000; // 10 minutes
	const pollIntervalMs = 3000;

	try {
		while (Date.now() - startTime < maxWaitMs) {
			await sleep(pollIntervalMs);

			// Get updated deployment status
			const updatedDeployment = await client.deployment.one.query({
				deploymentId,
			});
			lastStatus = updatedDeployment.status;

			if (lastStatus === "done") {
				// Give WebSocket a moment to flush remaining logs
				await sleep(500);
				cleanup?.();
				await backfillLogsIfEmpty();

				// Get final application info for URL
				const finalApp = await client.application.one.query({ applicationId });
				const duration = Math.round((Date.now() - startTime) / 1000);

				const deployUrl =
					formatAppUrl(finalApp.appSubdomain) ??
					formatAppUrl(finalApp.domain?.[0]?.host);

				if (isJsonMode()) {
					outputData({
						deploymentId,
						status: "done",
						url: deployUrl,
						duration,
						logs: logLines,
					});
				} else {
					log("");
					log(colors.dim("─".repeat(50)));
					log(colors.success("✓ Deployment successful!"));
					log("");
					log(`URL: ${colors.cyan(deployUrl || "Pending...")}`);
					log(`Duration: ${colors.dim(`${duration}s`)}`);
					log("");
				}
				return;
			}

			if (lastStatus === "error" || lastStatus === "cancelled") {
				cleanup?.();
				await backfillLogsIfEmpty();

				const errorAnalysis = analyzeDeploymentError(
					logLines,
					updatedDeployment.errorMessage,
				);
				const duration = Math.round((Date.now() - startTime) / 1000);

				if (isJsonMode()) {
					const failureCode =
						errorAnalysis.category === "build_script" ||
						errorAnalysis.category === "npm_install" ||
						errorAnalysis.category === "typescript"
							? "BUILD_FAILED"
							: "DEPLOYMENT_FAILED";
					outputError(
						failureCode,
						updatedDeployment.errorMessage || "Deployment failed",
						{
							deploymentId,
							duration,
							logs: logLines,
							errors: errors.length > 0 ? errors : undefined,
							errorAnalysis,
						},
					);
				} else {
					log("");
					log(colors.dim("─".repeat(50)));
					log(colors.error("✗ Deployment failed"));
					log("");

					if (updatedDeployment.errorMessage) {
						log(`Error: ${colors.error(updatedDeployment.errorMessage)}`);
					}

					if (errorAnalysis.category !== "unknown") {
						log("");
						log(colors.bold("Error Analysis:"));
						log(`  Category: ${errorAnalysis.category}`);
						log(`  Type: ${errorAnalysis.type}`);
						log("");
						log(colors.bold("Possible Causes:"));
						for (const cause of errorAnalysis.possibleCauses.slice(0, 3)) {
							log(`  • ${cause}`);
						}
						log("");
						log(colors.bold("Suggested Fixes:"));
						for (const fix of errorAnalysis.suggestedFixes.slice(0, 3)) {
							log(`  • ${fix}`);
						}
					}
					log("");
				}

				// Throw appropriate error for exit code
				if (
					errorAnalysis.category === "build_script" ||
					errorAnalysis.category === "npm_install" ||
					errorAnalysis.category === "typescript" ||
					errorAnalysis.category === "docker_build"
				) {
					throw new BuildFailedError(
						updatedDeployment.errorMessage || "Build failed",
						deploymentId,
						errorAnalysis,
					);
				}
				throw new DeploymentFailedError(
					updatedDeployment.errorMessage || "Deployment failed",
					deploymentId,
					errorAnalysis,
				);
			}
		}

		// Timeout
		cleanup?.();
		await backfillLogsIfEmpty();
		const duration = Math.round((Date.now() - startTime) / 1000);

		if (isJsonMode()) {
			outputError("DEPLOYMENT_TIMEOUT", "Deployment timed out", {
				deploymentId,
				duration,
				logs: logLines,
				errors: errors.length > 0 ? errors : undefined,
			});
		} else {
			log("");
			log(colors.dim("─".repeat(50)));
			log(colors.warn("⚠ Deployment timed out"));
			log("");
			log(
				`The deployment is still running. Check status with: ${colors.dim(`tarout deploy:status ${applicationId.slice(0, 8)}`)}`,
			);
			log("");
		}

		throw new DeploymentTimeoutError(
			"Deployment timed out after 10 minutes",
			deploymentId,
		);
	} finally {
		// Ensure cleanup is called
		cleanup?.();
	}
}

/**
 * Check if a log line contains an error indicator.
 */
function isErrorLine(line: string): boolean {
	const errorPatterns = [
		/error/i,
		/ERR!/i,
		/failed/i,
		/fatal/i,
		/exception/i,
		/ENOENT/i,
		/EACCES/i,
		/EPERM/i,
	];
	return errorPatterns.some((pattern) => pattern.test(line));
}

/**
 * Print a log line with appropriate formatting.
 */
function printLogLine(line: string): void {
	// Detect log level from content
	if (isErrorLine(line)) {
		console.log(colors.error(line));
	} else if (/warn/i.test(line)) {
		console.log(colors.warn(line));
	} else if (/step|stage|building|installing|deploying/i.test(line)) {
		console.log(colors.info(line));
	} else {
		console.log(line);
	}
}
