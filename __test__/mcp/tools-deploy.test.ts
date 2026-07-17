/**
 * Shared setup for the deploy tool suite. Task 14 lands `deployment_status`
 * and `deployment_logs`; Task 15 will append `deploy` specs to this file, so
 * the fakeClient below is intentionally broader than the two tools need.
 */
import { describe, expect, it, vi } from "vitest";

// Stub out the deploy pipeline helpers so the `deploy` tool's handler runs
// against pure in-process mocks and never touches the filesystem, the `zip`
// binary, or the network. Task 14's read-only specs don't need these — but
// Task 15's deploy tool does, and vi.mock is hoisted so it applies here too.
vi.mock("../../src/commands/deploy", () => ({
	inspectCurrentProject: vi.fn(() => ({
		database: null,
		storage: null,
		suggestedName: "web",
	})),
	createAppFromCurrentDirectory: vi.fn(async () => ({
		applicationId: "app_created",
		name: "created-app",
		organizationId: "org_1",
	})),
	uploadCurrentDirectorySource: vi.fn(async () => undefined),
	buildConfigFromOptions: vi.fn(() => ({})),
	isEntitlementError: vi.fn(() => false),
	extractEntitlementKeyFromError: vi.fn(() => null),
	createSourceArchive: vi.fn(async () => "/tmp/fake-archive.zip"),
}));

const defaultProfile = {
	token: "tok",
	apiUrl: "https://api.test",
	organizationId: "org_test",
	organizationName: "Test",
	environmentId: "env_test",
	environmentName: "prod",
	userId: "u1",
	userEmail: "u@test",
};
const getCurrentProfileMock = vi.fn(() => defaultProfile as unknown);

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
	getProjectConfig: () => null,
	setProjectConfig: () => {},
	isProjectLinked: () => false,
	removeProjectConfig: () => {},
	getCurrentProfile: () => getCurrentProfileMock(),
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
		getDeploymentStatus: {
			query: vi
				.fn()
				.mockResolvedValue({ status: "done", latestDeploymentId: "dep_1" }),
		},
	},
	deployment: {
		one: {
			query: vi.fn().mockResolvedValue({ deploymentId: "dep_1", status: "done" }),
		},
		getDeploymentLogs: {
			query: vi.fn().mockResolvedValue({ logs: [{ line: "hi" }], nextOffset: 1 }),
		},
	},
	subscription: {
		getCatalog: {
			query: vi.fn().mockResolvedValue({ plans: [], addons: [] }),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDeployTools } from "../../src/mcp/tools/deploy";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerDeployTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// SDK 1.29.x stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

describe("deployment_status", () => {
	it("resolves app by name then queries getDeploymentStatus", async () => {
		const r = await invoke("deployment_status", { app: "web" });
		const body = JSON.parse(r.content[0].text) as { status: string };
		expect(body.status).toBe("done");
	});

	it("uses deploymentId when provided", async () => {
		const r = await invoke("deployment_status", { deploymentId: "dep_1" });
		const body = JSON.parse(r.content[0].text) as { deploymentId: string };
		expect(body.deploymentId).toBe("dep_1");
	});

	it("returns INVALID_ARGUMENTS envelope when neither app nor deploymentId given", async () => {
		const r = await invoke("deployment_status", {});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("INVALID_ARGUMENTS");
	});
});

describe("deployment_logs", () => {
	it("returns log lines for a deployment id", async () => {
		const r = await invoke("deployment_logs", { deploymentId: "dep_1" });
		const body = JSON.parse(r.content[0].text) as { logs: unknown[] };
		expect(body.logs).toHaveLength(1);
	});
});

describe("deploy tool", () => {
	it("creates and links a missing app relative to the requested directory", async () => {
		const { createAppFromCurrentDirectory } = await import(
			"../../src/commands/deploy"
		);
		const create = createAppFromCurrentDirectory as ReturnType<typeof vi.fn>;
		create.mockClear();
		// biome-ignore lint/suspicious/noExplicitAny: augmenting fake for this test only.
		(fakeClient.application as any).deployToCloud = {
			mutate: vi.fn().mockResolvedValue({ deploymentId: "dep_created_path" }),
		};
		const requestedPath = "/tmp/tarout-new-requested-project";

		const r = await invoke("deploy", {
			path: requestedPath,
			wait: false,
			createIfMissing: true,
		});

		expect(r.isError).toBeUndefined();
		expect(create).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ organizationId: "org_test" }),
			expect.objectContaining({ nonInteractive: true }),
			requestedPath,
		);
	});

	it("archives the exact directory supplied by the MCP caller", async () => {
		const { uploadCurrentDirectorySource } = await import(
			"../../src/commands/deploy"
		);
		const upload = uploadCurrentDirectorySource as ReturnType<typeof vi.fn>;
		upload.mockClear();
		// biome-ignore lint/suspicious/noExplicitAny: augmenting fake for this test only.
		(fakeClient.application as any).deployToCloud = {
			mutate: vi.fn().mockResolvedValue({ deploymentId: "dep_path" }),
		};
		const requestedPath = "/tmp/tarout-requested-project";

		const r = await invoke("deploy", {
			path: requestedPath,
			name: "web",
			wait: false,
			createIfMissing: false,
		});

		expect(r.isError).toBeUndefined();
		expect(upload).toHaveBeenCalledWith(
			expect.anything(),
			"app_1",
			"web",
			requestedPath,
		);
	});

	it("wait=false returns the deployment id immediately", async () => {
		// Stub the pieces the deploy tool needs.
		const client = fakeClient as unknown as {
			application: {
				deployToCloud: { mutate: ReturnType<typeof vi.fn> };
			};
		};
		// biome-ignore lint/suspicious/noExplicitAny: augmenting fake for this test only.
		(client.application as any).deployToCloud = {
			mutate: vi.fn().mockResolvedValue({ deploymentId: "dep_9" }),
		};
		const r = await invoke("deploy", {
			path: process.cwd(),
			name: "web",
			wait: false,
			createIfMissing: false,
		});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { deploymentId: string };
		expect(body.deploymentId).toBe("dep_9");
	});

	it("times out cleanly and returns in_progress (not an error)", async () => {
		const client = fakeClient as unknown as {
			deployment: { one: { query: ReturnType<typeof vi.fn> } };
			application: {
				deployToCloud: { mutate: ReturnType<typeof vi.fn> };
			};
		};
		// biome-ignore lint/suspicious/noExplicitAny: augmenting fake.
		(client.application as any).deployToCloud = {
			mutate: vi.fn().mockResolvedValue({ deploymentId: "dep_slow" }),
		};
		// Always report "running" so the poll loop hits the deadline.
		(client.deployment.one.query as ReturnType<typeof vi.fn>).mockResolvedValue({
			deploymentId: "dep_slow",
			status: "running",
		});
		const r = await invoke("deploy", {
			path: process.cwd(),
			name: "web",
			wait: true,
			createIfMissing: false,
			timeoutSeconds: 1, // fastest possible cap
			// The tool's internal poll is fake-timed via the deadline check.
		});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { status: string };
		expect(body.status).toBe("in_progress");
	}, 10000);

	it("returns PERMISSION_DENIED with a remedy when app creation hits an entitlement gate", async () => {
		const {
			createAppFromCurrentDirectory,
			isEntitlementError,
			extractEntitlementKeyFromError,
		} = await import("../../src/commands/deploy");

		// No linked project, no matching name → tool falls through to the create
		// branch, where the mocked helper throws a FORBIDDEN entitlement error.
		const entitlementError = Object.assign(
			new Error("Plan limit reached for app.free.slots"),
			{ code: "FORBIDDEN", data: { code: "FORBIDDEN" } },
		);
		(createAppFromCurrentDirectory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			entitlementError,
		);
		(isEntitlementError as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
		(extractEntitlementKeyFromError as ReturnType<typeof vi.fn>).mockReturnValueOnce(
			"app.free.slots",
		);

		const r = await invoke("deploy", {
			path: process.cwd(),
			wait: false,
			createIfMissing: true,
		});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			remediation?: string;
			details?: {
				remedy?: { command?: string; targetKey?: string };
				entitlementKey?: string;
			};
		};
		expect(body.code).toBe("PERMISSION_DENIED");
		expect(body.details?.entitlementKey).toBe("app.free.slots");
		expect(body.details?.remedy?.command).toContain("tarout billing");
	});

	it("returns AUTH_ERROR envelope when profile is missing and createIfMissing", async () => {
		getCurrentProfileMock.mockReturnValueOnce(null as unknown as typeof defaultProfile);
		const r = await invoke("deploy", {
			path: process.cwd(),
			wait: false,
			createIfMissing: true,
		});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("AUTH_ERROR");
	});
});
