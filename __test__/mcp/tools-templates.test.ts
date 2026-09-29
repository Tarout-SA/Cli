import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
	getAuthScope: () => ({ scope: "none" }),
}));

const WIKI = {
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

const DEPLOYED = {
	applicationId: "app_1",
	appName: "team-wiki-x1",
	url: "https://team-wiki-x1.tarout.app",
	postgresId: "pg_1",
	deploymentId: "dep_1",
	generatedEnvKeys: ["SESSION_SECRET"],
};

function trpcError(message: string, code: string, reason?: string) {
	return Object.assign(new Error(message), {
		data: { code, ...(reason ? { reason } : {}) },
	});
}

const fakeClient = {
	template: {
		list: { query: vi.fn() },
		info: { query: vi.fn() },
		deploy: { mutate: vi.fn() },
	},
	subscription: {
		getCatalog: { query: vi.fn().mockResolvedValue({ plans: [], addons: [] }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	TEMPLATE_AFTER_APPROVAL_NOTE,
	TEMPLATE_UNSUPPORTED_MESSAGE,
} from "../../src/lib/templates";
import { sanitizeToolResult } from "../../src/mcp/sanitize-result";
import { registerTemplateTools } from "../../src/mcp/tools/templates";

function registered() {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerTemplateTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool is SDK-internal.
	return (server as any)._registeredTools as Record<string, any>;
}

type Result = { content: [{ text: string }]; isError?: boolean };

/** Invokes a handler and runs the result through the real MCP sanitizer. */
async function invoke(name: string, args: unknown): Promise<Result> {
	const reg = registered()[name];
	return sanitizeToolResult((await reg.handler(args)) as Result, name);
}

// biome-ignore lint/suspicious/noExplicitAny: parsed tool bodies are asserted field by field.
const body = (r: Result) => JSON.parse(r.content[0].text) as Record<string, any>;

beforeEach(() => {
	fakeClient.template.list.query.mockReset().mockResolvedValue([WIKI]);
	fakeClient.template.info.query.mockReset().mockResolvedValue(WIKI);
	fakeClient.template.deploy.mutate.mockReset().mockResolvedValue(DEPLOYED);
});

describe("template tools", () => {
	it("registers list and info read-only and deploy with no hint, like app_create", () => {
		const tools = registered();
		expect(Object.keys(tools).sort()).toEqual([
			"template_deploy",
			"template_info",
			"template_list",
		]);
		expect(tools.template_list.annotations).toEqual({ readOnlyHint: true });
		expect(tools.template_info.annotations).toEqual({ readOnlyHint: true });
		expect(tools.template_deploy.annotations).toBeUndefined();
	});

	it("template_list returns a trimmed catalog", async () => {
		const r = await invoke("template_list", {});
		expect(r.isError).toBeUndefined();
		expect(body(r)).toEqual({
			count: 1,
			templates: [
				{
					code: "wiki",
					name: "Team Wiki",
					description: "A wiki for your team.",
					category: "Productivity",
					requiresPostgres: true,
				},
			],
		});
	});

	it("template_info keeps the secret flag readable through the sanitizer", async () => {
		const r = await invoke("template_info", { code: "wiki" });
		expect(fakeClient.template.info.query).toHaveBeenCalledWith({ code: "wiki" });
		const env = body(r).template.env as Array<Record<string, unknown>>;
		expect(JSON.stringify(env)).not.toContain("redacted");
		expect(env.map((v) => [v.key, v.sensitive, v.source])).toEqual([
			["ADMIN_EMAIL", false, "you provide"],
			["SMTP_PASSWORD", true, "you provide"],
			["SESSION_SECRET", true, "generated (hex32)"],
			["LOG_LEVEL", false, "default: info"],
		]);
		expect(env[2]?.generate).toBe("hex32");
		expect(env[3]?.default).toBe("info");
	});

	it("template_info on an older server says templates are unsupported", async () => {
		fakeClient.template.info.query.mockRejectedValue(
			trpcError('No "query"-procedure on path "template.info"', "NOT_FOUND"),
		);
		const r = await invoke("template_info", { code: "wiki" });
		expect(r.isError).toBe(true);
		expect(body(r)).toMatchObject({
			code: "NOT_FOUND",
			error: TEMPLATE_UNSUPPORTED_MESSAGE,
			details: { procedure: "template.info", reason: "procedure_unavailable" },
		});
	});
});

describe("template_deploy", () => {
	it("refuses an unknown key before creating anything", async () => {
		const r = await invoke("template_deploy", {
			code: "wiki",
			env: { ADMIN_EMAIL: "a@b.c", SMTP_PASSWORD: "x", NOPE: "1" },
		});
		expect(r.isError).toBe(true);
		expect(body(r)).toMatchObject({
			code: "INVALID_ARGUMENTS",
			details: { unknownKeys: ["NOPE"] },
		});
		expect(fakeClient.template.deploy.mutate).not.toHaveBeenCalled();
	});

	it("returns NEEDS_INPUT listing every missing required variable", async () => {
		const r = await invoke("template_deploy", {
			code: "wiki",
			env: { ADMIN_EMAIL: "a@b.c" },
		});
		expect(r.isError).toBe(true);
		const b = body(r);
		expect(b.code).toBe("NEEDS_INPUT");
		expect(b.details.missing).toEqual([
			{ key: "SMTP_PASSWORD", description: "SMTP password", sensitive: true },
		]);
		expect(fakeClient.template.deploy.mutate).not.toHaveBeenCalled();
	});

	it("deploys with the given name and env and never echoes a value", async () => {
		const r = await invoke("template_deploy", {
			code: "wiki",
			name: "my wiki",
			env: { ADMIN_EMAIL: "a@b.c", SMTP_PASSWORD: "hunter2-smtp" },
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.template.deploy.mutate).toHaveBeenCalledWith({
			code: "wiki",
			name: "my wiki",
			env: { ADMIN_EMAIL: "a@b.c", SMTP_PASSWORD: "hunter2-smtp" },
		});
		const b = body(r);
		expect(b).toMatchObject({ template: "wiki", ...DEPLOYED });
		expect(b.hint).toContain("tarout env reveal team-wiki-x1 <KEY>");
		expect(r.content[0].text).not.toContain("hunter2-smtp");
	});

	it("adds the after-approval note to a parked deploy", async () => {
		fakeClient.template.deploy.mutate.mockRejectedValue(
			trpcError(
				'NEEDS_APPROVAL:pa_123abc: The destructive action "template.deploy" requires human approval for this API key.',
				"FORBIDDEN",
				"needs_approval",
			),
		);
		const r = await invoke("template_deploy", {
			code: "wiki",
			env: { ADMIN_EMAIL: "a@b.c", SMTP_PASSWORD: "x" },
		});
		expect(r.isError).toBe(true);
		expect(body(r)).toMatchObject({
			code: "NEEDS_APPROVAL",
			details: {
				approvalId: "pa_123abc",
				afterApproval: TEMPLATE_AFTER_APPROVAL_NOTE,
			},
		});
	});

	it("turns a plan limit into the billing_upgrade remedy", async () => {
		fakeClient.template.deploy.mutate.mockRejectedValue(
			trpcError("Plan limit reached for db.starter.slots: 1/1.", "FORBIDDEN"),
		);
		const r = await invoke("template_deploy", {
			code: "wiki",
			env: { ADMIN_EMAIL: "a@b.c", SMTP_PASSWORD: "x" },
		});
		const b = body(r);
		expect(b.code).toBe("FORBIDDEN");
		expect(b.remediation).toContain("billing_upgrade");
		expect(b.details.entitlementKey).toBe("db.starter.slots");
	});
});
