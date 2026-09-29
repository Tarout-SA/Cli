import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout template list | info | deploy` against the platform's `template`
 * router contract. The router is mocked: these pin what the CLI sends, what it
 * checks locally before sending, and what it prints (never a secret value).
 */

const h = vi.hoisted(() => ({
	// biome-ignore lint/suspicious/noExplicitAny: the tRPC client mock is untyped, like the CLI client.
	client: {} as any,
	prompt: vi.fn(),
	stream: vi.fn(),
	emitNeedsUpgrade: vi.fn(),
	promptEntitlementRemedy: vi.fn(),
}));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	getApiUrl: () => "https://tarout.sa",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

// The real prompt primitives run (they own the needs_input / TTY split); only
// the terminal UI underneath them is scripted.
vi.mock("inquirer", () => ({ default: { prompt: h.prompt } }));

vi.mock("../src/commands/deploy.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/commands/deploy.js")>()),
	streamDeploymentWithLogs: h.stream,
	emitNeedsUpgrade: h.emitNeedsUpgrade,
	promptEntitlementRemedy: h.promptEntitlementRemedy,
}));

import { Command } from "commander";
import {
	NO_DEPLOYMENT_TO_FOLLOW,
	registerTemplateCommands,
} from "../src/commands/template";
import { setGlobalOptions } from "../src/lib/output";
import {
	checkTemplateEnv,
	parseEnvAssignments,
	summarizeTemplateEnv,
	TEMPLATE_AFTER_APPROVAL_NOTE,
	TEMPLATE_UNSUPPORTED_MESSAGE,
	type Template,
} from "../src/lib/templates";

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
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	h.prompt.mockReset();
	h.stream.mockReset();
	h.emitNeedsUpgrade.mockReset();
	h.promptEntitlementRemedy.mockReset();
	// biome-ignore lint/suspicious/noExplicitAny: the tRPC client mock is untyped, like the CLI client.
	h.client = {} as any;
});

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerTemplateCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON lines are asserted field by field.
type Json = Record<string, any>;

function jsonLines(): Json[] {
	return stdout
		.map((line) => {
			try {
				return JSON.parse(line) as Json;
			} catch {
				return null;
			}
		})
		.filter((v): v is Json => !!v && typeof v === "object");
}

/** The terminal JSON envelopes on stdout (lines with a `success` key). */
const envelopes = () => jsonLines().filter((l) => "success" in l);
const needsInput = () => jsonLines().filter((l) => l.type === "needs_input");

const WIKI: Template = {
	code: "wiki",
	name: "Team Wiki",
	description: "A wiki for your team.",
	category: "Productivity",
	image: "ghcr.io/example/wiki:1.2",
	port: 3000,
	requiresPostgres: true,
	env: [
		{
			key: "ADMIN_EMAIL",
			description: "Admin sign-in email",
			required: true,
			secret: false,
		},
		{
			key: "SMTP_PASSWORD",
			description: "SMTP password",
			required: true,
			secret: true,
		},
		{
			key: "SESSION_SECRET",
			description: "Signs sessions",
			required: true,
			secret: true,
			generate: "hex32",
		},
		{
			key: "LOG_LEVEL",
			description: "Log verbosity",
			required: false,
			secret: false,
			default: "info",
		},
	],
	docsUrl: "https://example.com/wiki/docs",
	architectures: ["amd64", "arm64"],
};

const STATIC_SITE: Template = {
	code: "static",
	name: "Static Site",
	description: "Serves files.",
	category: "Web",
	image: "nginx:1.27",
	port: 80,
	requiresPostgres: false,
	env: [],
	docsUrl: null,
	architectures: ["amd64"],
};

const DEPLOYED = {
	applicationId: "app_1",
	appName: "team-wiki-x1",
	url: "https://team-wiki-x1.tarout.app",
	postgresId: "pg_1",
	deploymentId: "dep_1",
	generatedEnvKeys: ["SESSION_SECRET"],
};

const APPROVAL_MESSAGE =
	'NEEDS_APPROVAL:pa_123abc: The destructive action "template.deploy" requires human approval for this API key.';

function trpcError(message: string, code: string, reason?: string) {
	return Object.assign(new Error(message), {
		data: { code, ...(reason ? { reason } : {}) },
	});
}

function mockClient(
	options: {
		list?: Template[] | Error;
		info?: Template | Error;
		deploy?: Record<string, unknown> | Error;
	} = {},
) {
	const resolveOrReject = (value: unknown) =>
		value instanceof Error
			? vi.fn().mockRejectedValue(value)
			: vi.fn().mockResolvedValue(value);
	const list = resolveOrReject(options.list ?? [WIKI, STATIC_SITE]);
	const info = resolveOrReject(options.info ?? WIKI);
	const deploy = resolveOrReject(options.deploy ?? DEPLOYED);
	h.client = {
		template: {
			list: { query: list },
			info: { query: info },
			deploy: { mutate: deploy },
		},
	};
	return { list, info, deploy };
}

const FULL_ENV = [
	"--env",
	"ADMIN_EMAIL=me@example.com",
	"--env",
	"SMTP_PASSWORD=hunter2-smtp",
];

describe("tarout template list", () => {
	it("prints code, name, category and whether Postgres is created", async () => {
		const { list } = mockClient();
		await run(["template", "list"]);

		expect(list).toHaveBeenCalledTimes(1);
		const text = out();
		expect(text).toContain("CODE");
		expect(text).toContain("POSTGRES");
		expect(text).toMatch(/wiki\s+Team Wiki\s+Productivity\s+yes/);
		expect(text).toMatch(/static\s+Static Site\s+Web\s+no/);
		expect(text).toContain("2 templates");
		expect(text).toContain("tarout template deploy <code>");
		expect(exitCodes).toEqual([]);
	});

	it("--json returns one {success,data} envelope with every template", async () => {
		mockClient();
		await run(["template", "list"], { json: true });

		expect(stdout).toHaveLength(1);
		const [env] = envelopes();
		expect(env?.success).toBe(true);
		expect(env?.data).toEqual([WIKI, STATIC_SITE]);
	});

	it("says clearly when the server predates templates", async () => {
		mockClient({
			list: trpcError(
				'No "query"-procedure on path "template.list"',
				"NOT_FOUND",
			),
		});
		await run(["template", "list"], { json: true });

		expect(exitCodes).toEqual([4]);
		const [env] = envelopes();
		expect(env?.success).toBe(false);
		expect(env?.error.code).toBe("NOT_FOUND");
		expect(env?.error.message).toBe(TEMPLATE_UNSUPPORTED_MESSAGE);
		expect(env?.error.details).toEqual({
			procedure: "template.list",
			reason: "procedure_unavailable",
		});
	});
});

describe("tarout template info", () => {
	it("shows image, port, database, docs and every variable's source", async () => {
		const { info } = mockClient();
		await run(["template", "info", "wiki"]);

		expect(info).toHaveBeenCalledWith({ code: "wiki" });
		const text = out();
		expect(text).toContain("Team Wiki (wiki)");
		expect(text).toContain("ghcr.io/example/wiki:1.2");
		expect(text).toContain("3000");
		expect(text).toContain("managed PostgreSQL database is created");
		expect(text).toContain("https://example.com/wiki/docs");
		expect(text).toContain("amd64, arm64");
		expect(text).toMatch(/ADMIN_EMAIL\s+yes\s+no\s+you provide/);
		expect(text).toMatch(/SMTP_PASSWORD\s+yes\s+yes\s+you provide/);
		expect(text).toMatch(/SESSION_SECRET\s+yes\s+yes\s+generated \(hex32\)/);
		expect(text).toMatch(/LOG_LEVEL\s+no\s+no\s+default: info/);
		expect(text).toContain(
			"tarout template deploy wiki --env ADMIN_EMAIL=<value> --env SMTP_PASSWORD=<value>",
		);
	});

	it("--json returns the template as the platform sent it", async () => {
		mockClient();
		await run(["template", "info", "wiki"], { json: true });

		const [env] = envelopes();
		expect(env?.success).toBe(true);
		expect(env?.data).toEqual(WIKI);
	});

	it("passes an unknown code's NOT_FOUND through unchanged", async () => {
		mockClient({ info: trpcError('Template "nope" not found', "NOT_FOUND") });
		await run(["template", "info", "nope"], { json: true });

		expect(exitCodes).toEqual([4]);
		const [env] = envelopes();
		expect(env?.error.message).toBe('Template "nope" not found');
		expect(env?.error.message).not.toContain("does not support templates");
	});
});

describe("tarout template deploy: argument checks", () => {
	it("refuses a key the template does not read before creating anything", async () => {
		const { deploy } = mockClient();
		await run(
			["template", "deploy", "wiki", ...FULL_ENV, "--env", "ADMIN_EMAL=x"],
			{ json: true, yes: true },
		);

		expect(deploy).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
		const [env] = envelopes();
		expect(env?.error.code).toBe("INVALID_ARGUMENTS");
		expect(env?.error.message).toContain("does not read ADMIN_EMAL");
		expect(env?.error.message).toContain("Did you mean ADMIN_EMAIL?");
		expect(env?.error.details).toMatchObject({
			template: "wiki",
			unknownKeys: ["ADMIN_EMAL"],
			allowedKeys: ["ADMIN_EMAIL", "SMTP_PASSWORD", "SESSION_SECRET", "LOG_LEVEL"],
		});
	});

	it("rejects a malformed or repeated --env before calling the platform", async () => {
		const { info, deploy } = mockClient();
		await run(["template", "deploy", "wiki", "--env", "ADMIN_EMAIL"], {
			json: true,
		});
		await run(
			[
				"template",
				"deploy",
				"wiki",
				"--env",
				"ADMIN_EMAIL=a@b.c",
				"--env",
				"ADMIN_EMAIL=d@e.f",
			],
			{ json: true },
		);
		await run(["template", "deploy", "wiki", "--name", "  "], { json: true });

		expect(info).not.toHaveBeenCalled();
		expect(deploy).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2, 2, 2]);
		const messages = envelopes().map((e) => e.error.message);
		expect(messages[0]).toContain("Use KEY=VALUE");
		expect(messages[1]).toContain("more than once");
		expect(messages[2]).toContain("--name cannot be empty");
	});

	it("emits needs_input for the first missing required variable, listing all of them", async () => {
		const { deploy } = mockClient();
		await run(["template", "deploy", "wiki"], { json: true, yes: true });

		expect(deploy).not.toHaveBeenCalled();
		expect(exitCodes[0]).toBe(6);
		const [event] = needsInput();
		expect(event).toMatchObject({
			type: "needs_input",
			field: "env.ADMIN_EMAIL",
			kind: "input",
			flag: "--env ADMIN_EMAIL=<value>",
			sensitive: false,
			context: { template: "wiki", key: "ADMIN_EMAIL" },
		});
		expect(event?.context.missing.map((m: Json) => m.key)).toEqual([
			"ADMIN_EMAIL",
			"SMTP_PASSWORD",
		]);
		// Generated and defaulted variables are never asked for.
		expect(JSON.stringify(event)).not.toContain("SESSION_SECRET");
		expect(JSON.stringify(event)).not.toContain("LOG_LEVEL");
	});

	it("asks for a missing secret as a masked, sensitive password", async () => {
		mockClient();
		await run(
			["template", "deploy", "wiki", "--env", "ADMIN_EMAIL=me@example.com"],
			{ nonInteractive: true, yes: true },
		);

		expect(exitCodes[0]).toBe(6);
		const [event] = needsInput();
		expect(event).toMatchObject({
			field: "env.SMTP_PASSWORD",
			kind: "password",
			sensitive: true,
			flag: "--env SMTP_PASSWORD=<value>",
		});
	});

	it("prompts on a terminal, masking secrets, and sends what was typed", async () => {
		const { deploy } = mockClient();
		h.prompt
			.mockResolvedValueOnce({ value: "me@example.com" })
			.mockResolvedValueOnce({ value: "typed-smtp-pass" })
			.mockResolvedValueOnce({ confirmed: true });
		await run(["template", "deploy", "wiki"]);

		expect(exitCodes).toEqual([]);
		const questions = h.prompt.mock.calls.map((call) => call[0][0]);
		expect(questions[0]).toMatchObject({ type: "input" });
		expect(questions[0].message).toContain("ADMIN_EMAIL");
		expect(questions[1]).toMatchObject({ type: "password", mask: "*" });
		expect(questions[1].message).toContain("SMTP_PASSWORD");
		expect(questions[2]).toMatchObject({ type: "confirm" });
		expect(deploy).toHaveBeenCalledWith({
			code: "wiki",
			env: { ADMIN_EMAIL: "me@example.com", SMTP_PASSWORD: "typed-smtp-pass" },
		});
		expect(`${out()}\n${err()}`).not.toContain("typed-smtp-pass");
	});
});

describe("tarout template deploy: database confirmation", () => {
	it("asks before creating a database; --json without --yes emits needs_input", async () => {
		const { deploy } = mockClient();
		await run(["template", "deploy", "wiki", ...FULL_ENV], { json: true });

		expect(deploy).not.toHaveBeenCalled();
		expect(exitCodes[0]).toBe(6);
		const [event] = needsInput();
		expect(event).toMatchObject({
			field: "confirm_template_database",
			kind: "confirm",
			flag: "--yes",
			context: { template: "wiki", requiresPostgres: true },
		});
		expect(event?.question).toContain("managed PostgreSQL database");
	});

	it("does not ask with --yes", async () => {
		const { deploy } = mockClient();
		await run(["template", "deploy", "wiki", ...FULL_ENV], {
			json: true,
			yes: true,
		});

		expect(h.prompt).not.toHaveBeenCalled();
		expect(deploy).toHaveBeenCalledTimes(1);
		expect(exitCodes).toEqual([]);
	});

	it("creates nothing when the answer is no", async () => {
		const { deploy } = mockClient();
		h.prompt.mockResolvedValueOnce({ confirmed: false });
		await run(["template", "deploy", "wiki", ...FULL_ENV]);

		expect(deploy).not.toHaveBeenCalled();
		expect(out()).toContain("Cancelled.");
	});

	it("does not ask when the template creates no database", async () => {
		const { deploy } = mockClient({ info: STATIC_SITE });
		await run(["template", "deploy", "static"], { json: true });

		expect(h.prompt).not.toHaveBeenCalled();
		expect(needsInput()).toEqual([]);
		// No env and no name: the server applies its own defaults.
		expect(deploy).toHaveBeenCalledWith({ code: "static" });
	});
});

describe("tarout template deploy: result", () => {
	it("prints the URL and next steps, never a secret value", async () => {
		const { deploy } = mockClient();
		await run(
			["template", "deploy", "wiki", ...FULL_ENV, "--name", " my wiki "],
			{ yes: true },
		);

		expect(deploy).toHaveBeenCalledWith({
			code: "wiki",
			name: "my wiki",
			env: { ADMIN_EMAIL: "me@example.com", SMTP_PASSWORD: "hunter2-smtp" },
		});
		const text = out();
		expect(text).toContain("https://team-wiki-x1.tarout.app");
		expect(text).toContain("managed PostgreSQL (pg_1)");
		expect(text).toContain("Generated: SESSION_SECRET");
		expect(text).toContain("tarout deploy:status team-wiki-x1");
		expect(text).toContain("tarout env reveal team-wiki-x1 SESSION_SECRET");
		expect(text).toContain("tarout env list team-wiki-x1");
		expect(`${text}\n${err()}`).not.toContain("hunter2-smtp");
		expect(h.stream).not.toHaveBeenCalled();
	});

	it("--json returns one envelope with the result and the next command", async () => {
		mockClient();
		await run(["template", "deploy", "wiki", ...FULL_ENV], {
			json: true,
			yes: true,
		});

		expect(stdout).toHaveLength(1);
		const [env] = envelopes();
		expect(env?.success).toBe(true);
		expect(env?.data).toMatchObject({
			template: "wiki",
			...DEPLOYED,
			nextCommand: "tarout deploy:status team-wiki-x1",
		});
		expect(env?.data.hint).toContain(
			"tarout env reveal team-wiki-x1 <KEY>",
		);
		expect(out()).not.toContain("hunter2-smtp");
	});

	it("--wait follows the deployment with the deploy-follow helper", async () => {
		mockClient();
		await run(["template", "deploy", "wiki", ...FULL_ENV, "--wait"], {
			json: true,
			yes: true,
		});

		expect(h.stream).toHaveBeenCalledWith(
			h.client,
			"dep_1",
			"team-wiki-x1",
			"app_1",
		);
		// The helper owns the final envelope; the template result rides ahead of
		// it as one event line.
		expect(envelopes()).toEqual([]);
		const events = jsonLines().filter((l) => l.type === "event");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: "template_deployed",
			template: "wiki",
			applicationId: "app_1",
			deploymentId: "dep_1",
			generatedEnvKeys: ["SESSION_SECRET"],
		});
		expect(out()).not.toContain("hunter2-smtp");
	});

	it("--wait with no deployment to follow says so instead of hanging", async () => {
		mockClient({ deploy: { ...DEPLOYED, deploymentId: null } });
		await run(["template", "deploy", "wiki", ...FULL_ENV, "--wait"], {
			json: true,
			yes: true,
		});

		expect(h.stream).not.toHaveBeenCalled();
		const [env] = envelopes();
		expect(env?.success).toBe(true);
		expect(env?.data.warnings).toEqual([NO_DEPLOYMENT_TO_FOLLOW]);
		expect(env?.data.nextCommand).toBe("tarout deploy team-wiki-x1");
	});
});

describe("tarout template deploy: refusals", () => {
	it("reports a parked approval with the wait command and the after-approval note", async () => {
		mockClient({
			deploy: trpcError(APPROVAL_MESSAGE, "FORBIDDEN", "needs_approval"),
		});
		await run(["template", "deploy", "wiki", ...FULL_ENV], {
			json: true,
			yes: true,
		});

		expect(exitCodes).toEqual([5]);
		expect(h.emitNeedsUpgrade).not.toHaveBeenCalled();
		const [env] = envelopes();
		expect(env?.error.code).toBe("FORBIDDEN");
		expect(env?.error.details).toMatchObject({
			reason: "needs_approval",
			approvalId: "pa_123abc",
			nextCommand: "tarout approvals wait pa_123abc",
			afterApproval: TEMPLATE_AFTER_APPROVAL_NOTE,
		});
	});

	it("names the concrete wait command in terminal mode, from the message prefix alone", async () => {
		mockClient({ deploy: trpcError(APPROVAL_MESSAGE, "FORBIDDEN") });
		await run(["template", "deploy", "wiki", ...FULL_ENV], { yes: true });

		expect(exitCodes).toEqual([5]);
		expect(err()).toContain("Next: tarout approvals wait pa_123abc");
		expect(err()).toContain(TEMPLATE_AFTER_APPROVAL_NOTE);
	});

	it("hands a plan limit to the billing remedy with the retry command", async () => {
		const refusal = trpcError(
			"Plan limit reached for db.starter.slots: 1/1.",
			"FORBIDDEN",
		);
		mockClient({ deploy: refusal });
		await run(["template", "deploy", "wiki", ...FULL_ENV], {
			json: true,
			yes: true,
		});

		expect(exitCodes).toEqual([5]);
		expect(h.emitNeedsUpgrade).toHaveBeenCalledWith(
			h.client,
			refusal,
			undefined,
			"tarout template deploy wiki",
		);
	});

	it("says clearly when the server predates template.deploy", async () => {
		mockClient({
			deploy: trpcError(
				'No "mutation"-procedure on path "template.deploy"',
				"NOT_FOUND",
			),
		});
		await run(["template", "deploy", "wiki", ...FULL_ENV], {
			json: true,
			yes: true,
		});

		expect(exitCodes).toEqual([4]);
		const [env] = envelopes();
		expect(env?.error.message).toBe(TEMPLATE_UNSUPPORTED_MESSAGE);
		expect(env?.error.details).toMatchObject({ procedure: "template.deploy" });
	});
});

describe("lib/templates", () => {
	it("splits --env on the first = only and keeps explicit empty values", () => {
		expect(
			parseEnvAssignments(["URL=postgres://u:p@h/db?a=b", "EMPTY="]),
		).toEqual({ URL: "postgres://u:p@h/db?a=b", EMPTY: "" });
	});

	it("treats a blank value for a variable the caller must supply as missing", () => {
		const check = checkTemplateEnv(WIKI, {
			ADMIN_EMAIL: "   ",
			SMTP_PASSWORD: "x",
		});
		expect(check.unknown).toEqual([]);
		expect(check.missing.map((v) => v.key)).toEqual(["ADMIN_EMAIL"]);
	});

	it("renames secret to sensitive and drops a secret's default for agents", () => {
		expect(
			summarizeTemplateEnv({
				key: "API_TOKEN",
				description: "Token",
				required: false,
				secret: true,
				default: "changeme",
			}),
		).toEqual({
			key: "API_TOKEN",
			description: "Token",
			required: false,
			sensitive: true,
			source: "default",
		});
	});
});
