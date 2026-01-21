/**
 * @fileoverview Process utilities for running local dev/build commands.
 * Handles framework detection, package manager detection, and process spawning.
 * @module lib/process
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Package.json structure (partial)
 */
export interface PackageJson {
	name?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	packageManager?: string;
}

/**
 * Detected framework information
 */
export interface FrameworkInfo {
	name: string;
	devCommand: string;
	buildCommand: string;
	defaultPort?: number;
}

/**
 * Package manager types
 */
export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

/**
 * Reads and parses package.json from the given directory.
 * @param {string} [basePath] - Directory to read from (defaults to cwd)
 * @returns {PackageJson | null} Parsed package.json or null if not found
 */
export function readPackageJson(basePath?: string): PackageJson | null {
	const base = basePath || process.cwd();
	const packagePath = join(base, "package.json");

	if (!existsSync(packagePath)) {
		return null;
	}

	try {
		const content = readFileSync(packagePath, "utf-8");
		return JSON.parse(content) as PackageJson;
	} catch {
		return null;
	}
}

/**
 * Detects the package manager used in the project.
 * Checks for lock files in order of preference: bun, pnpm, yarn, npm.
 * @param {string} [basePath] - Directory to check (defaults to cwd)
 * @returns {PackageManager} The detected package manager
 */
export function detectPackageManager(basePath?: string): PackageManager {
	const base = basePath || process.cwd();

	// Check for lock files
	if (
		existsSync(join(base, "bun.lockb")) ||
		existsSync(join(base, "bun.lock"))
	) {
		return "bun";
	}
	if (existsSync(join(base, "pnpm-lock.yaml"))) {
		return "pnpm";
	}
	if (existsSync(join(base, "yarn.lock"))) {
		return "yarn";
	}
	if (existsSync(join(base, "package-lock.json"))) {
		return "npm";
	}

	// Check packageManager field in package.json
	const pkg = readPackageJson(basePath);
	if (pkg?.packageManager) {
		if (pkg.packageManager.startsWith("bun")) return "bun";
		if (pkg.packageManager.startsWith("pnpm")) return "pnpm";
		if (pkg.packageManager.startsWith("yarn")) return "yarn";
		if (pkg.packageManager.startsWith("npm")) return "npm";
	}

	// Default to npm
	return "npm";
}

/**
 * Framework detection configurations.
 * Maps dependencies to framework info.
 */
const FRAMEWORKS: Array<{
	dependencies: string[];
	info: FrameworkInfo;
}> = [
	{
		dependencies: ["next"],
		info: {
			name: "Next.js",
			devCommand: "next dev",
			buildCommand: "next build",
			defaultPort: 3000,
		},
	},
	{
		dependencies: ["vite"],
		info: {
			name: "Vite",
			devCommand: "vite",
			buildCommand: "vite build",
			defaultPort: 5173,
		},
	},
	{
		dependencies: ["@remix-run/dev"],
		info: {
			name: "Remix",
			devCommand: "remix dev",
			buildCommand: "remix build",
			defaultPort: 3000,
		},
	},
	{
		dependencies: ["nuxt"],
		info: {
			name: "Nuxt",
			devCommand: "nuxt dev",
			buildCommand: "nuxt build",
			defaultPort: 3000,
		},
	},
	{
		dependencies: ["astro"],
		info: {
			name: "Astro",
			devCommand: "astro dev",
			buildCommand: "astro build",
			defaultPort: 4321,
		},
	},
	{
		dependencies: ["@angular/core"],
		info: {
			name: "Angular",
			devCommand: "ng serve",
			buildCommand: "ng build",
			defaultPort: 4200,
		},
	},
	{
		dependencies: ["svelte-kit", "@sveltejs/kit"],
		info: {
			name: "SvelteKit",
			devCommand: "svelte-kit dev",
			buildCommand: "svelte-kit build",
			defaultPort: 5173,
		},
	},
	{
		dependencies: ["svelte"],
		info: {
			name: "Svelte",
			devCommand: "vite",
			buildCommand: "vite build",
			defaultPort: 5173,
		},
	},
	{
		dependencies: ["react-scripts"],
		info: {
			name: "Create React App",
			devCommand: "react-scripts start",
			buildCommand: "react-scripts build",
			defaultPort: 3000,
		},
	},
	{
		dependencies: ["gatsby"],
		info: {
			name: "Gatsby",
			devCommand: "gatsby develop",
			buildCommand: "gatsby build",
			defaultPort: 8000,
		},
	},
	{
		dependencies: ["express"],
		info: {
			name: "Express",
			devCommand: "node",
			buildCommand: "echo 'No build required'",
			defaultPort: 3000,
		},
	},
];

/**
 * Detects the framework used in the project.
 * @param {PackageJson} pkg - The package.json contents
 * @returns {FrameworkInfo | null} Detected framework info or null
 */
export function detectFramework(pkg: PackageJson): FrameworkInfo | null {
	const allDeps = {
		...pkg.dependencies,
		...pkg.devDependencies,
	};

	for (const framework of FRAMEWORKS) {
		for (const dep of framework.dependencies) {
			if (dep in allDeps) {
				return framework.info;
			}
		}
	}

	return null;
}

/**
 * Gets the dev command for the project.
 * Uses package.json scripts if available, otherwise detects from framework.
 * @param {PackageJson} pkg - The package.json contents
 * @param {PackageManager} pm - The package manager to use
 * @returns {string} The dev command to run
 */
export function getDevCommand(pkg: PackageJson, pm: PackageManager): string {
	// Check for common dev script names
	const devScripts = ["dev", "start:dev", "serve", "start"];
	for (const script of devScripts) {
		if (pkg.scripts?.[script]) {
			return `${pm} run ${script}`;
		}
	}

	// Detect framework and use its dev command
	const framework = detectFramework(pkg);
	if (framework) {
		return `${pm === "npm" ? "npx" : pm} ${framework.devCommand}`;
	}

	// Fallback to npm run dev
	return `${pm} run dev`;
}

/**
 * Gets the build command for the project.
 * Uses package.json scripts if available, otherwise detects from framework.
 * @param {PackageJson} pkg - The package.json contents
 * @param {PackageManager} pm - The package manager to use
 * @returns {string} The build command to run
 */
export function getBuildCommand(pkg: PackageJson, pm: PackageManager): string {
	// Check for common build script names
	if (pkg.scripts?.build) {
		return `${pm} run build`;
	}

	// Detect framework and use its build command
	const framework = detectFramework(pkg);
	if (framework) {
		return `${pm === "npm" ? "npx" : pm} ${framework.buildCommand}`;
	}

	// Fallback to npm run build
	return `${pm} run build`;
}

/**
 * Gets the default port for the project based on framework.
 * @param {PackageJson} pkg - The package.json contents
 * @returns {number} The default port
 */
export function getDefaultPort(pkg: PackageJson): number {
	const framework = detectFramework(pkg);
	return framework?.defaultPort || 3000;
}

/**
 * Result from running a command
 */
export interface CommandResult {
	exitCode: number;
	signal: NodeJS.Signals | null;
}

/**
 * Runs a command with the given environment variables.
 * Streams stdout and stderr to the terminal.
 * @param {string} command - The command to run
 * @param {Record<string, string>} env - Environment variables to inject
 * @param {object} options - Additional options
 * @returns {Promise<CommandResult>} The result of the command
 */
export function runCommand(
	command: string,
	env: Record<string, string>,
	options: {
		cwd?: string;
		onStdout?: (data: string) => void;
		onStderr?: (data: string) => void;
	} = {},
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const [cmd, ...args] = parseCommand(command);

		const spawnOptions: SpawnOptions = {
			cwd: options.cwd || process.cwd(),
			env: {
				...process.env,
				...env,
			},
			stdio: ["inherit", "pipe", "pipe"],
			shell: true,
		};

		const child = spawn(cmd, args, spawnOptions);

		child.stdout?.on("data", (data) => {
			const str = data.toString();
			if (options.onStdout) {
				options.onStdout(str);
			} else {
				process.stdout.write(str);
			}
		});

		child.stderr?.on("data", (data) => {
			const str = data.toString();
			if (options.onStderr) {
				options.onStderr(str);
			} else {
				process.stderr.write(str);
			}
		});

		// Handle SIGINT gracefully
		const handleSignal = () => {
			child.kill("SIGINT");
		};
		process.on("SIGINT", handleSignal);
		process.on("SIGTERM", handleSignal);

		child.on("close", (code, signal) => {
			process.off("SIGINT", handleSignal);
			process.off("SIGTERM", handleSignal);
			resolve({
				exitCode: code ?? 1,
				signal: signal,
			});
		});

		child.on("error", (err) => {
			process.off("SIGINT", handleSignal);
			process.off("SIGTERM", handleSignal);
			console.error(`Failed to start process: ${err.message}`);
			resolve({
				exitCode: 1,
				signal: null,
			});
		});
	});
}

/**
 * Parses a command string into command and arguments.
 * Handles quoted strings.
 * @param {string} command - The command string
 * @returns {string[]} Array of [command, ...args]
 */
function parseCommand(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inQuote = false;
	let quoteChar = "";

	for (const char of command) {
		if ((char === '"' || char === "'") && !inQuote) {
			inQuote = true;
			quoteChar = char;
		} else if (char === quoteChar && inQuote) {
			inQuote = false;
			quoteChar = "";
		} else if (char === " " && !inQuote) {
			if (current) {
				parts.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		parts.push(current);
	}

	return parts;
}

/**
 * Converts environment variables from API format to a simple key-value object.
 * @param {Array<{key: string; value: string | null}>} variables - API env vars
 * @returns {Record<string, string>} Environment variables object
 */
export function envVarsToObject(
	variables: Array<{ key: string; value: string | null }>,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const v of variables) {
		if (v.value !== null) {
			result[v.key] = v.value;
		}
	}
	return result;
}
