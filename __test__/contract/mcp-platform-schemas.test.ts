/**
 * Contract test — the systemic guard against the "silently-drifting payload"
 * bug class.
 *
 * Every other MCP/CLI test mocks the tRPC client, so the payloads our tools
 * build are only ever asserted against OUR OWN expectations — never against the
 * PLATFORM's real Zod input schemas. That gap let six tools ship broken
 * payloads (app_create/db_create missing appName+organizationId, env_unset
 * hitting a superRefine reject, billing_upgrade dropping quantity, phantom
 * procedure names). This test closes it: we capture the EXACT payload objects
 * the MCP tool handlers build (via a recording tRPC client), then validate each
 * one against the platform's actual schema — and assert every procedure the
 * tools reference exists in the platform's appRouter.
 *
 * Sibling-aware: the platform repo is expected as a sibling checkout. When it
 * isn't present (CLI CI in isolation) the whole suite SKIPS cleanly so CI stays
 * green; when it IS present (local dev) it RUNS. Validation runs INSIDE the
 * platform repo via a spawned `bun` process (cwd = platform) so the platform's
 * own tsconfig `@/*` path aliases and node_modules resolve — importing the
 * platform's TS by hand from here would break on those aliases.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Resolve the platform checkout portably — never assume a single machine's
 * absolute path (that skips forever on any other checkout/CI while looking
 * green). Order:
 *   1. TAROUT_PLATFORM_DIR env var — explicit override (e.g. a CI job that
 *      knows where it put the platform checkout).
 *   2. Sibling-relative: this test file lives at <cli>/__test__/contract/, so
 *      the CLI repo root is two dirs up and the platform checkout is expected
 *      as its sibling (<code>/platform). Computed from import.meta.url — NOT
 *      cwd, so it holds regardless of where the runner is invoked from.
 *   3. The original absolute dev path, as a last resort.
 */
function resolvePlatformRoot(): string {
	const fromEnv = process.env.TAROUT_PLATFORM_DIR?.trim();
	if (fromEnv) return fromEnv;
	const here = fileURLToPath(new URL(".", import.meta.url));
	const sibling = join(here, "..", "..", "..", "platform");
	if (existsSync(join(sibling, "src/server/validations/application.ts"))) {
		return sibling;
	}
	return "/Users/salehalibrahim/Desktop/Startups/Tarout/code/platform";
}

const PLATFORM_ROOT = resolvePlatformRoot();
const PLATFORM_SRC = `${PLATFORM_ROOT}/src`;

// Presence probe: a real, load-bearing platform file. When absent, skip.
const siblingPresent = existsSync(
	`${PLATFORM_SRC}/server/validations/application.ts`,
);

// Strict mode: an intentional contract run (REQUIRE_PLATFORM_CONTRACT set to
// any truthy value) must NEVER silently skip — a missing checkout FAILS the
// suite instead, so a CI job that means to run the contract can't pass blind.
const requirePlatformContract = Boolean(
	process.env.REQUIRE_PLATFORM_CONTRACT &&
		process.env.REQUIRE_PLATFORM_CONTRACT !== "0" &&
		process.env.REQUIRE_PLATFORM_CONTRACT !== "false",
);

// When we skip (not strict, sibling absent), say so loudly and explain how to
// point the suite at a platform checkout — a silent skip is the bug we're fixing.
if (!siblingPresent && !requirePlatformContract) {
	console.warn(
		`[contract] SKIPPING MCP↔platform schema contract: no platform checkout found at "${PLATFORM_ROOT}". ` +
			"Point it at one with TAROUT_PLATFORM_DIR=/abs/path/to/platform (or clone the platform repo as a sibling of the CLI repo). " +
			"Set REQUIRE_PLATFORM_CONTRACT=1 to FAIL instead of skip when it's missing.",
	);
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TOOLS_DIR = join(HERE, "../../src/mcp/tools");
const BILLING_LIB = join(HERE, "../../src/lib/billing-upgrade.ts");

// ---------------------------------------------------------------------------
// Recording tRPC client. A Proxy that turns any `client.<router>.<proc>.
// (query|mutate)(payload)` chain into a recorded { procedure, payload } entry
// and returns a benign value — an apps array for the resolveAppRef lookups,
// `{}` for everything else (so billing finalize classifies "deferred" and
// never polls / hits the network).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
	const calls: Array<{ procedure: string; payload: unknown }> = [];
	const APPS = [{ applicationId: "app_1", name: "web" }];
	function benign(path: string): unknown {
		return path.endsWith("allByOrganization") ? APPS : {};
	}
	function node(path: string[]): unknown {
		return new Proxy(
			() => {},
			{
				get(_t, prop) {
					if (typeof prop !== "string") return undefined;
					if (prop === "then") return undefined; // never a thenable
					if (prop === "query" || prop === "mutate") {
						return (payload: unknown = {}) => {
							calls.push({ procedure: path.join("."), payload });
							return Promise.resolve(benign(path.join(".")));
						};
					}
					return node([...path, prop]);
				},
			},
		);
	}
	return { calls, client: node([]) };
});

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
	getCurrentProfile: () => ({ organizationId: "org_1" }),
}));

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => h.client,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppsTools } from "../../src/mcp/tools/apps";
import { registerBillingTools } from "../../src/mcp/tools/billing";
import { registerDbTools } from "../../src/mcp/tools/db";
import { registerEnvTools } from "../../src/mcp/tools/env";

interface ValidatorResult {
	results: Array<{ id: string; schema: string; valid: boolean; errors: string[] }>;
	missingProcedures: string[];
	procedureCount: number;
}

interface CapturedPayload {
	id: string;
	schema: string;
	payload: unknown;
	expectValid: boolean;
}

/**
 * The validator script executed INSIDE the platform repo (cwd = platform) by
 * `bun`. It imports the platform's real Zod schemas + appRouter by absolute
 * path (their internal `@/*` imports resolve via the platform tsconfig), safe-
 * parses every captured payload against its named schema, and reports which of
 * the referenced procedures are missing from the live procedure map. Emits one
 * JSON object on stdout, then force-exits (the appRouter import leaves Redis/
 * timer handles open that would otherwise keep the process alive).
 */
const VALIDATOR_SCRIPT = `
import { readFileSync } from "node:fs";
const SRC = ${JSON.stringify(PLATFORM_SRC)};
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const [appMod, pgMod, myMod, envMod, subMod] = await Promise.all([
	import(SRC + "/server/validations/application"),
	import(SRC + "/server/validations/postgres"),
	import(SRC + "/server/validations/mysql"),
	import(SRC + "/server/validations/env-variable"),
	import(SRC + "/server/validations/subscription"),
]);
const registry = {
	apiCreateApplication: appMod.apiCreateApplication,
	apiCreatePostgres: pgMod.apiCreatePostgres,
	apiCreateMySql: myMod.apiCreateMySql,
	apiImportEnvVariables: envMod.apiImportEnvVariables,
	apiDeleteEnvVariable: envMod.apiDeleteEnvVariable,
	apiBulkDeleteEnvVariables: envMod.apiBulkDeleteEnvVariables,
	changePlanInput: subMod.changePlanInput,
	setPlanQuantityInput: subMod.setPlanQuantityInput,
};
const results = input.payloads.map((p) => {
	const schema = registry[p.schema];
	if (!schema) {
		return { id: p.id, schema: p.schema, valid: false, errors: ["schema '" + p.schema + "' not in validator registry"] };
	}
	const r = schema.safeParse(p.payload);
	return {
		id: p.id,
		schema: p.schema,
		valid: r.success,
		errors: r.success ? [] : r.error.issues.map((i) => (i.path.join(".") || "(root)") + ": " + i.message),
	};
});
const { appRouter } = await import(SRC + "/server/api/root");
const procs = new Set(Object.keys(appRouter._def.procedures));
const missingProcedures = [...new Set(input.procedures)].filter((pr) => !procs.has(pr));
process.stdout.write(JSON.stringify({ results, missingProcedures, procedureCount: procs.size }));
process.exit(0);
`;

let validator: ValidatorResult;
let payloads: CapturedPayload[];
let referenced: string[];

// describe.skipIf keeps CLI-only CI green while the platform sibling is absent,
// and RUNS the whole thing when the checkout exists.
describe.skipIf(!siblingPresent)("MCP payloads ↔ platform Zod schemas", () => {
	beforeAll(async () => {
		const server = new McpServer(
			{ name: "contract", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerAppsTools(server);
		registerDbTools(server);
		registerEnvTools(server);
		registerBillingTools(server);

		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
		const tools = (server as any)._registeredTools as Record<
			string,
			{ handler: (args: unknown) => Promise<unknown> }
		>;

		/** Invoke a tool and return the payload it sent to `procedure`. */
		async function capture(
			tool: string,
			args: unknown,
			procedure: string,
		): Promise<unknown> {
			const before = h.calls.length;
			await tools[tool].handler(args);
			const added = h.calls.slice(before);
			const found = added.find((c) => c.procedure === procedure);
			if (!found) {
				throw new Error(
					`${tool} did not call ${procedure}; it called: ${added
						.map((c) => c.procedure)
						.join(", ")}`,
				);
			}
			return found.payload;
		}

		// env_push reads a real dotenv file off disk — stage one.
		const scratch = mkdtempSync(join(tmpdir(), "tarout-contract-"));
		writeFileSync(join(scratch, ".env.contract"), "FOO=bar\nBAZ=qux\n");

		const captured: CapturedPayload[] = [
			{
				id: "app_create",
				schema: "apiCreateApplication",
				payload: await capture(
					"app_create",
					{ name: "My API", description: "backend", plan: "SHARED" },
					"application.create",
				),
				expectValid: true,
			},
			{
				id: "db_create.postgres",
				schema: "apiCreatePostgres",
				payload: await capture(
					"db_create",
					{ type: "postgres", name: "My DB", plan: "STARTER", description: "d" },
					"postgres.create",
				),
				expectValid: true,
			},
			{
				id: "db_create.mysql",
				schema: "apiCreateMySql",
				payload: await capture(
					"db_create",
					{ type: "mysql", name: "My DB", plan: "STANDARD" },
					"mysql.create",
				),
				expectValid: true,
			},
			{
				id: "env_set",
				schema: "apiImportEnvVariables",
				payload: await capture(
					"env_set",
					{ app: "web", vars: { FOO: "bar", BAZ: "qux" }, restart: false },
					"envVariable.import",
				),
				expectValid: true,
			},
			{
				id: "env_push",
				schema: "apiImportEnvVariables",
				payload: await capture(
					"env_push",
					{ app: "web", path: scratch, file: ".env.contract", merge: true, restart: false },
					"envVariable.import",
				),
				expectValid: true,
			},
			{
				id: "env_unset.single",
				schema: "apiDeleteEnvVariable",
				payload: await capture(
					"env_unset",
					{ app: "web", keys: ["FOO"] },
					"envVariable.delete",
				),
				expectValid: true,
			},
			{
				id: "env_unset.multi",
				schema: "apiBulkDeleteEnvVariables",
				payload: await capture(
					"env_unset",
					{ app: "web", keys: ["FOO", "BAR"] },
					"envVariable.bulkDelete",
				),
				expectValid: true,
			},
			{
				id: "billing_upgrade.plan+quantity",
				schema: "changePlanInput",
				payload: await capture(
					"billing_upgrade",
					{ plan: "shared", planQuantity: 3, wait: false },
					"subscription.changePlan",
				),
				expectValid: true,
			},
			{
				id: "billing_upgrade.planQuantity",
				schema: "setPlanQuantityInput",
				payload: await capture(
					"billing_upgrade",
					{ planQuantity: 5, wait: false },
					"subscription.setPlanQuantity",
				),
				expectValid: true,
			},
			// Negative control — the ORIGINAL bug: app_create WITHOUT appName. If
			// the harness can't detect this, it can't catch the bug class either.
			{
				id: "negative.app_create-missing-appName",
				schema: "apiCreateApplication",
				payload: { name: "My API", organizationId: "org_1", plan: "SHARED" },
				expectValid: false,
			},
		];

		// Referenced-procedure set for the phantom guard: union of (a) everything
		// the recording client actually saw during capture (resolves db.ts's
		// dynamic `router.<proc>` dispatch faithfully), (b) a static scan of every
		// tool file + the billing engine for literal `client.<router>.<proc>`
		// references (covers deploy/domains/storage/context/user tools we don't
		// invoke here), and (c) the db.ts dynamic router methods spelled out (the
		// static regex can't see `router.create` where router = client.postgres).
		const refs = new Set<string>();
		for (const c of h.calls) refs.add(c.procedure);
		const rx = /client\.([a-zA-Z]+)\.([a-zA-Z]+)\.(?:query|mutate)/g;
		const sources = [
			BILLING_LIB,
			...readdirSync(TOOLS_DIR)
				.filter((f) => f.endsWith(".ts"))
				.map((f) => join(TOOLS_DIR, f)),
		];
		for (const file of sources) {
			const text = readFileSync(file, "utf8");
			for (const m of text.matchAll(rx)) refs.add(`${m[1]}.${m[2]}`);
		}
		for (const engine of ["postgres", "mysql"]) {
			for (const proc of ["create", "one", "remove", "allByOrganization"]) {
				refs.add(`${engine}.${proc}`);
			}
		}

		payloads = captured;
		referenced = [...refs].sort();

		// Hand the captured payloads + referenced procedures to the platform-side
		// validator and collect its verdict.
		const inputPath = join(scratch, "input.json");
		const scriptPath = join(scratch, "validate.ts");
		writeFileSync(
			inputPath,
			JSON.stringify({ payloads: captured, procedures: referenced }),
		);
		writeFileSync(scriptPath, VALIDATOR_SCRIPT);

		const run = spawnSync("bun", ["run", scriptPath, inputPath], {
			cwd: PLATFORM_ROOT,
			encoding: "utf8",
			timeout: 120_000,
			env: {
				...process.env,
				SKIP_ENV_VALIDATION: "1",
				NODE_ENV: "test",
				DATABASE_URL:
					process.env.DATABASE_URL ??
					"postgresql://test:test@localhost:5432/tarout_test",
				REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
				BETTER_AUTH_SECRET:
					process.env.BETTER_AUTH_SECRET ?? "test-secret-not-real",
				NEXT_PUBLIC_APP_URL:
					process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:8000",
				BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8000",
			},
		});

		if (run.status !== 0 || !run.stdout) {
			throw new Error(
				`platform-side validator failed (status ${run.status}).\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
			);
		}
		validator = JSON.parse(run.stdout.trim()) as ValidatorResult;
	}, 120_000);

	it("captured payloads for every covered tool", () => {
		const ids = payloads.map((p) => p.id).sort();
		expect(ids).toEqual(
			[
				"app_create",
				"billing_upgrade.plan+quantity",
				"billing_upgrade.planQuantity",
				"db_create.mysql",
				"db_create.postgres",
				"env_push",
				"env_set",
				"env_unset.multi",
				"env_unset.single",
				"negative.app_create-missing-appName",
			].sort(),
		);
	});

	it("the platform validator ran and returned a full procedure map", () => {
		expect(validator.procedureCount).toBeGreaterThan(100);
		expect(validator.results.length).toBe(payloads.length);
	});

	// One assertion per real payload — each must parse against the platform's
	// actual schema. A failure here IS the drift bug, reported with the exact
	// Zod issue.
	for (const expected of [
		"app_create",
		"db_create.postgres",
		"db_create.mysql",
		"env_set",
		"env_push",
		"env_unset.single",
		"env_unset.multi",
		"billing_upgrade.plan+quantity",
		"billing_upgrade.planQuantity",
	]) {
		it(`${expected} payload validates against its platform schema`, () => {
			const r = validator.results.find((x) => x.id === expected);
			expect(r, `no validator result for ${expected}`).toBeDefined();
			expect(
				r?.valid,
				`${expected} → ${r?.schema} rejected: ${r?.errors.join("; ")}`,
			).toBe(true);
		});
	}

	it("negative control: app_create WITHOUT appName is REJECTED by the schema", () => {
		const r = validator.results.find(
			(x) => x.id === "negative.app_create-missing-appName",
		);
		expect(r?.valid).toBe(false);
		expect(r?.errors.join("; ")).toMatch(/appName/i);
	});

	it("no phantom procedures — every referenced tRPC path exists in appRouter", () => {
		expect(referenced.length).toBeGreaterThan(10);
		expect(
			validator.missingProcedures,
			`MCP tools reference procedures absent from the platform appRouter: ${validator.missingProcedures.join(
				", ",
			)}`,
		).toEqual([]);
	});
});

// Strict mode only: when REQUIRE_PLATFORM_CONTRACT is set but no platform
// checkout is present, the contract must FAIL rather than skip — otherwise a CI
// job that intends to run it would go green having asserted nothing.
describe.runIf(requirePlatformContract && !siblingPresent)(
	"MCP payloads ↔ platform Zod schemas (strict mode)",
	() => {
		it("platform checkout must be present (REQUIRE_PLATFORM_CONTRACT is set)", () => {
			throw new Error(
				`REQUIRE_PLATFORM_CONTRACT is set but no platform checkout was found at "${PLATFORM_ROOT}". ` +
					"Set TAROUT_PLATFORM_DIR to a platform checkout, or clone the platform repo as a sibling of the CLI repo.",
			);
		});
	},
);
