import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout agent sessions`: the account's agent credentials from
 * `user.listApiKeys`, grouped as OAuth connections and API keys. The key's
 * leading characters (`start`) must never reach the output, and a refusal must
 * read as a clear PERMISSION_DENIED, not a stack trace. There is no revoke.
 */

const h = vi.hoisted(() => ({
	// biome-ignore lint/suspicious/noExplicitAny: the tRPC client mock is untyped, like the CLI client.
	client: {} as any,
}));

vi.mock("../src/lib/api.js", async () => ({
	...(await vi.importActual<typeof import("../src/lib/api")>(
		"../src/lib/api",
	)),
	getApiClient: () => h.client,
}));

vi.mock("../src/lib/config.js", async () => ({
	...(await vi.importActual<typeof import("../src/lib/config")>(
		"../src/lib/config",
	)),
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	getApiUrl: () => "https://tarout.sa",
	getToken: () => "tok_test",
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerAgentCommands } from "../src/commands/agent";
import { toAgentSession } from "../src/lib/agent-sessions";
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
	// biome-ignore lint/suspicious/noExplicitAny: the tRPC client mock is untyped, like the CLI client.
	h.client = {} as any;
});

async function run(opts: Partial<typeof RESET> = {}): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerAgentCommands(program);
	try {
		await program.parseAsync(["node", "tarout", "agent", "sessions"]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

// biome-ignore lint/suspicious/noExplicitAny: parsed JSON envelopes are asserted field by field.
type Envelope = Record<string, any>;

function envelope(): Envelope {
	const parsed = stdout
		.map((line) => {
			try {
				return JSON.parse(line) as Envelope;
			} catch {
				return null;
			}
		})
		.filter((v): v is Envelope => !!v && "success" in v);
	expect(parsed).toHaveLength(1);
	return parsed[0] as Envelope;
}

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

const ROWS = [
	{
		id: "key_oauth_1",
		name: "Claude (OAuth)",
		prefix: "mcp",
		start: "mcp_SECRETSTART1",
		enabled: true,
		rateLimitEnabled: false,
		requestCount: 12,
		lastRequest: "2026-09-29T09:00:00.000Z",
		expiresAt: FAR_FUTURE,
		createdAt: "2026-09-20T08:00:00.000Z",
		scope: { organizationId: "org_1", projectId: null },
		tier: "operator",
		areas: null,
	},
	{
		id: "key_oauth_2",
		name: "Cursor (OAuth)",
		prefix: "mcp",
		start: "mcp_SECRETSTART2",
		enabled: true,
		requestCount: 0,
		lastRequest: null,
		expiresAt: "2026-01-01T00:00:00.000Z",
		createdAt: "2025-12-01T08:00:00.000Z",
		scope: { organizationId: "org_1", projectId: null },
		tier: "operator",
		areas: null,
	},
	{
		id: "key_agent_1",
		name: "ci-bot",
		prefix: "agent",
		start: "agent_SECRETSTART3",
		enabled: false,
		requestCount: 40,
		lastRequest: "2026-09-28T10:00:00.000Z",
		expiresAt: null,
		createdAt: "2026-09-01T08:00:00.000Z",
		scope: { organizationId: "org_1", projectId: "prj_1" },
		tier: "read_only",
		areas: ["apps"],
		permissions: '{"tier":"read_only"}',
	},
];

function mockList(result: unknown[] | Error) {
	const query = vi.fn();
	if (result instanceof Error) query.mockRejectedValue(result);
	else query.mockResolvedValue(result);
	h.client = { user: { listApiKeys: { query } } };
	return query;
}

function trpcError(message: string, data: Record<string, unknown>) {
	return Object.assign(new Error(message), { data });
}

describe("toAgentSession", () => {
	it("keeps only safe fields and derives the kind, name and status", () => {
		const now = Date.parse("2026-09-29T12:00:00.000Z");
		const oauth = toAgentSession(ROWS[0] as never, now);
		expect(oauth).toMatchObject({
			kind: "oauth",
			name: "Claude",
			tier: "operator",
			status: "active",
			lastUsedAt: "2026-09-29T09:00:00.000Z",
		});
		expect(Object.keys(oauth)).not.toContain("start");
		expect(JSON.stringify(oauth)).not.toContain("SECRETSTART");
		expect(toAgentSession(ROWS[1] as never, now).status).toBe("expired");
		const key = toAgentSession(ROWS[2] as never, now);
		expect(key).toMatchObject({
			kind: "api_key",
			name: "ci-bot",
			prefix: "agent",
			status: "paused",
			projectId: "prj_1",
			areas: ["apps"],
		});
		expect(JSON.stringify(key)).not.toContain("permissions");
	});
});

describe("tarout agent sessions", () => {
	it("prints OAuth connections and API keys as tables, then the dashboard note", async () => {
		const query = mockList(ROWS);
		await run();
		expect(query).toHaveBeenCalledTimes(1);
		expect(exitCodes).toEqual([]);
		const text = out();
		expect(text).toContain("OAuth connections (2)");
		expect(text).toMatch(/CLIENT\s+TIER\s+STATUS\s+CREATED\s+LAST USED\s+EXPIRES/);
		expect(text).toMatch(/Claude\s+operator\s+● active/);
		expect(text).toMatch(/Cursor\s+operator\s+○ expired\s+.+never/);
		expect(text).not.toContain("(OAuth)");
		expect(text).toContain("API keys (1)");
		expect(text).toMatch(/NAME\s+PREFIX\s+TIER\s+STATUS\s+LAST USED/);
		expect(text).toMatch(/ci-bot\s+agent\s+read-only\s+○ paused/);
		expect(text).toContain(
			"Revoke or pause any of these in the dashboard (Agent > Keys): https://tarout.sa/dashboard/agent",
		);
		expect(text).not.toContain("SECRETSTART");
		expect(text).not.toMatch(/revoke\s+</i);
	});

	it("--json prints one envelope with both groups and no key material", async () => {
		mockList(ROWS);
		await run({ json: true });
		const env = envelope();
		expect(env.success).toBe(true);
		expect(env.data.dashboardUrl).toBe("https://tarout.sa/dashboard/agent");
		expect(env.data.oauthConnections.map((s: Envelope) => s.name)).toEqual([
			"Claude",
			"Cursor",
		]);
		expect(env.data.keys.map((s: Envelope) => s.id)).toEqual(["key_agent_1"]);
		expect(out()).not.toContain("SECRETSTART");
		expect(out()).not.toContain('"start"');
	});

	it("says so when there are no credentials", async () => {
		mockList([]);
		await run();
		expect(out()).toContain(
			"No agent credentials for this account in this organization.",
		);
		expect(out()).toContain("https://tarout.sa/dashboard/agent");
	});

	it("turns a refusal into PERMISSION_DENIED (exit 5) with the dashboard link", async () => {
		mockList(
			trpcError(
				"Credential management requires an interactive signed-in session - an API key cannot mint, rotate, or re-enable keys. Re-authenticating will not help; use the Tarout dashboard for this action.",
				{ code: "FORBIDDEN", reason: "needs_interactive_session" },
			),
		);
		await run();
		expect(exitCodes).toEqual([5]);
		expect(err()).toContain(
			"Listing agent sessions is not available to this credential",
		);
		expect(err()).toContain("https://tarout.sa/dashboard/agent");
		expect(err()).not.toMatch(/\n\s+at /);
	});

	it("--json refusal is one PERMISSION_DENIED envelope with the reason", async () => {
		mockList(
			trpcError("AGENT_POLICY: denied by rule user.*", {
				code: "FORBIDDEN",
				reason: "policy_denied",
			}),
		);
		await run({ json: true });
		expect(exitCodes).toEqual([5]);
		const env = envelope();
		expect(env.success).toBe(false);
		expect(env.error.code).toBe("PERMISSION_DENIED");
		expect(env.error.message).toContain("AGENT_POLICY: denied by rule user.*.");
		expect(env.error.details).toMatchObject({
			procedure: "user.listApiKeys",
			reason: "policy_denied",
			dashboardUrl: "https://tarout.sa/dashboard/agent",
		});
	});

	it("an older server without the procedure is NOT_FOUND (exit 4)", async () => {
		mockList(
			trpcError('No "query"-procedure on path "user.listApiKeys"', {
				code: "NOT_FOUND",
			}),
		);
		await run();
		expect(exitCodes).toEqual([4]);
		expect(err()).toContain("cannot list agent sessions");
	});
});
