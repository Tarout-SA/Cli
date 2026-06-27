import { afterEach, describe, expect, it } from "vitest";
import {
	type AuthContext,
	selectAuthStrategy,
} from "../src/lib/auth-strategy";
import { browserLaunchSuppressed } from "../src/lib/browser";

/**
 * `selectAuthStrategy` is the pure policy behind the CLI's promise to never
 * dead-end a logged-out command on "go run `tarout login` yourself". These
 * cases pin the exact behavior the product requires:
 *   - an agent / non-TTY / JSON driver gets the browser opened FOR it,
 *   - a human at a real terminal gets an arrow menu (whose default opens it),
 *   - a headless host (no GUI) falls back to an API token,
 *   - an explicit token always wins, and an already-signed-in caller proceeds.
 */

const base: AuthContext = {
	loggedIn: false,
	hasToken: false,
	json: false,
	nonInteractive: false,
	canLaunchBrowser: true,
};

describe("selectAuthStrategy", () => {
	it("does nothing when already signed in (even if a token is also present)", () => {
		expect(selectAuthStrategy({ ...base, loggedIn: true })).toBe(
			"already-authenticated",
		);
		expect(
			selectAuthStrategy({ ...base, loggedIn: true, hasToken: true }),
		).toBe("already-authenticated");
	});

	it("uses an explicit token before any browser/menu, in any mode", () => {
		expect(selectAuthStrategy({ ...base, hasToken: true })).toBe("token-auth");
		expect(
			selectAuthStrategy({
				...base,
				hasToken: true,
				json: true,
				nonInteractive: true,
				canLaunchBrowser: false,
			}),
		).toBe("token-auth");
	});

	it("opens the browser automatically for an agent (non-TTY, no menu possible)", () => {
		expect(selectAuthStrategy({ ...base, nonInteractive: true })).toBe(
			"browser-auto",
		);
	});

	it("opens the browser automatically under --json", () => {
		expect(selectAuthStrategy({ ...base, json: true })).toBe("browser-auto");
	});

	it("offers the arrow menu to a human at a real terminal", () => {
		expect(
			selectAuthStrategy({ ...base, json: false, nonInteractive: false }),
		).toBe("browser-menu");
	});

	it("falls back to an API token when no GUI is reachable", () => {
		// headless agent
		expect(
			selectAuthStrategy({
				...base,
				nonInteractive: true,
				canLaunchBrowser: false,
			}),
		).toBe("token-headless");
		// headless human terminal
		expect(
			selectAuthStrategy({ ...base, canLaunchBrowser: false }),
		).toBe("token-headless");
		// headless --json
		expect(
			selectAuthStrategy({
				...base,
				json: true,
				canLaunchBrowser: false,
			}),
		).toBe("token-headless");
	});
});

describe("browserLaunchSuppressed (TAROUT_NO_BROWSER)", () => {
	const saved = process.env.TAROUT_NO_BROWSER;
	afterEach(() => {
		if (saved === undefined) delete process.env.TAROUT_NO_BROWSER;
		else process.env.TAROUT_NO_BROWSER = saved;
	});

	it("is off by default and for falsy-looking values", () => {
		delete process.env.TAROUT_NO_BROWSER;
		expect(browserLaunchSuppressed()).toBe(false);
		for (const v of ["", "0", "false", "False"]) {
			process.env.TAROUT_NO_BROWSER = v;
			expect(browserLaunchSuppressed()).toBe(false);
		}
	});

	it("is on for 1/true/any other value", () => {
		for (const v of ["1", "true", "yes", "anything"]) {
			process.env.TAROUT_NO_BROWSER = v;
			expect(browserLaunchSuppressed()).toBe(true);
		}
	});
});
