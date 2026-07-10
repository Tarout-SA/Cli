import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	domainRegistrar: {
		getAll: {
			query: vi.fn().mockResolvedValue([{ domainId: "d1", host: "acme.sa" }]),
		},
		verifyExternalDomain: {
			mutate: vi.fn().mockResolvedValue({ verified: true }),
		},
	},
	domain: {
		create: {
			mutate: vi
				.fn()
				.mockResolvedValue({ domainId: "d2", host: "www.acme.sa" }),
		},
		one: {
			query: vi.fn().mockResolvedValue({ domainId: "d2", verified: true }),
		},
	},
	application: {
		allByOrganization: {
			query: vi
				.fn()
				.mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDomainTools } from "../../src/mcp/tools/domains";

async function invoke(name: string, args: unknown) {
	const server = new McpServer(
		{ name: "t", version: "0" },
		{ capabilities: { tools: {} } },
	);
	registerDomainTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.handler is private-ish.
	// SDK 1.29.x stores the callback under `.handler`.
	const reg = (server as any)._registeredTools[name];
	return (await reg.handler(args)) as {
		content: [{ text: string }];
		isError?: boolean;
	};
}

beforeEach(() => {
	fakeClient.domainRegistrar.getAll.query.mockClear();
	fakeClient.domainRegistrar.verifyExternalDomain.mutate.mockClear();
	fakeClient.domain.create.mutate.mockClear();
	fakeClient.domain.one.query.mockClear();
	fakeClient.application.allByOrganization.query.mockClear();
});

describe("domain tools", () => {
	it("domain_list returns registered domains", async () => {
		const r = await invoke("domain_list", {});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			count: number;
			domains: Array<{ host: string }>;
		};
		expect(body.count).toBe(1);
		expect(body.domains[0]?.host).toBe("acme.sa");
	});

	it("domain_link resolves app + creates domain", async () => {
		const r = await invoke("domain_link", { app: "web", host: "www.acme.sa" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			linked: boolean;
			app: { applicationId: string; name: string };
			domain: { domainId: string; host: string };
		};
		expect(body.linked).toBe(true);
		expect(body.app.applicationId).toBe("app_1");
		expect(body.app.name).toBe("web");
		expect(body.domain.domainId).toBe("d2");
		expect(fakeClient.domain.create.mutate).toHaveBeenCalledWith({
			applicationId: "app_1",
			host: "www.acme.sa",
		});
	});

	it("domain_verify returns first result when already verified", async () => {
		const r = await invoke("domain_verify", { domainId: "d1" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { verified: boolean };
		expect(body.verified).toBe(true);
		expect(
			fakeClient.domainRegistrar.verifyExternalDomain.mutate,
		).toHaveBeenCalledWith({ domainId: "d1" });
		expect(fakeClient.domain.one.query).not.toHaveBeenCalled();
	});

	it("domain_verify polls domain.one when wait=true and first check is not verified", async () => {
		fakeClient.domainRegistrar.verifyExternalDomain.mutate.mockResolvedValueOnce(
			{ verified: false },
		);
		fakeClient.domain.one.query.mockResolvedValueOnce({
			domainId: "d1",
			verified: true,
		});
		vi.useFakeTimers();
		const promise = invoke("domain_verify", {
			domainId: "d1",
			wait: true,
			timeoutSeconds: 30,
		});
		await vi.advanceTimersByTimeAsync(6000);
		const r = await promise;
		vi.useRealTimers();
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			verified: boolean;
			domain: { domainId: string };
		};
		expect(body.verified).toBe(true);
		expect(body.domain.domainId).toBe("d1");
		expect(fakeClient.domain.one.query).toHaveBeenCalledWith({
			domainId: "d1",
		});
	});
});
