import open from "open";
import { colors, isJsonMode, isNonInteractiveMode, log } from "./output.js";

/**
 * Escape hatch to suppress every real browser launch while leaving the rest of
 * the flow intact (the URL is still printed, structured events still fire, the
 * local callback server still waits). Set `TAROUT_NO_BROWSER=1` for headless
 * safety or to let an automated test observe which auth path was chosen without
 * a window actually popping open.
 */
export function browserLaunchSuppressed(): boolean {
	const v = process.env.TAROUT_NO_BROWSER;
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Whether a browser can plausibly be launched from this process. A non-TTY
 * shell (an agent's Bash tool, a piped session) does NOT imply the browser is
 * unreachable — browser-based flows (OAuth login, hosted checkout) are driven
 * by a local callback server or the hosted page, not stdin. So gate on whether
 * a GUI is actually reachable: on Linux/BSD an X11 or Wayland display must be
 * exported; macOS and Windows always have a window server.
 */
export function canLaunchBrowser(): boolean {
	if (process.platform === "darwin" || process.platform === "win32") {
		return true;
	}
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Launch `url` in the user's default browser for an interactive flow and always
 * print it as a copy/paste fallback, so a silent launch failure (common over
 * SSH/WSL, or when `xdg-open` exits 0 without raising a window) never strands
 * the user. Returns whether the launch was attempted and succeeded. Skips the
 * launch — but still prints the URL — when no GUI is reachable or the caller
 * opted out via `noOpen`. `--json` callers should surface the URL through their
 * structured envelope instead of calling this (it prints nothing in JSON mode).
 */
export async function openInBrowser(
	url: string,
	opts?: { hint?: string; noOpen?: boolean },
): Promise<boolean> {
	if (!isJsonMode()) {
		log(
			colors.dim(opts?.hint ?? "If the browser didn't open, visit this URL:"),
		);
		log(`  ${colors.cyan(url)}`);
	}
	if (opts?.noOpen || browserLaunchSuppressed() || !canLaunchBrowser())
		return false;
	try {
		await open(url);
		return true;
	} catch {
		return false;
	}
}

/**
 * The browser opener injected into the billing engine for hosted-checkout
 * payment URLs. Returns `undefined` (engine skips opening) only when the caller
 * opted out via `--no-open` or no GUI is reachable. Crucially it opens in
 * `--json` mode too: the CLI runs on the user's machine, so opening the payment
 * page locally saves a manual click while the agent still receives `paymentUrl`
 * in the JSON envelope. Open failures are swallowed — the URL is always printed
 * textually as a fallback.
 */
export function paymentBrowserOpener(opts?: {
	noOpen?: boolean;
}): ((url: string) => Promise<void>) | undefined {
	if (opts?.noOpen || !canLaunchBrowser()) return undefined;
	return async (url: string) => {
		try {
			await open(url);
		} catch {
			// A display was reported reachable but the launch still failed (no
			// default browser, xdg-open missing, sandboxed spawn). Don't fail the
			// purchase — but say so, instead of swallowing silently, so the user
			// knows to use the payment link printed by the caller. Stay quiet in
			// `--json` so the structured envelope isn't polluted.
			if (!isJsonMode()) {
				log(
					colors.dim(
						"Couldn't open the browser automatically — use the payment link to complete checkout.",
					),
				);
			}
		}
	};
}

/**
 * Whether to skip the local y/n confirm on a paid plan change and go straight
 * to the hosted checkout. True only for an agent context (non-TTY, non-JSON)
 * that can open a browser, on a positive charge: there the StreamPay payment
 * page is the real consent surface, so a local confirm just halts the agent
 * with `needs_input`. `--json` keeps the structured handoff; net-zero/free
 * changes (no amount due) still confirm — they apply instantly with no payment
 * page to gate them.
 */
export function shouldAutoConfirmPaidCheckout(
	amountDueHalalas: number | undefined,
): boolean {
	const isPaidCheckout =
		typeof amountDueHalalas === "number" && amountDueHalalas > 0;
	return (
		!isJsonMode() &&
		isNonInteractiveMode() &&
		canLaunchBrowser() &&
		isPaidCheckout
	);
}
