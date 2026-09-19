import type { Command } from "commander";
import { resolveActiveProject } from "../lib/active-project.js";
import { resolveProfileFromCredential } from "../lib/auth-profile.js";
import { startCliBrowserAuth } from "../lib/auth-server.js";
import { normalizeApiUrl } from "../lib/api-url.js";
import { canLaunchBrowser, openInBrowser } from "../lib/browser.js";
import {
	clearConfig,
	deleteProfile,
	getApiUrl,
	getAuthScope,
	getConfig,
	getCurrentProfile,
	getGlobalProfile,
	getToken,
	isLoggedIn,
	listProfiles,
	setCurrentProfile,
	setProfile,
} from "../lib/config.js";
import {
	type CredentialPlacement,
	getProjectCredential,
	isProjectTokenCommitted,
	probeCredentialInGit,
	removeProjectCredential,
	resolveCredentialPlacement,
	setProjectTokenCommitted,
} from "../lib/project-auth.js";
import { persistProfile } from "../lib/credential-store.js";
import type { Profile } from "../lib/config.js";
import { AuthError, CliError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	isNonInteractiveMode,
	isQuietMode,
	log,
	outputData,
	outputJsonLine,
	success,
	warn,
} from "../lib/output.js";
import { stringifyJson } from "../utils/json.js";
import { ExitCode } from "../utils/exit-codes.js";
import { input, promptOrEmit } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

/**
 * Browser auth (`tarout login`, `tarout register`) runs on the user's machine,
 * so we always open the browser and wait on the local callback — even under
 * `--json`/agent mode (the CLI is driven locally, so a browser is reachable).
 * This just adds visibility: in `--json` it emits the auth URL as a structured
 * event so the agent can show it to the user; on a genuinely headless host it
 * points at the API-token fallback. It never refuses.
 */
export function announceAuthUrl(
	authUrl: string,
	callbackPort: number,
	launched: boolean,
): void {
	if (isJsonMode()) {
		outputJsonLine({
			type: "event",
			event: "auth_url",
			authUrl,
			browserLaunched: launched,
			callbackPort,
		});
		return;
	}
	if (!canLaunchBrowser()) {
		log(
			colors.dim(
				"On a remote/headless host? Run `tarout login --token <api-token>` instead — create one at https://tarout.sa/dashboard/agent/keys.",
			),
		);
	}
}

/**
 * `login`, `login --token`, `register`, and `token <key>` all send authentication
 * material (an API key, or the browser flow's one-time PKCE exchange) to whatever
 * `--api-url` names.
 * Warn — never block — when that host is neither a Tarout host nor loopback, so a
 * typo or a malicious `--api-url` can't silently exfiltrate a token. Called from
 * the most shared chokepoint of each path (`authenticateWithToken` for the token
 * flows, just before the browser handshake for the interactive flows) so no
 * credential-transmitting path is missed. Emitted on stderr in every mode
 * (structured under --json) so it never pollutes the stdout envelope.
 */
export function warnIfUntrustedHost(apiUrl: string): void {
	let host: string;
	try {
		host = new URL(apiUrl).hostname.toLowerCase();
	} catch {
		return;
	}
	if (
		host === "tarout.sa" ||
		host.endsWith(".tarout.sa") ||
		host === "localhost" ||
		host === "127.0.0.1"
	) {
		return;
	}
	const message = `Credentials will be sent to a non-Tarout host: ${host}. Only continue if you trust it.`;
	if (isJsonMode()) {
		if (isQuietMode()) return;
		console.error(
			stringifyJson({
				type: "event",
				event: "untrusted_host_warning",
				host,
				message,
			}),
		);
	} else {
		warn(message);
	}
}

/**
 * Sign out of the CURRENT profile only. Best-effort revokes the server-side CLI
 * key first (so it can't outlive logout for its 30-day lifespan), then drops the
 * local credential. A network failure or an older server without the revoke
 * endpoint must never block logout — we warn and still clear local state. Other
 * saved profiles are left untouched; when the current profile was the last one,
 * the whole store is reset (identical to the historical single-profile flow).
 */
/**
 * Sign out of the PROJECT credential only — deletes `.tarout/auth.json` and
 * leaves both the machine-wide profile and the rest of `.tarout` alone.
 *
 * The server-side key is deliberately NOT revoked here: the same key may still
 * be the machine-wide credential or bound to another checkout of the project, so
 * revoking it would sign the user out of directories this command never touched.
 * Use `tarout logout --global` (or the dashboard) to actually kill a key.
 */
export async function performProjectLogout(): Promise<void> {
	const resolved = getProjectCredential();
	if (!resolved) {
		if (isJsonMode()) {
			outputData({
				success: true,
				scope: "project",
				message: "No project credential in this directory",
			});
		} else {
			log("No project credential in this directory.");
		}
		return;
	}

	const removed = removeProjectCredential(resolved.projectDir);
	const fallback = getGlobalProfile();

	if (isJsonMode()) {
		outputData({
			success: true,
			scope: "project",
			message: "Project credential removed",
			removedPath: removed,
			fallsBackTo: fallback
				? { scope: "global", userEmail: fallback.userEmail }
				: null,
		});
		return;
	}

	success(`Removed the project credential for ${resolved.credential.userEmail}`);
	log(colors.dim(`  ${removed}`));
	if (fallback) {
		log(
			`This directory now uses the machine-wide login (${colors.cyan(fallback.userEmail)}).`,
		);
	}
	log(
		colors.dim(
			"The API key itself was not revoked — revoke it in the dashboard if it is no longer needed.",
		),
	);
}

export async function performLogout(
	options: { scope?: "auto" | "project" | "global" } = {},
): Promise<void> {
	const scope = options.scope ?? "auto";

	// A project credential wins over the machine-wide one for every other
	// command, so an unqualified `logout` has to mean "sign this directory out".
	// Doing otherwise would revoke the PROJECT's key (getApiClient() is holding
	// that token) while deleting an unrelated global profile, leaving the
	// directory pointed at a key that no longer works.
	if (scope !== "global" && getProjectCredential()) {
		await performProjectLogout();
		return;
	}

	const globalProfile = getGlobalProfile();
	if (!globalProfile?.token) {
		if (isJsonMode()) {
			outputData({ success: true, scope: "global", message: "Already logged out" });
		} else {
			log("Already logged out.");
		}
		return;
	}

	const profile = globalProfile;
	const currentName = getConfig().currentProfile;

	let revoked = false;
	let revokeFailed = false;
	try {
		// Build the client from the GLOBAL credential explicitly — the shared
		// singleton would revoke whichever key is currently winning, which is not
		// necessarily the one being logged out of.
		const { createCredentialClient } = await import("../lib/auth-profile.js");
		const client = createCredentialClient(
			globalProfile.apiUrl,
			globalProfile.token,
		);
		const result = await client.user.revokeCurrentCliKey.mutate();
		revoked = Boolean(result?.revoked);
	} catch {
		// Best-effort: offline, or a server too old to know the endpoint. Fall
		// through to clearing local state so logout still succeeds locally.
		revokeFailed = true;
	}

	deleteProfile(currentName);
	const remaining = listProfiles();
	// Deleting the active profile silently promotes another saved profile to
	// current — never switch identity without announcing which profile/email is
	// now active. `switchedTo` is null when this was the last profile (a full
	// logout with nothing left to switch to).
	let switchedTo: { profile: string; userEmail?: string } | null = null;
	if (remaining.length === 0) {
		clearConfig();
	} else {
		const nextName = remaining[0] as string;
		setCurrentProfile(nextName);
		const nextProfile = getGlobalProfile();
		switchedTo = { profile: nextName, userEmail: nextProfile?.userEmail };
	}

	if (isJsonMode()) {
		outputData({
			success: true,
			scope: "global",
			message: "Logged out successfully",
			revoked,
			switchedTo,
		});
	} else {
		if (revokeFailed) {
			warn(
				"Could not reach Tarout to revoke this session; cleared local credentials anyway.",
			);
		}
		const from = profile?.userEmail || "Tarout";
		if (switchedTo) {
			success(
				`Logged out from ${from}. Now using profile '${switchedTo.profile}'${switchedTo.userEmail ? ` (${switchedTo.userEmail})` : ""}.`,
			);
		} else {
			success(`Logged out from ${from}`);
		}
	}
}

/**
 * Credential sources minted by a browser sign-in. Those CLI keys expire after
 * 30 days (the platform's `/api/cli/exchange`), so a committed copy signs the
 * whole team out at once. Dashboard keys never expire unless asked to.
 */
const EXPIRING_CREDENTIAL_SOURCES = new Set(["login", "register"]);

/** The "Credential:" line of the account box. */
function credentialLine(
	credentialPath: string | undefined,
	tokenCommitted: boolean | undefined,
): string {
	if (!credentialPath) {
		return `Credential: ${colors.bold("machine-wide CLI profile")}`;
	}
	const note = tokenCommitted
		? "(this project only, committed with the repo)"
		: "(this project only, kept out of git)";
	return `Credential: ${colors.bold(credentialPath)} ${colors.dim(note)}`;
}

/**
 * Say what a teammate who clones the repo gets, and how to change it. `.tarout/`
 * arrives nearly empty in a clone, so the choice is offered where the login
 * happens rather than left for someone to discover.
 */
function logTokenGitHint(tokenCommitted: boolean | undefined): void {
	log(
		colors.dim(
			tokenCommitted
				? "Anyone who clones this repo is signed in as this account. Undo: tarout login --no-commit-token"
				: "Teammates who clone this repo sign in with `tarout login`. To share this login through git instead (private repos only): tarout login --commit-token",
		),
	);
}

/**
 * `--commit-token` is a rule in `.tarout/.gitignore`, so it only means
 * something when the credential lands in a project.
 */
function assertCommitTokenPlacement(
	commitToken: boolean | undefined,
	placement: CredentialPlacement,
): void {
	if (commitToken === undefined || placement.scope === "project") return;
	throw new CliError(
		"--commit-token and --no-commit-token only apply to a project credential (.tarout/auth.json). Run this inside the project, without --global.",
		ExitCode.INVALID_ARGUMENTS,
	);
}

/** Result of applying `--commit-token` / `--no-commit-token`. */
export interface TokenCommitOutcome {
	tokenCommitted: boolean;
	/** False when `.tarout/.gitignore` already said so. */
	changed: boolean;
	/** What the user still has to know or do by hand. */
	warnings: string[];
}

/**
 * Apply `--commit-token` / `--no-commit-token` to a project. Only the ignore
 * rule changes: staging, committing, and un-tracking stay with the user, and
 * git is only asked read-only questions.
 *
 * @param {string} projectDir - The project that owns the credential.
 * @param {boolean} commit - True to commit `auth.json`, false to ignore it.
 * @param {{ userEmail: string; apiUrl: string; source?: string }} credential
 * @returns {TokenCommitOutcome}
 */
export function applyTokenCommitChoice(
	projectDir: string,
	commit: boolean,
	credential: { userEmail: string; apiUrl: string; source?: string },
): TokenCommitOutcome {
	const changed = setProjectTokenCommitted(projectDir, commit);
	const git = probeCredentialInGit(projectDir);
	const keysUrl = new URL("/dashboard/agent/keys", credential.apiUrl).toString();
	const warnings: string[] = [];

	if (commit) {
		if (changed) {
			warnings.push(
				`Anyone who can read this repository can deploy and manage resources as ${credential.userEmail}, and so can anything that builds from it. Only commit the token to a private repo.`,
			);
		}
		if (credential.source && EXPIRING_CREDENTIAL_SOURCES.has(credential.source)) {
			warnings.push(
				`This token came from a browser login and expires after 30 days, which signs everyone out at once. For a shared login, create a key at ${keysUrl} and run: tarout login --token <key> --commit-token`,
			);
		}
		if (git.ignored === true) {
			warnings.push(
				"Git still ignores .tarout/auth.json, most likely because a .gitignore higher up ignores .tarout/. Remove that rule or the token will not be committed.",
			);
		}
	} else if (git.tracked === true) {
		warnings.push(
			`Git is still tracking .tarout/auth.json from an earlier commit. Stop tracking it with \`git rm --cached .tarout/auth.json\`. If it was ever pushed it stays in the git history, so revoke the key at ${keysUrl}.`,
		);
	}

	return { tokenCommitted: commit, changed, warnings };
}

/** Human output for {@link applyTokenCommitChoice}. */
function reportTokenCommitChoice(outcome: TokenCommitOutcome): void {
	if (outcome.tokenCommitted) {
		success(
			outcome.changed
				? "This project's token will now be committed with the repo."
				: "This project's token is already committed with the repo.",
		);
	} else {
		success(
			outcome.changed
				? "This project's token is kept out of git again."
				: "This project's token is already kept out of git.",
		);
	}
	for (const message of outcome.warnings) warn(message);
	if (outcome.changed) {
		log(
			colors.dim(
				outcome.tokenCommitted
					? "Stage it with: git add .tarout/.gitignore .tarout/auth.json"
					: "Stage the change with: git add .tarout/.gitignore",
			),
		);
	}
}

/** Shared success reporting for every authentication path. */
function reportAuthenticated(
	profile: Profile,
	placement: CredentialPlacement,
	credentialPath: string | undefined,
	replacedEmail: string | undefined,
	commitOutcome?: TokenCommitOutcome,
): void {
	const tokenCommitted =
		placement.scope === "project" && placement.projectDir
			? isProjectTokenCommitted(placement.projectDir)
			: undefined;
	if (isJsonMode()) {
		outputData({
			success: true,
			scope: placement.scope,
			credentialPath,
			tokenCommitted,
			...(commitOutcome ? { warnings: commitOutcome.warnings } : {}),
			scopeFallbackReason: placement.fallbackReason,
			replacedProfile: replacedEmail ? { userEmail: replacedEmail } : undefined,
			user: {
				id: profile.userId,
				email: profile.userEmail,
				name: profile.userName,
			},
			organization: {
				id: profile.organizationId,
				name: profile.organizationName,
			},
			project: {
				id: profile.projectId,
				name: profile.projectName,
				slug: profile.projectSlug,
			},
		});
		return;
	}

	log("");
	if (replacedEmail) {
		log(colors.dim(`Replaced previous session for ${replacedEmail}.`));
	}
	if (placement.fallbackReason) {
		warn(placement.fallbackReason);
	}
	success(`Authenticated as ${colors.cyan(profile.userEmail)}`);
	box("Account", [
		`Organization: ${colors.bold(profile.organizationName || "None")}`,
		`Project: ${colors.bold(profile.projectName || "None")}`,
		// Always print the real path: the whole point of project scope is that the
		// user can see, move, and delete the credential.
		credentialLine(credentialPath, tokenCommitted),
	]);
	if (commitOutcome) reportTokenCommitChoice(commitOutcome);
	else if (placement.scope === "project") logTokenGitHint(tokenCommitted);
}

/**
 * Headless authentication with an existing API key. Shared by `tarout login
 * --token` and `tarout token` — both resolve the key to a full profile (org,
 * project) and persist it at the resolved destination, which defaults to this
 * project's `.tarout/auth.json`. A legacy environment hint may still be hydrated
 * for older commands, but it is not an authorization boundary. Unlike browser
 * `login`, this is an explicit re-auth and overwrites any existing session at
 * that destination.
 */
export async function authenticateWithToken(
	apiToken: string,
	apiUrl: string,
	options: {
		scope?: "project" | "global" | "auto";
		cwd?: string;
		source?: string;
		/** `--commit-token` (true) / `--no-commit-token` (false); unset leaves it. */
		commitToken?: boolean;
	} = {},
): Promise<void> {
	const normalizedApiUrl = normalizeApiUrl(apiUrl);
	warnIfUntrustedHost(normalizedApiUrl);

	const placement = resolveCredentialPlacement(
		options.scope ?? "auto",
		options.cwd,
	);
	assertCommitTokenPlacement(options.commitToken, placement);
	const previous = isLoggedIn() ? getCurrentProfile() : null;

	const _spinner = startSpinner("Verifying token...");
	let profile: Awaited<ReturnType<typeof resolveProfileFromCredential>>;
	try {
		profile = await resolveProfileFromCredential({
			token: apiToken,
			apiUrl: normalizedApiUrl,
		});
	} catch (err) {
		failSpinner("Token verification failed");
		throw err;
	}
	succeedSpinner("Token verified!");

	const source = options.source ?? "login --token";
	const credentialPath = persistProfile(profile, placement, source);
	const commitOutcome =
		options.commitToken !== undefined && placement.projectDir
			? applyTokenCommitChoice(placement.projectDir, options.commitToken, {
					...profile,
					source,
				})
			: undefined;

	// A project-scoped key does not replace anything — the machine-wide login is
	// untouched and still applies everywhere else — so the "replaced" notice is
	// only honest for the global path.
	const replacedEmail =
		placement.scope === "global" &&
		previous &&
		previous.userEmail &&
		previous.userEmail !== profile.userEmail
			? previous.userEmail
			: undefined;

	reportAuthenticated(
		profile,
		placement,
		credentialPath,
		replacedEmail,
		commitOutcome,
	);
}

/**
 * Resolve the current credential against Tarout before reporting identity.
 * Saved profile fields are only compatibility fallbacks; they are never proof
 * that the token is still valid or that its project scope has changed.
 */
export async function resolveVerifiedCurrentProfile() {
	const token = getToken();
	if (!token) throw new AuthError();
	return resolveProfileFromCredential({
		token,
		apiUrl: getApiUrl(),
		fallback: getCurrentProfile(),
	});
}

export function buildProjectKeyMetadata(scope: {
	organizationId: string;
	projectId: string;
}) {
	return {
		organizationId: scope.organizationId,
		projectId: scope.projectId,
	};
}

export function registerAuthCommands(program: Command) {
	// Login command
	program
		.command("login")
		.description(
			"Authenticate with Tarout via browser, or headlessly with --token",
		)
		.option("--api-url <url>", "Custom API URL", "https://tarout.sa")
		.option(
			"--token <api-token>",
			"Authenticate with an existing API key instead of opening the browser (for headless/CI). Create one at /dashboard/agent/keys",
		)
		.option(
			"--global",
			"Store the credential machine-wide instead of in this project's .tarout/auth.json",
		)
		.option(
			"--local",
			"Force this project's .tarout/auth.json (the default when run inside a project)",
		)
		.option(
			"--commit-token",
			"Stop git-ignoring this project's .tarout/auth.json, so everyone who clones the repo shares this login (private repos only)",
		)
		.option(
			"--no-commit-token",
			"Git-ignore this project's .tarout/auth.json again (the default)",
		)
		.action(async (options) => {
			try {
				if (options.local && options.global) {
					throw new CliError(
						"Pass either --local or --global, not both.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				const requestedScope = options.global
					? "global"
					: options.local
						? "project"
						: "auto";
				// Unset unless one of the two flags was passed.
				const commitToken: boolean | undefined = options.commitToken;

				// Headless path: a pasted API key skips the browser entirely and is an
				// explicit re-auth, so it overwrites any current session.
				// authenticateWithToken warns about an untrusted --api-url itself.
				if (options.token) {
					await authenticateWithToken(options.token, options.apiUrl, {
						scope: requestedScope,
						commitToken,
					});
					return;
				}

				// "Already logged in" must be judged against the destination this
				// invocation would write to. A machine-wide profile is not a reason to
				// skip signing this project in; that is exactly the case project
				// scope exists for.
				const placement = resolveCredentialPlacement(requestedScope);
				assertCommitTokenPlacement(commitToken, placement);
				if (placement.scope === "project") {
					const existing = getProjectCredential();
					if (existing && existing.projectDir === placement.projectDir) {
						// Committing or un-committing the token needs no new sign-in.
						const commitOutcome =
							commitToken === undefined
								? undefined
								: applyTokenCommitChoice(
										existing.projectDir,
										commitToken,
										existing.credential,
									);
						if (isJsonMode()) {
							outputData({
								alreadyLoggedIn: true,
								scope: "project",
								credentialPath: existing.path,
								tokenCommitted: isProjectTokenCommitted(existing.projectDir),
								...(commitOutcome
									? {
											tokenCommitChanged: commitOutcome.changed,
											warnings: commitOutcome.warnings,
										}
									: {}),
								userEmail: existing.credential.userEmail,
								organizationName: existing.credential.organizationName,
							});
							return;
						}
						log(
							`This project is already signed in as ${colors.cyan(existing.credential.userEmail)}`,
						);
						log(colors.dim(`Credential: ${existing.path}`));
						log("");
						if (commitOutcome) {
							reportTokenCommitChoice(commitOutcome);
							return;
						}
						log(`Run ${colors.dim("tarout logout")} to sign this project out.`);
						return;
					}
				} else if (isLoggedIn()) {
					const profile = getCurrentProfile();
					if (profile) {
						if (isJsonMode()) {
							outputData({
								alreadyLoggedIn: true,
								userEmail: profile.userEmail,
								organizationName: profile.organizationName,
							});
							return;
						}
						log(`Already logged in as ${colors.cyan(profile.userEmail)}`);
						log(`Organization: ${profile.organizationName}`);
						log("");
						log(`Run ${colors.dim("tarout logout")} to sign out first.`);
						return;
					}
				}

				const apiUrl = options.apiUrl;
				warnIfUntrustedHost(apiUrl);
				log("");
				log("Opening browser to authenticate...");

				// Start local server for callback
				const authServer = await startCliBrowserAuth(apiUrl);

				// Open browser to auth page. The launch may silently no-op (SSH/WSL,
				// missing xdg-open) — openInBrowser also prints the URL so the user
				// can complete auth by pasting it, while the callback server keeps
				// waiting below.
				const authUrl = authServer.authUrl;
				const launched = await openInBrowser(authUrl, {
					hint: "If the browser didn't open, visit this URL to authenticate:",
				});
				announceAuthUrl(authUrl, authServer.port, launched);

				const _spinner = startSpinner("Waiting for authentication...");

				try {
					const authData = await authServer.waitForCallback();

					succeedSpinner("CLI authorized.");
					authServer.close();

					// Save profile
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
					};
					const profile = await resolveProfileFromCredential({
						token: authData.token,
						apiUrl,
						fallback: fallbackProfile,
					}).catch(() => fallbackProfile);
					// Browser login lands in the same place a token login would: this
					// project, unless the user asked for machine-wide or the working
					// directory is not a project at all.
					const credentialPath = persistProfile(profile, placement, "login");
					const commitOutcome =
						commitToken !== undefined && placement.projectDir
							? applyTokenCommitChoice(placement.projectDir, commitToken, {
									...profile,
									source: "login",
								})
							: undefined;
					const tokenCommitted = placement.projectDir
						? isProjectTokenCommitted(placement.projectDir)
						: undefined;

					if (isJsonMode()) {
						outputData({
							success: true,
							scope: placement.scope,
							credentialPath,
							tokenCommitted,
							...(commitOutcome ? { warnings: commitOutcome.warnings } : {}),
							scopeFallbackReason: placement.fallbackReason,
							user: {
								id: authData.userId,
								email: authData.userEmail,
								name: authData.userName,
							},
							organization: {
								id: authData.organizationId,
								name: authData.organizationName,
							},
							project: {
								id: profile.projectId,
								name: profile.projectName,
								slug: profile.projectSlug,
							},
						});
					} else {
						log("");
						if (placement.fallbackReason) warn(placement.fallbackReason);
						success(`CLI authorized as ${colors.cyan(authData.userEmail)}`);
						// Login binds the account and organization only, so there may be
						// no project yet — omit the line rather than print "undefined".
						const activeProjectName =
							profile.projectName || authData.projectName;
						box("Account", [
							`Organization: ${colors.bold(authData.organizationName)}`,
							...(activeProjectName
								? [`Project: ${colors.bold(activeProjectName)}`]
								: []),
							credentialLine(credentialPath, tokenCommitted),
						]);
						if (commitOutcome) reportTokenCommitChoice(commitOutcome);
						else if (placement.scope === "project") {
							logTokenGitHint(tokenCommitted);
						}

						// Login binds the account and organization; pick a project now
						// so the next command doesn't stop to ask. Skippable, and a
						// failure here must not undo a login that already succeeded.
						// Interactive only: in a non-TTY the picker would emit
						// needs_input and exit 6, failing a login that worked.
						if (!profile.projectId && !isNonInteractiveMode()) {
							await resolveActiveProject().catch(() => null);
						}
					}
				} catch (err) {
					failSpinner("Authentication failed");
					authServer.close();
					throw err;
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Logout command
	program
		.command("logout")
		.description(
			"Sign out. Removes this project's credential when it has one, otherwise the machine-wide login",
		)
		.option(
			"--global",
			"Sign out of the machine-wide login even when this project has its own credential",
		)
		.option("--local", "Remove only this project's .tarout/auth.json")
		.action(async (options: { global?: boolean; local?: boolean }) => {
			try {
				if (options.global && options.local) {
					throw new CliError(
						"Pass either --global or --local, not both.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				await performLogout({
					scope: options.global ? "global" : options.local ? "project" : "auto",
				});
			} catch (err) {
				handleError(err);
			}
		});

	// Register command
	program
		.command("register")
		.description("Create a new Tarout account via browser")
		.option("--api-url <url>", "Custom API URL", "https://tarout.sa")
		.option(
			"--global",
			"Store the credential machine-wide instead of in this project's .tarout/auth.json",
		)
		.action(async (options) => {
			try {
				const placement = resolveCredentialPlacement(
					options.global ? "global" : "auto",
				);
				if (isLoggedIn()) {
					const profile = getCurrentProfile();
					if (profile) {
						if (isJsonMode()) {
							outputData({
								alreadyLoggedIn: true,
								userEmail: profile.userEmail,
								organizationName: profile.organizationName,
							});
							return;
						}
						log(`Already logged in as ${colors.cyan(profile.userEmail)}`);
						log(`Run ${colors.dim("tarout logout")} to sign out first.`);
						return;
					}
				}

				const apiUrl = options.apiUrl;
				warnIfUntrustedHost(apiUrl);
				log("");
				log("Opening browser to create your account...");

				const authServer = await startCliBrowserAuth(apiUrl, {
					action: "register",
				});
				const authUrl = authServer.authUrl;
				const launched = await openInBrowser(authUrl, {
					hint: "If the browser didn't open, visit this URL to create your account:",
				});
				announceAuthUrl(authUrl, authServer.port, launched);

				const _spinner = startSpinner("Waiting for account creation...");

				try {
					const authData = await authServer.waitForCallback();
					succeedSpinner("Account created and authenticated!");
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
					};
					const profile = await resolveProfileFromCredential({
						token: authData.token,
						apiUrl,
						fallback: fallbackProfile,
					}).catch(() => fallbackProfile);
					const credentialPath = persistProfile(
						profile,
						placement,
						"register",
					);

					if (isJsonMode()) {
						outputData({
							success: true,
							scope: placement.scope,
							credentialPath,
							user: {
								id: authData.userId,
								email: authData.userEmail,
								name: authData.userName,
							},
							organization: {
								id: authData.organizationId,
								name: authData.organizationName,
							},
							project: {
								id: profile.projectId,
								name: profile.projectName,
								slug: profile.projectSlug,
							},
						});
					} else {
						log("");
						success(
							`Account created! Logged in as ${colors.cyan(authData.userEmail)}`,
						);
						// Login binds the account and organization only, so there may be
						// no project yet — omit the line rather than print "undefined".
						const activeProjectName =
							profile.projectName || authData.projectName;
						box("Account", [
							`Organization: ${colors.bold(authData.organizationName)}`,
							...(activeProjectName
								? [`Project: ${colors.bold(activeProjectName)}`]
								: []),
							credentialPath
								? `Credential: ${colors.bold(credentialPath)} ${colors.dim("(this project only)")}`
								: `Credential: ${colors.bold("machine-wide CLI profile")}`,
						]);
					}
				} catch (err) {
					failSpinner("Account creation failed");
					authServer.close();
					throw err;
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Token command — authenticate with an existing API token (useful for CI)
	program
		.command("token")
		.argument("<api-token>", "API token to authenticate with")
		.description("Authenticate using an existing API key (for CI/scripts)")
		.option("--api-url <url>", "Custom API URL", "https://tarout.sa")
		.option(
			"--global",
			"Store the key machine-wide instead of in this project's .tarout/auth.json",
		)
		.option(
			"--local",
			"Force this project's .tarout/auth.json (the default when run inside a project)",
		)
		.option(
			"--commit-token",
			"Stop git-ignoring this project's .tarout/auth.json, so everyone who clones the repo shares this key (private repos only)",
		)
		.option(
			"--no-commit-token",
			"Git-ignore this project's .tarout/auth.json again (the default)",
		)
		.action(async (apiToken, options) => {
			try {
				if (options.local && options.global) {
					throw new CliError(
						"Pass either --local or --global, not both.",
						ExitCode.INVALID_ARGUMENTS,
					);
				}
				await authenticateWithToken(apiToken, options.apiUrl, {
					scope: options.global
						? "global"
						: options.local
							? "project"
							: "auto",
					source: "token",
					commitToken: options.commitToken,
				});
			} catch (err) {
				handleError(err);
			}
		});

	// Generate API token for current user
	program
		.command("token:create")
		.description("Create a new API token for the current account")
		.option("-n, --name <name>", "Token name")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let tokenName = options.name;
				if (!tokenName) {
					tokenName = await promptOrEmit<string>(
						{
							field: "name",
							kind: "input",
							question: "Token name (e.g., ci-deploy):",
							flag: "--name",
							context: { step: "token_create" },
						},
						() => input("Token name (e.g., ci-deploy):"),
					);
				}

				const { getApiClient } = await import("../lib/api.js");
				const client = getApiClient();

				const profile = getCurrentProfile();

				// A key with an empty organizationId authenticates to NOTHING (every
				// later REST/MCP/CLI call → UNAUTHORIZED). When running from a bare
				// TAROUT_TOKEN (no saved profile, so profile is null) resolve the real
				// org from the live credential instead of stamping "".
				let keyOrg = profile?.organizationId;
				let keyProj = profile?.projectId;
				if (!keyOrg || !keyProj) {
					const resolved = await resolveProfileFromCredential({
						apiUrl: getApiUrl(),
						token: getToken() || "",
						fallback: profile,
					});
					keyOrg = resolved.organizationId;
					keyProj = resolved.projectId;
				}
				if (!keyOrg) {
					throw new Error(
						"Could not determine your organization. Run `tarout auth login` first, or pass a token scoped to an organization.",
					);
				}
				if (!keyProj) {
					throw new Error(
						"Could not determine your project. Run `tarout auth login` first, or switch to a project before creating a token.",
					);
				}

				const _spinner = startSpinner("Creating API token...");

				const result = await client.user.createApiKey.mutate({
					name: tokenName,
					metadata: buildProjectKeyMetadata({
						organizationId: keyOrg,
						projectId: keyProj,
					}),
				});

				succeedSpinner("API token created!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");
				log(colors.bold("API Token Created"));
				log("");
				log(`  Name: ${tokenName}`);
				log(`  Token: ${colors.cyan(result.key || result.token || "")}`);
				log("");
				log(colors.warn("Save this token — it will not be shown again."));
				log(
					`  Use with: ${colors.dim("tarout login --token <your-token>")} ${colors.dim("(stores it in this project's .tarout/auth.json)")}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Whoami command
	program
		.command("whoami")
		.description("Show current authenticated user")
		.action(async () => {
			try {
				if (!isLoggedIn()) {
					throw new AuthError();
				}

				const profile = await resolveVerifiedCurrentProfile();
				const authScope = getAuthScope();

				if (isJsonMode()) {
					outputData({
						user: {
							id: profile.userId,
							email: profile.userEmail,
							name: profile.userName,
						},
						organization: {
							id: profile.organizationId,
							name: profile.organizationName,
						},
						project: profile.projectId
							? {
									id: profile.projectId,
									name: profile.projectName,
									slug: profile.projectSlug,
								}
							: null,
						apiUrl: profile.apiUrl,
						scope: authScope.scope,
						credentialPath: authScope.path,
					});
				} else {
					// Lead with the account, then say where that answer came from.
					// With per-project credentials, "who am I" and "why am I that"
					// are one question: the same directory can resolve to a different
					// org than the machine-wide login, and the file path is the only
					// thing that explains it.
					log("");
					log(
						`${colors.bold("Signed in as")} ${colors.cyan(profile.userEmail)} ${colors.dim("·")} ${colors.bold(profile.organizationName)}`,
					);
					if (authScope.scope === "project") {
						log(
							`  ${colors.dim("from")} ${authScope.path ?? ""} ${colors.dim("(this directory only)")}`,
						);
					} else if (authScope.scope === "global") {
						log(
							`  ${colors.dim("from the machine-wide login — every directory without its own .tarout/auth.json")}`,
						);
					} else {
						log(
							`  ${colors.dim("from the TAROUT_TOKEN environment variable (lowest precedence)")}`,
						);
					}
					log("");
					log(`${colors.bold("User")}`);
					log(`  Email: ${colors.cyan(profile.userEmail)}`);
					if (profile.userName) {
						log(`  Name: ${profile.userName}`);
					}
					log("");
					log(`${colors.bold("Organization")}`);
					log(`  Name: ${profile.organizationName}`);
					log(`  ID: ${colors.dim(profile.organizationId)}`);
					log("");
					log(`${colors.bold("Project")}`);
					if (profile.projectId) {
						log(`  Name: ${profile.projectName ?? colors.dim("(unnamed)")}`);
						log(`  ID: ${colors.dim(profile.projectId)}`);
					} else {
						log(`  ${colors.dim("(none — using the org's default project)")}`);
					}
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});
}
