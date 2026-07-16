import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceAuthUrl } from "../src/commands/auth";
import { setGlobalOptions } from "../src/lib/output";

/**
 * `tarout login`/`register` no longer refuse in agent/--json mode — they always
 * open the browser and wait on the local callback. `announceAuthUrl` is the
 * visibility hook: it emits a structured `auth_url` event under `--json` (so the
 * agent can show the link), prints nothing extra when a browser is reachable,
 * and points at the API-token fallback only on a genuinely headless host. It
 * must NEVER emit the old AUTH_BOOTSTRAP_REQUIRED refusal.
 */

const savedDisplay = process.env.DISPLAY;
const savedWayland = process.env.WAYLAND_DISPLAY;

function setDisplay(present: boolean) {
	if (present) {
		process.env.DISPLAY = ":0";
		delete process.env.WAYLAND_DISPLAY;
	} else {
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
	}
}

let logs: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	logs = [];
	spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
		if (typeof m === "string") logs.push(m);
	});
	setGlobalOptions({ json: false, nonInteractive: false });
	setDisplay(true);
});

afterEach(() => {
	spy.mockRestore();
	setGlobalOptions({ json: false, nonInteractive: false });
	if (savedDisplay === undefined) delete process.env.DISPLAY;
	else process.env.DISPLAY = savedDisplay;
	if (savedWayland === undefined) delete process.env.WAYLAND_DISPLAY;
	else process.env.WAYLAND_DISPLAY = savedWayland;
});

describe("announceAuthUrl", () => {
	it("emits a structured auth_url event under --json and never refuses", () => {
		setGlobalOptions({ json: true, nonInteractive: true });
		announceAuthUrl("https://tarout.sa/cli-authorize?x=1", 4567, true);

		const events = logs
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean) as Array<Record<string, unknown>>;
		const evt = events.find((e) => e.event === "auth_url");
		expect(evt).toBeTruthy();
		expect(evt?.authUrl).toBe("https://tarout.sa/cli-authorize?x=1");
		expect(evt?.browserLaunched).toBe(true);
		expect(evt?.callbackPort).toBe(4567);
		expect(logs.some((l) => l.includes("AUTH_BOOTSTRAP_REQUIRED"))).toBe(false);
	});

	it("prints nothing extra when a browser is reachable (URL already shown by openInBrowser)", () => {
		setDisplay(true);
		announceAuthUrl("https://tarout.sa/x", 4567, true);
		expect(logs).toEqual([]);
	});

	it("points at the API-token fallback only on a headless host", () => {
		setDisplay(false);
		announceAuthUrl("https://tarout.sa/x", 4567, false);
		if (process.platform === "darwin" || process.platform === "win32") {
			expect(logs).toEqual([]);
		} else {
			expect(logs.join("\n")).toMatch(/tarout login --token/);
		}
	});
});
