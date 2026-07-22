import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi
				.fn()
				.mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
	},
	scheduledJob: {
		list: {
			query: vi.fn().mockResolvedValue([
				{
					id: "job_1",
					name: "nightly",
					applicationId: "app_1",
					application: { name: "web" },
					jobType: "COMMAND",
					cron: "0 2 * * *",
					timezone: "Etc/UTC",
					command: "bun run cleanup",
					httpMethod: "POST",
					targetPath: "/",
					enabled: true,
					lastRunAt: null,
					lastStatus: null,
					consecutiveFailures: 0,
				},
			]),
		},
		get: { query: vi.fn().mockResolvedValue({ id: "job_1", name: "nightly" }) },
		create: { mutate: vi.fn().mockResolvedValue({ id: "job_2" }) },
		update: { mutate: vi.fn().mockResolvedValue({ id: "job_1", enabled: false }) },
		delete: { mutate: vi.fn().mockResolvedValue({ success: true }) },
		runNow: {
			mutate: vi.fn().mockResolvedValue({
				queued: true,
				ok: true,
				status: "queued",
				statusCode: null,
				exitCode: null,
				durationMs: 0,
				output: null,
				error: null,
			}),
		},
		runs: {
			query: vi
				.fn()
				.mockResolvedValue([{ id: "run_1", ok: true, exitCode: 0 }]),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJobsTools } from "../../src/mcp/tools/jobs";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerJobsTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

beforeEach(() => {
	fakeClient.application.allByOrganization.query.mockClear();
	fakeClient.scheduledJob.list.query.mockClear();
	fakeClient.scheduledJob.get.query.mockClear();
	fakeClient.scheduledJob.create.mutate.mockClear();
	fakeClient.scheduledJob.update.mutate.mockClear();
	fakeClient.scheduledJob.delete.mutate.mockClear();
	fakeClient.scheduledJob.runNow.mutate.mockClear();
	fakeClient.scheduledJob.runs.query.mockClear();
});

describe("scheduled task tools", () => {
	it("job_list without an app lists the whole organization", async () => {
		const r = await invoke("job_list", {});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			count: number;
			jobs: Array<{ id: string; target: string }>;
		};
		expect(body.count).toBe(1);
		// COMMAND tasks summarize to their command, HTTP tasks to method + path.
		expect(body.jobs[0]?.target).toBe("bun run cleanup");
		expect(fakeClient.scheduledJob.list.query).toHaveBeenCalledWith({});
		expect(fakeClient.application.allByOrganization.query).not.toHaveBeenCalled();
	});

	it("job_list scopes to the resolved app and filters by type", async () => {
		await invoke("job_list", { app: "web", jobType: "COMMAND" });
		expect(fakeClient.scheduledJob.list.query).toHaveBeenCalledWith({
			applicationId: "app_1",
			jobType: "COMMAND",
		});
	});

	it("job_create rejects a COMMAND task with no command before calling the API", async () => {
		const r = await invoke("job_create", {
			app: "web",
			name: "nightly",
			cron: "0 2 * * *",
			jobType: "COMMAND",
		});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("INVALID_ARGUMENTS");
		expect(fakeClient.scheduledJob.create.mutate).not.toHaveBeenCalled();
	});

	it("job_create sends the resolved applicationId and the command", async () => {
		const r = await invoke("job_create", {
			app: "web",
			name: "nightly",
			cron: "0 2 * * *",
			jobType: "COMMAND",
			command: "  bun run cleanup  ",
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.scheduledJob.create.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "app_1",
				jobType: "COMMAND",
				command: "bun run cleanup",
				cron: "0 2 * * *",
			}),
		);
	});

	it("job_update only sends the fields that were provided", async () => {
		await invoke("job_update", { id: "job_1", enabled: false });
		expect(fakeClient.scheduledJob.update.mutate).toHaveBeenCalledWith({
			id: "job_1",
			enabled: false,
		});
	});

	it("job_run tells the agent to poll job_runs when the run is queued", async () => {
		const r = await invoke("job_run", { id: "job_1" });
		const body = JSON.parse(r.content[0].text) as {
			queued: boolean;
			nextStep: string | null;
		};
		expect(body.queued).toBe(true);
		expect(body.nextStep).toContain("job_runs");
	});

	it("job_run returns the inline outcome for HTTP tasks with no poll hint", async () => {
		fakeClient.scheduledJob.runNow.mutate.mockResolvedValueOnce({
			queued: false,
			ok: true,
			status: "ok",
			statusCode: 200,
			exitCode: null,
			durationMs: 42,
			output: null,
			error: null,
		});
		const r = await invoke("job_run", { id: "job_1" });
		const body = JSON.parse(r.content[0].text) as {
			queued: boolean;
			statusCode: number;
			nextStep: string | null;
		};
		expect(body.queued).toBe(false);
		expect(body.statusCode).toBe(200);
		expect(body.nextStep).toBeNull();
	});

	it("job_runs defaults the limit", async () => {
		const r = await invoke("job_runs", { id: "job_1" });
		const body = JSON.parse(r.content[0].text) as { count: number };
		expect(body.count).toBe(1);
		expect(fakeClient.scheduledJob.runs.query).toHaveBeenCalledWith({
			id: "job_1",
			limit: 20,
		});
	});
});
