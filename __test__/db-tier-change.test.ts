import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
	assertPostgresTierChange,
	registerDbCommands,
	resolveDbTierTarget,
	runDatabaseTierChange,
} from "../src/commands/db";

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

describe("db downgrade command registration", () => {
	it("registers downgrade with --plan", () => {
		const cmd = dbSubcommand("downgrade");
		expect(cmd, "db downgrade should exist").toBeTruthy();
		const longs = cmd?.options.map((o) => o.long) ?? [];
		expect(longs).toContain("--plan");
	});
});
