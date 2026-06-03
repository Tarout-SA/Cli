import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerEmailCommands(program: Command) {
	const email = program
		.command("email")
		.description("Manage email service configuration, templates, and logs");

	// ── Config management ────────────────────────────────────────────────────────
	const config = email
		.command("config")
		.description("Manage email configuration");

	config
		.command("get")
		.description("Show email configuration for an environment")
		.option("-e, --env <environment-id>", "Environment ID")
		.action(async (options: { env?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching email config...");
				const data = await client.emailService.getConfig.query({
					environmentId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const c = data as any;
				if (!c) {
					log("No email configuration found.");
					return;
				}
				log("");
				log(colors.bold("Email Configuration"));
				log(`  Provider:   ${c.provider || "-"}`);
				log(`  From Name:  ${c.fromName || "-"}`);
				log(`  From Email: ${c.fromEmail || "-"}`);
				log(`  Domain:     ${c.fromDomain || "-"}`);
				log(`  Reply To:   ${c.replyToEmail || "-"}`);
				log(
					`  Verified:   ${c.isVerified ? colors.success("yes") : colors.warn("no")}`,
				);
				log(`  ID:         ${colors.dim(c.id || c.emailServiceId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	config
		.command("create")
		.description("Create email configuration for an environment")
		.option("-e, --env <environment-id>", "Environment ID")
		.option(
			"-p, --provider <provider>",
			"Email provider (resend, sendgrid, mailgun, ses)",
		)
		.option("--api-key <key>", "API key")
		.option("--from-domain <domain>", "From domain")
		.option("--from-name <name>", "From name")
		.option("--from-email <email>", "From email address")
		.option("--reply-to <email>", "Reply-to email")
		.action(
			async (options: {
				env?: string;
				provider?: string;
				apiKey?: string;
				fromDomain?: string;
				fromName?: string;
				fromEmail?: string;
				replyTo?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const provider =
						options.provider ||
						(await select(
							"Email provider:",
							[
								{ name: "Resend", value: "resend" },
								{ name: "SendGrid", value: "sendgrid" },
								{ name: "Mailgun", value: "mailgun" },
								{ name: "Amazon SES", value: "ses" },
							],
							{ field: "email_provider", flag: "--provider" },
						));
					const apiKey =
						options.apiKey ||
						(await input("API Key:", undefined, {
							field: "api_key",
							flag: "--api-key",
							sensitive: true,
						}));
					const fromDomain =
						options.fromDomain ||
						(await input("From domain (e.g. mail.example.com):", undefined, {
							field: "from_domain",
							flag: "--from-domain",
						}));
					const fromName =
						options.fromName ||
						(await input("From name:", undefined, {
							field: "from_name",
							flag: "--from-name",
						}));
					const fromEmail =
						options.fromEmail ||
						(await input(
							`From email (e.g. hello@${fromDomain}):`,
							undefined,
							{ field: "from_email", flag: "--from-email" },
						));
					const client = getApiClient();
					const _spinner = startSpinner("Creating email config...");
					const result = await client.emailService.createConfig.mutate({
						environmentId,
						provider,
						apiKey,
						fromDomain,
						fromName,
						fromEmail,
						replyToEmail: options.replyTo,
					} as any);
					succeedSpinner("Email configuration created.");
					if (isJsonMode()) outputData(result);
					else quietOutput((result as any).id || environmentId);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	config
		.command("update <email-service-id>")
		.description("Update email configuration")
		.option("--api-key <key>", "New API key")
		.option("--from-domain <domain>", "New from domain")
		.option("--from-name <name>", "New from name")
		.option("--from-email <email>", "New from email")
		.option("--reply-to <email>", "New reply-to email")
		.action(
			async (
				emailServiceId: string,
				options: {
					apiKey?: string;
					fromDomain?: string;
					fromName?: string;
					fromEmail?: string;
					replyTo?: string;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Updating email config...");
					await client.emailService.updateConfig.mutate({
						emailServiceId,
						apiKey: options.apiKey,
						fromDomain: options.fromDomain,
						fromName: options.fromName,
						fromEmail: options.fromEmail,
						replyToEmail: options.replyTo,
					} as any);
					succeedSpinner("Email configuration updated.");
					if (isJsonMode()) outputData({ updated: true, emailServiceId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	config
		.command("delete <email-service-id>")
		.alias("rm")
		.description("Delete email configuration")
		.action(async (emailServiceId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete email configuration "${emailServiceId}"?`,
						false,
						{
							field: "confirm_delete_email_config",
							flag: "--yes",
							context: { emailServiceId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Deleting email config...");
				await client.emailService.deleteConfig.mutate({
					emailServiceId,
				} as any);
				succeedSpinner("Email configuration deleted.");
				if (isJsonMode()) outputData({ deleted: true, emailServiceId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Domain verification ──────────────────────────────────────────────────────
	const domain = email
		.command("domain")
		.description("Manage email domain verification");

	domain
		.command("verify")
		.description("Initiate email domain verification")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-d, --domain <domain>", "Domain to verify")
		.action(async (options: { env?: string; domain?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const domainName =
					options.domain ||
					(await input("Domain to verify:", undefined, {
						field: "domain",
						flag: "--domain",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Initiating domain verification...");
				const result = await client.emailService.verifyDomain.mutate({
					environmentId,
					domain: domainName,
				} as any);
				succeedSpinner("Verification initiated.");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	domain
		.command("status")
		.description("Check email domain verification status")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-d, --domain <domain>", "Domain to check")
		.action(async (options: { env?: string; domain?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const domainName =
					options.domain ||
					(await input("Domain name:", undefined, {
						field: "domain",
						flag: "--domain",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Checking domain status...");
				const data = await client.emailService.getDomainStatus.query({
					environmentId,
					domain: domainName,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const s = data as any;
				log("");
				log(`Domain: ${colors.cyan(domainName)}`);
				log(
					`Status: ${s.verified || s.status === "verified" ? colors.success("verified") : colors.warn(s.status || "pending")}`,
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	domain
		.command("dns-records")
		.description("Get DNS records needed for email domain verification")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-d, --domain <domain>", "Domain name")
		.option("--type <type>", "Domain type (managed/external)")
		.action(
			async (options: { env?: string; domain?: string; type?: string }) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const domainName =
						options.domain ||
						(await input("Domain name:", undefined, {
							field: "domain",
							flag: "--domain",
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Fetching DNS records...");
					const data = await client.emailService.getDnsRecords.query({
						environmentId,
						domain: domainName,
						domainType: options.type || "external",
					} as any);
					succeedSpinner();
					if (isJsonMode()) {
						outputData(data);
						return;
					}
					const records = Array.isArray(data)
						? data
						: (data as any)?.records || [];
					log("");
					log(colors.bold("DNS Records for Email Verification"));
					log("");
					table(
						["TYPE", "HOST", "VALUE"],
						records.map((r: any) => [
							colors.cyan(r.type || "-"),
							r.name || r.host || "-",
							(r.value || r.data || "-").slice(0, 60),
						]),
					);
					log("");
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Templates ────────────────────────────────────────────────────────────────
	const templates = email
		.command("templates")
		.description("Manage email templates");

	templates
		.command("list")
		.alias("ls")
		.description("List email templates")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("--active", "Show only active templates")
		.action(async (options: { env?: string; active?: boolean }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching templates...");
				const list = await client.emailService.listTemplates.query({
					environmentId,
					isActive: options.active,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(list);
					return;
				}
				const items = Array.isArray(list) ? list : [];
				if (items.length === 0) {
					log("No templates found.");
					return;
				}
				log("");
				table(
					["NAME", "SLUG", "SUBJECT", "ACTIVE", "ID"],
					items.map((t: any) => [
						colors.bold(t.name || "-"),
						t.slug || "-",
						(t.subject || "-").slice(0, 40),
						t.isActive ? colors.success("yes") : colors.dim("no"),
						colors.dim(t.id || t.templateId || "-"),
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	templates
		.command("get-by-slug <slug>")
		.description("Get an email template by its slug")
		.option("-e, --env <environment-id>", "Environment ID")
		.action(async (slug: string, options: { env?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching template...");
				const data = await client.emailService.getTemplateBySlug.query({
					environmentId,
					slug,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const t = data as any;
				if (!t) {
					log(`No template found with slug "${slug}".`);
					return;
				}
				log("");
				log(colors.bold(t.name || slug));
				log(`  Slug:    ${t.slug || slug}`);
				log(`  Subject: ${t.subject || "-"}`);
				log(
					`  Active:  ${t.isActive ? colors.success("yes") : colors.dim("no")}`,
				);
				log(`  ID:      ${colors.dim(t.id || t.templateId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	templates
		.command("get <template-id>")
		.description("Show email template details")
		.action(async (templateId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching template...");
				const data = await client.emailService.getTemplate.query({
					templateId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const t = data as any;
				log("");
				log(colors.bold(t.name || templateId));
				log(`  Slug:      ${t.slug || "-"}`);
				log(`  Subject:   ${t.subject || "-"}`);
				log(
					`  Active:    ${t.isActive ? colors.success("yes") : colors.dim("no")}`,
				);
				log(`  Variables: ${(t.variables || []).join(", ") || "-"}`);
				log(`  ID:        ${colors.dim(t.id || t.templateId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	templates
		.command("create")
		.description("Create an email template")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-n, --name <name>", "Template name")
		.option("--slug <slug>", "Template slug")
		.option("--subject <subject>", "Email subject")
		.option("--html <html>", "HTML content")
		.option("--description <text>", "Template description")
		.action(
			async (options: {
				env?: string;
				name?: string;
				slug?: string;
				subject?: string;
				html?: string;
				description?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const name =
						options.name ||
						(await input("Template name:", undefined, {
							field: "template_name",
							flag: "--name",
						}));
					const subject =
						options.subject ||
						(await input("Email subject:", undefined, {
							field: "email_subject",
							flag: "--subject",
						}));
					const htmlContent =
						options.html ||
						(await input("HTML content (or paste):", undefined, {
							field: "html_content",
							flag: "--html",
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Creating template...");
					const result = await client.emailService.createTemplate.mutate({
						environmentId,
						name,
						slug:
							options.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
						subject,
						htmlContent,
						description: options.description,
						isActive: true,
					} as any);
					succeedSpinner("Template created.");
					if (isJsonMode()) outputData(result);
					else
						quietOutput(
							(result as any).id || (result as any).templateId || "created",
						);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	templates
		.command("update <template-id>")
		.description("Update an email template")
		.option("-n, --name <name>", "New name")
		.option("--slug <slug>", "New slug")
		.option("--subject <subject>", "New subject")
		.option("--html <html>", "New HTML content")
		.option("--activate", "Activate the template")
		.option("--deactivate", "Deactivate the template")
		.action(
			async (
				templateId: string,
				options: {
					name?: string;
					slug?: string;
					subject?: string;
					html?: string;
					activate?: boolean;
					deactivate?: boolean;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const isActive = options.activate
						? true
						: options.deactivate
							? false
							: undefined;
					const client = getApiClient();
					const _spinner = startSpinner("Updating template...");
					await client.emailService.updateTemplate.mutate({
						templateId,
						name: options.name,
						slug: options.slug,
						subject: options.subject,
						htmlContent: options.html,
						isActive,
					} as any);
					succeedSpinner("Template updated.");
					if (isJsonMode()) outputData({ updated: true, templateId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	templates
		.command("delete <template-id>")
		.alias("rm")
		.description("Delete an email template")
		.action(async (templateId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete template "${templateId}"?`,
						false,
						{
							field: "confirm_delete_template",
							flag: "--yes",
							context: { templateId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Deleting template...");
				await client.emailService.deleteTemplate.mutate({
					templateId,
				} as any);
				succeedSpinner("Template deleted.");
				if (isJsonMode()) outputData({ deleted: true, templateId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	templates
		.command("seed")
		.description("Seed pre-built templates for an environment")
		.option("-e, --env <environment-id>", "Environment ID")
		.action(async (options: { env?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Seeding templates...");
				const result = await client.emailService.seedPrebuiltTemplates.mutate({
					environmentId,
				} as any);
				succeedSpinner("Templates seeded.");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Send email ───────────────────────────────────────────────────────────────
	email
		.command("send")
		.description("Send an email")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("--to <email>", "Recipient email")
		.option("--subject <subject>", "Email subject")
		.option("--html <html>", "HTML body")
		.option("--text <text>", "Plain text body")
		.option("--from <email>", "Override from email")
		.action(
			async (options: {
				env?: string;
				to?: string;
				subject?: string;
				html?: string;
				text?: string;
				from?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const to =
						options.to ||
						(await input("Recipient email:", undefined, {
							field: "recipient_email",
							flag: "--to",
						}));
					const subject =
						options.subject ||
						(await input("Subject:", undefined, {
							field: "email_subject",
							flag: "--subject",
						}));
					const html = options.html || options.text;
					const client = getApiClient();
					const _spinner = startSpinner("Sending email...");
					const result = await client.emailService.sendEmail.mutate({
						environmentId,
						to,
						subject,
						html,
						text: options.text,
						from: options.from,
					} as any);
					succeedSpinner("Email sent.");
					if (isJsonMode()) outputData(result);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Send templated email ─────────────────────────────────────────────────────
	email
		.command("send-template")
		.description("Send a templated email")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("--template-id <id>", "Template ID")
		.option("--to <email>", "Recipient email")
		.option("--vars <json>", "Template variables as JSON string")
		.action(
			async (options: {
				env?: string;
				templateId?: string;
				to?: string;
				vars?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const templateId =
						options.templateId ||
						(await input("Template ID:", undefined, {
							field: "template_id",
							flag: "--template-id",
						}));
					const to =
						options.to ||
						(await input("Recipient email:", undefined, {
							field: "recipient_email",
							flag: "--to",
						}));
					const variables = options.vars ? JSON.parse(options.vars) : {};
					const client = getApiClient();
					const _spinner = startSpinner("Sending templated email...");
					const result = await client.emailService.sendTemplatedEmail.mutate({
						environmentId,
						templateId,
						to,
						variables,
					} as any);
					succeedSpinner("Email sent.");
					if (isJsonMode()) outputData(result);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Logs ─────────────────────────────────────────────────────────────────────
	email
		.command("logs")
		.description("View email sending logs")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-n, --limit <n>", "Number of logs to show", "50")
		.option("--status <status>", "Filter by status (sent, failed, bounced)")
		.option("--to <email>", "Filter by recipient")
		.action(
			async (options: {
				env?: string;
				limit?: string;
				status?: string;
				to?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const client = getApiClient();
					const _spinner = startSpinner("Fetching logs...");
					const logs = await client.emailService.getEmailLogs.query({
						environmentId,
						status: options.status,
						to: options.to,
						limit: Number.parseInt(options.limit || "50"),
					} as any);
					succeedSpinner();
					if (isJsonMode()) {
						outputData(logs);
						return;
					}
					const list = Array.isArray(logs) ? logs : (logs as any)?.items || [];
					if (list.length === 0) {
						log("No email logs found.");
						return;
					}
					log("");
					table(
						["DATE", "TO", "SUBJECT", "STATUS"],
						list.map((l: any) => [
							l.createdAt ? new Date(l.createdAt).toLocaleString() : "-",
							l.to || "-",
							(l.subject || "-").slice(0, 40),
							l.status === "sent"
								? colors.success(l.status)
								: l.status === "failed" || l.status === "bounced"
									? colors.error(l.status)
									: colors.warn(l.status || "-"),
						]),
					);
					log("");
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Stats ─────────────────────────────────────────────────────────────────────
	email
		.command("stats")
		.description("Show email sending statistics")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("--start <date>", "Start date (ISO)")
		.option("--end <date>", "End date (ISO)")
		.action(async (options: { env?: string; start?: string; end?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching stats...");
				const stats = await client.emailService.getEmailStats.query({
					environmentId,
					startDate: options.start,
					endDate: options.end,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(stats);
					return;
				}
				const s = stats as any;
				log("");
				log(colors.bold("Email Statistics"));
				log(`  Total Sent:  ${colors.cyan(String(s.sent || s.total || 0))}`);
				log(`  Delivered:   ${colors.success(String(s.delivered || 0))}`);
				log(`  Bounced:     ${colors.error(String(s.bounced || 0))}`);
				log(`  Failed:      ${colors.error(String(s.failed || 0))}`);
				log(`  Open Rate:   ${s.openRate ? `${s.openRate}%` : "-"}`);
				log(`  Click Rate:  ${s.clickRate ? `${s.clickRate}%` : "-"}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── API Keys ──────────────────────────────────────────────────────────────────
	const apiKeys = email
		.command("api-keys")
		.description("Manage email service API keys");

	apiKeys
		.command("list")
		.alias("ls")
		.description("List email service API keys")
		.option("-e, --env <environment-id>", "Environment ID")
		.action(async (options: { env?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching API keys...");
				const list = await client.emailService.listApiKeys.query({
					environmentId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(list);
					return;
				}
				const items = Array.isArray(list) ? list : [];
				if (items.length === 0) {
					log("No API keys found.");
					return;
				}
				log("");
				table(
					["NAME", "MODE", "ID", "CREATED"],
					items.map((k: any) => [
						k.name || "-",
						k.mode || "-",
						colors.dim(k.id || k.apiKeyId || "-"),
						k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	apiKeys
		.command("create")
		.description("Create an email service API key")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-n, --name <name>", "Key name")
		.option("--mode <mode>", "Key mode (sending/full)", "sending")
		.action(async (options: { env?: string; name?: string; mode?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const name =
					options.name ||
					(await input("API key name:", undefined, {
						field: "api_key_name",
						flag: "--name",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Creating API key...");
				const result = await client.emailService.createApiKey.mutate({
					environmentId,
					name,
					mode: options.mode || "sending",
				} as any);
				succeedSpinner("API key created.");
				if (isJsonMode()) outputData(result);
				else {
					const r = result as any;
					log("");
					log(colors.warn("Save this key — it won't be shown again!"));
					log(`Key: ${colors.cyan(r.key || r.token || "-")}`);
					log("");
				}
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	apiKeys
		.command("update <api-key-id>")
		.description("Update an email service API key")
		.option("-n, --name <name>", "New name")
		.action(async (apiKeyId: string, options: { name?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const name =
					options.name ||
					(await input("New name:", undefined, {
						field: "new_name",
						flag: "--name",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Updating API key...");
				await client.emailService.updateApiKey.mutate({
					apiKeyId,
					name,
				} as any);
				succeedSpinner("API key updated.");
				if (isJsonMode()) outputData({ updated: true, apiKeyId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	apiKeys
		.command("revoke <api-key-id>")
		.description("Revoke an email service API key")
		.action(async (apiKeyId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Revoke API key "${apiKeyId}"?`,
						false,
						{
							field: "confirm_revoke_api_key",
							flag: "--yes",
							context: { apiKeyId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Revoking API key...");
				await client.emailService.revokeApiKey.mutate({ apiKeyId } as any);
				succeedSpinner("API key revoked.");
				if (isJsonMode()) outputData({ revoked: true, apiKeyId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	apiKeys
		.command("delete <api-key-id>")
		.alias("rm")
		.description("Delete an email service API key")
		.action(async (apiKeyId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete API key "${apiKeyId}"?`,
						false,
						{
							field: "confirm_delete_api_key",
							flag: "--yes",
							context: { apiKeyId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Deleting API key...");
				await client.emailService.deleteApiKey.mutate({ apiKeyId } as any);
				succeedSpinner("API key deleted.");
				if (isJsonMode()) outputData({ deleted: true, apiKeyId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
