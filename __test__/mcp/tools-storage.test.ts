import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	storage: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([
				{
					bucketId: "buk_1",
					name: "assets",
					plan: "STARTER",
					publicAccess: false,
				},
			]),
		},
		findById: {
			query: vi.fn().mockResolvedValue({
				bucketId: "buk_1",
				name: "assets",
				plan: "STARTER",
				publicAccess: false,
				description: "static assets",
			}),
		},
		// storage.create's real response: no `name`, and the plan the platform
		// derived from the subscription (the input plan is ignored).
		create: {
			mutate: vi.fn().mockResolvedValue({
				bucketId: "buk_2",
				tenantPrefix: "t/buk2/",
				bucketName: "tarout-shared-starter",
				plan: "STARTER",
				publicAccess: false,
				endpoint: "https://storage.tarout.sa",
				publicUrl: null,
			}),
		},
		// storage.getCredentials only answers for CUSTOM buckets, in this shape.
		getCredentials: {
			query: vi.fn().mockResolvedValue({
				accessKeyId: "GOOG1EXAMPLE",
				authMode: "hmac",
				secretAccessKey: "SEC",
				endpoint: "https://storage.googleapis.com",
				bucket: "customer-bucket",
				prefix: "t/byo/",
				region: "me-central2",
				providerType: "GCS",
			}),
		},
		getFiles: {
			query: vi.fn().mockResolvedValue({
				files: [{ key: "a.txt" }, { key: "b/c.png" }],
			}),
		},
		delete: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStorageTools } from "../../src/mcp/tools/storage";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerStorageTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// SDK 1.29.x stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

beforeEach(() => {
	fakeClient.storage.allByOrganization.query.mockClear();
	fakeClient.storage.findById.query.mockClear();
	fakeClient.storage.create.mutate.mockClear();
	fakeClient.storage.getCredentials.query.mockClear();
	fakeClient.storage.getFiles.query.mockClear();
	fakeClient.storage.delete.mutate.mockClear();
});

describe("storage tools", () => {
	it("storage_list returns buckets with mapped fields", async () => {
		const r = await invoke("storage_list", {});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			count: number;
			buckets: Array<{
				id: string;
				name: string;
				plan: string;
				publicAccess: boolean;
			}>;
		};
		expect(body.count).toBe(1);
		expect(body.buckets[0]?.id).toBe("buk_1");
		expect(body.buckets[0]?.name).toBe("assets");
		expect(body.buckets[0]?.plan).toBe("STARTER");
		expect(body.buckets[0]?.publicAccess).toBe(false);
	});

	it("storage_create does not forward the ignored plan and returns the server's plan", async () => {
		const r = await invoke("storage_create", {
			name: "logs",
			plan: "STANDARD",
			description: "log archive",
			publicAccess: false,
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.create.mutate).toHaveBeenCalledWith({
			name: "logs",
			description: "log archive",
			publicAccess: false,
		});
		const body = JSON.parse(r.content[0].text) as { plan: string };
		expect(body.plan).toBe("STARTER");
	});

	it("storage_create works without a plan", async () => {
		const r = await invoke("storage_create", {
			name: "logs",
			publicAccess: false,
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.create.mutate).toHaveBeenCalledWith({
			name: "logs",
			description: undefined,
			publicAccess: false,
		});
	});

	it("storage_info resolves by name and calls storage.findById", async () => {
		const r = await invoke("storage_info", { bucket: "assets" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.findById.query).toHaveBeenCalledWith({
			bucketId: "buk_1",
		});
		const body = JSON.parse(r.content[0].text) as {
			bucket: { bucketId: string };
		};
		expect(body.bucket.bucketId).toBe("buk_1");
	});

	it("storage_info resolves by id and calls storage.findById", async () => {
		const r = await invoke("storage_info", { bucket: "buk_1" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.findById.query).toHaveBeenCalledWith({
			bucketId: "buk_1",
		});
	});

	it("storage_credentials resolves a CUSTOM bucket by name and returns HMAC keys", async () => {
		fakeClient.storage.allByOrganization.query.mockResolvedValueOnce([
			{ bucketId: "buk_9", name: "byo", plan: "CUSTOM", publicAccess: false },
		]);
		const r = await invoke("storage_credentials", { bucket: "byo" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			accessKeyId: string;
			secretAccessKey: string;
			endpoint: string;
			bucket: string;
			prefix: string;
		};
		expect(body.accessKeyId).toBe("GOOG1EXAMPLE");
		expect(body.secretAccessKey).toBe("SEC");
		expect(body.endpoint).toBe("https://storage.googleapis.com");
		expect(body.bucket).toBe("customer-bucket");
		expect(body.prefix).toBe("t/byo/");
		expect(fakeClient.storage.getCredentials.query).toHaveBeenCalledWith({
			bucketId: "buk_9",
		});
	});

	it("storage_credentials surfaces the platform's FORBIDDEN for a managed bucket", async () => {
		fakeClient.storage.getCredentials.query.mockRejectedValueOnce(
			Object.assign(
				new Error(
					"Direct provider credentials are disabled for managed storage. Create a scoped Tarout storage access key instead.",
				),
				{ data: { code: "FORBIDDEN" } },
			),
		);
		const r = await invoke("storage_credentials", { bucket: "assets" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("FORBIDDEN");
	});

	it("storage_files lists files (default invocation)", async () => {
		// Note: schema defaults (maxResults=100) are applied by the SDK's Zod
		// parse before dispatch; calling .handler directly in tests bypasses
		// that, so we pass maxResults explicitly here to mirror what the SDK
		// would forward. This mirrors tools-apps.test.ts:app_logs.
		const r = await invoke("storage_files", {
			bucket: "assets",
			maxResults: 100,
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.getFiles.query).toHaveBeenCalledWith({
			bucketId: "buk_1",
			prefix: undefined,
			maxResults: 100,
		});
		const body = JSON.parse(r.content[0].text) as {
			files: Array<{ key: string }>;
		};
		expect(body.files).toHaveLength(2);
	});

	it("storage_files passes prefix + maxResults through", async () => {
		const r = await invoke("storage_files", {
			bucket: "assets",
			prefix: "b/",
			maxResults: 50,
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.getFiles.query).toHaveBeenCalledWith({
			bucketId: "buk_1",
			prefix: "b/",
			maxResults: 50,
		});
	});

	it("storage_delete calls storage.delete and returns metadata", async () => {
		const r = await invoke("storage_delete", { bucket: "assets" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.delete.mutate).toHaveBeenCalledWith({
			bucketId: "buk_1",
		});
		const body = JSON.parse(r.content[0].text) as {
			deleted: boolean;
			bucketId: string;
			name: string;
		};
		expect(body.deleted).toBe(true);
		expect(body.bucketId).toBe("buk_1");
		expect(body.name).toBe("assets");
	});

	it("storage_delete refuses a name shared by several buckets and lists their ids", async () => {
		fakeClient.storage.allByOrganization.query.mockResolvedValueOnce([
			{ bucketId: "buk_1", name: "assets", plan: "STARTER" },
			{ bucketId: "buk_7", name: "assets", plan: "STARTER" },
		]);
		const r = await invoke("storage_delete", { bucket: "assets" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			error: string;
		};
		expect(body.code).toBe("INVALID_ARGUMENTS");
		expect(body.error).toContain("buk_1");
		expect(body.error).toContain("buk_7");
		expect(fakeClient.storage.delete.mutate).not.toHaveBeenCalled();
	});

	it("storage_delete still resolves an exact id when names collide", async () => {
		fakeClient.storage.allByOrganization.query.mockResolvedValueOnce([
			{ bucketId: "buk_1", name: "assets", plan: "STARTER" },
			{ bucketId: "buk_7", name: "assets", plan: "STARTER" },
		]);
		const r = await invoke("storage_delete", { bucket: "buk_7" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.storage.delete.mutate).toHaveBeenCalledWith({
			bucketId: "buk_7",
		});
	});

	it("storage_info returns NOT_FOUND envelope when the bucket cannot be resolved", async () => {
		const r = await invoke("storage_info", { bucket: "does-not-exist" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
		expect(fakeClient.storage.findById.query).not.toHaveBeenCalled();
	});
});
