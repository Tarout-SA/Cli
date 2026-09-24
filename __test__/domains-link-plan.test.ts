import { describe, expect, it } from "vitest";
import { resolveDomainLinkPlan } from "../src/commands/domains.js";

const registered = [{ domainId: "reg-1", domainName: "example.sa" }];

describe("tarout domains link: which flow a hostname takes", () => {
	it("links a hostname already added with add-external (the documented path that broke)", () => {
		const plan = resolveDomainLinkPlan(
			"sc3-13429.tarouttest-s6mitl.org",
			[{ domainId: "dom-1", host: "sc3-13429.tarouttest-s6mitl.org", isVerified: true }],
			registered,
		);
		expect(plan).toEqual({ kind: "existing", domainId: "dom-1", isVerified: true });
	});

	it("creates a subdomain under a domain registered through Tarout", () => {
		expect(resolveDomainLinkPlan("app.example.sa", [], registered)).toEqual({
			kind: "registered-subdomain",
			registeredDomainId: "reg-1",
			subdomain: "app",
		});
	});

	it("tells the user exactly what to run for a hostname nobody added", () => {
		const plan = resolveDomainLinkPlan("shop.customer.com", [], registered);
		expect(plan.kind).toBe("unavailable");
		if (plan.kind === "unavailable") {
			expect(plan.message).toContain("tarout domains add-external shop.customer.com");
			expect(plan.message).toContain("tarout domains verify shop.customer.com");
			expect(plan.message).not.toMatch(/linkToApplication|domainRegistrar|—/);
		}
	});

	it("does not guess a multi-label subdomain under a registered domain", () => {
		expect(resolveDomainLinkPlan("a.b.example.sa", [], registered).kind).toBe("unavailable");
	});
});
