import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout storage` read field names the platform does not send, recommended a
 * command the platform refuses for managed buckets, and required inputs the
 * platform ignores. These specs drive each command against the real `storage.*`
 * response shapes (cloud/src/server/api/routers/storage.ts) and pin both what
 * the CLI sends and what it prints.
 */

const h = vi.hoisted(() => ({
	client: {} as any,
	input: vi.fn(),
	confirm: vi.fn(),
	select: vi.fn(),
}));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1", projectName: undefined }),
	getApiUrl: () => "https://api.test",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
}));

vi.mock("../src/lib/auth-profile.js", () => ({
	requireProfile: async () => ({ organizationId: "org_1", token: "tok_test" }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

vi.mock("../src/utils/prompts.js", () => ({
	input: h.input,
	confirm: h.confirm,
	select: h.select,
}));

import { Command } from "commander";
import { registerStorageCommands } from "../src/commands/storage";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
const ANSI = /\x1b\[[0-9;]*m/g;

let stdout: string[];
let stderr: string[];
let exitCodes: number[];

beforeEach(() => {
	stdout = [];
	stderr = [];
	exitCodes = [];
	h.input.mockReset();
	h.confirm.mockReset();
	h.select.mockReset();
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	// handleError ends in process.exit; record the code and unwind instead.
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	h.client = {} as any;
});

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerStorageCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

function helpFor(path: string[]): string {
	const program = new Command();
	registerStorageCommands(program);
	let cmd: Command | undefined = program;
	for (const name of path) {
		cmd = cmd?.commands.find((c) => c.name() === name);
	}
	if (!cmd) throw new Error(`no command ${path.join(" ")}`);
	return cmd.helpInformation();
}

/** One row of storage.allByOrganization, in the router's real shape. */
function listRow(over: Record<string, unknown> = {}) {
	return {
		bucketId: "bkt_0123456789abcdefghij",
		name: "assets",
		appName: "assets-ab12cd",
		description: null,
		region: "me-central2",
		storageUsed: 5 * 1024 * 1024,
		storageUsageBytes: 5 * 1024 * 1024,
		storageLimit: 1024 ** 3,
		filesCount: 3,
		publicAccess: false,
		endpoint: "https://storage.tarout.sa",
		publicUrl: null,
		applicationStatus: "done",
		createdAt: "2026-09-01T00:00:00.000Z",
		organizationId: "org_1",
		projectId: "prj_1",
		providerType: "GCS",
		plan: "STARTER",
		tenantPrefix: "t/abc/",
		bucketName: "tarout-shared-starter",
		...over,
	};
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

describe("storage info", () => {
	it("prints the real storageUsed / filesCount fields from storage.findById", async () => {
		const findById = vi.fn(async () => listRow());
		h.client = {
			storage: {
				allByOrganization: { query: async () => [listRow()] },
				findById: { query: findById },
			},
		};

		await run(["storage", "info", "assets"]);

		expect(findById).toHaveBeenCalledWith({
			bucketId: "bkt_0123456789abcdefghij",
		});
		const text = out();
		expect(text).toMatch(/Used: 5\.0 MB \/ 1\.0 GB/);
		expect(text).toMatch(/Files: 3/);
		expect(exitCodes).toEqual([]);
	});
});

describe("storage create", () => {
	/** storage.create's real response: no `name`, and the plan it DERIVED. */
	const CREATED = {
		bucketId: "bkt_new0123456789abcdef",
		tenantPrefix: "t/new/",
		bucketName: "tarout-shared-starter",
		plan: "STARTER",
		publicAccess: false,
		endpoint: "https://storage.tarout.sa",
		publicUrl: null,
	};

	it("prints the name it sent and the plan the server chose, and never prompts for a plan", async () => {
		const mutate = vi.fn(async () => CREATED);
		h.client = { storage: { create: { mutate } } };

		await run(["storage", "create", "  uploads  ", "--plan", "pro"]);

		expect(h.select).not.toHaveBeenCalled();
		// The platform derives the plan from the project's subscription and
		// ignores the input, so the CLI does not send one.
		expect(mutate).toHaveBeenCalledWith({
			name: "uploads",
			description: undefined,
			publicAccess: false,
		});
		const text = out();
		expect(text).toMatch(/ID: bkt_new0123456789abcdef/);
		expect(text).toMatch(/Name: uploads/);
		expect(text).not.toMatch(/undefined/);
		expect(text).toMatch(/Plan: STARTER/);
		expect(text).not.toMatch(/Plan: PRO/);
		expect(exitCodes).toEqual([]);
	});

	it("does not prompt for a plan in interactive mode", async () => {
		h.client = { storage: { create: { mutate: async () => CREATED } } };

		await run(["storage", "create", "uploads"]);

		expect(h.select).not.toHaveBeenCalled();
		expect(out()).toMatch(/Plan: STARTER/);
	});

	it("recommends attaching to an app instead of the managed-bucket credentials command", async () => {
		h.client = { storage: { create: { mutate: async () => CREATED } } };

		await run(["storage", "create", "uploads"]);

		const text = out();
		expect(text).not.toMatch(/tarout storage credentials/);
		expect(text).toMatch(
			/tarout storage attach bkt_new0123456789abcdef <app-id>/,
		);
	});

	it("says in help that --plan is ignored", () => {
		expect(helpFor(["storage", "create"])).toMatch(/--plan <plan>\s+Ignored/);
	});
});

describe("storage credentials", () => {
	it("explains the managed-bucket refusal and points at attach", async () => {
		h.client = {
			storage: {
				allByOrganization: { query: async () => [listRow()] },
				getCredentials: {
					query: async () => {
						throw Object.assign(
							new Error(
								"Direct provider credentials are disabled for managed storage. Create a scoped Tarout storage access key instead.",
							),
							{ data: { code: "FORBIDDEN" } },
						);
					},
				},
			},
		};

		await run(["storage", "credentials", "assets"]);

		expect(exitCodes).toEqual([5]);
		expect(err()).toMatch(/managed/i);
		expect(err()).toMatch(/tarout storage attach/);
	});

	it("prints the real getCredentials fields for a CUSTOM bucket", async () => {
		const row = listRow({ plan: "CUSTOM", name: "byo" });
		h.client = {
			storage: {
				allByOrganization: { query: async () => [row] },
				getCredentials: {
					query: async () => ({
						accessKeyId: "GOOG1EXAMPLE",
						authMode: "hmac",
						secretAccessKey: "s3cr3t",
						endpoint: "https://storage.googleapis.com",
						bucket: "customer-bucket",
						prefix: "t/abc/",
						region: "me-central2",
						providerType: "GCS",
					}),
				},
			},
		};

		await run(["storage", "credentials", "byo"]);

		const text = out();
		expect(text).toMatch(/Access Key ID: GOOG1EXAMPLE/);
		expect(text).toMatch(/Endpoint: https:\/\/storage\.googleapis\.com/);
		expect(text).toMatch(/Bucket: customer-bucket/);
		expect(text).toMatch(/Prefix: t\/abc\//);
		expect(exitCodes).toEqual([]);
	});

	it("says in help that it only works for custom buckets", () => {
		expect(helpFor(["storage", "credentials"])).toMatch(/custom buckets only/i);
	});
});

describe("storage complete-upload", () => {
	it("does not require --expected-size (the platform ignores it)", async () => {
		const mutate = vi.fn(async () => ({
			sizeBytes: 2048,
			contentType: "text/plain",
			lastModified: "2026-09-25T00:00:00.000Z",
			generation: "1",
		}));
		h.client = {
			storage: {
				allByOrganization: { query: async () => [listRow()] },
				completeUpload: { mutate },
			},
		};

		await run([
			"storage",
			"complete-upload",
			"assets",
			"notes.txt",
			"--reservation-token",
			"rsv_1",
		]);

		expect(exitCodes).toEqual([]);
		expect(mutate).toHaveBeenCalledWith({
			bucketId: "bkt_0123456789abcdefghij",
			reservationToken: "rsv_1",
			fileName: "notes.txt",
		});
		expect(out()).not.toMatch(/expected-size/);
	});

	it("rejects a non-positive --expected-size when one is given", async () => {
		const mutate = vi.fn();
		h.client = {
			storage: {
				allByOrganization: { query: async () => [listRow()] },
				completeUpload: { mutate },
			},
		};

		await run([
			"storage",
			"complete-upload",
			"assets",
			"notes.txt",
			"--expected-size",
			"0",
		]);

		expect(mutate).not.toHaveBeenCalled();
		expect(exitCodes).not.toEqual([]);
	});
});

describe("bucket references", () => {
	it("refuses a name shared by several buckets and lists their ids", async () => {
		const del = vi.fn();
		h.client = {
			storage: {
				allByOrganization: {
					query: async () => [
						listRow({ bucketId: "bkt_aaaaaaaaaaaaaaaaaaaa" }),
						listRow({ bucketId: "bkt_bbbbbbbbbbbbbbbbbbbb" }),
					],
				},
				delete: { mutate: del },
			},
		};

		await run(["storage", "delete", "assets"], { yes: true });

		expect(del).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
		expect(err()).toMatch(/bkt_aaaaaaaaaaaaaaaaaaaa/);
		expect(err()).toMatch(/bkt_bbbbbbbbbbbbbbbbbbbb/);
	});

	it("still resolves an exact id when names collide", async () => {
		const del = vi.fn(async () => ({ success: true }));
		h.client = {
			storage: {
				allByOrganization: {
					query: async () => [
						listRow({ bucketId: "bkt_aaaaaaaaaaaaaaaaaaaa" }),
						listRow({ bucketId: "bkt_bbbbbbbbbbbbbbbbbbbb" }),
					],
				},
				delete: { mutate: del },
			},
		};

		await run(["storage", "delete", "bkt_bbbbbbbbbbbbbbbbbbbb"], { yes: true });

		expect(del).toHaveBeenCalledWith({ bucketId: "bkt_bbbbbbbbbbbbbbbbbbbb" });
		expect(exitCodes).toEqual([]);
	});
});
