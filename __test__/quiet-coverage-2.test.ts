import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Quiet-mode (`-q`) coverage sweep for the CLI's secondary command surface
 * (projects / providers / keys / tickets / notifications / inbox / firewall /
 * destinations / orgs). Each get/create/delete/switch-style subcommand
 * whose primary human output is silenced in quiet mode must still emit the
 * essential machine identifier via `quietOutput` — a single bare line on
 * stdout, no borders/labels — so agents and shell scripts can capture it.
 *
 * These are spot-checks: they prove the identifier reaches stdout in quiet
 * mode and (see the json-mode guard) that quiet emission never fires in JSON
 * mode, where `outputData` owns the payload.
 */

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({
		organizationId: "org_1",
		organizationName: "Acme",
	}),
	updateProfile: vi.fn(),
	getApiUrl: () => "https://tarout.sa",
}));

const client = {
	project: {
		all: {
			query: async () => [
				{ projectId: "proj_alpha", name: "Alpha", slug: "alpha" },
			],
		},
		one: {
			query: async () => ({ projectId: "proj_alpha", name: "Alpha" }),
		},
	},
	sshKey: {
		list: {
			query: async () => [{ keyId: "key_abc", name: "laptop" }],
		},
		setDefault: { mutate: vi.fn(async () => ({})) },
	},
	supportTicket: {
		close: { mutate: vi.fn(async () => ({})) },
	},
	appNotification: {
		unreadCount: { query: async () => ({ count: 3 }) },
	},
	destination: {
		byId: {
			query: async () => ({ id: "dest_1", name: "backups", provider: "s3" }),
		},
	},
	github: {
		one: { query: async () => ({ githubId: "gh_1", name: "acme-gh" }) },
	},
	firewallTemplate: {
		get: { query: async () => ({ id: "fw_1", name: "web", rules: [] }) },
	},
	notification: {
		remove: { mutate: vi.fn(async () => ({})) },
	},
	organization: {
		all: { query: async () => [{ id: "org_active", name: "Acme" }] },
		setActive: { mutate: vi.fn(async () => ({})) },
	},
	postgres: {
		allByOrganization: {
			query: async () => [
				{
					postgresId: "pg_main",
					name: "main",
					applicationStatus: "running",
					createdAt: "2026-01-01",
				},
			],
		},
	},
	mysql: {
		allByOrganization: { query: async () => [] },
	},
	// No `environment` stub on purpose: the platform appRouter has no
	// `environment` router, so any CLI code reaching for one is dead by
	// construction. Stubbing it here is what let the old `tarout envs` tests
	// pass against a namespace that could never work against a real server.
};

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => client,
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerDbCommands } from "../src/commands/db";
import { registerDestinationsCommands } from "../src/commands/destinations";
import { registerFirewallCommands } from "../src/commands/firewall";
import { registerInboxCommands } from "../src/commands/inbox";
import { registerKeysCommands } from "../src/commands/keys";
import { registerNotificationsCommands } from "../src/commands/notifications";
import { registerOrgsCommands } from "../src/commands/orgs";
import { registerProjectsCommands } from "../src/commands/projects";
import { registerProvidersCommands } from "../src/commands/providers";
import { registerTicketsCommands } from "../src/commands/tickets";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	// yes: skip confirmation prompts for delete/close paths.
	setGlobalOptions({ ...RESET, quiet: true, yes: true });
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
});

async function run(
	register: (program: Command) => void,
	argv: string[],
): Promise<void> {
	const program = new Command();
	program.exitOverride();
	register(program);
	await program.parseAsync(["node", "tarout", ...argv]);
}

describe("quiet-mode identifier coverage (secondary commands)", () => {
	it("projects get emits the project id", async () => {
		await run(registerProjectsCommands, ["projects", "get", "proj_alpha"]);
		expect(logSpy).toHaveBeenCalledWith("proj_alpha");
	});

	it("projects list emits one full project id per line (no table/header)", async () => {
		await run(registerProjectsCommands, ["projects", "list"]);
		expect(logSpy).toHaveBeenCalledWith("proj_alpha");
		// The human table columns (NAME/SLUG/DEFAULT/ACTIVE) never reach stdout.
		const printed = logSpy.mock.calls.map((c) => String(c[0]));
		expect(printed).not.toContain("NAME");
		expect(printed).toEqual(["proj_alpha"]);
	});

	it("projects list drops id-less rows instead of printing a blank line", async () => {
		const orig = client.project.all.query;
		client.project.all.query = (async () => [
			{ projectId: "proj_ok", name: "Ok", slug: "ok" },
			{ name: "orphan", slug: "orphan" },
		]) as typeof orig;
		try {
			await run(registerProjectsCommands, ["projects", "list"]);
			const printed = logSpy.mock.calls.map((c) => String(c[0]));
			expect(printed).toEqual(["proj_ok"]);
			expect(printed).not.toContain("");
		} finally {
			client.project.all.query = orig;
		}
	});

	it("db list emits one full database id per line (no table/header)", async () => {
		await run(registerDbCommands, ["db", "list"]);
		expect(logSpy).toHaveBeenCalledWith("pg_main");
		// The human table columns (ID/NAME/TYPE/STATUS/CREATED) never reach stdout.
		const printed = logSpy.mock.calls.map((c) => String(c[0]));
		expect(printed).not.toContain("NAME");
		expect(printed).toEqual(["pg_main"]);
	});

	it("keys default emits the key id", async () => {
		await run(registerKeysCommands, ["keys", "default", "key_abc"]);
		expect(logSpy).toHaveBeenCalledWith("key_abc");
	});

	it("tickets close emits the ticket id", async () => {
		// >=36 chars so the command skips the partial-id list lookup.
		const ticketId = "ticket_00000000000000000000000000000000";
		await run(registerTicketsCommands, ["tickets", "close", ticketId]);
		expect(logSpy).toHaveBeenCalledWith(ticketId);
	});

	it("inbox count emits the unread count", async () => {
		await run(registerInboxCommands, ["inbox", "count"]);
		expect(logSpy).toHaveBeenCalledWith("3");
	});

	it("destinations info emits the destination id", async () => {
		await run(registerDestinationsCommands, ["destinations", "info", "dest_1"]);
		expect(logSpy).toHaveBeenCalledWith("dest_1");
	});

	it("providers github info emits the github id", async () => {
		await run(registerProvidersCommands, [
			"providers",
			"github",
			"info",
			"gh_1",
		]);
		expect(logSpy).toHaveBeenCalledWith("gh_1");
	});

	it("firewall get emits the template id", async () => {
		await run(registerFirewallCommands, ["firewall", "get", "fw_1"]);
		expect(logSpy).toHaveBeenCalledWith("fw_1");
	});

	it("notifications delete emits the notification id", async () => {
		await run(registerNotificationsCommands, [
			"notifications",
			"delete",
			"notif_1",
		]);
		expect(logSpy).toHaveBeenCalledWith("notif_1");
	});

	it("orgs activate emits the organization id", async () => {
		await run(registerOrgsCommands, ["orgs", "activate", "org_active"]);
		expect(logSpy).toHaveBeenCalledWith("org_active");
	});

});

describe("quiet emission never fires in JSON mode", () => {
	it("projects get prints the JSON envelope, not a bare id line", async () => {
		setGlobalOptions({ ...RESET, json: true });
		await run(registerProjectsCommands, ["projects", "get", "proj_alpha"]);
		// The bare identifier line is a quiet-only artifact.
		expect(logSpy).not.toHaveBeenCalledWith("proj_alpha");
		// Some stdout was produced (the JSON payload) and it contains the id.
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("proj_alpha");
	});
});
