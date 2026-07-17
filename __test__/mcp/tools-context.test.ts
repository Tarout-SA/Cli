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
	};
});

const fakeClient = {
	user: { get: { query: vi.fn().mockResolvedValue({ id: "u1", email: "e" }) } },
	organization: {
		all: {
			query: vi.fn().mockResolvedValue([{ organizationId: "o1", name: "Acme" }]),
		},
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	project: {
		all: {
			query: vi.fn().mockResolvedValue([{ id: "p1", slug: "web", name: "Web" }]),
		},
		getActive: { query: vi.fn().mockResolvedValue({ id: "p1" }) },
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	environment: {
		getActive: {
			query: vi.fn().mockResolvedValue({ id: "e1", slug: "production" }),
		},
		all: {
			query: vi.fn().mockResolvedValue([
				{ environmentId: "e1", slug: "production", displayName: "Production" },
			]),
		},
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([
				{ applicationId: "app_1", name: "web", organizationId: "o1" },
			]),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContextTools } from "../../src/mcp/tools/context";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ctx-"));
	fakeClient.organization.setActive.mutate.mockClear();
	fakeClient.project.setActive.mutate.mockClear();
	fakeClient.environment.setActive.mutate.mockClear();
	fakeClient.environment.all.query.mockClear();
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
			environment: { id: string };
			link: { linked: boolean };
		};
		expect(body.user.id).toBe("u1");
		expect(body.project.id).toBe("p1");
		expect(body.environment.id).toBe("e1");
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
	it("switches organization by name", async () => {
		const r = await invoke("context_switch", { organization: "Acme" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.organization.setActive.mutate).toHaveBeenCalledWith({
			organizationId: "o1",
		});
	});

	it("switches project by slug", async () => {
		const r = await invoke("context_switch", { project: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.project.setActive.mutate).toHaveBeenCalledWith({
			projectId: "p1",
		});
	});

	it("switches environment by id", async () => {
		const r = await invoke("context_switch", { environment: "e1" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.environment.setActive.mutate).toHaveBeenCalledWith({
			environmentId: "e1",
		});
	});

	it("switches environment by slug/name (resolves to its id)", async () => {
		// Regression: the old code passed the raw name straight to setActive as
		// an environmentId; it must be resolved via environment.all first.
		const r = await invoke("context_switch", { environment: "production" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.environment.all.query).toHaveBeenCalled();
		expect(fakeClient.environment.setActive.mutate).toHaveBeenCalledWith({
			environmentId: "e1",
		});
	});

	it("returns an error when the environment is unknown", async () => {
		const r = await invoke("context_switch", { environment: "nope" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { error: string };
		expect(body.error).toContain("Unknown environment");
		expect(fakeClient.environment.setActive.mutate).not.toHaveBeenCalled();
	});

	it("only mutates the fields supplied", async () => {
		const r = await invoke("context_switch", { organization: "Acme" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.organization.setActive.mutate).toHaveBeenCalledTimes(1);
		expect(fakeClient.project.setActive.mutate).not.toHaveBeenCalled();
		expect(fakeClient.environment.setActive.mutate).not.toHaveBeenCalled();
	});

	it("returns an error when the org is unknown", async () => {
		const r = await invoke("context_switch", { organization: "nope" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { error: string };
		expect(body.error).toContain("Unknown organization");
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
