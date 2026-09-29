import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	linked: null as null | { applicationId: string; name: string },
}));

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
	getCurrentProfile: () => ({ organizationId: "org_1" }),
	getProjectConfig: () => h.linked,
}));

const fakeClient = {
	application: {
		allByOrganization: {
			// The real application.allByOrganization row (routers/application.ts):
			// `applicationStatus` and a bare-host `liveUrl`, no status/url fields.
			query: vi.fn().mockResolvedValue([
				{
					applicationId: "app_1",
					name: "web",
					appName: "web-x1y2",
					description: null,
					applicationStatus: "done",
					plan: "SHARED",
					region: "me-central2",
					createdAt: "2026-09-01T00:00:00.000Z",
					domain: null,
					liveUrl: "web-x1y2.tarout.app",
					lastDeployment: { status: "done", at: "2026-09-20T10:00:00.000Z" },
				},
			]),
		},
		one: {
			query: vi.fn().mockResolvedValue({ applicationId: "app_1", name: "web" }),
		},
		create: {
			mutate: vi
				.fn()
				.mockResolvedValue({ applicationId: "app_2", name: "api" }),
		},
		getApplicationLogs: {
			query: vi.fn().mockResolvedValue({ logs: [{ line: "hi" }] }),
		},
		restart: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		stop: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		delete: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		exec: {
			mutate: vi.fn().mockResolvedValue({
				exitCode: 0,
				stdout: "hello\n",
				stderr: "",
				truncated: false,
				timedOut: false,
				durationMs: 25,
			}),
		},
		explainBuild: { query: vi.fn() },
		explainBuildResult: { query: vi.fn() },
	},
};

/** An application.explainBuild answer; the shape of services/build-explain.ts. */
function explained(overrides: Record<string, unknown> = {}) {
	return {
		status: "ok",
		detectedKind: "node",
		buildType: "railpack",
		summary: "Node app, built with npm.",
		plan: {
			providers: ["node"],
			packages: [{ name: "node", version: "22.11.0", source: "package.json" }],
			steps: [{ name: "install", commands: ["npm ci"] }],
			startCommand: "node server.js",
			port: 3000,
			buildEnv: ["DATABASE_URL"],
		},
		warnings: [],
		errors: [],
		source: {
			type: "github",
			repository: "https://github.com/acme/web",
			branch: "main",
			commitSha: "a1b2c3d4e5f6",
		},
		...overrides,
	};
}

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	APP_EXEC_AFTER_APPROVAL_NOTE,
	registerAppsTools,
} from "../../src/mcp/tools/apps";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerAppsTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// The SDK renamed the field from `callback` to `handler` in 1.29.x; the
	// stored value is the callback function itself, invoked with (args, extra).
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

beforeEach(() => {
	fakeClient.application.allByOrganization.query.mockClear();
	fakeClient.application.one.query.mockClear();
	fakeClient.application.create.mutate.mockClear();
	fakeClient.application.getApplicationLogs.query.mockClear();
	fakeClient.application.restart.mutate.mockClear();
	fakeClient.application.stop.mutate.mockClear();
	fakeClient.application.delete.mutate.mockClear();
	fakeClient.application.exec.mutate.mockClear();
	fakeClient.application.explainBuild.query.mockReset();
	fakeClient.application.explainBuildResult.query.mockReset();
	h.linked = null;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("apps tools", () => {
	it("app_logs validates the cloud's defaults, bounds, and filter vocabulary", () => {
		const server = new McpServer(
			{ name: "t", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerAppsTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: inspect the registered protocol schema.
		const schema = (server as any)._registeredTools.app_logs.inputSchema;
		expect(schema.parse({ app: "web" })).toMatchObject({
			lines: 500,
			level: "ALL",
			timeRange: "all",
		});
		for (const args of [
			{ lines: 9 },
			{ lines: 5001 },
			{ lines: 10.5 },
			{ level: "error" },
			{ timeRange: "15m" },
		]) {
			expect(schema.safeParse({ app: "web", ...args }).success).toBe(false);
		}
		for (const level of [
			"ALL",
			"ERROR",
			"WARN",
			"INFO",
			"DEBUG",
			"TRACE",
			"UNKNOWN",
		]) {
			expect(schema.safeParse({ app: "web", level }).success).toBe(true);
		}
	});

	it("app_list trims to essentials", async () => {
		const r = await invoke("app_list", {});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			count: number;
			apps: Array<Record<string, unknown>>;
		};
		expect(body.count).toBe(1);
		expect(body.apps).toHaveLength(1);
		// status/url used to read `status` and `deployedUrl ?? url`, which the
		// router never sends, so every app looked undeployed to agents.
		expect(body.apps[0]).toEqual({
			id: "app_1",
			name: "web",
			status: "done",
			plan: "SHARED",
			url: "https://web-x1y2.tarout.app",
			lastDeployment: { status: "done", at: "2026-09-20T10:00:00.000Z" },
		});
	});

	it("app_info resolves by name and returns the full object", async () => {
		const r = await invoke("app_info", { app: "web" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { app: { name: string } };
		expect(body.app.name).toBe("web");
		expect(fakeClient.application.one.query).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
	});

	it("app_create injects appName slug + organizationId", async () => {
		const r = await invoke("app_create", {
			name: "My API",
			description: "backend",
			plan: "SHARED",
		});
		expect(r.isError).toBeUndefined();
		// Regression: the platform application.create schema requires appName
		// (a slug) and organizationId — the old payload sent neither.
		expect(fakeClient.application.create.mutate).toHaveBeenCalledWith({
			name: "My API",
			appName: "my-api",
			description: "backend",
			organizationId: "org_1",
			plan: "SHARED",
		});
		const body = JSON.parse(r.content[0].text) as {
			created: { applicationId: string };
		};
		expect(body.created.applicationId).toBe("app_2");
	});

	it("app_logs resolves app and forwards optional params", async () => {
		const r = await invoke("app_logs", {
			app: "web",
			lines: 100,
			level: "ERROR",
			timeRange: "1h",
		});
		expect(r.isError).toBeUndefined();
		expect(
			fakeClient.application.getApplicationLogs.query,
		).toHaveBeenCalledWith({
			applicationId: "app_1",
			lines: 100,
			level: "ERROR",
			timeRange: "1h",
		});
	});

	it("app_restart calls application.restart", async () => {
		const r = await invoke("app_restart", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.restart.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		const body = JSON.parse(r.content[0].text) as { restarted: boolean };
		expect(body.restarted).toBe(true);
	});

	it("app_stop calls application.stop", async () => {
		const r = await invoke("app_stop", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.stop.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		const body = JSON.parse(r.content[0].text) as { stopped: boolean };
		expect(body.stopped).toBe(true);
	});

	it("app_delete calls application.delete", async () => {
		const r = await invoke("app_delete", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.delete.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		const body = JSON.parse(r.content[0].text) as {
			deleted: boolean;
			applicationId: string;
			name: string;
		};
		expect(body.deleted).toBe(true);
		expect(body.applicationId).toBe("app_1");
		expect(body.name).toBe("web");
	});

	it("app_delete refuses an ambiguous id prefix with INVALID_ARGUMENTS", async () => {
		fakeClient.application.allByOrganization.query.mockResolvedValueOnce([
			{ applicationId: "Vq3kPz81xYbT0nLm4sRwE", name: "web" },
			{ applicationId: "Vq3kZZZZZZZZZZZZZZZZZ", name: "api" },
		]);
		const r = await invoke("app_delete", { app: "Vq3k" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			error: string;
		};
		expect(body.code).toBe("INVALID_ARGUMENTS");
		expect(body.error).toContain("Vq3kPz81xYbT0nLm4sRwE");
		expect(fakeClient.application.delete.mutate).not.toHaveBeenCalled();
	});

	it("app_exec is destructive and bounds command and timeout like the platform", () => {
		const server = new McpServer(
			{ name: "t", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerAppsTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: inspect the registered tool.
		const tool = (server as any)._registeredTools.app_exec;
		expect(tool.annotations).toEqual({ destructiveHint: true });
		const schema = tool.inputSchema;
		expect(schema.safeParse({ command: "ls" }).success).toBe(true);
		expect(
			schema.safeParse({ app: "web", command: "ls", timeoutSeconds: 300 })
				.success,
		).toBe(true);
		for (const args of [
			{},
			{ command: "" },
			{ command: "x".repeat(4001) },
			{ command: "ls", timeoutSeconds: 0 },
			{ command: "ls", timeoutSeconds: 301 },
			{ command: "ls", timeoutSeconds: 1.5 },
		]) {
			expect(schema.safeParse(args).success).toBe(false);
		}
	});

	it("app_exec resolves the app and returns the result with ok", async () => {
		const r = await invoke("app_exec", {
			app: "web",
			command: "echo hello",
			timeoutSeconds: 30,
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.exec.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
			command: "echo hello",
			timeoutSeconds: 30,
		});
		expect(JSON.parse(r.content[0].text)).toEqual({
			applicationId: "app_1",
			name: "web",
			command: "echo hello",
			exitCode: 0,
			stdout: "hello\n",
			stderr: "",
			truncated: false,
			timedOut: false,
			durationMs: 25,
			ok: true,
		});
	});

	it("app_exec reports a non-zero exit as a result, not a tool error", async () => {
		fakeClient.application.exec.mutate.mockResolvedValueOnce({
			exitCode: 1,
			stdout: "",
			stderr: "nope\n",
			truncated: false,
			timedOut: false,
			durationMs: 5,
		});
		const r = await invoke("app_exec", { app: "web", command: "false" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.exec.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
			command: "false",
		});
		const body = JSON.parse(r.content[0].text) as {
			exitCode: number;
			ok: boolean;
		};
		expect(body.exitCode).toBe(1);
		expect(body.ok).toBe(false);
	});

	it("app_exec falls back to the linked app, and refuses when there is none", async () => {
		const missing = await invoke("app_exec", { command: "ls" });
		expect(missing.isError).toBe(true);
		expect(JSON.parse(missing.content[0].text).code).toBe("INVALID_ARGUMENTS");
		expect(fakeClient.application.exec.mutate).not.toHaveBeenCalled();

		h.linked = { applicationId: "app_9", name: "linked" };
		const r = await invoke("app_exec", { command: "ls" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.exec.mutate).toHaveBeenCalledWith({
			applicationId: "app_9",
			command: "ls",
		});
	});

	it("app_exec adds the output caveat to NEEDS_APPROVAL", async () => {
		fakeClient.application.exec.mutate.mockRejectedValueOnce(
			Object.assign(
				new Error(
					'NEEDS_APPROVAL:pa_123abc: The destructive action "application.exec" requires human approval for this API key.',
				),
				{ data: { code: "FORBIDDEN", reason: "needs_approval" } },
			),
		);
		const r = await invoke("app_exec", { app: "web", command: "env" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			remediation: string;
			details: Record<string, unknown>;
		};
		expect(body.code).toBe("NEEDS_APPROVAL");
		expect(body.remediation).toContain("approvals_get");
		expect(body.details).toMatchObject({
			reason: "needs_approval",
			approvalId: "pa_123abc",
			afterApproval: APP_EXEC_AFTER_APPROVAL_NOTE,
		});
	});

	it("app_exec passes other errors through untouched", async () => {
		fakeClient.application.exec.mutate.mockRejectedValueOnce(
			Object.assign(new Error("No running container was found."), {
				data: { code: "PRECONDITION_FAILED" },
			}),
		);
		const r = await invoke("app_exec", { app: "web", command: "ls" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			details?: Record<string, unknown>;
		};
		expect(body.code).toBe("PRECONDITION_FAILED");
		expect(body.details?.afterApproval).toBeUndefined();
	});

	it("app_explain_build is read-only and bounds waitSeconds", () => {
		const server = new McpServer(
			{ name: "t", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerAppsTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: inspect the registered tool.
		const tool = (server as any)._registeredTools.app_explain_build;
		expect(tool.annotations).toEqual({ readOnlyHint: true });
		expect(tool.description).toContain("not uncommitted or unpushed local files");
		const schema = tool.inputSchema;
		expect(schema.safeParse({}).success).toBe(true);
		expect(schema.safeParse({ app: "web", waitSeconds: 0 }).success).toBe(true);
		expect(schema.safeParse({ waitSeconds: 600 }).success).toBe(true);
		for (const waitSeconds of [-1, 601, 1.5]) {
			expect(schema.safeParse({ waitSeconds }).success).toBe(false);
		}
	});

	it("app_explain_build resolves the app and returns the platform's answer", async () => {
		fakeClient.application.explainBuild.query.mockResolvedValueOnce(explained());
		const r = await invoke("app_explain_build", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.explainBuild.query).toHaveBeenCalledWith({
			applicationId: "app_1",
		});
		expect(fakeClient.application.explainBuildResult.query).not.toHaveBeenCalled();
		expect(JSON.parse(r.content[0].text)).toEqual({
			applicationId: "app_1",
			name: "web",
			...explained(),
		});
	});

	it("app_explain_build reports status failed as a result, not a tool error", async () => {
		fakeClient.application.explainBuild.query.mockResolvedValueOnce(
			explained({
				status: "failed",
				plan: null,
				errors: ["No start command was detected."],
			}),
		);
		const r = await invoke("app_explain_build", { app: "web" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as Record<string, unknown>;
		expect(body.status).toBe("failed");
		expect(body.errors).toEqual(["No start command was detected."]);
		expect(body.stillPending).toBeUndefined();
	});

	it("app_explain_build polls a pending answer until it settles", async () => {
		vi.useFakeTimers();
		fakeClient.application.explainBuild.query.mockResolvedValueOnce(
			explained({ status: "pending", jobId: "explain-42", plan: null }),
		);
		fakeClient.application.explainBuildResult.query
			.mockResolvedValueOnce(
				explained({ status: "pending", jobId: "explain-42", plan: null }),
			)
			.mockResolvedValueOnce(explained({ jobId: "explain-42" }));
		const pending = invoke("app_explain_build", { app: "web" });
		await vi.advanceTimersByTimeAsync(10_000);
		const r = await pending;
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.explainBuildResult.query).toHaveBeenCalledTimes(2);
		expect(fakeClient.application.explainBuildResult.query).toHaveBeenCalledWith({
			applicationId: "app_1",
			jobId: "explain-42",
		});
		const body = JSON.parse(r.content[0].text) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body.stillPending).toBeUndefined();
	});

	it("app_explain_build with waitSeconds 0 returns a pending answer at once", async () => {
		fakeClient.application.explainBuild.query.mockResolvedValueOnce(
			explained({ status: "pending", jobId: "explain-42", plan: null }),
		);
		const r = await invoke("app_explain_build", { app: "web", waitSeconds: 0 });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.explainBuildResult.query).not.toHaveBeenCalled();
		const body = JSON.parse(r.content[0].text) as Record<string, unknown>;
		expect(body).toMatchObject({
			status: "pending",
			jobId: "explain-42",
			stillPending: true,
		});
	});

	it("app_explain_build falls back to the linked app, and refuses when there is none", async () => {
		const missing = await invoke("app_explain_build", {});
		expect(missing.isError).toBe(true);
		expect(JSON.parse(missing.content[0].text).code).toBe("INVALID_ARGUMENTS");
		expect(fakeClient.application.explainBuild.query).not.toHaveBeenCalled();

		h.linked = { applicationId: "app_9", name: "linked" };
		fakeClient.application.explainBuild.query.mockResolvedValueOnce(explained());
		const r = await invoke("app_explain_build", {});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.explainBuild.query).toHaveBeenCalledWith({
			applicationId: "app_9",
		});
		expect(JSON.parse(r.content[0].text).name).toBe("linked");
	});

	it("app_explain_build turns the rate limit into a wait-a-minute envelope", async () => {
		fakeClient.application.explainBuild.query.mockRejectedValueOnce(
			Object.assign(
				new Error(
					"Too many build explanations right now. Wait a minute and try again, or poll a pending one with application.explainBuildResult.",
				),
				{ data: { code: "TOO_MANY_REQUESTS" } },
			),
		);
		const r = await invoke("app_explain_build", { app: "web" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			error: string;
			remediation: string;
			details: Record<string, unknown>;
		};
		expect(body.code).toBe("TOO_MANY_REQUESTS");
		expect(body.error).toContain("10 a minute");
		expect(body.error).not.toContain("explainBuildResult");
		expect(body.remediation).toContain("Wait about a minute");
		expect(body.details).toMatchObject({ retryAfterSeconds: 60 });
	});

	it("app_explain_build says an older server does not support it", async () => {
		fakeClient.application.explainBuild.query.mockRejectedValueOnce(
			Object.assign(
				new Error('No "query"-procedure on path "application.explainBuild"'),
				{ data: { code: "NOT_FOUND" } },
			),
		);
		const r = await invoke("app_explain_build", { app: "web" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			error: string;
			details: Record<string, unknown>;
		};
		expect(body.code).toBe("NOT_FOUND");
		expect(body.error).toContain(
			"This Tarout server does not support build explain yet",
		);
		expect(body.details).toMatchObject({
			procedure: "application.explainBuild",
			reason: "procedure_unavailable",
		});
	});

	it("app_info returns NOT_FOUND envelope when app cannot be resolved", async () => {
		const r = await invoke("app_info", { app: "does-not-exist" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
	});
});
