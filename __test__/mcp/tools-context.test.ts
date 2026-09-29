import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Preserve the real config helpers (getProjectConfig / setProjectConfig / …)
// but stub the auth-facing exports so withAuth() doesn't require a real token.
vi.mock("../../src/lib/config", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/config")>(
		"../../src/lib/config",
	);
	return {
		...actual,
		isLoggedIn: () => true,
		getToken: () => "tok",
		getApiUrl: () => "https://api.test",
		getCurrentProfile: () => ({ organizationId: "o1" }),
		updateProfile: vi.fn(),
	};
});

const fakeClient = {
	user: { get: { query: vi.fn().mockResolvedValue({ id: "u1", email: "e" }) } },
	organization: {
		all: {
			query: vi
				.fn()
				.mockResolvedValue([{ id: "o1", slug: "acme", name: "Acme" }]),
		},
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	project: {
		all: {
			query: vi
				.fn()
				.mockResolvedValue([{ projectId: "p1", slug: "web", name: "Web" }]),
		},
		getActive: { query: vi.fn().mockResolvedValue({ id: "p1" }) },
		manifest: { query: vi.fn() },
		credentialScope: {
			query: vi.fn().mockResolvedValue({ accountScoped: true }),
		},
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	// No `environment` stub: the platform appRouter has no `environment`
	// router, so context_status/context_switch deliberately no longer touch one.
	application: {
		allByOrganization: {
			query: vi
				.fn()
				.mockResolvedValue([
					{ applicationId: "app_1", name: "web", organizationId: "o1" },
				]),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
	rememberRequestProjectId: vi.fn(),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../../src/mcp/server";
import { registerContextTools } from "../../src/mcp/tools/context";
import { updateProfile } from "../../src/lib/config";
import { rememberRequestProjectId } from "../../src/lib/api";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ctx-"));
	fakeClient.organization.setActive.mutate.mockClear();
	fakeClient.project.setActive.mutate.mockClear();
	fakeClient.project.credentialScope.query.mockResolvedValue({
		accountScoped: true,
	});
	vi.mocked(updateProfile).mockClear();
	vi.mocked(rememberRequestProjectId).mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerContextTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// The SDK stores the callback under `.handler` (renamed from `.callback` in 1.29.x).
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

describe("context_status", () => {
	it("returns whoami + active context + link info (unlinked)", async () => {
		const r = await invoke("context_status", { path: dir });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			user: { id: string };
			project: { id: string };
			link: { linked: boolean };
		};
		expect(body.user.id).toBe("u1");
		expect(body.project.id).toBe("p1");
		expect(body.link.linked).toBe(false);
	});

	it("reflects a linked directory", async () => {
		await invoke("link_app", { app: "web", path: dir });
		const r = await invoke("context_status", { path: dir });
		const body = JSON.parse(r.content[0].text) as {
			link: { linked: boolean; applicationId?: string; name?: string };
		};
		expect(body.link.linked).toBe(true);
		expect(body.link.applicationId).toBe("app_1");
		expect(body.link.name).toBe("web");
	});
});

describe("context_switch", () => {
	it("accepts the current organization by name without mutating a stateless session", async () => {
		const r = await invoke("context_switch", { organization: "Acme" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.organization.setActive.mutate).not.toHaveBeenCalled();
		expect(JSON.parse(r.content[0].text).organization.id).toBe("o1");
	});

	it("switches project by slug", async () => {
		const r = await invoke("context_switch", { project: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.project.setActive.mutate).not.toHaveBeenCalled();
		expect(updateProfile).toHaveBeenCalledWith({
			projectId: "p1",
			projectName: "Web",
			projectSlug: "web",
		});
		expect(rememberRequestProjectId).toHaveBeenCalledWith("p1");
	});

	it("only mutates the fields supplied", async () => {
		const r = await invoke("context_switch", { organization: "Acme" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.organization.setActive.mutate).not.toHaveBeenCalled();
		expect(fakeClient.project.setActive.mutate).not.toHaveBeenCalled();
	});

	it("returns an error when the org is unknown", async () => {
		const r = await invoke("context_switch", { organization: "nope" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { error: string };
		expect(body.error).toContain("Unknown organization");
	});

	it("resolves the platform's projectId field", async () => {
		const r = await invoke("context_switch", { project: "p1", path: dir });
		expect(r.isError).toBeUndefined();
		expect(rememberRequestProjectId).toHaveBeenCalledWith("p1");
	});

	it("rejects project-pinned credentials without changing the profile", async () => {
		fakeClient.project.credentialScope.query.mockResolvedValue({
			accountScoped: false,
			projectId: "other",
		} as any);
		const r = await invoke("context_switch", { project: "web", path: dir });
		expect(r.isError).toBe(true);
		expect(updateProfile).not.toHaveBeenCalled();
		expect(rememberRequestProjectId).not.toHaveBeenCalled();
	});
});

describe("link_app / unlink_app", () => {
	it("links a directory to an app by name and writes .tarout/project.json", async () => {
		const r = await invoke("link_app", { app: "web", path: dir });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			linked: boolean;
			applicationId: string;
			name: string;
		};
		expect(body.linked).toBe(true);
		expect(body.applicationId).toBe("app_1");
		expect(body.name).toBe("web");
		expect(existsSync(join(dir, ".tarout", "project.json"))).toBe(true);
	});

	it("unlink removes the local link", async () => {
		await invoke("link_app", { app: "web", path: dir });
		expect(existsSync(join(dir, ".tarout", "project.json"))).toBe(true);
		const r = await invoke("unlink_app", { path: dir });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { unlinked: boolean };
		expect(body.unlinked).toBe(true);
		expect(existsSync(join(dir, ".tarout", "project.json"))).toBe(false);
	});
});

const MANIFEST = {
	project: { id: "p1", name: "Web", description: null, region: null },
	applications: [
		{
			id: "app_1",
			name: "web",
			appName: "web-x1",
			status: "running",
			url: "https://web-x1.tarout.app",
			buildType: "nixpacks",
			source: { type: "github", repository: "acme/web", branch: "main" },
			customDomains: [],
			databaseIds: ["pg_1"],
			envVarNames: ["DATABASE_URL", "API_TOKEN", "SECRET_KEY_BASE"],
			scheduledJobCount: 1,
		},
	],
	databases: [
		{
			id: "pg_1",
			name: "main",
			engine: "postgres",
			status: "running",
			plan: "starter",
			linkedApplicationIds: ["app_1"],
			externalAccess: true,
		},
	],
	buckets: [],
	domains: [],
	generatedAt: "2026-09-29T10:00:00.000Z",
};

describe("agent_manifest", () => {
	beforeEach(() => {
		fakeClient.project.manifest.query.mockReset();
		fakeClient.project.manifest.query.mockResolvedValue(MANIFEST);
	});

	it("is read-only and returns the manifest", async () => {
		const server = new McpServer(
			{ name: "t", version: "0" },
			{ capabilities: { tools: {} } },
		);
		registerContextTools(server);
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool is SDK-internal.
		const tool = (server as any)._registeredTools.agent_manifest;
		expect(tool.annotations).toEqual({ readOnlyHint: true });

		const r = await invoke("agent_manifest", {});
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content[0].text)).toEqual(MANIFEST);
		expect(fakeClient.project.manifest.query).toHaveBeenCalledWith({});
	});

	it("passes an explicit projectId", async () => {
		await invoke("agent_manifest", { projectId: "p2" });
		expect(fakeClient.project.manifest.query).toHaveBeenCalledWith({
			projectId: "p2",
		});
	});

	it("returns NOT_FOUND with a pointer on a server without project.manifest", async () => {
		fakeClient.project.manifest.query.mockRejectedValue(
			Object.assign(new Error('No "query"-procedure on path "project.manifest"'), {
				data: { code: "NOT_FOUND" },
			}),
		);
		const r = await invoke("agent_manifest", {});
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			code: string;
			error: string;
			details: { reason: string };
		};
		expect(body.code).toBe("NOT_FOUND");
		expect(body.error).toContain("project.manifest");
		expect(body.details.reason).toBe("procedure_unavailable");
	});

	it("keeps env var names intact through the server's result sanitizer", async () => {
		const server = createMcpServer();
		// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool is SDK-internal.
		const tool = (server as any)._registeredTools.agent_manifest;
		const r = (await tool.handler({})) as {
			content: [{ text: string }];
			isError?: boolean;
		};
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as typeof MANIFEST;
		expect(body.applications[0]?.envVarNames).toEqual([
			"DATABASE_URL",
			"API_TOKEN",
			"SECRET_KEY_BASE",
		]);
		expect(body.databases[0]?.externalAccess).toBe(true);
	});
});
