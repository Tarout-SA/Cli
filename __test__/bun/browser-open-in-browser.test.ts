import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Mock the `open` npm package so the real one (which spawns a browser via
 * xdg-open) never runs. src/lib/browser.ts resolves `import open from "open"`
 * to node_modules/open/index.js — bun's `mock.module` keys on the resolved
 * path, so mock that ABSOLUTE path, then DYNAMICALLY import the SUT afterward.
 */
const openedUrls: string[] = [];
let openShouldThrow = false;
function setOpenShouldThrow(v: boolean) {
	openShouldThrow = v;
}

const openAbsPath = resolve(process.cwd(), "node_modules/open/index.js");
mock.module(openAbsPath, () => ({
	default: async (url: string) => {
		openedUrls.push(url);
		if (openShouldThrow) throw new Error("no display / open failed");
		return { pid: 1 } as unknown;
	},
}));

const { openInBrowser } = await import("../../src/lib/browser");
const { setGlobalOptions } = await import("../../src/lib/output");

const savedDisplay = process.env.DISPLAY;
const savedWayland = process.env.WAYLAND_DISPLAY;
const savedNoBrowser = process.env.TAROUT_NO_BROWSER;

function setDisplay(present: boolean) {
	if (present) {
		process.env.DISPLAY = ":0";
		delete process.env.WAYLAND_DISPLAY;
	} else {
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
	}
}

beforeEach(() => {
	openedUrls.length = 0;
	setOpenShouldThrow(false);
	setGlobalOptions({ json: false, nonInteractive: false });
	delete process.env.TAROUT_NO_BROWSER;
	setDisplay(true);
});

afterEach(() => {
	if (savedDisplay === undefined) delete process.env.DISPLAY;
	else process.env.DISPLAY = savedDisplay;
	if (savedWayland === undefined) delete process.env.WAYLAND_DISPLAY;
	else process.env.WAYLAND_DISPLAY = savedWayland;
	if (savedNoBrowser === undefined) delete process.env.TAROUT_NO_BROWSER;
	else process.env.TAROUT_NO_BROWSER = savedNoBrowser;
	setGlobalOptions({ json: false, nonInteractive: false });
});

describe("openInBrowser: launches when a GUI is reachable", () => {
	it("opens the URL and reports success (plain mode, display present)", async () => {
		const ok = await openInBrowser("https://tarout.sa/cli-authorize?x=1");
		expect(ok).toBe(true);
		expect(openedUrls).toEqual(["https://tarout.sa/cli-authorize?x=1"]);
	});

	it("opens in JSON mode too — CLI runs on the user's machine", async () => {
		setGlobalOptions({ json: true, nonInteractive: false });
		const ok = await openInBrowser("https://tarout.sa/json-mode");
		expect(ok).toBe(true);
		expect(openedUrls).toEqual(["https://tarout.sa/json-mode"]);
	});

	it("opens in non-interactive (agent) mode when a display is present", async () => {
		setGlobalOptions({ json: false, nonInteractive: true });
		const ok = await openInBrowser("https://tarout.sa/agent");
		expect(ok).toBe(true);
		expect(openedUrls).toEqual(["https://tarout.sa/agent"]);
	});
});

describe("openInBrowser: degrades gracefully without aborting", () => {
	it("does NOT throw when the launch fails — the URL is the fallback", async () => {
		setOpenShouldThrow(true);
		const ok = await openInBrowser("https://tarout.sa/launch-fails");
		expect(ok).toBe(false);
		// open() was still attempted with the URL before failing.
		expect(openedUrls).toEqual(["https://tarout.sa/launch-fails"]);
	});

	it("uses the host platform's GUI policy when display variables are absent", async () => {
		setDisplay(false);
		const ok = await openInBrowser("https://tarout.sa/no-display");
		if (process.platform === "darwin" || process.platform === "win32") {
			expect(ok).toBe(true);
			expect(openedUrls).toEqual(["https://tarout.sa/no-display"]);
		} else {
			expect(ok).toBe(false);
			expect(openedUrls).toEqual([]);
		}
	});

	it("skips the launch when the caller opts out via noOpen", async () => {
		const ok = await openInBrowser("https://tarout.sa/opt-out", {
			noOpen: true,
		});
		expect(ok).toBe(false);
		expect(openedUrls).toEqual([]);
	});

	it("skips the launch when TAROUT_NO_BROWSER suppresses browsers", async () => {
		process.env.TAROUT_NO_BROWSER = "1";
		const ok = await openInBrowser("https://tarout.sa/suppressed");
		expect(ok).toBe(false);
		expect(openedUrls).toEqual([]);
	});
});
