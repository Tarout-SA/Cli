import { describe, expect, it } from "vitest";
import { computeReuseProvisionOptions } from "../src/commands/up";

/**
 * Regression: `tarout up --app <id>` used to skip provisioning entirely, so a
 * resume after a billing gate (app-slot or DB-slot limit) deployed the app with
 * no database and no storage — none of the PG* / STORAGE_* connection env vars
 * were injected, so Postgres fell back to localhost and storage reported
 * unconfigured.
 *
 * computeReuseProvisionOptions now provisions any DETECTED backend the reused
 * app is MISSING, detecting what's already wired in from the injected connection
 * env vars (DATABASE_URL for a DB, STORAGE_BUCKET for storage).
 */

const detectedDb = { database: "postgres", storage: false } as any;
const detectedStorage = { database: "none", storage: true } as any;
const detectedBoth = { database: "postgres", storage: true } as any;
const detectedNone = { database: "none", storage: false } as any;

const noKeys = new Set<string>();
const dbKeys = new Set(["DATABASE_URL", "PGHOST"]);
const storageKeys = new Set(["STORAGE_BUCKET"]);
const bothKeys = new Set(["DATABASE_URL", "STORAGE_BUCKET"]);

describe("computeReuseProvisionOptions (tarout up resume)", () => {
	it("provisions a detected DB the reused app is missing (the resume bug)", () => {
		const out = computeReuseProvisionOptions(noKeys, {} as any, detectedDb);
		expect(out).not.toBeNull();
		expect(out?.database).toBe("postgres");
	});

	it("provisions detected storage the reused app is missing", () => {
		const out = computeReuseProvisionOptions(noKeys, {} as any, detectedStorage);
		expect(out?.storage).toBe(true);
	});

	it("provisions both when both are detected and missing", () => {
		const out = computeReuseProvisionOptions(noKeys, {} as any, detectedBoth);
		expect(out?.database).toBe("postgres");
		expect(out?.storage).toBe(true);
	});

	it("does NOT re-provision a DB already wired in (DATABASE_URL present)", () => {
		expect(
			computeReuseProvisionOptions(dbKeys, {} as any, detectedDb),
		).toBeNull();
	});

	it("does NOT re-provision storage already wired in (STORAGE_BUCKET present)", () => {
		expect(
			computeReuseProvisionOptions(storageKeys, {} as any, detectedStorage),
		).toBeNull();
	});

	it("is a no-op for a genuine redeploy (all present, or nothing detected)", () => {
		expect(
			computeReuseProvisionOptions(bothKeys, {} as any, detectedBoth),
		).toBeNull();
		expect(
			computeReuseProvisionOptions(noKeys, {} as any, detectedNone),
		).toBeNull();
	});

	it("respects --skip-database / --skip-storage even when detected+missing", () => {
		expect(
			computeReuseProvisionOptions(
				noKeys,
				{ skipDatabase: true } as any,
				detectedDb,
			),
		).toBeNull();
		expect(
			computeReuseProvisionOptions(
				noKeys,
				{ skipStorage: true } as any,
				detectedStorage,
			),
		).toBeNull();
	});

	it("still honors an explicit --database on a redeploy (existing behavior)", () => {
		const out = computeReuseProvisionOptions(
			dbKeys,
			{ database: "postgres" } as any,
			detectedNone,
		);
		expect(out).not.toBeNull();
	});
});
