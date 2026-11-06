import { describe, expect, it } from "vitest";
import {
	AGENT_WEBHOOK_EVENTS,
	type AgentWebhook,
	assertPublicHttpsUrl,
	buildCreateWebhookInput,
	buildUpdateWebhookInput,
	describeDeliveryOutcome,
	findAgentWebhook,
	isAgentWebhookEvent,
	parseDeliveriesLimit,
	parseWebhookEvents,
	suggestWebhookName,
	withWebhookGuidance,
} from "../src/commands/agent-webhooks";
import { CliError, InvalidArgumentError } from "../src/lib/errors";
import { ExitCode } from "../src/utils/exit-codes";

function webhook(partial: Partial<AgentWebhook>): AgentWebhook {
	return {
		id: "wh_aaaaaaaa",
		organizationId: "org-1",
		name: "hook",
		url: "https://example.com/hook",
		events: ["deployment.failed"],
		enabled: true,
		...partial,
	};
}

describe("agent webhook events", () => {
	it("mirrors the platform event enum exactly", () => {
		expect([...AGENT_WEBHOOK_EVENTS]).toEqual([
			"deployment.failed",
			"application.unhealthy",
			"monitor.down",
			"backup.failed",
			"approval.requested",
			"scheduled_task.failed",
			"scheduled_task.recovered",
		]);
		expect(isAgentWebhookEvent("monitor.down")).toBe(true);
		expect(isAgentWebhookEvent("monitor.up")).toBe(false);
	});

	it("parses repeated and comma-separated flags, de-duplicating in order", () => {
		expect(
			parseWebhookEvents(["monitor.down", "backup.failed,monitor.down"]),
		).toEqual(["monitor.down", "backup.failed"]);
		expect(parseWebhookEvents(["  Deployment.Failed  "])).toEqual([
			"deployment.failed",
		]);
	});

	it("returns undefined when no event flag was passed, so update stays a no-op", () => {
		expect(parseWebhookEvents(undefined)).toBeUndefined();
		expect(parseWebhookEvents([])).toBeUndefined();
	});

	it("expands --all-events to every event", () => {
		expect(parseWebhookEvents(undefined, true)).toEqual([
			...AGENT_WEBHOOK_EVENTS,
		]);
		// --all-events wins over an explicit list rather than intersecting it.
		expect(parseWebhookEvents(["monitor.down"], true)).toEqual([
			...AGENT_WEBHOOK_EVENTS,
		]);
	});

	it("rejects an unknown event name and suggests the closest match", () => {
		expect(() => parseWebhookEvents(["deployment.faild"])).toThrow(
			InvalidArgumentError,
		);
		expect(() => parseWebhookEvents(["deployment.faild"])).toThrow(
			/Did you mean deployment\.failed/,
		);
		expect(() => parseWebhookEvents(["monitor.up"])).toThrow(
			/Valid events: deployment\.failed/,
		);
	});

	it("rejects an event flag that resolves to nothing", () => {
		expect(() => parseWebhookEvents([" ", ","])).toThrow(
			/Subscribe to at least one event/,
		);
	});
});

describe("agent webhook URL validation", () => {
	it("accepts a public https endpoint and returns it trimmed", () => {
		expect(assertPublicHttpsUrl("  https://example.com/tarout-hook  ")).toBe(
			"https://example.com/tarout-hook",
		);
	});

	it("rejects an empty, unparseable, or non-https URL", () => {
		expect(() => assertPublicHttpsUrl("")).toThrow(InvalidArgumentError);
		expect(() => assertPublicHttpsUrl("not a url")).toThrow(/not a valid URL/);
		expect(() => assertPublicHttpsUrl("http://example.com/hook")).toThrow(
			/must use https/,
		);
	});

	it("rejects endpoints Tarout can never reach", () => {
		for (const url of [
			"https://localhost/hook",
			"https://127.0.0.1/hook",
			"https://10.0.0.5/hook",
			"https://192.168.1.10/hook",
			"https://172.20.3.4/hook",
			"https://169.254.169.254/latest/meta-data",
			"https://metadata.google.internal/hook",
			"https://[::1]/hook",
		]) {
			expect(() => assertPublicHttpsUrl(url)).toThrow(
				/not reachable from Tarout/,
			);
		}
	});

	it("does not mistake a public IP or long host for a private one", () => {
		expect(assertPublicHttpsUrl("https://172.15.0.1/hook")).toBe(
			"https://172.15.0.1/hook",
		);
		expect(assertPublicHttpsUrl("https://8.8.8.8/hook")).toBe(
			"https://8.8.8.8/hook",
		);
	});

	it("rejects a URL past the server's 2048 character limit", () => {
		const long = `https://example.com/${"a".repeat(2100)}`;
		expect(() => assertPublicHttpsUrl(long)).toThrow(/too long/);
	});
});

describe("agent webhook create input", () => {
	it("sends the exact agentWebhook.create contract", () => {
		expect(
			buildCreateWebhookInput("https://example.com/hooks/tarout", {
				name: " Deploy watcher ",
				event: ["deployment.failed", "monitor.down"],
			}),
		).toEqual({
			name: "Deploy watcher",
			url: "https://example.com/hooks/tarout",
			events: ["deployment.failed", "monitor.down"],
			enabled: true,
		});
	});

	it("names the webhook after the endpoint when --name is omitted", () => {
		expect(suggestWebhookName("https://ci.example.com/hooks/tarout")).toBe(
			"ci.example.com/hooks",
		);
		expect(suggestWebhookName("https://ci.example.com")).toBe("ci.example.com");
		expect(
			buildCreateWebhookInput("https://ci.example.com/hooks", {
				allEvents: true,
			}),
		).toEqual({
			name: "ci.example.com/hooks",
			url: "https://ci.example.com/hooks",
			events: [...AGENT_WEBHOOK_EVENTS],
			enabled: true,
		});
	});

	it("maps --disabled onto enabled: false", () => {
		expect(
			buildCreateWebhookInput("https://example.com/hook", {
				event: ["backup.failed"],
				disabled: true,
			}).enabled,
		).toBe(false);
	});

	it("refuses to create a webhook subscribed to nothing", () => {
		expect(() => buildCreateWebhookInput("https://example.com/hook")).toThrow(
			InvalidArgumentError,
		);
		expect(() =>
			buildCreateWebhookInput("https://example.com/hook", { event: [] }),
		).toThrow(/Subscribe to at least one event/);
	});

	it("validates the URL and the name before any request", () => {
		expect(() =>
			buildCreateWebhookInput("http://example.com/hook", { allEvents: true }),
		).toThrow(/must use https/);
		expect(() =>
			buildCreateWebhookInput("https://example.com/hook", {
				allEvents: true,
				name: "   ",
			}),
		).toThrow(/name cannot be empty/);
		expect(() =>
			buildCreateWebhookInput("https://example.com/hook", {
				allEvents: true,
				name: "x".repeat(101),
			}),
		).toThrow(/too long/);
	});
});

describe("agent webhook update input", () => {
	it("sends only the fields the caller asked to change", () => {
		expect(buildUpdateWebhookInput("wh_1", { name: "Renamed" })).toEqual({
			id: "wh_1",
			name: "Renamed",
		});
		expect(buildUpdateWebhookInput("wh_1", { disable: true })).toEqual({
			id: "wh_1",
			enabled: false,
		});
		expect(buildUpdateWebhookInput("wh_1", { enable: true })).toEqual({
			id: "wh_1",
			enabled: true,
		});
	});

	it("replaces the whole event list when event flags are present", () => {
		expect(
			buildUpdateWebhookInput("wh_1", { event: ["monitor.down"] }),
		).toEqual({ id: "wh_1", events: ["monitor.down"] });
		expect(buildUpdateWebhookInput("wh_1", { allEvents: true }).events).toEqual([
			...AGENT_WEBHOOK_EVENTS,
		]);
	});

	it("omits events entirely when no event flag was passed", () => {
		expect(
			buildUpdateWebhookInput("wh_1", { url: "https://example.com/new" }),
		).toEqual({ id: "wh_1", url: "https://example.com/new" });
	});

	it("rejects an empty update and contradictory enable flags", () => {
		expect(() => buildUpdateWebhookInput("wh_1")).toThrow(/Nothing to update/);
		expect(() => buildUpdateWebhookInput("wh_1", { event: [] })).toThrow(
			/Nothing to update/,
		);
		expect(() =>
			buildUpdateWebhookInput("wh_1", { enable: true, disable: true }),
		).toThrow(/not both/);
	});

	it("validates a replacement URL", () => {
		expect(() =>
			buildUpdateWebhookInput("wh_1", { url: "https://127.0.0.1/hook" }),
		).toThrow(/not reachable from Tarout/);
	});
});

describe("agent webhook identifier resolution", () => {
	const hooks = [
		webhook({ id: "wh_alpha123", name: "Deploy watcher" }),
		webhook({
			id: "wh_beta456",
			name: "deploy watcher",
			url: "https://other.example.com/hook",
		}),
		webhook({ id: "zz_unique", name: "Monitor hook" }),
	];

	it("prefers an exact id over everything else", () => {
		expect(findAgentWebhook(hooks, "wh_beta456")?.id).toBe("wh_beta456");
	});

	it("matches a name or URL case-insensitively when unique", () => {
		expect(findAgentWebhook(hooks, "MONITOR HOOK")?.id).toBe("zz_unique");
		expect(findAgentWebhook(hooks, "https://OTHER.example.com/hook")?.id).toBe(
			"wh_beta456",
		);
	});

	it("matches a unique id prefix", () => {
		expect(findAgentWebhook(hooks, "zz")?.id).toBe("zz_unique");
	});

	it("throws and lists candidates for an ambiguous name or id prefix", () => {
		expect(() => findAgentWebhook(hooks, "deploy watcher")).toThrow(
			/matches 2 webhooks/,
		);
		expect(() => findAgentWebhook(hooks, "wh_")).toThrow(
			InvalidArgumentError,
		);
		expect(() => findAgentWebhook(hooks, "wh_")).toThrow(
			/wh_alpha123 \(Deploy watcher\)/,
		);
	});

	it("returns undefined for an unknown or empty identifier", () => {
		expect(findAgentWebhook(hooks, "nope")).toBeUndefined();
		expect(findAgentWebhook(hooks, "   ")).toBeUndefined();
		expect(findAgentWebhook([], "wh_alpha123")).toBeUndefined();
	});
});

describe("agent webhook deliveries", () => {
	it("keeps --limit inside the server's 1-100 window", () => {
		expect(parseDeliveriesLimit(undefined)).toBe(50);
		expect(parseDeliveriesLimit("1")).toBe(1);
		expect(parseDeliveriesLimit("100")).toBe(100);
		expect(() => parseDeliveriesLimit("0")).toThrow(/between 1 and 100/);
		expect(() => parseDeliveriesLimit("101")).toThrow(/between 1 and 100/);
		expect(() => parseDeliveriesLimit("many")).toThrow(/whole number/);
	});

	it("describes a delivery outcome without colors", () => {
		expect(
			describeDeliveryOutcome({ ok: true, statusCode: 200, error: null }),
		).toBe("ok 200");
		expect(describeDeliveryOutcome({ ok: true, statusCode: null, error: null })).toBe(
			"ok",
		);
		expect(
			describeDeliveryOutcome({ ok: false, statusCode: 500, error: "boom" }),
		).toBe("failed 500");
		expect(
			describeDeliveryOutcome({
				ok: false,
				statusCode: null,
				error: "timeout",
			}),
		).toBe("failed (no response)");
	});
});

describe("agent webhook server-error guidance", () => {
	it("turns the per-org cap into next steps with a permission exit code", () => {
		const mapped = withWebhookGuidance({
			message:
				"You have reached the limit of 10 agent webhook(s). Delete one to add another.",
			data: { code: "FORBIDDEN" },
		});
		expect(mapped).toBeInstanceOf(CliError);
		expect((mapped as CliError).code).toBe(ExitCode.PERMISSION_DENIED);
		expect((mapped as CliError).suggestions?.[0]).toMatch(
			/tarout agent-webhooks list/,
		);
	});

	it("maps a rejected endpoint to INVALID_ARGUMENTS", () => {
		const mapped = withWebhookGuidance({
			message:
				"Webhook URL must be a public https endpoint (it may not resolve to a private, internal, or metadata address).",
			data: { code: "BAD_REQUEST" },
		});
		expect((mapped as CliError).code).toBe(ExitCode.INVALID_ARGUMENTS);
	});

	it("maps a missing webhook to NOT_FOUND", () => {
		const mapped = withWebhookGuidance({
			message: "Agent webhook not found",
			data: { code: "NOT_FOUND" },
		});
		expect((mapped as CliError).code).toBe(ExitCode.NOT_FOUND);
	});

	it("passes through CliErrors and unrecognized failures untouched", () => {
		const original = new InvalidArgumentError("already shaped");
		expect(withWebhookGuidance(original)).toBe(original);
		const unknown = { message: "socket hang up" };
		expect(withWebhookGuidance(unknown)).toBe(unknown);
		expect(withWebhookGuidance(undefined)).toBeUndefined();
	});
});
