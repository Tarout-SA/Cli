import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

/**
 * Responses mirror the real platform shapes:
 * - domainRegistrar.getAll / getById: registered_domain rows with provider
 *   fields stripped (dnsZoneStatus, usesTaroutRouting, no cloudflare*).
 * - domainRegistrar.verifyExternalDomain: { verified, sslStatus,
 *   verificationErrors, ownershipVerification, ... }.
 * - domain.all: app-domain rows ({ domainId, host, isVerified, ... }).
 * - domain.create refuses any call without registeredDomainId
 *   (cloud/src/server/api/routers/domain.ts), so it must never be used here.
 */
const REGISTERED = {
	domainId: "rd_acme",
	domainName: "acme.sa",
	source: "purchased",
	status: "active",
	dnsZoneStatus: "active",
	usesTaroutRouting: false,
};
const EXTERNAL = {
	domainId: "rd_shop",
	domainName: "shop.customer.com",
	source: "external",
	status: "pending",
	dnsZoneStatus: "pending",
	usesTaroutRouting: true,
	cnameTarget: "edge.tarout.sa",
	isApex: false,
	apexIps: [],
};

const fakeClient = {
	domainRegistrar: {
		getAll: { query: vi.fn() },
		getById: { query: vi.fn() },
		verifyExternalDomain: { mutate: vi.fn() },
	},
	domain: {
		all: { query: vi.fn() },
		linkToApplication: { mutate: vi.fn() },
		createWithRegisteredDomain: { mutate: vi.fn() },
		create: {
			mutate: vi.fn(async () => {
				throw Object.assign(
					new Error(
						"Add external hostnames with domainRegistrar.addExternalDomain, verify the hostname, then link it with domain.linkToApplication.",
					),
					{ data: { code: "PRECONDITION_FAILED" } },
				);
			}),
		},
		one: { query: vi.fn() },
	},
	application: {
		allByOrganization: {
			query: vi.fn(),
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
	vi.clearAllMocks();
	fakeClient.domainRegistrar.getAll.query.mockResolvedValue([REGISTERED, EXTERNAL]);
	fakeClient.domainRegistrar.getById.query.mockResolvedValue({
		...EXTERNAL,
		linkedHosts: [],
	});
	fakeClient.domainRegistrar.verifyExternalDomain.mutate.mockResolvedValue({
		verified: true,
		customHostnameStatus: "active",
		sslStatus: "active",
		verificationErrors: [],
		ownershipVerification: null,
		cfOwnershipVerification: null,
		caaBlock: null,
	});
	fakeClient.domain.all.query.mockResolvedValue([]);
	fakeClient.application.allByOrganization.query.mockResolvedValue([
		{ applicationId: "app_1", name: "web" },
	]);
});

describe("domain_list", () => {
	it("returns registered domains", async () => {
		const r = await invoke("domain_list", {});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			count: number;
			domains: Array<{ domainName: string }>;
		};
		expect(body.count).toBe(2);
		expect(body.domains[0]?.domainName).toBe("acme.sa");
	});
});

describe("domain_link", () => {
	it("links an external hostname that was already added, via linkToApplication", async () => {
		fakeClient.domain.all.query.mockResolvedValue([
			{
				domainId: "dom_shop",
				host: "shop.customer.com",
				isVerified: true,
				applicationId: null,
			},
		]);
		fakeClient.domain.linkToApplication.mutate.mockResolvedValue({
			domainId: "dom_shop",
			host: "shop.customer.com",
			applicationId: "app_1",
			isVerified: true,
		});

		const r = await invoke("domain_link", {
			app: "web",
			host: "Shop.Customer.com",
		});

		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text);
		expect(body.linked).toBe(true);
		expect(body.app).toEqual({ applicationId: "app_1", name: "web" });
		expect(body.domain).toMatchObject({
			domainId: "dom_shop",
			host: "shop.customer.com",
			isVerified: true,
		});
		expect(fakeClient.domain.all.query).toHaveBeenCalledWith({
			includeUnlinked: true,
		});
		expect(fakeClient.domain.linkToApplication.mutate).toHaveBeenCalledWith({
			domainId: "dom_shop",
			applicationId: "app_1",
		});
		expect(fakeClient.domain.create.mutate).not.toHaveBeenCalled();
	});

	it("creates a subdomain under a Tarout-registered domain via createWithRegisteredDomain", async () => {
		fakeClient.domain.createWithRegisteredDomain.mutate.mockResolvedValue({
			domainId: "dom_www",
			host: "www.acme.sa",
			applicationId: "app_1",
			isVerified: true,
		});

		const r = await invoke("domain_link", { app: "web", host: "www.acme.sa" });

		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text);
		expect(body.linked).toBe(true);
		expect(body.domain.domainId).toBe("dom_www");
		expect(
			fakeClient.domain.createWithRegisteredDomain.mutate,
		).toHaveBeenCalledWith({
			registeredDomainId: "rd_acme",
			subdomain: "www",
			applicationId: "app_1",
		});
		expect(fakeClient.domain.create.mutate).not.toHaveBeenCalled();
	});

	it("refuses a hostname nobody added, naming the add, verify and link steps", async () => {
		const r = await invoke("domain_link", {
			app: "web",
			host: "blog.elsewhere.com",
		});

		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text);
		expect(body.error).toContain("blog.elsewhere.com has not been added yet");
		expect(body.error).toContain("domainRegistrar.addExternalDomain");
		expect(body.error).toContain("domain_verify");
		expect(body.details).toMatchObject({ reason: "DOMAIN_NOT_ADDED" });
		expect(fakeClient.domain.create.mutate).not.toHaveBeenCalled();
		expect(fakeClient.domain.linkToApplication.mutate).not.toHaveBeenCalled();
	});
});

describe("domain_verify", () => {
	it("returns the first check when already verified", async () => {
		const r = await invoke("domain_verify", { domainId: "rd_shop" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { verified: boolean };
		expect(body.verified).toBe(true);
		expect(
			fakeClient.domainRegistrar.verifyExternalDomain.mutate,
		).toHaveBeenCalledWith({ domainId: "rd_shop" });
		expect(fakeClient.domainRegistrar.getById.query).not.toHaveBeenCalled();
		expect(fakeClient.domain.one.query).not.toHaveBeenCalled();
	});

	it("accepts the domain name and resolves it to the registered-domain id", async () => {
		await invoke("domain_verify", { domainId: "shop.customer.com" });
		expect(
			fakeClient.domainRegistrar.verifyExternalDomain.mutate,
		).toHaveBeenCalledWith({ domainId: "rd_shop" });
	});

	it("polls domainRegistrar.getById (same id space) until dnsZoneStatus is active", async () => {
		fakeClient.domainRegistrar.verifyExternalDomain.mutate.mockResolvedValueOnce({
			verified: false,
			sslStatus: "pending_validation",
			verificationErrors: ["custom hostname does not CNAME to this zone."],
			ownershipVerification: null,
			cfOwnershipVerification: null,
			caaBlock: null,
		});
		fakeClient.domainRegistrar.getById.query
			.mockResolvedValueOnce({ ...EXTERNAL, dnsZoneStatus: "pending" })
			.mockResolvedValueOnce({
				...EXTERNAL,
				status: "active",
				dnsZoneStatus: "active",
				sslStatus: "active",
			});
		vi.useFakeTimers();
		const promise = invoke("domain_verify", {
			domainId: "rd_shop",
			wait: true,
			timeoutSeconds: 30,
		});
		await vi.advanceTimersByTimeAsync(11_000);
		const r = await promise;
		vi.useRealTimers();

		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as {
			verified: boolean;
			domain: { domainId: string; dnsZoneStatus: string };
		};
		expect(body.verified).toBe(true);
		expect(body.domain.domainId).toBe("rd_shop");
		expect(fakeClient.domainRegistrar.getById.query).toHaveBeenCalledTimes(2);
		expect(fakeClient.domainRegistrar.getById.query).toHaveBeenCalledWith({
			domainId: "rd_shop",
		});
		expect(fakeClient.domain.one.query).not.toHaveBeenCalled();
	});

	it("on timeout returns the first check's reasons so the agent can fix DNS", async () => {
		fakeClient.domainRegistrar.verifyExternalDomain.mutate.mockResolvedValueOnce({
			verified: false,
			sslStatus: "pending_validation",
			verificationErrors: ["Ownership TXT record not detected yet."],
			ownershipVerification: { name: "_tarout.shop", value: "abc" },
			cfOwnershipVerification: null,
			caaBlock: null,
		});
		fakeClient.domainRegistrar.getById.query.mockResolvedValue({
			...EXTERNAL,
			dnsZoneStatus: "pending",
		});
		vi.useFakeTimers();
		const promise = invoke("domain_verify", {
			domainId: "rd_shop",
			wait: true,
			timeoutSeconds: 10,
		});
		await vi.advanceTimersByTimeAsync(11_000);
		const r = await promise;
		vi.useRealTimers();

		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text);
		expect(body.verified).toBe(false);
		expect(body.timedOut).toBe(true);
		expect(body.verificationErrors).toEqual([
			"Ownership TXT record not detected yet.",
		]);
		expect(body.ownershipVerification).toEqual({
			name: "_tarout.shop",
			value: "abc",
		});
	});
});
