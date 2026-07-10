/**
 * Curated MCP tools for domain management: domain_list, domain_link,
 * domain_verify. Handlers route through withAuth() and, for domain_link,
 * resolve the target application via resolveAppRef() so agents can address
 * apps by name OR id.
 *
 * `domain_verify` supports `wait?` + `timeoutSeconds?` — when wait=true and
 * the initial check does not report `verified: true`, it polls domain.one
 * every 5s until the domain flips to verified or the deadline elapses.
 *
 * Annotations:
 * - readOnlyHint on domain_list
 * - domain_link / domain_verify are mutating but non-destructive (no hint)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAppRef } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");

export function registerDomainTools(server: McpServer): void {
	server.registerTool(
		"domain_list",
		{
			title: "List registered / external domains",
			description: "Wraps domainRegistrar.getAll.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const list = (await client.domainRegistrar.getAll.query()) as Array<
					Record<string, unknown>
				>;
				return { count: list.length, domains: list };
			}),
	);

	server.registerTool(
		"domain_link",
		{
			title: "Link a custom domain to an application",
			description:
				"Creates a domain record pointing at the given app and returns DNS instructions.",
			inputSchema: {
				app,
				host: z.string().describe("Hostname to link (e.g. www.example.com)."),
			},
		},
		async ({ app: appRef, host }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const created = (await client.domain.create.mutate({
					applicationId,
					host,
				})) as Record<string, unknown>;
				return { linked: true, app: { applicationId, name }, domain: created };
			}),
	);

	server.registerTool(
		"domain_verify",
		{
			title: "Verify an external domain's DNS",
			description:
				"Runs the verification check. When `wait` is true, polls domain.one until `verified` flips.",
			inputSchema: {
				domainId: z.string(),
				wait: z.boolean().optional().default(false),
				timeoutSeconds: z
					.number()
					.int()
					.positive()
					.max(1800)
					.optional()
					.default(120),
			},
		},
		async ({ domainId, wait, timeoutSeconds }) =>
			withAuth(async (client) => {
				const first = (await client.domainRegistrar.verifyExternalDomain.mutate({
					domainId,
				})) as { verified?: boolean };
				if (!wait || first.verified) return first;
				const deadline = Date.now() + timeoutSeconds * 1000;
				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 5000));
					const next = (await client.domain.one.query({ domainId })) as {
						verified?: boolean;
					};
					if (next.verified) return { verified: true, domain: next };
				}
				return { verified: false, timedOut: true };
			}),
	);
}
