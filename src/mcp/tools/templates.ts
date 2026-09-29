/**
 * Curated MCP tools for one-command app templates: template_list,
 * template_info, template_deploy. They wrap the platform's `template` router
 * through lib/templates, the same helpers `tarout template` uses.
 *
 * Variables come back with `sensitive` in place of the platform's `secret`
 * flag: the result sanitizer redacts every field whose name contains "secret",
 * so the flag itself would read "[redacted from MCP response]". A secret
 * variable's default is left out for the same reason the terminal never prints
 * it.
 *
 * template_deploy checks `env` against the template before creating anything:
 * an unknown key is INVALID_ARGUMENTS, and a required variable with no default
 * and no generator is NEEDS_INPUT with every missing variable in
 * `details.missing`. Generated values are never returned, only their names.
 *
 * Annotations:
 * - readOnlyHint on template_list / template_info
 * - template_deploy creates billable resources but destroys nothing, so, like
 *   app_create and db_create, it carries no hint. Operator-tier keys may get
 *   NEEDS_APPROVAL for the database it creates; a plan limit comes back as
 *   FORBIDDEN with the billing_upgrade remedy (both from withAuth).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CliError } from "../../lib/errors.js";
import {
	checkTemplateEnv,
	deployTemplate,
	envRevealCommand,
	getTemplate,
	listTemplates,
	summarizeTemplateEnv,
	TEMPLATE_AFTER_APPROVAL_NOTE,
	type Template,
	unknownEnvKeysMessage,
} from "../../lib/templates.js";
import { ExitCode } from "../../utils/exit-codes.js";
import { formatAppUrl } from "../../utils/url.js";
import {
	type Envelope,
	errorResult,
	type ToolText,
	withAuth,
} from "../runtime.js";

const code = z
	.string()
	.min(1)
	.describe("Template code: the `code` field from template_list.");

/** A template in the shape agents see (`sensitive`, never `secret`). */
function templateView(template: Template) {
	return {
		code: template.code,
		name: template.name,
		description: template.description,
		category: template.category,
		image: template.image,
		port: template.port,
		requiresPostgres: template.requiresPostgres,
		docsUrl: template.docsUrl,
		architectures: template.architectures,
		env: template.env.map(summarizeTemplateEnv),
	};
}

/** Adds the approval note to a NEEDS_APPROVAL envelope; any other result as is. */
function withApprovalNote(result: ToolText): ToolText {
	if (!result.isError) return result;
	const text = result.content[0]?.text;
	try {
		const env = JSON.parse(text ?? "") as {
			code?: string;
			details?: Record<string, unknown>;
		};
		if (env.code !== "NEEDS_APPROVAL") return result;
		env.details = {
			...(env.details ?? {}),
			afterApproval: TEMPLATE_AFTER_APPROVAL_NOTE,
		};
		return {
			...result,
			content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
		};
	} catch {
		return result;
	}
}

export function registerTemplateTools(server: McpServer): void {
	server.registerTool(
		"template_list",
		{
			title: "List the app templates this Tarout server offers",
			description:
				"Wraps template.list. Returns code, name, description, category and requiresPostgres (true when deploying also creates a managed PostgreSQL database) per template. Call template_info for a template's variables. A server without templates answers NOT_FOUND.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const all = await listTemplates(client);
				return {
					count: all.length,
					templates: all.map((t) => ({
						code: t.code,
						name: t.name,
						description: t.description,
						category: t.category,
						requiresPostgres: t.requiresPostgres,
					})),
				};
			}),
	);

	server.registerTool(
		"template_info",
		{
			title: "Full details for one app template",
			description:
				"Wraps template.info. Returns the image, port, requiresPostgres, docsUrl, architectures and env: one entry per variable with key, description, required, sensitive (stored as a secret; the platform calls it `secret`), default (omitted for sensitive variables), generate (password | hex32 | base64-32 when the platform mints the value) and source. Pass template_deploy an `env` value for every variable whose source is \"you provide\". An unknown code answers NOT_FOUND.",
			inputSchema: { code },
			annotations: { readOnlyHint: true },
		},
		async ({ code: templateCode }) =>
			withAuth(async (client) => {
				const template = await getTemplate(client, templateCode.trim());
				return { template: templateView(template) };
			}),
	);

	server.registerTool(
		"template_deploy",
		{
			title: "Deploy an app template into the active project",
			description:
				"Wraps template.deploy: creates the app in the active project, creates and attaches a managed PostgreSQL database when the template's requiresPostgres is true (this can add a charge to the plan), fills the variables and starts the first deployment. `env` keys are checked against template_info first: an unknown key is INVALID_ARGUMENTS, and a required variable with no default and no generator is NEEDS_INPUT listing every missing one in details.missing; ask the user for those values, then call again. Returns applicationId, appName, url (null until assigned), postgresId, deploymentId (poll it with deployment_status) and generatedEnvKeys: the NAMES of variables the platform generated, never their values (a human reads one with `tarout env reveal <app> <KEY>`). An operator-tier key may get NEEDS_APPROVAL; a plan limit is FORBIDDEN with a billing_upgrade remedy. A server without templates answers NOT_FOUND.",
			inputSchema: {
				code,
				name: z
					.string()
					.min(1)
					.optional()
					.describe("Name for the new app. Defaults to the template's name."),
				env: z
					.record(z.string(), z.string())
					.optional()
					.describe(
						"Variables to set, keyed by the template's variable keys. Values are sent to the platform and never echoed back.",
					),
			},
		},
		async ({ code: templateCode, name, env }) => {
			// Set inside withAuth when a required variable is missing; a holder
			// object because TypeScript does not see assignments made in a callback.
			const outcome: { refusal?: Envelope } = {};
			const result = await withAuth(async (client) => {
				const template = await getTemplate(client, templateCode.trim());
				const supplied = env ?? {};
				const check = checkTemplateEnv(template, supplied);
				if (check.unknown.length > 0) {
					throw new CliError(
						unknownEnvKeysMessage(template, check.unknown),
						ExitCode.INVALID_ARGUMENTS,
						undefined,
						{
							template: template.code,
							unknownKeys: check.unknown,
							allowedKeys: template.env.map((v) => v.key),
						},
					);
				}
				if (check.missing.length > 0) {
					outcome.refusal = {
						error: `The ${template.code} template needs a value for ${check.missing
							.map((v) => v.key)
							.join(", ")}.`,
						code: "NEEDS_INPUT",
						remediation:
							"Ask the user for each variable in details.missing (mask the sensitive ones), then call template_deploy again with them in `env`.",
						details: {
							template: template.code,
							missing: check.missing.map((v) => ({
								key: v.key,
								description: v.description,
								sensitive: v.secret,
							})),
						},
					};
					return null;
				}
				const deployed = await deployTemplate(client, {
					code: template.code,
					name: name?.trim() || undefined,
					env: supplied,
				});
				return {
					template: template.code,
					...deployed,
					url: formatAppUrl(deployed.url),
					...(deployed.generatedEnvKeys.length > 0
						? {
								hint: `Generated values are stored as secret environment variables and never returned. A human reads one with \`${envRevealCommand(deployed.appName)}\`.`,
							}
						: {}),
				};
			});
			if (outcome.refusal) return errorResult(outcome.refusal);
			return withApprovalNote(result);
		},
	);
}
