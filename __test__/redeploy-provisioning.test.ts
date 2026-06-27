import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configureOptionalResources,
	hasExplicitResourceRequest,
} from "../src/commands/deploy";
import { setGlobalOptions } from "../src/lib/output";

/**
 * Fix: `--database`/`--storage` were silently ignored on a redeploy of an
 * existing app (resource provisioning ran only on first create). Now they're
 * honored — but a redeploy must REUSE an existing project database, never spawn
 * a duplicate (billable) one, and only create when none exists.
 *
 * These drive `configureOptionalResources` with `{ appReused: true }` against a
 * scripted fake tRPC client — no app, no DB, no payment gateway.
 */

const profile = {
	organizationId: "org1",
	environmentId: "env1",
	projectId: "proj1",
} as any;

const app = { applicationId: "app1", name: "demo4" } as any;

const noDb = { database: "none", storage: false } as any;

beforeEach(() => {
	setGlobalOptions({ json: true, nonInteractive: true });
});

afterEach(() => {
	setGlobalOptions({ json: false, nonInteractive: false });
});

describe("hasExplicitResourceRequest", () => {
	it("is true only when a resource flag is set", () => {
		expect(hasExplicitResourceRequest({} as any)).toBe(false);
		expect(hasExplicitResourceRequest({ database: "postgres" } as any)).toBe(
			true,
		);
		expect(hasExplicitResourceRequest({ storage: true } as any)).toBe(true);
		expect(hasExplicitResourceRequest({ reuseDatabase: "auto" } as any)).toBe(
			true,
		);
		expect(hasExplicitResourceRequest({ reuseStorage: "auto" } as any)).toBe(
			true,
		);
	});
});

describe("configureOptionalResources on a redeploy (appReused)", () => {
	it("reuses the existing project DB and never creates a duplicate", async () => {
		let created = false;
		let attachedTo: string | undefined;
		const client = {
			postgres: {
				allByOrganization: {
					query: async () => [
						{
							postgresId: "db-1",
							name: "demo4-pg",
							projectId: "proj1",
							plan: "STANDARD",
							createdAt: "2026-01-01T00:00:00Z",
						},
					],
				},
				create: {
					mutate: async () => {
						created = true;
						return { postgresId: "db-new" };
					},
				},
				attachToApplication: {
					mutate: async (input: { postgresId: string }) => {
						attachedTo = input.postgresId;
						return {};
					},
				},
			},
			mysql: { allByOrganization: { query: async () => [] } },
			storage: { allByOrganization: { query: async () => [] } },
		};

		await configureOptionalResources(
			client,
			profile,
			app,
			{ ...noDb, database: "postgres" },
			noDb,
			{ appReused: true },
		);

		expect(attachedTo).toBe("db-1"); // attached the existing DB
		expect(created).toBe(false); // NO duplicate created
	});

	it("creates + attaches when the app has --database but no DB exists yet", async () => {
		let createdName: string | undefined;
		let attached = false;
		const client = {
			subscription: {
				getCurrent: { query: async () => ({ planKey: "shared" }) },
			},
			postgres: {
				allByOrganization: { query: async () => [] },
				getEntitlements: {
					query: async () => ({
						tiers: [
							{
								tier: "STANDARD",
								canCreate: true,
								limit: 5,
								available: 5,
								monthlyHalalas: 4900,
							},
						],
					}),
				},
				create: {
					mutate: async (input: { name: string }) => {
						createdName = input.name;
						return { postgresId: "db-new" };
					},
				},
				attachToApplication: {
					mutate: async () => {
						attached = true;
						return {};
					},
				},
			},
			mysql: { allByOrganization: { query: async () => [] } },
			storage: { allByOrganization: { query: async () => [] } },
		};

		await configureOptionalResources(
			client,
			profile,
			app,
			{ ...noDb, database: "postgres" },
			noDb,
			{ appReused: true },
		);

		expect(createdName).toBeTruthy(); // created because none existed
		expect(attached).toBe(true);
	});

	it("does nothing on a redeploy with no explicit resource flags", async () => {
		let touched = false;
		const mark = () => {
			touched = true;
			return [];
		};
		const client = {
			postgres: { allByOrganization: { query: async () => mark() } },
			mysql: { allByOrganization: { query: async () => mark() } },
			storage: { allByOrganization: { query: async () => mark() } },
		};

		await configureOptionalResources(client, profile, app, noDb, noDb, {
			appReused: true,
		});

		expect(touched).toBe(false); // no provisioning attempted
	});
});
