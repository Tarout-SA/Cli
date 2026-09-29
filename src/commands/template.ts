/**
 * @fileoverview One-command app templates (`tarout template list | info |
 * deploy`). Wraps the platform's `template` router through lib/templates.
 *
 * `deploy` checks `--env` against the template before calling the platform:
 * an unknown key is an argument error, and a required variable with no default
 * and no generator is asked for (masked when secret), or reported as a
 * `needs_input` event in --json / non-interactive mode. A template that
 * creates a managed PostgreSQL database asks first unless --yes. Generated
 * values are never printed; the output names the keys and the command that
 * reads one back.
 * @module commands/template
 */

import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	handleError,
	InvalidArgumentError,
	rejectionReasonFromMessage,
	staleCredentialGuidance,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	isNonInteractiveMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	table,
	warn,
} from "../lib/output.js";
import {
	checkTemplateEnv,
	deployTemplate,
	describeEnvSource,
	envRevealCommand,
	getTemplate,
	listTemplates,
	needsCallerValue,
	parseEnvAssignments,
	TEMPLATE_AFTER_APPROVAL_NOTE,
	type Template,
	type TemplateDeployResult,
	type TemplateEnvVar,
	unknownEnvKeysMessage,
} from "../lib/templates.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { confirm, input, password } from "../utils/prompts.js";
import { startSpinner, stopSpinner, succeedSpinner } from "../utils/spinner.js";
import { formatAppUrl } from "../utils/url.js";
import {
	emitNeedsUpgrade,
	isEntitlementError,
	promptEntitlementRemedy,
	streamDeploymentWithLogs,
} from "./deploy.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

interface TemplateDeployOptions {
	name?: string;
	env?: string[];
	wait?: boolean;
}

/** Said when `--wait` has nothing to follow. */
export const NO_DEPLOYMENT_TO_FOLLOW =
	"The platform did not start a deployment for this app, so --wait has nothing to follow. Start one with `tarout deploy <app>`.";

/** Commander collector for the repeatable `--env KEY=VALUE`. */
function collectEnv(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** `--name`: trimmed; given but blank is an argument error. */
function parseAppName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const name = raw.trim();
	if (!name) throw new InvalidArgumentError("--name cannot be empty.");
	return name;
}

function yesNo(value: boolean): string {
	return value ? "yes" : "no";
}

/** The server's message when `err` is a parked (needs_approval) refusal. */
function parkedApprovalMessage(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as {
		message?: unknown;
		data?: { reason?: unknown } | null;
		shape?: { data?: { reason?: unknown } | null } | null;
	};
	const message = typeof e.message === "string" ? e.message : "";
	const named = e.data?.reason ?? e.shape?.data?.reason;
	const reason =
		typeof named === "string" && named
			? named
			: rejectionReasonFromMessage(message);
	return reason === "needs_approval" ? message : undefined;
}

/**
 * The same FORBIDDEN envelope `handleError` prints for a parked action, plus
 * the template-specific `afterApproval` note, and in human mode the concrete
 * `Next: tarout approvals wait <id>` line.
 */
function reportParkedDeploy(message: string): never {
	const guidance = staleCredentialGuidance(
		"FORBIDDEN",
		"needs_approval",
		message,
	);
	outputError(
		"FORBIDDEN",
		guidance ? `${message}: ${guidance.hint}` : message,
		{
			...(guidance?.details ?? {}),
			afterApproval: TEMPLATE_AFTER_APPROVAL_NOTE,
		},
	);
	if (!isJsonMode()) console.error(colors.dim(TEMPLATE_AFTER_APPROVAL_NOTE));
	exit(ExitCode.PERMISSION_DENIED);
}

/**
 * Asks for one variable the caller must supply. In --json or non-interactive
 * mode the prompt primitive emits `needs_input` for the first missing variable
 * (with every missing one in `context.missing`) and exits 6. Secret variables
 * are masked.
 */
async function askForEnvValue(
	template: Template,
	variable: TemplateEnvVar,
	missing: TemplateEnvVar[],
): Promise<string> {
	const question = `${variable.key} (${variable.description}):`;
	const descriptor = {
		field: `env.${variable.key}`,
		flag: `--env ${variable.key}=<value>`,
		sensitive: variable.secret,
		context: {
			template: template.code,
			key: variable.key,
			description: variable.description,
			missing: missing.map((v) => ({
				key: v.key,
				description: v.description,
				secret: v.secret,
				flag: `--env ${v.key}=<value>`,
			})),
		},
	};
	for (;;) {
		const value = variable.secret
			? await password(question, descriptor)
			: await input(question, undefined, descriptor);
		if (value.trim()) return value;
		warn(`${variable.key} is required.`);
	}
}

function printTemplateList(templates: Template[]): void {
	if (templates.length === 0) {
		log("");
		log("No templates are available on this Tarout server yet.");
		return;
	}
	log("");
	table(
		["CODE", "NAME", "CATEGORY", "POSTGRES"],
		templates.map((t) => [
			colors.cyan(t.code),
			t.name,
			t.category,
			t.requiresPostgres ? "yes" : colors.dim("no"),
		]),
	);
	log("");
	log(
		colors.dim(
			`${templates.length} template${templates.length === 1 ? "" : "s"}`,
		),
	);
	log(`Details: ${colors.dim("tarout template info <code>")}`);
	log(`Deploy:  ${colors.dim("tarout template deploy <code>")}`);
}

function printTemplateInfo(template: Template): void {
	log("");
	log(`${colors.bold(template.name)} ${colors.dim(`(${template.code})`)}`);
	if (template.description) log(template.description);
	log("");
	log(`Category:      ${template.category}`);
	log(`Image:         ${template.image}`);
	log(`Port:          ${template.port}`);
	log(
		`Postgres:      ${
			template.requiresPostgres
				? "yes, a managed PostgreSQL database is created and attached (it can add a charge to your plan)"
				: "no"
		}`,
	);
	if (template.architectures.length > 0) {
		log(`Architectures: ${template.architectures.join(", ")}`);
	}
	log(`Docs:          ${template.docsUrl ?? colors.dim("none")}`);
	log("");

	if (template.env.length === 0) {
		log("Environment variables: none");
	} else {
		log(colors.bold("Environment variables"));
		table(
			["KEY", "REQUIRED", "SECRET", "VALUE", "DESCRIPTION"],
			template.env.map((v) => [
				colors.cyan(v.key),
				yesNo(v.required),
				yesNo(v.secret),
				describeEnvSource(v),
				v.description,
			]),
		);
	}
	log("");

	const toSupply = template.env.filter(needsCallerValue);
	const flags = toSupply.map((v) => ` --env ${v.key}=<value>`).join("");
	log(`Deploy: ${colors.dim(`tarout template deploy ${template.code}${flags}`)}`);
	if (template.env.some((v) => v.generate)) {
		log(
			colors.dim(
				"Generated values are stored as secret environment variables and never printed.",
			),
		);
	}
}

/** The --json success payload. Carries variable NAMES only, never values. */
function deployPayload(
	template: Template,
	result: TemplateDeployResult,
	warnings: string[],
) {
	return {
		template: template.code,
		...result,
		url: formatAppUrl(result.url),
		nextCommand: result.deploymentId
			? `tarout deploy:status ${result.appName}`
			: `tarout deploy ${result.appName}`,
		...(result.generatedEnvKeys.length > 0
			? {
					hint: `Generated values are stored as secret environment variables and never printed. Read one with \`${envRevealCommand(result.appName)}\`.`,
				}
			: {}),
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

function printDeploySummary(
	template: Template,
	result: TemplateDeployResult,
	following: boolean,
): void {
	const url = formatAppUrl(result.url);
	const lines = [
		`App: ${colors.bold(result.appName)} ${colors.dim(`(${result.applicationId})`)}`,
		`URL: ${url ? colors.cyan(url) : colors.dim("assigned when the first deployment finishes")}`,
	];
	if (result.postgresId) {
		lines.push(
			`Database: managed PostgreSQL ${colors.dim(`(${result.postgresId})`)}`,
		);
	}
	if (result.deploymentId) {
		lines.push(`Deployment: ${colors.dim(result.deploymentId)}`);
	}
	if (result.generatedEnvKeys.length > 0) {
		lines.push(
			`Generated: ${result.generatedEnvKeys.join(", ")} ${colors.dim("(stored as secrets, never printed)")}`,
		);
	}
	box(`${template.name} deployed from template`, lines);

	log("Next steps:");
	if (!following && result.deploymentId) {
		log(
			`  Follow the deployment: ${colors.dim(`tarout deploy:status ${result.appName}`)}`,
		);
	}
	if (result.generatedEnvKeys.length > 0) {
		log(
			`  Read a generated value: ${colors.dim(envRevealCommand(result.appName, result.generatedEnvKeys[0]))}`,
		);
	}
	log(
		`  List environment variables: ${colors.dim(`tarout env list ${result.appName}`)}`,
	);
	log(`  View logs: ${colors.dim(`tarout logs ${result.appName}`)}`);
	if (template.docsUrl) log(`  Docs: ${colors.dim(template.docsUrl)}`);
	log("");
}

/** Plan-limit refusal: the same upgrade-or-addon handling `db create` uses. */
async function handleEntitlementRefusal(
	err: unknown,
	retryCommand: string,
): Promise<void> {
	if (isJsonMode() || isNonInteractiveMode() || shouldSkipConfirmation()) {
		await emitNeedsUpgrade(getApiClient(), err, undefined, retryCommand);
		exit(ExitCode.PERMISSION_DENIED);
	}
	const message = err instanceof Error ? err.message : "Plan upgrade required";
	log("");
	log(colors.warn(message));
	const upgraded = await promptEntitlementRemedy(getApiClient(), err, undefined);
	if (!upgraded) {
		await emitNeedsUpgrade(getApiClient(), err, undefined, retryCommand);
		exit(ExitCode.PERMISSION_DENIED);
	}
	box("Billing updated", [
		colors.success("Subscription updated."),
		`Run ${colors.cyan(retryCommand)} again to deploy the template.`,
	]);
}

async function runTemplateDeploy(
	code: string,
	options: TemplateDeployOptions,
): Promise<void> {
	const templateCode = code.trim();
	let client: TrpcClient;
	try {
		if (!templateCode) {
			throw new InvalidArgumentError(
				"Pass a template code. List the available ones with `tarout template list`.",
			);
		}
		const env = parseEnvAssignments(options.env ?? []);
		const name = parseAppName(options.name);
		if (!isLoggedIn()) throw new AuthError();

		client = getApiClient();
		startSpinner(`Loading the ${templateCode} template...`);
		let template: Template;
		try {
			template = await getTemplate(client, templateCode);
		} finally {
			stopSpinner();
		}

		// Every local check runs before anything is asked or created.
		const check = checkTemplateEnv(template, env);
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
		for (const variable of check.missing) {
			env[variable.key] = await askForEnvValue(
				template,
				variable,
				check.missing,
			);
		}

		if (template.requiresPostgres && !shouldSkipConfirmation()) {
			const confirmed = await confirm(
				`Deploying ${template.name} also creates a managed PostgreSQL database, which can add a charge to your plan. Continue?`,
				false,
				{
					field: "confirm_template_database",
					flag: "--yes",
					context: { template: template.code, requiresPostgres: true },
				},
			);
			if (!confirmed) {
				log("Cancelled.");
				return;
			}
		}

		startSpinner(`Deploying ${template.name}...`);
		const result = await deployTemplate(client, {
			code: template.code,
			name,
			env,
		});
		succeedSpinner(`${template.name} created.`);

		if (options.wait && result.deploymentId) {
			if (isJsonMode()) {
				// A streaming preamble line, like `tarout up`'s events: the follow
				// helper below prints the one final envelope.
				outputJsonLine({
					type: "event",
					event: "template_deployed",
					template: template.code,
					...result,
					url: formatAppUrl(result.url),
				});
			} else {
				printDeploySummary(template, result, true);
			}
			await streamDeploymentWithLogs(
				client,
				result.deploymentId,
				result.appName,
				result.applicationId,
			);
			return;
		}

		const warnings =
			options.wait && !result.deploymentId ? [NO_DEPLOYMENT_TO_FOLLOW] : [];
		if (isJsonMode()) {
			outputData(deployPayload(template, result, warnings));
			return;
		}
		quietOutput(result.applicationId);
		for (const message of warnings) warn(message);
		printDeploySummary(template, result, false);
	} catch (err) {
		stopSpinner();
		const parked = parkedApprovalMessage(err);
		if (parked !== undefined) reportParkedDeploy(parked);
		if (isEntitlementError(err)) {
			await handleEntitlementRefusal(
				err,
				`tarout template deploy ${templateCode}`,
			);
			return;
		}
		handleError(err);
	}
}

export function registerTemplateCommands(program: Command) {
	const template = program
		.command("template")
		.alias("templates")
		.description("Deploy ready-made apps from templates");

	template
		.command("list")
		.alias("ls")
		.description("List the available templates")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				startSpinner("Fetching templates...");
				const templates = await listTemplates(client);
				succeedSpinner();

				if (isJsonMode()) {
					outputData(templates);
					return;
				}
				printTemplateList(templates);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	template
		.command("info")
		.argument("<code>", "Template code (from `tarout template list`)")
		.description(
			"Show a template: image, port, database, and the environment variables it reads",
		)
		.action(async (code: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				startSpinner("Fetching template...");
				const found = await getTemplate(client, code.trim());
				succeedSpinner();

				if (isJsonMode()) {
					outputData(found);
					return;
				}
				quietOutput(found.code);
				printTemplateInfo(found);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	template
		.command("deploy")
		.argument("<code>", "Template code (from `tarout template list`)")
		.description("Deploy a template as a new app in the active project")
		.option("--name <name>", "Name for the new app (default: the template's)")
		.option(
			"-e, --env <KEY=VALUE>",
			"Set a variable the template reads (repeatable)",
			collectEnv,
			[] as string[],
		)
		.option("-w, --wait", "Wait for the first deployment and stream its logs")
		.addHelpText(
			"after",
			`
Keys passed with --env are checked against the template first; an unknown key
fails before anything is created. A required variable you leave out is asked
for (masked when secret); with --json or --non-interactive it is reported as a
needs_input event (exit 6) naming the --env flag to add. A template that
creates a managed PostgreSQL database asks before it does, unless --yes.
Generated values are never printed: read one with \`tarout env reveal <app> <KEY>\`.

Examples:
  tarout template list
  tarout template info <code>
  tarout template deploy <code> --env ADMIN_EMAIL=me@example.com --yes --wait
  tarout template deploy <code> --name my-app --json`,
		)
		.action(async (code: string, options: TemplateDeployOptions) =>
			runTemplateDeploy(code, options),
		);
}
