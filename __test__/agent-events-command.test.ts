import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout agent events`: the agent activity timeline from
 * `dashboard.getAgentActivity` (scope "agent"). Printed oldest first; `--since`
 * pages back client-side; `--follow` polls, dedupes by id, prints only new rows
 * oldest first, and stops cleanly on Ctrl+C. A refusal reads as a clear
 * PERMISSION_DENIED.
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
import {
	type AgentEvent,
	FOLLOW_OVERLAP_MS,
	fetchAgentEvents,
	parseSinceDuration,
	watchAgentEvents,
} from "../src/lib/agent-events";
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
	vi.useRealTimers();
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
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
	registerAgentCommands(program);
	try {
		await program.parseAsync(["node", "tarout", "agent", "events", ...argv]);
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
		.filter((v): v is Json => !!v);
}

const BASE = Date.parse("2026-09-29T10:00:00.000Z");

/** A platform row, `secondsAgo` before BASE. */
function item(id: string, secondsAgo: number, overrides: Json = {}) {
	return {
		id,
		router: "application",
		proc: `deploy_${id}`,
		surface: "cli",
		status: "ok",
		at: new Date(BASE - secondsAgo * 1000).toISOString(),
		apiKeyId: "key_abcdef123456",
		keyName: "ci-bot",
		...overrides,
	};
}

type Page = { items: unknown[]; nextCursor?: string };

/** Answers each getAgentActivity call with the next page (the last repeats). */
function mockFeed(pages: Array<Page | Error>) {
	const query = vi.fn();
	for (const page of pages) {
		if (page instanceof Error) query.mockRejectedValueOnce(page);
		else query.mockResolvedValueOnce(page);
	}
	const last = pages[pages.length - 1];
	if (last instanceof Error) query.mockRejectedValue(last);
	else query.mockResolvedValue(last ?? { items: [] });
	h.client = { dashboard: { getAgentActivity: { query } } };
	return query;
}

function trpcError(message: string, data: Record<string, unknown>) {
	return Object.assign(new Error(message), { data });
}

/**
 * Ctrl+C without `process.emit("SIGINT")`, which would also fire the test
 * runner's own SIGINT listeners: calls the handler the command registered.
 */
function watchSigint(): () => void {
	const once = vi.spyOn(process, "once");
	return () => {
		const call = [...once.mock.calls]
			.reverse()
			.find(([event]) => event === "SIGINT");
		(call?.[1] as (() => void) | undefined)?.();
	};
}

describe("parseSinceDuration", () => {
	it("reads d/h/m/s units and bare seconds", () => {
		expect(parseSinceDuration("90")).toBe(90_000);
		expect(parseSinceDuration("15m")).toBe(900_000);
		expect(parseSinceDuration("1h30m")).toBe(5_400_000);
		expect(parseSinceDuration("7d")).toBe(604_800_000);
		expect(() => parseSinceDuration("yesterday")).toThrow(/--since must be/);
		expect(() => parseSinceDuration("0")).toThrow(/--since must be/);
	});
});

describe("fetchAgentEvents", () => {
	it("asks for the agent scope and returns rows oldest first", async () => {
		const query = mockFeed([
			{ items: [item("c", 10), item("b", 20), item("a", 30)] },
		]);
		const events = await fetchAgentEvents(h.client, { limit: 3 });
		expect(query).toHaveBeenCalledWith({ scope: "agent", limit: 3 });
		expect(events.map((e) => e.id)).toEqual(["a", "b", "c"]);
		expect(events[0]).toMatchObject({
			procedure: "application.deploy_a",
			surface: "cli",
			status: "ok",
			keyName: "ci-bot",
		});
	});

	it("pages back with the cursor and stops at the first row older than --since", async () => {
		const query = mockFeed([
			{ items: [item("d", 10), item("c", 60)], nextCursor: "c" },
			{ items: [item("b", 120), item("a", 7200)], nextCursor: "a" },
			{ items: [item("z", 9000)] },
		]);
		const events = await fetchAgentEvents(h.client, {
			sinceMs: 600_000,
			now: () => BASE,
		});
		expect(events.map((e) => e.id)).toEqual(["b", "c", "d"]);
		expect(query).toHaveBeenCalledTimes(2);
		// --since without --limit may return up to 500 rows, in pages of 100.
		expect(query).toHaveBeenNthCalledWith(1, { scope: "agent", limit: 100 });
		expect(query).toHaveBeenNthCalledWith(2, {
			scope: "agent",
			limit: 100,
			cursor: "c",
		});
	});
});

describe("watchAgentEvents", () => {
	it("delivers the backlog, then only unseen rows, oldest first, including a late write", async () => {
		const query = mockFeed([
			// Backlog: the 2 most recent.
			{ items: [item("b", 20), item("a", 30)] },
			// Poll 1: two new rows, the already-printed b, and a late write "late"
			// stamped before b but after the backlog's oldest row.
			{ items: [item("d", 5), item("c", 8), item("b", 20), item("late", 25)] },
			// Poll 2: nothing new (all seen), plus a row older than the floor.
			{ items: [item("d", 5), item("c", 8), item("b", 20), item("old", 3600)] },
			// Poll 3: one new row.
			{ items: [item("e", 1), item("d", 5)] },
		]);
		const batches: string[][] = [];
		let polls = 0;
		await watchAgentEvents(h.client, {
			limit: 2,
			now: () => BASE,
			sleep: async () => {
				polls++;
			},
			isInterrupted: () => polls >= 4,
			onEvents: (events: AgentEvent[]) => batches.push(events.map((e) => e.id)),
		});
		expect(batches).toEqual([["a", "b"], ["late", "c", "d"], ["e"]]);
		expect(query).toHaveBeenCalledTimes(4);
	});

	it("does not reprint rows the --limit cut from the backlog", async () => {
		mockFeed([
			{ items: [item("b", 20)] },
			// "a" existed before (older than the backlog's oldest row): not new.
			{ items: [item("c", 2), item("b", 20), item("a", 30)] },
		]);
		const batches: string[][] = [];
		let polls = 0;
		await watchAgentEvents(h.client, {
			limit: 1,
			sleep: async () => {
				polls++;
			},
			isInterrupted: () => polls >= 2,
			onEvents: (events) => batches.push(events.map((e) => e.id)),
		});
		expect(batches).toEqual([["b"], ["c"]]);
	});

	it("rescans only the overlap window behind the newest row", async () => {
		const query = mockFeed([
			{ items: [item("b", 0)], nextCursor: "b" },
			{
				items: [item("b", 0), item("far", FOLLOW_OVERLAP_MS / 1000 + 5)],
				nextCursor: "far",
			},
		]);
		let polls = 0;
		await watchAgentEvents(h.client, {
			limit: 1,
			sleep: async () => {
				polls++;
			},
			isInterrupted: () => polls >= 2,
			onEvents: () => {},
		});
		// The poll stopped at "far" (older than newest - overlap), no extra page.
		expect(query).toHaveBeenCalledTimes(2);
	});

	it("tolerates two failed polls and throws on the third", async () => {
		const boom = new Error("socket hang up");
		mockFeed([{ items: [item("a", 1)] }, boom]);
		let polls = 0;
		await expect(
			watchAgentEvents(h.client, {
				sleep: async () => {
					polls++;
				},
				onEvents: () => {},
			}),
		).rejects.toThrow("socket hang up");
		expect(polls).toBe(3);
	});
});

describe("tarout agent events", () => {
	it("prints the timeline oldest first with the error summary", async () => {
		const query = mockFeed([
			{
				items: [
					item("b", 10, {
						router: "postgres",
						proc: "remove",
						status: "error",
						errorCode: "FORBIDDEN",
						errorMessage: "AGENT_READ_ONLY: this key is read-only",
					}),
					item("a", 20, { surface: "mcp", keyName: "Claude (OAuth)" }),
				],
			},
		]);
		await run([]);
		expect(exitCodes).toEqual([]);
		expect(query).toHaveBeenCalledWith({ scope: "agent", limit: 30 });
		const text = out();
		expect(text).toMatch(/TIME\s+AGENT\s+PROCEDURE\s+SURFACE\s+STATUS\s+ERROR/);
		const first = text.indexOf("application.deploy_a");
		const second = text.indexOf("postgres.remove");
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		expect(text).toMatch(/Claude \(OAuth\)\s+application\.deploy_a\s+mcp\s+✓ ok/);
		expect(text).toMatch(
			/ci-bot\s+postgres\.remove\s+cli\s+✗ error\s+FORBIDDEN: AGENT_READ_ONLY: this key is read-only/,
		);
		expect(text).toContain("2 events, oldest first");
	});

	it("--json prints one envelope, oldest first", async () => {
		mockFeed([{ items: [item("b", 10), item("a", 20)] }]);
		await run(["--limit", "5"], { json: true });
		const lines = jsonLines();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.success).toBe(true);
		expect(lines[0]?.data.count).toBe(2);
		expect(lines[0]?.data.events.map((e: Json) => e.id)).toEqual(["a", "b"]);
	});

	it("says so when nothing happened in the --since window", async () => {
		mockFeed([{ items: [] }]);
		await run(["--since", "1h"]);
		expect(out()).toContain("No agent activity in the last 1h.");
	});

	it("rejects a bad --limit or --since as INVALID_ARGUMENTS (exit 2)", async () => {
		mockFeed([{ items: [] }]);
		await run(["--limit", "0"]);
		await run(["--limit", "501"]);
		await run(["--since", "soon"]);
		expect(exitCodes).toEqual([2, 2, 2]);
		expect(err()).toContain("--limit must be a whole number from 1 to 500");
		expect(err()).toContain("--since must be a duration");
	});

	it("turns a refusal into PERMISSION_DENIED (exit 5) with the dashboard link", async () => {
		mockFeed([
			trpcError('AGENT_SCOPE: denied by agent policy rule "dashboard.*"', {
				code: "FORBIDDEN",
				reason: "policy_denied",
			}),
		]);
		await run([], { json: true });
		expect(exitCodes).toEqual([5]);
		const env = jsonLines()[0] as Json;
		expect(env.success).toBe(false);
		expect(env.error.code).toBe("PERMISSION_DENIED");
		expect(env.error.message).toContain(
			"Reading the agent activity feed is not available to this credential",
		);
		expect(env.error.details).toMatchObject({
			procedure: "dashboard.getAgentActivity",
			dashboardUrl: "https://tarout.sa/dashboard/agent",
		});
	});

	it("--follow --json streams NDJSON, dedupes, and stops cleanly on Ctrl+C", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pressCtrlC = watchSigint();
		const query = vi
			.fn()
			.mockResolvedValueOnce({ items: [item("b", 20), item("a", 30)] })
			.mockImplementationOnce(async () => {
				// Ctrl+C arrives while this poll is in flight: its rows still print.
				pressCtrlC();
				return { items: [item("c", 5), item("b", 20), item("a", 30)] };
			});
		h.client = { dashboard: { getAgentActivity: { query } } };
		const before = process.listenerCount("SIGINT");

		const done = run(["--follow"], { json: true });
		await vi.advanceTimersByTimeAsync(3000);
		await done;

		expect(exitCodes).toEqual([]);
		expect(query).toHaveBeenCalledTimes(2);
		const lines = jsonLines();
		expect(lines.map((line) => line.id)).toEqual(["a", "b", "c"]);
		for (const line of lines) {
			expect(line.type).toBe("agent_event");
			expect(line).not.toHaveProperty("success");
		}
		expect(process.listenerCount("SIGINT")).toBe(before);
	});

	it("--follow in human mode prints the header once and a stop line", async () => {
		const query = mockFeed([{ items: [item("a", 30)] }]);
		const pressCtrlC = watchSigint();
		const before = process.listenerCount("SIGINT");
		const done = run(["--follow"]);
		// Ctrl+C during the 3s sleep: it wakes at once and nothing else is fetched.
		await vi.waitFor(() => expect(out()).toContain("application.deploy_a"));
		pressCtrlC();
		await done;
		expect(exitCodes).toEqual([]);
		expect(query).toHaveBeenCalledTimes(1);
		expect(process.listenerCount("SIGINT")).toBe(before);
		const text = out();
		expect(text).toContain("Following agent activity (polling every 3s)");
		expect(text.match(/TIME\s+AGENT/g)).toHaveLength(1);
		expect(text).toContain("Stopped following agent activity.");
	});
});
