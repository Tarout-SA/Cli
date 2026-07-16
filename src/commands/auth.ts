import type { Command } from "commander";
import { resolveProfileFromCredential } from "../lib/auth-profile.js";
import { startAuthServer } from "../lib/auth-server.js";
import { canLaunchBrowser, openInBrowser } from "../lib/browser.js";
import {
	clearConfig,
	getApiUrl,
	getCurrentProfile,
	getToken,
	isLoggedIn,
	setCurrentProfile,
	setProfile,
} from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	outputJsonLine,
	success,
} from "../lib/output.js";
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
 * Headless authentication with an existing API key. Shared by `tarout login
 * --token` and `tarout token` — both resolve the key to a full profile (org,
 * project) and persist it as the `default` profile. A legacy environment hint
 * may still be hydrated for older commands, but it is not an authorization
 * boundary. Unlike browser
 * `login`, this is an explicit re-auth and overwrites any existing session.
 */
export async function authenticateWithToken(
	apiToken: string,
	apiUrl: string,
): Promise<void> {
	const previous = isLoggedIn() ? getCurrentProfile() : null;

	const _spinner = startSpinner("Verifying token...");
	let profile: Awaited<ReturnType<typeof resolveProfileFromCredential>>;
	try {
		profile = await resolveProfileFromCredential({ token: apiToken, apiUrl });
	} catch (err) {
		failSpinner("Token verification failed");
		throw err;
	}
	succeedSpinner("Token verified!");

	setProfile("default", profile);
	setCurrentProfile("default");

	const replacedEmail =
		previous && previous.userEmail && previous.userEmail !== profile.userEmail
			? previous.userEmail
			: undefined;

	if (isJsonMode()) {
		outputData({
			success: true,
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
	success(`Authenticated as ${colors.cyan(profile.userEmail)}`);
	box("Account", [
		`Organization: ${colors.bold(profile.organizationName || "None")}`,
		`Project: ${colors.bold(profile.projectName || "None")}`,
	]);
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
		.action(async (options) => {
			try {
				// Headless path: a pasted API key skips the browser entirely and is an
				// explicit re-auth, so it overwrites any current session.
				if (options.token) {
					await authenticateWithToken(options.token, options.apiUrl);
					return;
				}

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
						log(`Organization: ${profile.organizationName}`);
						log("");
						log(`Run ${colors.dim("tarout logout")} to sign out first.`);
						return;
					}
				}

				const apiUrl = options.apiUrl;
				log("");
				log("Opening browser to authenticate...");

				// Start local server for callback
				const authServer = await startAuthServer();
				const callbackUrl = `http://localhost:${authServer.port}/callback?state=${encodeURIComponent(authServer.state)}`;

				// Open browser to auth page. The launch may silently no-op (SSH/WSL,
				// missing xdg-open) — openInBrowser also prints the URL so the user
				// can complete auth by pasting it, while the callback server keeps
				// waiting below.
				const authUrl = `${apiUrl}/cli-authorize?callback=${encodeURIComponent(callbackUrl)}`;
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
						environmentId: authData.environmentId || "",
						environmentName: authData.environmentName || "production",
					};
					const profile = await resolveProfileFromCredential({
						token: authData.token,
						apiUrl,
						fallback: fallbackProfile,
					}).catch(() => fallbackProfile);
					setProfile("default", profile);
					setCurrentProfile("default");

					if (isJsonMode()) {
						outputData({
							success: true,
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
						success(`CLI authorized as ${colors.cyan(authData.userEmail)}`);
						box("Account", [
							`Organization: ${colors.bold(authData.organizationName)}`,
							`Project: ${colors.bold(profile.projectName || authData.projectName)}`,
						]);
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
		.description("Sign out and clear stored credentials")
		.action(async () => {
			try {
				if (!isLoggedIn()) {
					if (isJsonMode()) {
						outputData({ success: true, message: "Already logged out" });
					} else {
						log("Already logged out.");
					}
					return;
				}

				const profile = getCurrentProfile();
				clearConfig();

				if (isJsonMode()) {
					outputData({ success: true, message: "Logged out successfully" });
				} else {
					success(`Logged out from ${profile?.userEmail || "Tarout"}`);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Register command
	program
		.command("register")
		.description("Create a new Tarout account via browser")
		.option("--api-url <url>", "Custom API URL", "https://tarout.sa")
		.action(async (options) => {
			try {
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
				log("");
				log("Opening browser to create your account...");

				const authServer = await startAuthServer();
				const callbackUrl = `http://localhost:${authServer.port}/callback?state=${encodeURIComponent(authServer.state)}`;
				const authUrl = `${apiUrl}/cli-authorize?action=register&callback=${encodeURIComponent(callbackUrl)}`;
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
						environmentId: authData.environmentId || "",
						environmentName: authData.environmentName || "production",
					};
					const profile = await resolveProfileFromCredential({
						token: authData.token,
						apiUrl,
						fallback: fallbackProfile,
					}).catch(() => fallbackProfile);
					setProfile("default", profile);
					setCurrentProfile("default");

					if (isJsonMode()) {
						outputData({
							success: true,
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
						box("Account", [
							`Organization: ${colors.bold(authData.organizationName)}`,
							`Project: ${colors.bold(profile.projectName || authData.projectName)}`,
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
		.action(async (apiToken, options) => {
			try {
				await authenticateWithToken(apiToken, options.apiUrl);
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
					`  Use with: ${colors.dim("tarout token <your-token>")} or set ${colors.dim("TAROUT_TOKEN")} env var`,
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
						project: {
							id: profile.projectId,
							name: profile.projectName,
							slug: profile.projectSlug,
						},
						apiUrl: profile.apiUrl,
					});
				} else {
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
					log(`  Name: ${profile.projectName || "None"}`);
					log(`  ID: ${colors.dim(profile.projectId || "None")}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});
}
