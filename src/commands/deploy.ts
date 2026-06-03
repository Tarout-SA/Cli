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
import { getApiClient, resetApiClient } from "../lib/api.js";
import { startAuthServer } from "../lib/auth-server.js";
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
	log,
	outputData,
	outputError,
	quietOutput,
	shouldSkipConfirmation,
	success,
	table,
} from "../lib/output.js";
import { streamDeploymentLogs } from "../lib/websocket.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
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

interface AppSummary {
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
	outputDirectory?: string;
	plan?: string;
	region?: string;
	rootDirectory?: string;
	source?: string;
	startCommand?: string;
	storage?: boolean;
	storagePlan?: string;
	token?: string;
	wait?: boolean;
	watch?: boolean;
}

type AppPlan = "FREE" | "SHARED" | "DEDICATED";
type ResourcePlan = "FREE" | "STARTER" | "STANDARD" | "PRO";
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
						`Paste a Tarout API token. Generate one at ${apiUrl}/dashboard/account/tokens`,
					flag: "--token",
					sensitive: true,
					context: {
						step: "auth",
						reason: "not_logged_in",
						generateUrl: `${apiUrl}/dashboard/account/tokens`,
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
						`Stored credentials are invalid or expired. Paste a new Tarout API token from ${apiUrl}/dashboard/account/tokens`,
					flag: "--token",
					sensitive: true,
					context: {
						step: "auth",
						reason: "expired_credentials",
						generateUrl: `${apiUrl}/dashboard/account/tokens`,
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
	await open(authUrl);

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

async function resolveDeploymentTarget(
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

	const linkedProject = getProjectConfig();
	if (linkedProject) {
		const app =
			findApp(apps, linkedProject.applicationId) ??
			findApp(apps, linkedProject.name);

		if (app) {
			const details = await getApplicationDetails(client, app.applicationId);
			return {
				app,
				createdApp: false,
				hasConfiguredSource: hasConfiguredSource(details),
				shouldUploadSource: shouldUseLocalSource(details, {
					linkedProject: true,
				}),
			};
		}

		if (!isJsonMode()) {
			log("");
			log(
				colors.warn(
					`Linked application "${linkedProject.name}" was not found in this organization.`,
				),
			);
		}
	}

	if (isJsonMode()) {
		throw new InvalidArgumentError(
			"No linked application. Run 'tarout link', pass an app name, or run without --json to choose interactively.",
		);
	}

	if (apps.length === 0) {
		if (sourcePreference === "configured") {
			throw new InvalidArgumentError(
				'No Tarout app exists to deploy from a configured source. Create or select an app with a configured Git provider first, or rerun with "--source upload".',
			);
		}
		const app = await createAppFromCurrentDirectory(client, profile, options);
		return {
			app,
			createdApp: true,
			hasConfiguredSource: false,
			shouldUploadSource: true,
		};
	}

	const createValue = "__create__";
	const selected = await select<string>("Select an application to deploy:", [
		{
			name: `Create a new app from ${colors.cyan(basename(process.cwd()) || "this directory")}`,
			value: createValue,
		},
		...apps.map((app) => ({
			name: `${app.name} ${colors.dim(`(${app.applicationId.slice(0, 8)})`)}`,
			value: app.applicationId,
		})),
	]);

	if (selected === createValue) {
		if (sourcePreference === "configured") {
			throw new InvalidArgumentError(
				'New apps do not have a configured Git provider source yet. Connect a Git provider first, or rerun with "--source upload".',
			);
		}
		const app = await createAppFromCurrentDirectory(client, profile, options);
		return {
			app,
			createdApp: true,
			hasConfiguredSource: false,
			shouldUploadSource: true,
		};
	}

	const app = findApp(apps, selected);
	if (!app) {
		throw new NotFoundError("Application", selected);
	}

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
		shouldUploadSource: await promptForLocalSourceIfNeeded(details),
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

	if (!providedName && !shouldSkipConfirmation()) {
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

async function resolveAppPlanForCreate(
	client: any,
	options: DeployOptions,
): Promise<AppPlan | undefined> {
	const explicitPlan = normalizeAppPlan(options.plan);
	if (explicitPlan) return explicitPlan;
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
	const { pollCheckoutUntilTerminal } = await import("./billing.js");

	const _changing = startSpinner(`Switching to plan "${planKey}"...`);
	const result = await client.subscription.changePlan.mutate({ planKey });

	if (result?.applied) {
		succeedSpinner("Plan applied.");
		return true;
	}

	if (!result?.paymentUrl || !result?.orderId) {
		// Downgrade staged for period rollover, or applied without
		// payment. Treat as not-confirmed for deploy purposes.
		failSpinner("Plan change did not return a payment URL.");
		return false;
	}

	succeedSpinner("Checkout opened — waiting for payment confirmation.");

	const orderId: string = result.orderId;
	const paymentUrl: string = result.paymentUrl;

	log("");
	log(`Open this URL to complete payment:`);
	log(`  ${colors.cyan(paymentUrl)}`);
	log(`Order ID: ${colors.dim(orderId)}`);

	try {
		await open(paymentUrl);
	} catch {
		// Headless — the URL printed above is the fallback.
	}

	const _pollSpinner = startSpinner("Polling for payment confirmation...");
	const final = await pollCheckoutUntilTerminal(client, orderId, {
		timeoutMs: 600_000,
		intervalMs: 4_000,
	});

	if (final.status === "PAID") {
		succeedSpinner("Payment confirmed.");
		return true;
	}

	failSpinner(
		final.status === "PENDING"
			? "Payment still pending after 10 minutes."
			: `Payment ${final.status.toLowerCase()}.`,
	);

	if (final.failureReason) {
		log(colors.error(final.failureReason));
	}

	log(
		colors.dim(
			`Resume later with: tarout billing wait ${orderId.slice(0, 8)} --timeout 600`,
		),
	);

	return false;
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
	const r = (requested ?? "free").trim().toLowerCase();
	if (!r || r === "free") return "shared";
	if (r === "shared") return "shared";
	if (r === "dedicated" || r === "dedicated_small") return "dedicated_small";
	if (r === "dedicated_medium") return "dedicated_medium";
	if (r === "dedicated_large") return "dedicated_large";
	return r;
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

	const failedKey = extractEntitlementKeyFromError(err);
	const matchingPlan = failedKey
		? upgradeable.find((p) =>
				p.grants?.some((g: any) => g.entitlementKey === failedKey),
			)
		: undefined;
	const recommendedKey: string | undefined = matchingPlan
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

async function configureOptionalResources(
	client: any,
	profile: Profile,
	app: AppSummary,
	options: DeployOptions,
	inspection: ProjectInspection,
): Promise<void> {
	const database = await resolveDatabaseChoice(options, inspection);
	const createdResources: string[] = [];

	if (database !== "none") {
		const plan = await resolveResourcePlan(
			options.databasePlan,
			"Database plan:",
		);
		const databaseName = formatResourceName(
			app.name,
			database === "postgres" ? "Postgres" : "MySQL",
		);
		await createAndAttachDatabase(client, profile, app, {
			kind: database,
			name: databaseName,
			plan,
		});
		createdResources.push(
			`${database === "postgres" ? "Postgres" : "MySQL"} (${plan})`,
		);
	}

	if (await resolveStorageChoice(options, inspection)) {
		const plan = await resolveResourcePlan(options.storagePlan, "Storage plan:");
		const storageName = formatResourceName(app.name, "files", 50);
		await createAndAttachStorage(client, app, {
			name: storageName,
			plan,
		});
		createdResources.push(`Storage (${plan})`);
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

async function resolveResourcePlan(
	value: string | undefined,
	message: string,
): Promise<ResourcePlan> {
	const explicitPlan = normalizeResourcePlan(value);
	if (explicitPlan) return explicitPlan;
	if (isJsonMode() || shouldSkipConfirmation()) return "FREE";

	return select<ResourcePlan>(message, [
		{ name: "Free", value: "FREE" },
		{ name: "Starter", value: "STARTER" },
		{ name: "Standard", value: "STANDARD" },
		{ name: "Pro", value: "PRO" },
	]);
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

	try {
		if (input.kind === "postgres") {
			await client.postgres.create.mutate({
				name: input.name,
				appName,
				dockerImage: "postgres:17",
				organizationId: profile.organizationId,
				environmentId: profile.environmentId,
				plan: input.plan,
				region: DEFAULT_REGION,
			});
		} else {
			await client.mysql.create.mutate({
				name: input.name,
				appName,
				dockerImage: "mysql:9.1",
				organizationId: profile.organizationId,
				environmentId: profile.environmentId,
				plan: input.plan,
				region: DEFAULT_REGION,
			});
		}
		succeedSpinner(`${label} database created.`);
	} catch (err) {
		failSpinner(`Failed to create ${label} database.`);
		throw err;
	}

	const databaseId = await findDatabaseIdByAppName(client, input.kind, appName);
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
		.action(async (appIdentifier, options: DeployOptions) => {
			try {
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

					// JSON / non-TTY / --yes path: preserve the machine-readable
					// contract so external agents and CI don't regress.
					if (isJsonMode() || shouldSkipConfirmation()) {
						outputError("NEEDS_UPGRADE", message, {
							suggestedPlan: inferSuggestedPlan(options.plan),
							failedEntitlementKey: extractEntitlementKeyFromError(err),
							hint: "Run `tarout billing upgrade <plan> --wait` to add slots, then retry `tarout deploy`.",
						});
						exit(ExitCode.PERMISSION_DENIED);
					}

					log("");
					log(colors.warn(message));

					const upgraded = await promptUpgradeFromEntitlementError(
						getApiClient(),
						err,
						options.plan,
					);

					if (!upgraded) {
						outputError("NEEDS_UPGRADE", message, {
							suggestedPlan: inferSuggestedPlan(options.plan),
							failedEntitlementKey: extractEntitlementKeyFromError(err),
							hint: "Run `tarout billing upgrade <plan> --wait`, then retry `tarout deploy`.",
						});
						exit(ExitCode.PERMISSION_DENIED);
					}

					// Don't resume from inside the catch — the deploy may have
					// created partial state (app row, source upload). Re-running
					// `tarout deploy` re-enters the resolver chain safely.
					box("Upgrade complete", [
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
						url: app.appSubdomain
							? `https://${app.appSubdomain}`
							: app.domain?.[0]?.host
								? `https://${app.domain[0].host}`
								: null,
						cloudStatus,
					});
					return;
				}

				log("");
				log(`${colors.bold(app.name)}`);
				log("");
				log(`Status: ${getStatusBadge(app.applicationStatus)}`);

				const appUrl = app.appSubdomain
					? `https://${app.appSubdomain}`
					: app.domain?.[0]?.host
						? `https://${app.domain[0].host}`
						: null;
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
function findApp(apps: AppSummary[], identifier: string) {
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

				// Get final application info for URL
				const finalApp = await client.application.one.query({ applicationId });
				const duration = Math.round((Date.now() - startTime) / 1000);

				const deployUrl = finalApp.appSubdomain
					? `https://${finalApp.appSubdomain}`
					: finalApp.domain?.[0]?.host
						? `https://${finalApp.domain[0].host}`
						: null;

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
