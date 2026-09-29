/**
 * @fileoverview One-command app templates, shared by `tarout template` and the
 * stdio MCP tools `template_list`, `template_info` and `template_deploy`.
 * Wraps the platform's `template` router.
 *
 * A template is a ready-made app (an image, a port, the environment variables
 * it reads, and optionally a managed PostgreSQL database). `template.deploy`
 * creates the app in the active project, creates and attaches the database
 * when the template needs one, fills the variables, and starts the first
 * deployment. Variables with a `generate` rule are minted by the platform; the
 * CLI never sees, prints or returns their values, only their names.
 *
 * Everything here is pure: no output, no prompts, no process exit. Both
 * surfaces decide how to ask for missing input and how to report errors.
 * @module lib/templates
 */

import { ExitCode } from "../utils/exit-codes.js";
import {
	CliError,
	findSimilar,
	InvalidArgumentError,
	isMissingProcedureError,
} from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

/** How the platform mints a value the caller does not supply. */
export type TemplateGenerateRule = "password" | "hex32" | "base64-32";

export interface TemplateEnvVar {
	key: string;
	description: string;
	required: boolean;
	/** Stored as a secret env var; mask it when asking for it. */
	secret: boolean;
	default?: string;
	/** Set when the platform generates the value if none is supplied. */
	generate?: TemplateGenerateRule;
}

/** What `template.list` returns one of, and `template.info` returns. */
export interface Template {
	code: string;
	name: string;
	description: string;
	category: string;
	image: string;
	port: number;
	/** True when deploying also creates and attaches a managed PostgreSQL database. */
	requiresPostgres: boolean;
	env: TemplateEnvVar[];
	docsUrl: string | null;
	architectures: string[];
}

export interface TemplateDeployInput {
	code: string;
	name?: string;
	env?: Record<string, string>;
}

/** What `template.deploy` returns. Never carries a variable's value. */
export interface TemplateDeployResult {
	applicationId: string;
	appName: string;
	url: string | null;
	postgresId: string | null;
	deploymentId: string | null;
	/** NAMES of the variables the platform generated. Never values. */
	generatedEnvKeys: string[];
}

export const TEMPLATE_UNSUPPORTED_MESSAGE =
	"This Tarout server does not support templates yet (the template router is missing; it ships in a newer platform release). Deploy the image yourself with `tarout apps create` and `tarout deploy` in the meantime.";

/**
 * Said with every parked (NEEDS_APPROVAL) template deploy. The platform replays
 * an approved call without keeping its return value, so the new app's id and
 * URL never reach the agent that asked.
 */
export const TEMPLATE_AFTER_APPROVAL_NOTE =
	'Once a human approves it, the platform creates the app (and its database) and starts the first deployment, but the result is not returned to you: the approval records only "executed" or "failed". After it reports executed, find the new app with `tarout apps list`.';

/** Rethrows `err`, as a readable NOT_FOUND when the server predates `procedure`. */
function rethrowTemplateError(err: unknown, procedure: string): never {
	if (isMissingProcedureError(err)) {
		throw new CliError(
			TEMPLATE_UNSUPPORTED_MESSAGE,
			ExitCode.NOT_FOUND,
			undefined,
			{ procedure, reason: "procedure_unavailable" },
		);
	}
	throw err;
}

/** `template.list`. An older server fails with NOT_FOUND and a readable message. */
export async function listTemplates(client: TrpcClient): Promise<Template[]> {
	try {
		const all = (await client.template.list.query()) as Template[] | null;
		return Array.isArray(all) ? all : [];
	} catch (err) {
		rethrowTemplateError(err, "template.list");
	}
}

/**
 * `template.info`. An unknown code is the server's own NOT_FOUND and passes
 * through unchanged; only a missing procedure is rewritten.
 */
export async function getTemplate(
	client: TrpcClient,
	code: string,
): Promise<Template> {
	try {
		return (await client.template.info.query({ code })) as Template;
	} catch (err) {
		rethrowTemplateError(err, "template.info");
	}
}

/**
 * `template.deploy`, in the active project. `name` and `env` are sent only
 * when given, so the server applies its own defaults. Refusals (a parked
 * approval, a plan limit) propagate for the caller to report.
 */
export async function deployTemplate(
	client: TrpcClient,
	input: TemplateDeployInput,
): Promise<TemplateDeployResult> {
	const payload: TemplateDeployInput = { code: input.code };
	if (input.name !== undefined) payload.name = input.name;
	if (input.env && Object.keys(input.env).length > 0) payload.env = input.env;
	try {
		const result = (await client.template.deploy.mutate(
			payload,
		)) as TemplateDeployResult;
		return {
			...result,
			generatedEnvKeys: Array.isArray(result?.generatedEnvKeys)
				? result.generatedEnvKeys
				: [],
		};
	} catch (err) {
		rethrowTemplateError(err, "template.deploy");
	}
}

/**
 * Parses repeated `--env KEY=VALUE` values. Splits on the first `=` only, so a
 * value may itself contain `=`. `KEY=` is an explicit empty value. A pair
 * without `=`, an empty key, or the same key twice is an argument error.
 */
export function parseEnvAssignments(pairs: string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq === -1) {
			throw new InvalidArgumentError(
				`Invalid --env value "${pair}". Use KEY=VALUE, for example --env ADMIN_EMAIL=me@example.com.`,
			);
		}
		const key = pair.slice(0, eq).trim();
		if (!key) {
			throw new InvalidArgumentError(
				`Invalid --env value "${pair}": the key before "=" is empty.`,
			);
		}
		if (Object.hasOwn(env, key)) {
			throw new InvalidArgumentError(
				`--env ${key} was given more than once. Pass each variable once.`,
			);
		}
		env[key] = pair.slice(eq + 1);
	}
	return env;
}

/** True when the platform fills the variable itself if the caller does not. */
export function hasPlatformValue(variable: TemplateEnvVar): boolean {
	return Boolean(variable.generate) || variable.default !== undefined;
}

/** A variable the caller must supply: required, with no default and no generator. */
export function needsCallerValue(variable: TemplateEnvVar): boolean {
	return variable.required && !hasPlatformValue(variable);
}

export interface TemplateEnvCheck {
	/** Supplied keys the template does not read. */
	unknown: string[];
	/** Required variables with no value, no default and no generator. */
	missing: TemplateEnvVar[];
}

/**
 * Compares supplied variables against the template. Keys are case-sensitive,
 * like env vars. An empty value for a variable the caller must supply counts
 * as missing.
 */
export function checkTemplateEnv(
	template: Template,
	env: Record<string, string>,
): TemplateEnvCheck {
	const known = new Set(template.env.map((v) => v.key));
	const unknown = Object.keys(env).filter((key) => !known.has(key));
	const missing = template.env.filter(
		(v) => needsCallerValue(v) && !(env[v.key] ?? "").trim(),
	);
	return { unknown, missing };
}

/** The INVALID_ARGUMENTS message for keys the template does not read. */
export function unknownEnvKeysMessage(
	template: Template,
	unknown: string[],
): string {
	const keys = template.env.map((v) => v.key);
	const suggestions = unknown.flatMap((key) => findSimilar(key, keys, 1));
	const allowed =
		keys.length > 0
			? `It reads: ${keys.join(", ")}.`
			: "It reads no variables.";
	const hint =
		suggestions.length > 0
			? ` Did you mean ${[...new Set(suggestions)].join(", ")}?`
			: "";
	return `The ${template.code} template does not read ${unknown.join(", ")}. ${allowed}${hint}`;
}

/** Plain-words description of where a variable's value comes from. */
export function describeEnvSource(variable: TemplateEnvVar): string {
	if (variable.generate) return `generated (${variable.generate})`;
	if (variable.default !== undefined) {
		// A secret's default is still a secret-shaped value; name it, don't show it.
		return variable.secret || variable.default === ""
			? "default"
			: `default: ${variable.default}`;
	}
	return variable.required ? "you provide" : "optional";
}

/** A variable in the shape agents see: `sensitive` in place of `secret`. */
export interface TemplateEnvSummary {
	key: string;
	description: string;
	required: boolean;
	sensitive: boolean;
	default?: string;
	generate?: TemplateGenerateRule;
	source: string;
}

/**
 * Renames `secret` to `sensitive` for MCP results. The MCP result sanitizer
 * redacts every field whose name contains "secret", which would turn the flag
 * itself into "[redacted from MCP response]". A secret variable's default is
 * dropped for the same reason the terminal never prints it.
 */
export function summarizeTemplateEnv(
	variable: TemplateEnvVar,
): TemplateEnvSummary {
	return {
		key: variable.key,
		description: variable.description,
		required: variable.required,
		sensitive: variable.secret,
		...(variable.default !== undefined && !variable.secret
			? { default: variable.default }
			: {}),
		...(variable.generate ? { generate: variable.generate } : {}),
		source: describeEnvSource(variable),
	};
}

/** The command that reads a generated value back, safe to show as printed. */
export function envRevealCommand(appName: string, key = "<KEY>"): string {
	return `tarout env reveal ${appName} ${key}`;
}
