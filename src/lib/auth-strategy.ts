/**
 * @fileoverview Pure decision logic for how to recover authentication when a
 * command needs a signed-in account but none is present. Kept free of I/O so
 * the policy ("auto-open a browser for agents, offer an arrow menu to humans,
 * fall back to a token on headless hosts") is exhaustively unit-testable.
 * @module lib/auth-strategy
 */

/** The recovery action chosen for a not-yet-authenticated invocation. */
export type AuthStrategy =
	/** Already signed in — proceed, do nothing. */
	| "already-authenticated"
	/** A token was supplied (`--token`/CI) — authenticate with it directly. */
	| "token-auth"
	/** Human at a real terminal — show an arrow-selectable menu whose default
	 *  choice opens the browser. */
	| "browser-menu"
	/** Agent / non-TTY / JSON driver — open the browser immediately (a menu
	 *  can't render without a TTY) and wait on the local callback. */
	| "browser-auto"
	/** No GUI is reachable — ask for an API token instead of a browser. */
	| "token-headless";

/** Observable facts about the current invocation that drive the choice. */
export interface AuthContext {
	/** Whether a usable credential is already stored / present. */
	loggedIn: boolean;
	/** Whether the caller passed an explicit API token to use. */
	hasToken: boolean;
	/** `--json` machine-readable mode. */
	json: boolean;
	/** Non-interactive: `--non-interactive` or a non-TTY stdin (agents, pipes). */
	nonInteractive: boolean;
	/** Whether a browser can plausibly be launched (a GUI is reachable). */
	canLaunchBrowser: boolean;
}

/**
 * Decide how to get the user authenticated. The ordering encodes the product
 * rule the CLI promises: never dead-end on "go run `tarout login` yourself".
 *
 * 1. Already signed in → proceed.
 * 2. Explicit token → use it (CI / `--token`).
 * 3. A browser is reachable → open it. A human at a TTY first gets an arrow
 *    menu (so they can pick token instead); an agent/non-TTY/JSON driver skips
 *    the un-renderable menu and opens the browser straight away.
 * 4. Otherwise (headless, no display) → fall back to an API-token prompt.
 */
export function selectAuthStrategy(ctx: AuthContext): AuthStrategy {
	if (ctx.loggedIn) return "already-authenticated";
	if (ctx.hasToken) return "token-auth";
	if (ctx.canLaunchBrowser) {
		const interactiveHuman = !ctx.json && !ctx.nonInteractive;
		return interactiveHuman ? "browser-menu" : "browser-auto";
	}
	return "token-headless";
}
