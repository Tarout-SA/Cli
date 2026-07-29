import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// context_switch now writes the LOCAL profile (not just server session state),
// so updateProfile MUST be stubbed — the real one persists to the machine-wide
// conf store and would clobber the developer's active org/project.
const stub = vi.hoisted(() => ({
	updateProfile: vi.fn(),
	getCurrentProfile: vi.fn(() => ({
		organizationId: "o1",
		organizationName: "Acme",
		projectId: "p1",
		projectName: "Web",
		projectSlug: "web",
	})),
}));

// Preserve the real config helpers (getProjectConfig / setProjectConfig / …)
// but stub the auth-facing and profile-writing exports.
vi.mock("../../src/lib/config", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/config")>(
		"../../src/lib/config",
	);
	return {
		...actual,
		isLoggedIn: () => true,
		getToken: () => "tok",
		getApiUrl: () => "https://api.test",
		getCurrentProfile: stub.getCurrentProfile,
		updateProfile: stub.updateProfile,
	};
});

// Field names mirror the platform routers: organization.all rows carry `id`
// (commands/orgs.ts findOrg) while project.all rows carry `projectId`
// (commands/projects.ts ProjectSummary).
const fakeClient = {
	user: { get: { query: vi.fn().mockResolvedValue({ id: "u1", email: "e" }) } },
	organization: {
		all: { query: vi.fn().mockResolvedValue([{ id: "o1", name: "Acme" }]) },
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	project: {
		all: {
			query: vi
				.fn()
				.mockResolvedValue([{ projectId: "p1", slug: "web", name: "Web" }]),
		},
		getActive: { query: vi.fn().mockResolvedValue({ projectId: "p1" }) },
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	// No `environment` stub: the platform appRouter has no `environment`
	// router, so context_status/context_switch deliberately no longer touch one.
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([
				{ applicationId: "app_1", name: "web", organizationId: "o1" },
			]),
		},
		one: {
			query: vi
				.fn()
				.mockResolvedValue({ applicationId: "app_1", name: "web", organizationId: "o1" }),
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
	fakeClient.project.getActive.query.mockClear();
	fakeClient.application.one.query.mockClear();
	stub.updateProfile.mockClear();
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
			project: { projectId: string };
			profile: { organizationId: string } | null;
			link: { linked: boolean };
		};
		expect(body.user.id).toBe("u1");
		expect(body.project.projectId).toBe("p1");
		// The local profile drives the create tools, so status reports it
		// alongside the server view to make any divergence observable.
		expect(body.profile?.organizationId).toBe("o1");
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
	it("switches organization by name and updates the local profile", async () => {
		const r = await invoke("context_switch", { organization: "Acme" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.organization.setActive.mutate).toHaveBeenCalledWith({
			organizationId: "o1",
		});
		// A server-only switch would leave the local profile pointing at the old
		// org, so create tools would keep provisioning there. Projects are
		// org-scoped, so the stale selection is cleared.
		expect(stub.updateProfile).toHaveBeenCalledWith({
			organizationId: "o1",
			organizationName: "Acme",
			projectId: undefined,
			projectName: undefined,
			projectSlug: undefined,
		});
	});

	it("switches project by slug after verifying the credential scope", async () => {
		const r = await invoke("context_switch", { project: "web" });
		expect(r.isError).toBeUndefined();
		// Project-scoped API keys cannot be moved by mutating session state —
		// `tarout projects use` verifies scope then rewrites the local profile.
		expect(fakeClient.project.getActive.query).toHaveBeenCalled();
		expect(stub.updateProfile).toHaveBeenCalledWith({
			projectId: "p1",
			projectName: "Web",
			projectSlug: "web",
		});
		expect(fakeClient.project.setActive.mutate).not.toHaveBeenCalled();
	});

	it("rejects a project the current credential is not scoped to", async () => {
		fakeClient.project.getActive.query.mockResolvedValueOnce({
			projectId: "other",
		});
		const r = await invoke("context_switch", { project: "web" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("AUTH_ERROR");
		expect(stub.updateProfile).not.toHaveBeenCalled();
	});

	it("only mutates the fields supplied", async () => {
		const r = await invoke("context_switch", { organization: "Acme" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.organization.setActive.mutate).toHaveBeenCalledTimes(1);
		expect(fakeClient.project.getActive.query).not.toHaveBeenCalled();
		expect(stub.updateProfile).toHaveBeenCalledTimes(1);
	});

	it("returns a NOT_FOUND envelope when the org is unknown", async () => {
		const r = await invoke("context_switch", { organization: "nope" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as {
			error: string;
			code: string;
		};
		expect(body.code).toBe("NOT_FOUND");
		expect(body.error).toContain("Organization");
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
