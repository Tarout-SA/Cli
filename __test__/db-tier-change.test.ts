import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared, mutable fake tRPC client the mocked `getApiClient` hands back, so each
// command-driving test can script its own preview/mutation shapes.
const hoisted = vi.hoisted(() => ({
	// biome-ignore lint/suspicious/noExplicitAny: scripted fake tRPC proxy.
	client: null as any,
}));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => hoisted.client,
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: () => {},
	succeedSpinner: () => {},
	failSpinner: () => {},
	stopSpinner: () => {},
	updateSpinner: () => {},
}));

// canLaunchBrowser() is hardcoded true on macOS/Windows, which made the
// "no browser reachable" fallback structurally untestable there (the old test
// early-returned on darwin/win32). Mock the module and drive browser
// reachability off a hoisted flag so every platform exercises both branches
// deterministically.
const browserState = vi.hoisted(() => ({ canLaunch: true }));

vi.mock("../src/lib/browser.js", async () => {
	const { isJsonMode, isNonInteractiveMode } = await import(
		"../src/lib/output.js"
	);
	return {
		canLaunchBrowser: () => browserState.canLaunch,
		browserLaunchSuppressed: () => false,
		openInBrowser: async () => browserState.canLaunch,
		paymentBrowserOpener: (opts?: { noOpen?: boolean }) =>
			opts?.noOpen || !browserState.canLaunch ? undefined : async () => {},
		// Faithful mirror of the real predicate, with canLaunchBrowser() replaced
		// by the flag: agent context (non-json, non-interactive) + reachable
		// browser + a positive charge.
		shouldAutoConfirmPaidCheckout: (amountDueHalalas?: number) => {
			const isPaidCheckout =
				typeof amountDueHalalas === "number" && amountDueHalalas > 0;
			return (
				!isJsonMode() &&
				isNonInteractiveMode() &&
				browserState.canLaunch &&
				isPaidCheckout
			);
		},
	};
});

import { Command } from "commander";
import {
	assertPostgresTierChange,
	registerDbCommands,
	resolveDatabaseUpgradeDueHalalas,
	resolveDbTierTarget,
	runDatabaseTierChange,
} from "../src/commands/db";
import { shouldAutoConfirmPaidCheckout } from "../src/lib/browser";
import { setGlobalOptions } from "../src/lib/output";

function dbSubcommand(name: string) {
	const program = new Command();
	program.exitOverride();
	registerDbCommands(program);
	const db = program.commands.find((c) => c.name() === "db");
	return db?.commands.find((c) => c.name() === name);
}

describe("assertPostgresTierChange", () => {
	it("passes for a postgres database", () => {
		expect(() => assertPostgresTierChange({ type: "postgres", name: "main" })).not.toThrow();
	});
	it("throws a clear error for mysql", () => {
		expect(() => assertPostgresTierChange({ type: "mysql", name: "shop" })).toThrow(/PostgreSQL/);
	});
});

describe("resolveDbTierTarget", () => {
	it("upgrade normalizes to uppercase and accepts pro", () => {
		expect(resolveDbTierTarget("upgrade", "pro")).toBe("PRO");
		expect(resolveDbTierTarget("upgrade", "standard")).toBe("STANDARD");
	});
	it("downgrade accepts standard but rejects pro", () => {
		expect(resolveDbTierTarget("downgrade", "standard")).toBe("STANDARD");
		expect(() => resolveDbTierTarget("downgrade", "pro")).toThrow(/highest tier/);
	});
	it("rejects free, empty, and invalid tiers", () => {
		expect(() => resolveDbTierTarget("upgrade", "free")).toThrow();
		expect(() => resolveDbTierTarget("upgrade", undefined)).toThrow(/required/);
		expect(() => resolveDbTierTarget("upgrade", "huge")).toThrow();
	});
});

describe("runDatabaseTierChange", () => {
	it("upgrade routes to purchaseDatabaseUpgrade and classifies a checkout", async () => {
		let captured: unknown;
		const client = {
			subscription: {
				purchaseDatabaseUpgrade: {
					mutate: async (i: unknown) => {
						captured = i;
						return { applied: false, paymentUrl: "https://pay.test/x", orderId: "ord_1", proratedChargeHalalas: 2000 };
					},
				},
			},
		};
		const r = await runDatabaseTierChange(client, { direction: "upgrade", postgresId: "pg_1", targetPlan: "PRO" });
		expect(captured).toEqual({ postgresId: "pg_1", targetPlan: "PRO" });
		expect(r.status).toBe("payment_required");
		expect(r.kind).toBe("database");
		expect(r.target).toBe("PRO");
	});
	it("downgrade routes to purchaseDatabaseDowngrade and applies immediately", async () => {
		let captured: unknown;
		const client = {
			subscription: {
				purchaseDatabaseDowngrade: {
					mutate: async (i: unknown) => {
						captured = i;
						return { applied: true, proratedChargeHalalas: 0 };
					},
				},
			},
		};
		const r = await runDatabaseTierChange(client, { direction: "downgrade", postgresId: "pg_2", targetPlan: "STARTER" });
		expect(captured).toEqual({ postgresId: "pg_2", targetPlan: "STARTER" });
		expect(r.status).toBe("applied");
		expect(r.kind).toBe("database");
	});
});

describe("db upgrade command registration", () => {
	it("registers upgrade with --plan and checkout flags", () => {
		const cmd = dbSubcommand("upgrade");
		expect(cmd, "db upgrade should exist").toBeTruthy();
		const longs = cmd?.options.map((o) => o.long) ?? [];
		expect(longs).toContain("--plan");
		expect(longs).toContain("--wait");
		expect(longs).toContain("--no-wait");
		expect(longs).toContain("--timeout");
	});
});

describe("resolveDatabaseUpgradeDueHalalas", () => {
	it("reads the real preview field `totalProratedHalalas`", () => {
		// Regression: db.ts previously read `proratedChargeHalalas`, which
		// previewDatabaseUpgrade does not return — so the amount was always
		// undefined and the agent auto-confirm below never fired.
		expect(
			resolveDatabaseUpgradeDueHalalas({ totalProratedHalalas: 2000 }),
		).toBe(2000);
	});
	it("falls back to the legacy `proratedChargeHalalas` field", () => {
		expect(
			resolveDatabaseUpgradeDueHalalas({ proratedChargeHalalas: 1500 }),
		).toBe(1500);
	});
	it("prefers totalProratedHalalas when both are present", () => {
		expect(
			resolveDatabaseUpgradeDueHalalas({
				totalProratedHalalas: 2000,
				proratedChargeHalalas: 9999,
			}),
		).toBe(2000);
	});
	it("returns undefined for a missing/empty preview", () => {
		expect(resolveDatabaseUpgradeDueHalalas(null)).toBeUndefined();
		expect(resolveDatabaseUpgradeDueHalalas({})).toBeUndefined();
	});
});

describe("db upgrade agent auto-confirm", () => {
	const savedDisplay = process.env.DISPLAY;
	beforeEach(() => {
		// Agent context: non-interactive, non-JSON, with a reachable browser so the
		// hosted checkout is the consent surface.
		setGlobalOptions({ json: false, nonInteractive: true });
		browserState.canLaunch = true;
		process.env.DISPLAY = ":0";
	});
	afterEach(() => {
		setGlobalOptions({ json: false, nonInteractive: false });
		browserState.canLaunch = true;
		if (savedDisplay === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = savedDisplay;
	});

	it("triggers when the preview returns totalProratedHalalas > 0", () => {
		const dueHalalas = resolveDatabaseUpgradeDueHalalas({
			totalProratedHalalas: 2000,
		});
		expect(dueHalalas).toBe(2000);
		expect(shouldAutoConfirmPaidCheckout(dueHalalas)).toBe(true);
	});

	it("does not trigger when the amount cannot be resolved (the old bug)", () => {
		// Simulate the previous field-name mismatch: reading a field the server
		// never sends leaves the amount undefined, so auto-confirm stays off.
		const dueHalalas = resolveDatabaseUpgradeDueHalalas({
			// biome-ignore lint/suspicious/noExplicitAny: intentionally the wrong shape.
			someOtherField: 2000,
		} as any);
		expect(dueHalalas).toBeUndefined();
		expect(shouldAutoConfirmPaidCheckout(dueHalalas)).toBe(false);
	});
});

describe("db downgrade command registration", () => {
	it("registers downgrade with --plan", () => {
		const cmd = dbSubcommand("downgrade");
		expect(cmd, "db downgrade should exist").toBeTruthy();
		const longs = cmd?.options.map((o) => o.long) ?? [];
		expect(longs).toContain("--plan");
	});
});

// End-to-end drive of the `db upgrade` command action against a scripted fake
// client — proving the auto-confirm branch is actually REACHABLE in a
// non-interactive agent run (not just that the pure helpers agree).
describe("db upgrade command — non-interactive auto-confirm reachability", () => {
	function fakeUpgradeClient(opts: {
		// biome-ignore lint/suspicious/noExplicitAny: scripted preview shape.
		preview?: any;
		onPreview?: () => void;
		// biome-ignore lint/suspicious/noExplicitAny: scripted mutation result.
		mutateResult?: any;
		// biome-ignore lint/suspicious/noExplicitAny: captured mutation input.
		onMutate?: (input: any) => void;
	}) {
		return {
			postgres: {
				allByOrganization: {
					query: async () => [
						{ postgresId: "pg_1", name: "main", applicationStatus: "running" },
					],
				},
			},
			mysql: {
				allByOrganization: { query: async () => [] },
			},
			subscription: {
				previewDatabaseUpgrade: {
					query: async () => {
						opts.onPreview?.();
						return opts.preview ?? { totalProratedHalalas: 2000 };
					},
				},
				purchaseDatabaseUpgrade: {
					// biome-ignore lint/suspicious/noExplicitAny: scripted mutation input.
					mutate: async (input: any) => {
						opts.onMutate?.(input);
						return opts.mutateResult ?? { applied: true };
					},
				},
			},
		};
	}

	const savedDisplay = process.env.DISPLAY;
	// biome-ignore lint/suspicious/noExplicitAny: vitest spy handle.
	let logSpy: any;
	// biome-ignore lint/suspicious/noExplicitAny: vitest spy handle.
	let exitSpy: any;
	let logs: string[];
	// Every process.exit(code) in call order. In production process.exit(6) is
	// terminal, but the throwing mock unwinds into the command's try/catch →
	// handleError → exit(1), so the LAST throw is 1; the operative code is the
	// FIRST one recorded here.
	let exitCodes: number[];

	beforeEach(() => {
		// Agent context: non-interactive, non-JSON, with a reachable browser so the
		// hosted checkout is the consent surface. Individual tests flip
		// browserState.canLaunch to exercise the headless fallback.
		setGlobalOptions({ json: false, nonInteractive: true });
		browserState.canLaunch = true;
		process.env.DISPLAY = ":0";
		logs = [];
		exitCodes = [];
		logSpy = vi
			.spyOn(console, "log")
			// biome-ignore lint/suspicious/noExplicitAny: capture any console arg.
			.mockImplementation((m?: any) => {
				logs.push(String(m));
			});
		// process.exit can't stop execution under test — record the code, then throw
		// to unwind so a stray needs_input/exit is observable instead of tearing down
		// the runner.
		exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exitCodes.push(code ?? 0);
			throw new Error(`__EXIT_${code ?? 0}`);
		}) as never);
	});

	afterEach(() => {
		setGlobalOptions({ json: false, nonInteractive: false });
		browserState.canLaunch = true;
		if (savedDisplay === undefined) delete process.env.DISPLAY;
		else process.env.DISPLAY = savedDisplay;
		logSpy?.mockRestore();
		exitSpy?.mockRestore();
		hoisted.client = null;
	});

	it("enters the preview block, auto-confirms, and proceeds straight to the mutation", async () => {
		let previewCalled = false;
		let mutateCalled = false;
		hoisted.client = fakeUpgradeClient({
			onPreview: () => {
				previewCalled = true;
			},
			onMutate: () => {
				mutateCalled = true;
			},
			preview: { totalProratedHalalas: 2000 },
			mutateResult: { applied: true },
		});

		const program = new Command();
		program.exitOverride();
		registerDbCommands(program);

		try {
			await program.parseAsync([
				"node",
				"tarout",
				"db",
				"upgrade",
				"pg_1",
				"--plan",
				"pro",
				"--no-open",
			]);
		} catch (err) {
			// Only swallow our own exit-unwind sentinel; re-throw real failures.
			if (!/__EXIT_/.test(String(err))) throw err;
		}

		// Under the OLD guard (`!isNonInteractiveMode()`), a non-interactive run
		// skipped this block entirely — the preview was never queried.
		expect(previewCalled).toBe(true);
		// Auto-confirm fired instead of the local y/n (which, being annotated,
		// would have emitted needs_input and exited 6 in non-interactive mode).
		expect(
			logs.some((l) => /Opening the secure payment page/.test(l)),
			"expected the auto-confirm message to be logged",
		).toBe(true);
		// ...and the flow proceeded to the real tier-change mutation.
		expect(mutateCalled).toBe(true);
	});

	it("falls back to the annotated confirm (needs_input) when no browser is reachable", async () => {
		// No browser reachable on ANY platform (the mocked canLaunchBrowser reads
		// this flag, so darwin/win32 no longer force `true`). A payable upgrade with
		// no launchable browser must fall through to the annotated confirm →
		// needs_input/exit 6, proving the auto-confirm is a genuine branch and not an
		// unconditional bypass.
		browserState.canLaunch = false;

		let previewCalled = false;
		let mutateCalled = false;
		hoisted.client = fakeUpgradeClient({
			onPreview: () => {
				previewCalled = true;
			},
			onMutate: () => {
				mutateCalled = true;
			},
			preview: { totalProratedHalalas: 2000 },
		});

		const program = new Command();
		program.exitOverride();
		registerDbCommands(program);

		try {
			await program.parseAsync([
				"node",
				"tarout",
				"db",
				"upgrade",
				"pg_1",
				"--plan",
				"pro",
				"--no-open",
			]);
		} catch (err) {
			if (!/__EXIT_/.test(String(err))) throw err;
		}

		// The block is still entered (preview runs)...
		expect(previewCalled).toBe(true);
		// ...but the annotated confirm emitted a structured needs_input and exited 6
		// (the operative first exit; the mock's throw then re-enters handleError).
		expect(exitCodes[0]).toBe(6);
		const needsInput = logs
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((e) => e?.type === "needs_input");
		expect(needsInput?.field).toBe("confirm_db_upgrade");
		// ...so the mutation never ran without consent.
		expect(mutateCalled).toBe(false);
	});

	it("non-interactive free upgrade (nothing payable) applies immediately without a confirm", async () => {
		// dueHalalas 0 → not a paid checkout, so there's no payment page to gate and
		// no TTY to confirm at. A non-interactive run must apply the change straight
		// through to the mutation instead of dead-ending at the annotated confirm's
		// needs_input/exit 6 (the regression this restores). Browser reachability is
		// irrelevant when nothing is payable.
		browserState.canLaunch = false;

		let previewCalled = false;
		let mutateCalled = false;
		hoisted.client = fakeUpgradeClient({
			onPreview: () => {
				previewCalled = true;
			},
			onMutate: () => {
				mutateCalled = true;
			},
			preview: { totalProratedHalalas: 0 },
			mutateResult: { applied: true },
		});

		const program = new Command();
		program.exitOverride();
		registerDbCommands(program);

		try {
			await program.parseAsync([
				"node",
				"tarout",
				"db",
				"upgrade",
				"pg_1",
				"--plan",
				"pro",
				"--no-open",
			]);
		} catch (err) {
			// No exit(6) expected here; only swallow our sentinel if one leaks.
			if (!/__EXIT_/.test(String(err))) throw err;
		}

		expect(previewCalled).toBe(true);
		// No confirm was requested, so no needs_input event was emitted...
		const needsInput = logs
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.find((e) => e?.type === "needs_input");
		expect(needsInput).toBeUndefined();
		// ...and the free change applied straight through to the mutation.
		expect(mutateCalled).toBe(true);
	});
});
