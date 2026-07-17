import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Mock the `open` npm package so the real one (which spawns a browser via
 * xdg-open) never runs. src/lib/browser.ts resolves `import open from "open"`
 * to node_modules/open/index.js, NOT the repo-root copy — bun's
 * `mock.module` keys on the resolved path, so we must mock that ABSOLUTE path,
 * then DYNAMICALLY import the SUT afterward (static imports hoist above the
 * mock and would bind the real module).
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

const { performBillingChange } = await import(
	"../../src/lib/billing-upgrade"
);
const { canLaunchBrowser, paymentBrowserOpener, shouldAutoConfirmPaidCheckout } =
	await import("../../src/lib/browser");
const { setGlobalOptions } = await import("../../src/lib/output");

/** Reset env + mode to a known baseline between tests. */
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
	// Restore the real host env so we don't leak state to other files.
	if (savedDisplay === undefined) delete process.env.DISPLAY;
	else process.env.DISPLAY = savedDisplay;
	if (savedWayland === undefined) delete process.env.WAYLAND_DISPLAY;
	else process.env.WAYLAND_DISPLAY = savedWayland;
	if (savedNoBrowser === undefined) delete process.env.TAROUT_NO_BROWSER;
	else process.env.TAROUT_NO_BROWSER = savedNoBrowser;
	setGlobalOptions({ json: false, nonInteractive: false });
});

/** Sanity: confirm the `open` mock is actually wired before relying on it. */
describe("mock wiring sanity", () => {
	it("the open mock intercepts paymentBrowserOpener's open() call", async () => {
		const opener = paymentBrowserOpener();
		expect(typeof opener).toBe("function");
		await opener?.("https://wired.test/probe");
		expect(openedUrls).toEqual(["https://wired.test/probe"]);
	});
});

// ---------------------------------------------------------------------------
// A) paymentBrowserOpener returns a usable opener in ALL modes when display
//    present and --no-open not passed.
// ---------------------------------------------------------------------------
describe("A: paymentBrowserOpener available in all modes (display present)", () => {
	it("returns a function in plain mode", () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		expect(typeof paymentBrowserOpener()).toBe("function");
	});

	it("returns a function in JSON mode (the key fix)", () => {
		setGlobalOptions({ json: true, nonInteractive: false });
		expect(typeof paymentBrowserOpener()).toBe("function");
	});

	it("returns a function in non-interactive mode", () => {
		setGlobalOptions({ json: false, nonInteractive: true });
		expect(typeof paymentBrowserOpener()).toBe("function");
	});

	it("returns a function in json + non-interactive mode", () => {
		setGlobalOptions({ json: true, nonInteractive: true });
		expect(typeof paymentBrowserOpener()).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// B) Returns undefined when noOpen:true, and when no display.
// ---------------------------------------------------------------------------
describe("B: paymentBrowserOpener opt-out / no-display", () => {
	it("returns undefined when noOpen:true (display present)", () => {
		expect(paymentBrowserOpener({ noOpen: true })).toBeUndefined();
	});

	it("returns undefined when TAROUT_NO_BROWSER suppresses launches", () => {
		process.env.TAROUT_NO_BROWSER = "1";
		expect(paymentBrowserOpener()).toBeUndefined();
	});

	it("returns undefined when no display (DISPLAY + WAYLAND both unset)", () => {
		setDisplay(false);
		if (process.platform === "darwin" || process.platform === "win32") {
			expect(typeof paymentBrowserOpener()).toBe("function");
		} else {
			expect(paymentBrowserOpener()).toBeUndefined();
		}
	});

	it("returns undefined when noOpen:true AND no display", () => {
		setDisplay(false);
		expect(paymentBrowserOpener({ noOpen: true })).toBeUndefined();
	});

	it("noOpen:false with display present still returns a function", () => {
		expect(typeof paymentBrowserOpener({ noOpen: false })).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// C) Returned opener invokes `open` with the URL; swallows open() rejection.
// ---------------------------------------------------------------------------
describe("C: opener invokes open + swallows errors", () => {
	it("invokes open() with the given URL", async () => {
		const opener = paymentBrowserOpener();
		await opener?.("https://pay.test/abc");
		expect(openedUrls).toEqual(["https://pay.test/abc"]);
	});

	it("resolves (does not reject) when open() throws", async () => {
		setOpenShouldThrow(true);
		const opener = paymentBrowserOpener();
		// If the error were not swallowed this await would reject and fail the test.
		await expect(opener?.("https://pay.test/err")).resolves.toBeUndefined();
		// open() was still attempted with the URL.
		expect(openedUrls).toEqual(["https://pay.test/err"]);
	});
});

// ---------------------------------------------------------------------------
// D) shouldAutoConfirmPaidCheckout truth table.
//    True ONLY when: !json && nonInteractive && canLaunchBrowser && amount>0.
// ---------------------------------------------------------------------------
describe("D: shouldAutoConfirmPaidCheckout truth table", () => {
	it("all-true case → true", () => {
		setGlobalOptions({ json: false, nonInteractive: true });
		setDisplay(true);
		expect(shouldAutoConfirmPaidCheckout(1900)).toBe(true);
	});

	it("json on → false", () => {
		setGlobalOptions({ json: true, nonInteractive: true });
		setDisplay(true);
		expect(shouldAutoConfirmPaidCheckout(1900)).toBe(false);
	});

	it("nonInteractive off → false", () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		setDisplay(true);
		expect(shouldAutoConfirmPaidCheckout(1900)).toBe(false);
	});

	it("no display variables follows the host GUI policy", () => {
		setGlobalOptions({ json: false, nonInteractive: true });
		setDisplay(false);
		expect(shouldAutoConfirmPaidCheckout(1900)).toBe(
			process.platform === "darwin" || process.platform === "win32",
		);
	});

	it("amountDue 0 → false", () => {
		setGlobalOptions({ json: false, nonInteractive: true });
		setDisplay(true);
		expect(shouldAutoConfirmPaidCheckout(0)).toBe(false);
	});

	it("amountDue undefined → false", () => {
		setGlobalOptions({ json: false, nonInteractive: true });
		setDisplay(true);
		expect(shouldAutoConfirmPaidCheckout(undefined)).toBe(false);
	});

	it("amountDue negative → false", () => {
		setGlobalOptions({ json: false, nonInteractive: true });
		setDisplay(true);
		expect(shouldAutoConfirmPaidCheckout(-100)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// E) canLaunchBrowser correctness across supported host policies.
// ---------------------------------------------------------------------------
describe("E: canLaunchBrowser host policy", () => {
	it("DISPLAY set → true", () => {
		process.env.DISPLAY = ":0";
		delete process.env.WAYLAND_DISPLAY;
		expect(canLaunchBrowser()).toBe(true);
	});

	it("WAYLAND_DISPLAY set → true", () => {
		delete process.env.DISPLAY;
		process.env.WAYLAND_DISPLAY = "wayland-0";
		expect(canLaunchBrowser()).toBe(true);
	});

	it("without display variables, macOS/Windows remain browser-capable", () => {
		delete process.env.DISPLAY;
		delete process.env.WAYLAND_DISPLAY;
		expect(canLaunchBrowser()).toBe(
			process.platform === "darwin" || process.platform === "win32",
		);
	});
});

// ---------------------------------------------------------------------------
// F) Engine integration with the REAL paymentBrowserOpener as openBrowser.
//    A paid checkout result must call open(paymentUrl) even in JSON mode,
//    for both wait:true and the no-wait case.
// ---------------------------------------------------------------------------
function paidCheckoutClient() {
	return {
		subscription: {
			changePlan: {
				mutate: async () => ({
					applied: false,
					paymentUrl: "https://pay.test/checkout",
					orderId: "ord_int",
					proratedChargeHalalas: 1900,
				}),
			},
			pollCheckoutStatus: {
				query: async () => ({
					orderId: "ord_int",
					status: "PAID" as const,
					paidAt: null,
					failedAt: null,
					failureReason: null,
				}),
			},
		},
	};
}

describe("F: engine uses real paymentBrowserOpener; open called with paymentUrl", () => {
	it("no-wait path opens paymentUrl (plain mode)", async () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		setDisplay(true);
		const r = await performBillingChange(paidCheckoutClient(), {
			kind: "plan",
			planKey: "shared",
			openBrowser: paymentBrowserOpener(),
		});
		expect(r.status).toBe("payment_required");
		expect(openedUrls).toEqual(["https://pay.test/checkout"]);
	});

	it("no-wait path opens paymentUrl even in JSON mode", async () => {
		setGlobalOptions({ json: true, nonInteractive: false });
		setDisplay(true);
		const r = await performBillingChange(paidCheckoutClient(), {
			kind: "plan",
			planKey: "shared",
			openBrowser: paymentBrowserOpener(),
		});
		expect(r.status).toBe("payment_required");
		expect(openedUrls).toEqual(["https://pay.test/checkout"]);
	});

	it("wait:true path opens paymentUrl (plain mode)", async () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		setDisplay(true);
		const r = await performBillingChange(paidCheckoutClient(), {
			kind: "plan",
			planKey: "shared",
			wait: true,
			openBrowser: paymentBrowserOpener(),
		});
		expect(r.status).toBe("paid");
		expect(openedUrls).toEqual(["https://pay.test/checkout"]);
	});

	it("wait:true path opens paymentUrl even in JSON mode", async () => {
		setGlobalOptions({ json: true, nonInteractive: false });
		setDisplay(true);
		const r = await performBillingChange(paidCheckoutClient(), {
			kind: "plan",
			planKey: "shared",
			wait: true,
			openBrowser: paymentBrowserOpener(),
		});
		expect(r.status).toBe("paid");
		expect(openedUrls).toEqual(["https://pay.test/checkout"]);
	});

	it("no opener injected after explicit opt-out → open is never called", async () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		const opener = paymentBrowserOpener({ noOpen: true });
		expect(opener).toBeUndefined();
		const r = await performBillingChange(paidCheckoutClient(), {
			kind: "plan",
			planKey: "shared",
			openBrowser: opener,
		});
		expect(r.status).toBe("payment_required");
		expect(openedUrls).toEqual([]);
	});

	it("TAROUT_NO_BROWSER preserves the payment handoff without opening", async () => {
		process.env.TAROUT_NO_BROWSER = "1";
		const opener = paymentBrowserOpener();
		expect(opener).toBeUndefined();
		const r = await performBillingChange(paidCheckoutClient(), {
			kind: "plan",
			planKey: "shared",
			openBrowser: opener,
		});
		expect(r.status).toBe("payment_required");
		expect(r.paymentUrl).toBe("https://pay.test/checkout");
		expect(openedUrls).toEqual([]);
	});

	// The user's reported symptom: buying a DB *addon* must open the hosted
	// checkout exactly like a plan upgrade does.
	it("addon purchase opens the checkout URL (no-wait, plain mode)", async () => {
		setGlobalOptions({ json: false, nonInteractive: false });
		setDisplay(true);
		const client = {
			subscription: {
				purchaseAddons: {
					mutate: async () => ({
						applied: false,
						paymentUrl: "https://pay.test/addon",
						orderId: "ord_addon",
						proratedChargeHalalas: 2900,
					}),
				},
			},
		};
		const r = await performBillingChange(client, {
			kind: "addon",
			addonKey: "db.starter",
			quantity: 1,
			openBrowser: paymentBrowserOpener(),
		});
		expect(r.status).toBe("payment_required");
		expect(r.kind).toBe("addon");
		expect(openedUrls).toEqual(["https://pay.test/addon"]);
	});
});
