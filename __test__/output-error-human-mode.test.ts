import { afterEach, describe, expect, it, vi } from "vitest";
import { outputError, setGlobalOptions } from "../src/lib/output.js";

// Production 2026-09-23: `tarout up --yes` on a Free plan with no free slot
// ended on "Creating application..." with exit 5 and no reason, because
// outputError only ever printed in --json mode.
describe("outputError in human mode", () => {
	afterEach(() => {
		setGlobalOptions({ json: false });
		vi.restoreAllMocks();
	});

	it("prints the reason and every option to stderr", () => {
		setGlobalOptions({ json: false });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		outputError("NEEDS_UPGRADE", "Plan limit reached for app.free.slots: 1/1. Upgrade to add more.", {
			options: [
				{ action: "upgrade_plan", label: "Upgrade to Starter", command: "tarout billing upgrade shared --wait" },
				{ action: "reuse_app", label: 'Reuse "m-001"', command: "tarout up --app abc" },
			],
		});
		const text = err.mock.calls.map((c) => String(c[0])).join("\n");
		expect(text).toContain("Plan limit reached for app.free.slots: 1/1");
		expect(text).toContain("tarout billing upgrade shared --wait");
		expect(text).toContain("tarout up --app abc");
		expect(out).not.toHaveBeenCalled();
	});

	it("falls back to nextCommand, and stays a single JSON envelope in --json mode", () => {
		setGlobalOptions({ json: false });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		outputError("DOMAIN_VERIFY_TIMEOUT", "Domain a.example did not verify within 60s", { nextCommand: "tarout domains verify a.example" });
		expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("tarout domains verify a.example");

		setGlobalOptions({ json: true });
		err.mockClear();
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		outputError("NEEDS_UPGRADE", "x", { options: [] });
		expect(err).not.toHaveBeenCalled();
		expect(out).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ success: false, error: { code: "NEEDS_UPGRADE" } });
	});
});
