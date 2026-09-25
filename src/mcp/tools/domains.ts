/**
 * Curated MCP tools for domain management: domain_list, domain_link,
 * domain_verify. Handlers route through withAuth() and, for domain_link,
 * resolve the target application via resolveAppRef() so agents can address
 * apps by name OR id.
 *
 * `domain_link` follows the same plan as `tarout domains link`
 * (resolveDomainLinkPlan): a hostname that already has a domain row (added
 * with addExternalDomain, or unlinked earlier) is attached with
 * domain.linkToApplication; a single-label subdomain of a domain registered
 * through Tarout is created with domain.createWithRegisteredDomain. It used to
 * call domain.create without a registeredDomainId, which the platform refuses
 * for every host.
 *
 * `domain_verify` checks a registered (external) domain with
 * domainRegistrar.verifyExternalDomain. With `wait`, it polls
 * domainRegistrar.getById (the same id space) until `dnsZoneStatus` reads
 * `active`, which is what verification writes; the platform also re-checks
 * pending domains every minute in the background. It used to poll domain.one,
 * whose ids are app-domain ids (NOT_FOUND for every registered domain), and
 * read `verified`, which that procedure never returns.
 *
 * Annotations:
 * - readOnlyHint on domain_list
 * - domain_link / domain_verify are mutating but non-destructive (no hint)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveDomainLinkPlan } from "../../commands/domains.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { CliError, NotFoundError } from "../../lib/errors.js";
import { ExitCode } from "../../utils/exit-codes.js";
import { withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");

const POLL_INTERVAL_MS = 5000;

type RegisteredDomainRow = { domainId: string; domainName: string };

/**
 * Accept a registered-domain id or its hostname. Ids are nanoids, which never
 * contain a dot, so anything with a dot is looked up by name.
 */
async function resolveRegisteredDomainId(
	// biome-ignore lint/suspicious/noExplicitAny: tRPC client is untyped here.
	client: any,
	ref: string,
): Promise<string> {
	if (!ref.includes(".")) return ref;
	const rows = (await client.domainRegistrar.getAll.query()) as RegisteredDomainRow[];
	const wanted = ref.trim().toLowerCase();
	const match = rows.find((r) => r.domainName?.toLowerCase() === wanted);
	if (!match) throw new NotFoundError("Domain", ref);
	return match.domainId;
}

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
				"Attaches a hostname to an app. The hostname must either be a subdomain of a domain registered through Tarout, or already added as an external domain (domainRegistrar.addExternalDomain via the `call` tool, then domain_verify).",
			inputSchema: {
				app,
				host: z.string().describe("Hostname to link (e.g. www.example.com)."),
			},
		},
		async ({ app: appRef, host: rawHost }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const host = rawHost.trim().toLowerCase();
				const plan = resolveDomainLinkPlan(
					host,
					(await client.domain.all.query({ includeUnlinked: true })) as unknown[],
					(await client.domainRegistrar.getAll.query()) as unknown[],
				);

				if (plan.kind === "existing") {
					const linked = (await client.domain.linkToApplication.mutate({
						domainId: plan.domainId,
						applicationId,
					})) as Record<string, unknown> | null | undefined;
					return {
						linked: true,
						app: { applicationId, name },
						domain: {
							domainId: plan.domainId,
							host,
							isVerified: plan.isVerified,
							...(linked && typeof linked === "object" ? linked : {}),
						},
					};
				}

				if (plan.kind === "registered-subdomain") {
					const created = (await client.domain.createWithRegisteredDomain.mutate({
						registeredDomainId: plan.registeredDomainId,
						subdomain: plan.subdomain,
						applicationId,
					})) as Record<string, unknown>;
					return { linked: true, app: { applicationId, name }, domain: created };
				}

				throw new CliError(
					`${host} has not been added yet. Add it with the \`call\` tool (procedure domainRegistrar.addExternalDomain, input {"domainName":"${host}"}), publish the DNS records it returns, run domain_verify with wait=true, then call domain_link again.`,
					ExitCode.INVALID_ARGUMENTS,
					undefined,
					{ host, reason: "DOMAIN_NOT_ADDED" },
				);
			}),
	);

	server.registerTool(
		"domain_verify",
		{
			title: "Verify an external domain's DNS",
			description:
				"Runs the DNS check for an external domain (id from domain_list, or its hostname). When `wait` is true and it is not verified yet, polls domainRegistrar.getById until the domain's DNS status is active.",
			inputSchema: {
				domainId: z
					.string()
					.describe("Registered-domain id from domain_list, or the domain name."),
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
		async ({ domainId: ref, wait, timeoutSeconds }) =>
			withAuth(async (client) => {
				const domainId = await resolveRegisteredDomainId(client, ref);
				const first = (await client.domainRegistrar.verifyExternalDomain.mutate({
					domainId,
				})) as Record<string, unknown> & { verified?: boolean };
				if (!wait || first.verified) return first;
				const deadline = Date.now() + timeoutSeconds * 1000;
				let last: Record<string, unknown> | undefined;
				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
					last = (await client.domainRegistrar.getById.query({
						domainId,
					})) as Record<string, unknown>;
					if (last?.dnsZoneStatus === "active") {
						return { verified: true, domain: last };
					}
				}
				// Hand back the first check's reasons and records so the agent can
				// fix DNS instead of blindly waiting again.
				return {
					...first,
					verified: false,
					timedOut: true,
					...(last ? { domain: last } : {}),
				};
			}),
	);
}
