/**
 * `.tarout/config.json` — the project's declared deploy contract.
 *
 * Everything Tarout needed to know about a project used to be inferred: which
 * database to provision came from scanning dependencies, what "working" meant
 * came from assuming `/`, and there was no way to say "run migrations before
 * this goes live" at all. Heuristics are a good default and a bad contract —
 * they cannot be reviewed, cannot be diffed, and differ between the laptop that
 * ran `tarout up` and the CI that ran it next.
 *
 * This file is the declaration. It is committed (unlike `auth.json` and
 * `project.json`, which are credentials and machine-local link state), so it
 * travels with the repo and a teammate or an agent gets the same deploy.
 *
 * Precedence is: manifest > what's already on the app > heuristics. Anything the
 * manifest omits keeps working exactly as it does today — an absent file means
 * absent, not empty.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILENAME = "config.json";

export interface ProjectManifest {
	healthCheck?: {
		path?: string;
		expectedStatus?: number;
	};
	/**
	 * Routes that must actually serve for a deploy to be promoted. Declaring one
	 * opts into a hard gate — see the server's post-deploy smoke test.
	 */
	smokePaths?: string[];
	/** One-shot command run in the new container before the deploy is promoted. */
	releaseCommand?: string;
	releaseCommandTimeoutSec?: number;
	build?: {
		installCommand?: string | null;
		buildCommand?: string | null;
		startCommand?: string | null;
		rootDirectory?: string | null;
		outputDirectory?: string | null;
		frameworkPreset?: string | null;
	};
	/**
	 * What this project needs provisioned. Explicit beats guessing from
	 * dependencies — a repo that imports `pg` for a script it never deploys
	 * should not silently get a database.
	 */
	resources?: {
		postgres?: boolean;
		mysql?: boolean;
		storage?: boolean;
	};
	/** Secrets Tarout should generate once and inject if they don't exist. */
	generatedSecrets?: string[];
}

export class ManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManifestError";
	}
}

export function getManifestPath(basePath = process.cwd()): string {
	return join(basePath, ".tarout", MANIFEST_FILENAME);
}

export function hasManifest(basePath = process.cwd()): boolean {
	return existsSync(getManifestPath(basePath));
}

function assertPath(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.startsWith("/")) {
		throw new ManifestError(`${field} must be a path starting with "/"`);
	}
	if (value.length > 512 || /[\r\n]/.test(value)) {
		throw new ManifestError(`${field} is not a usable path`);
	}
	return value;
}

function assertCommand(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new ManifestError(`${field} must be a string`);
	}
	if (value.length > 4000) {
		throw new ManifestError(`${field} is too long (max 4000 characters)`);
	}
	return value;
}

/**
 * Read and validate the manifest.
 *
 * Validation is strict and fails loudly: a malformed manifest means the user
 * declared something and we could not honour it, and silently falling back to
 * heuristics would deploy something other than what the file says. That is the
 * one failure mode a declared contract must not have.
 *
 * Returns null when the file simply does not exist.
 */
export function readProjectManifest(
	basePath = process.cwd(),
): ProjectManifest | null {
	const path = getManifestPath(basePath);
	if (!existsSync(path)) return null;

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err) {
		throw new ManifestError(
			`Could not read .tarout/${MANIFEST_FILENAME}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new ManifestError(
			`.tarout/${MANIFEST_FILENAME} is not valid JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ManifestError(
			`.tarout/${MANIFEST_FILENAME} must contain a JSON object`,
		);
	}

	const input = parsed as Record<string, unknown>;
	const manifest: ProjectManifest = {};

	if (input.healthCheck !== undefined) {
		const hc = input.healthCheck as Record<string, unknown>;
		if (typeof hc !== "object" || hc === null) {
			throw new ManifestError("healthCheck must be an object");
		}
		manifest.healthCheck = {};
		if (hc.path !== undefined) {
			manifest.healthCheck.path = assertPath(hc.path, "healthCheck.path");
		}
		if (hc.expectedStatus !== undefined) {
			const code = hc.expectedStatus;
			if (
				typeof code !== "number" ||
				!Number.isInteger(code) ||
				code < 100 ||
				code > 599
			) {
				throw new ManifestError(
					"healthCheck.expectedStatus must be an HTTP status code",
				);
			}
			manifest.healthCheck.expectedStatus = code;
		}
	}

	if (input.smokePaths !== undefined) {
		if (!Array.isArray(input.smokePaths)) {
			throw new ManifestError("smokePaths must be an array of paths");
		}
		if (input.smokePaths.length > 10) {
			throw new ManifestError("smokePaths allows at most 10 paths");
		}
		manifest.smokePaths = input.smokePaths.map((p, i) =>
			assertPath(p, `smokePaths[${i}]`),
		);
	}

	if (input.releaseCommand !== undefined) {
		manifest.releaseCommand = assertCommand(
			input.releaseCommand,
			"releaseCommand",
		);
	}

	if (input.releaseCommandTimeoutSec !== undefined) {
		const t = input.releaseCommandTimeoutSec;
		if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 900) {
			throw new ManifestError(
				"releaseCommandTimeoutSec must be a whole number of seconds between 1 and 900",
			);
		}
		manifest.releaseCommandTimeoutSec = t;
	}

	if (input.build !== undefined) {
		const build = input.build as Record<string, unknown>;
		if (typeof build !== "object" || build === null) {
			throw new ManifestError("build must be an object");
		}
		manifest.build = {};
		for (const field of [
			"installCommand",
			"buildCommand",
			"startCommand",
			"rootDirectory",
			"outputDirectory",
			"frameworkPreset",
		] as const) {
			if (build[field] === undefined || build[field] === null) continue;
			manifest.build[field] = assertCommand(build[field], `build.${field}`);
		}
	}

	if (input.resources !== undefined) {
		const resources = input.resources as Record<string, unknown>;
		if (typeof resources !== "object" || resources === null) {
			throw new ManifestError("resources must be an object");
		}
		manifest.resources = {};
		for (const field of ["postgres", "mysql", "storage"] as const) {
			if (resources[field] === undefined) continue;
			if (typeof resources[field] !== "boolean") {
				throw new ManifestError(`resources.${field} must be true or false`);
			}
			manifest.resources[field] = resources[field] as boolean;
		}
		if (manifest.resources.postgres && manifest.resources.mysql) {
			throw new ManifestError(
				"resources cannot request both postgres and mysql",
			);
		}
	}

	if (input.generatedSecrets !== undefined) {
		if (!Array.isArray(input.generatedSecrets)) {
			throw new ManifestError("generatedSecrets must be an array of names");
		}
		manifest.generatedSecrets = input.generatedSecrets.map((name, i) => {
			if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
				throw new ManifestError(
					`generatedSecrets[${i}] must be an environment-variable name (A-Z, 0-9, _)`,
				);
			}
			return name;
		});
	}

	return manifest;
}

/**
 * The build-config payload to send to `application.saveBuildConfig`, or null
 * when the manifest declares nothing that lives on the app.
 */
export function manifestBuildConfig(
	manifest: ProjectManifest,
): Record<string, unknown> | null {
	const config: Record<string, unknown> = {};

	if (manifest.healthCheck?.path !== undefined) {
		config.healthCheckPath = manifest.healthCheck.path;
	}
	if (manifest.healthCheck?.expectedStatus !== undefined) {
		config.healthCheckReturnCode = manifest.healthCheck.expectedStatus;
	}
	if (manifest.smokePaths !== undefined) {
		config.smokePaths = manifest.smokePaths;
	}
	if (manifest.releaseCommand !== undefined) {
		config.releaseCommand = manifest.releaseCommand;
	}
	if (manifest.releaseCommandTimeoutSec !== undefined) {
		config.releaseCommandTimeoutSec = manifest.releaseCommandTimeoutSec;
	}
	for (const [key, value] of Object.entries(manifest.build ?? {})) {
		if (value !== undefined && value !== null) config[key] = value;
	}

	return Object.keys(config).length > 0 ? config : null;
}

/**
 * A value for a declared generated secret.
 *
 * 32 bytes of CSPRNG output, base64url so it survives being pasted into a shell,
 * a URL, or a YAML file without quoting. Deliberately not configurable: a
 * manifest that let a project choose its own secret length would grow an option
 * whose only interesting values are "long enough" and "wrong".
 */
export function generateSecretValue(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Which declared secrets don't exist on the app yet.
 *
 * Only ever ADDS. A secret that already exists is left completely alone —
 * rotating `SESSION_SECRET` on every deploy would log out every user of the
 * app, and doing that silently, from a config file, would be indefensible.
 * Removing a name from `generatedSecrets` likewise does not delete anything;
 * the manifest declares what must exist, not what must not.
 */
export function missingGeneratedSecrets(
	manifest: ProjectManifest | null,
	existingKeys: Set<string>,
): string[] {
	const declared = manifest?.generatedSecrets ?? [];
	return declared.filter((key) => !existingKeys.has(key));
}

/**
 * Fold the manifest's declared resources over what the dependency scan guessed.
 *
 * A declaration always wins, including a negative one: `"postgres": false` in a
 * repo that happens to depend on `pg` means the user has told us this project
 * does not want a Tarout database, and guessing over that would provision (and
 * bill for) something they said no to.
 */
export function applyManifestResources<
	T extends { database: string; storage: boolean },
>(inspection: T, manifest: ProjectManifest | null): T {
	const declared = manifest?.resources;
	if (!declared) return inspection;

	const next = { ...inspection };
	if (declared.postgres !== undefined || declared.mysql !== undefined) {
		next.database = declared.postgres
			? "postgres"
			: declared.mysql
				? "mysql"
				: "none";
	}
	if (declared.storage !== undefined) {
		next.storage = declared.storage;
	}
	return next;
}
