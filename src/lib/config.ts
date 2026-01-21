/**
 * @fileoverview Configuration management for the Tarout CLI.
 * Stores user profiles, authentication tokens, and settings in ~/.tarout/config.json
 * @module lib/config
 */

import Conf from "conf";

/**
 * User profile containing authentication and context information.
 * @interface Profile
 */
export interface Profile {
	token: string;
	apiUrl: string;
	organizationId: string;
	organizationName: string;
	environmentId: string;
	environmentName: string;
	userId: string;
	userEmail: string;
	userName?: string;
}

/**
 * Root configuration structure containing all user profiles.
 * @interface Config
 */
export interface Config {
	/** Name of the currently active profile */
	currentProfile: string;
	/** Map of profile names to profile data */
	profiles: Record<string, Profile>;
}

/** Configuration store using the Conf library. Persists to ~/.tarout/config.json */
const config = new Conf<Config>({
	projectName: "tarout",
	defaults: {
		currentProfile: "default",
		profiles: {},
	},
});

/**
 * Gets the entire configuration object.
 * @returns {Config} The full configuration
 */
export function getConfig(): Config {
	return config.store;
}

/**
 * Gets the currently active profile.
 * @returns {Profile | null} The current profile or null if not logged in
 */
export function getCurrentProfile(): Profile | null {
	const cfg = getConfig();
	return cfg.profiles[cfg.currentProfile] || null;
}

/**
 * Saves a profile to the configuration.
 * @param {string} name - The profile name (e.g., "default", "work")
 * @param {Profile} profile - The profile data to save
 */
export function setProfile(name: string, profile: Profile): void {
	config.set(`profiles.${name}`, profile);
}

/**
 * Sets the currently active profile by name.
 * @param {string} name - The profile name to activate
 */
export function setCurrentProfile(name: string): void {
	config.set("currentProfile", name);
}

/**
 * Deletes a profile from the configuration.
 * @param {string} name - The profile name to delete
 */
export function deleteProfile(name: string): void {
	const profiles = config.get("profiles");
	delete profiles[name];
	config.set("profiles", profiles);
}

/**
 * Clears all configuration data, effectively logging out all profiles.
 */
export function clearConfig(): void {
	config.clear();
}

/**
 * Checks if the user is logged in (has a valid token).
 * @returns {boolean} True if logged in, false otherwise
 */
export function isLoggedIn(): boolean {
	const profile = getCurrentProfile();
	return profile !== null && !!profile.token;
}

/**
 * Gets the authentication token for the current profile.
 * @returns {string | null} The token or null if not logged in
 */
export function getToken(): string | null {
	const profile = getCurrentProfile();
	return profile?.token || null;
}

/**
 * Gets the API URL for the current profile.
 * @returns {string} The API URL, defaults to https://tarout.sa
 */
export function getApiUrl(): string {
	const profile = getCurrentProfile();
	return profile?.apiUrl || "https://tarout.sa";
}

/**
 * Updates the current profile with partial data.
 * @param {Partial<Profile>} updates - The fields to update
 */
export function updateProfile(updates: Partial<Profile>): void {
	const cfg = getConfig();
	const currentProfileName = cfg.currentProfile;
	const currentProfile = cfg.profiles[currentProfileName];

	if (currentProfile) {
		config.set(`profiles.${currentProfileName}`, {
			...currentProfile,
			...updates,
		});
	}
}

/**
 * Lists all available profile names.
 * @returns {string[]} Array of profile names
 */
export function listProfiles(): string[] {
	return Object.keys(config.get("profiles"));
}

// ==========================================
// Project Configuration (Local .tarout directory)
// ==========================================

import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Project configuration stored in .tarout/project.json
 * Links a local directory to a remote Tarout application.
 * @interface ProjectConfig
 */
export interface ProjectConfig {
	/** The linked application ID */
	applicationId: string;
	/** The application name (for display purposes) */
	name: string;
	/** The organization ID the app belongs to */
	organizationId: string;
	/** When the project was linked */
	linkedAt: string;
}

/** Default path to the local project config directory */
const PROJECT_CONFIG_DIR = ".tarout";
/** Default path to the local project config file */
const PROJECT_CONFIG_FILE = "project.json";

/**
 * Gets the path to the .tarout directory for a given base path.
 * @param {string} [basePath] - The base directory path (defaults to cwd)
 * @returns {string} The full path to the .tarout directory
 */
export function getProjectConfigDir(basePath?: string): string {
	const base = basePath || process.cwd();
	return join(base, PROJECT_CONFIG_DIR);
}

/**
 * Gets the path to the project.json file for a given base path.
 * @param {string} [basePath] - The base directory path (defaults to cwd)
 * @returns {string} The full path to the project.json file
 */
export function getProjectConfigPath(basePath?: string): string {
	return join(getProjectConfigDir(basePath), PROJECT_CONFIG_FILE);
}

/**
 * Checks if the current directory is linked to a Tarout project.
 * @param {string} [basePath] - The base directory path (defaults to cwd)
 * @returns {boolean} True if a project config exists
 */
export function isProjectLinked(basePath?: string): boolean {
	return existsSync(getProjectConfigPath(basePath));
}

/**
 * Gets the project configuration from the local .tarout directory.
 * @param {string} [basePath] - The base directory path (defaults to cwd)
 * @returns {ProjectConfig | null} The project config or null if not linked
 */
export function getProjectConfig(basePath?: string): ProjectConfig | null {
	const configPath = getProjectConfigPath(basePath);

	if (!existsSync(configPath)) {
		return null;
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content) as ProjectConfig;
	} catch {
		return null;
	}
}

/**
 * Saves the project configuration to the local .tarout directory.
 * Creates the .tarout directory if it doesn't exist.
 * @param {ProjectConfig} config - The project configuration to save
 * @param {string} [basePath] - The base directory path (defaults to cwd)
 */
export function setProjectConfig(
	config: ProjectConfig,
	basePath?: string,
): void {
	const configDir = getProjectConfigDir(basePath);
	const configPath = getProjectConfigPath(basePath);

	// Create .tarout directory if it doesn't exist
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Write the config file
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

	// Create .gitignore in .tarout directory to ignore sensitive files
	const gitignorePath = join(configDir, ".gitignore");
	if (!existsSync(gitignorePath)) {
		writeFileSync(
			gitignorePath,
			"# Ignore local tarout config\n*\n!.gitignore\n",
			"utf-8",
		);
	}
}

/**
 * Removes the project configuration (unlinks the project).
 * @param {string} [basePath] - The base directory path (defaults to cwd)
 * @returns {boolean} True if the config was removed, false if it didn't exist
 */
export function removeProjectConfig(basePath?: string): boolean {
	const configDir = getProjectConfigDir(basePath);

	if (!existsSync(configDir)) {
		return false;
	}

	try {
		rmSync(configDir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
