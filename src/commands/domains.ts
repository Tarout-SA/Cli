import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
import {
	box,
	colors,
	error,
	isJsonMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	success,
	table,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { confirm, input } from "../utils/prompts.js";
import {
	failSpinner,
	startSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

export function registerDomainsCommands(program: Command) {
	const domains = program
		.command("domains")
		.description("Manage domains and DNS");

	// ── List registered domains (purchased + external) ──
	domains
		.command("list")
		.alias("ls")
		.description("List all registered domains (purchased and external)")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching domains...");

				const domainsList: any[] = await client.domainRegistrar.getAll.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(domainsList);
					return;
				}

				if (domainsList.length === 0) {
					log("");
					log("No registered domains found.");
					log("");
					log(
						`Register one with: ${colors.dim("tarout domains register <domain>")}`,
					);
					log(
						`Or add an external domain: ${colors.dim("tarout domains add-external <domain>")}`,
					);
					return;
				}

				log("");
				table(
					["DOMAIN", "SOURCE", "STATUS", "CF ZONE", "EXPIRY", "AUTO-RENEW"],
					domainsList.map((d: any) => [
						colors.cyan(d.domainName),
						d.source === "purchased"
							? colors.info("purchased")
							: colors.dim("external"),
						formatStatus(d.status),
						formatCfStatus(d.cloudflareZoneStatus),
						d.source === "purchased" && d.expiryDate
							? formatDate(d.expiryDate)
							: colors.dim("-"),
						d.source === "purchased"
							? d.autoRenew
								? colors.success("on")
								: colors.warn("off")
							: colors.dim("-"),
					]),
				);
				log("");
				log(
					colors.dim(
						`${domainsList.length} domain${domainsList.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// ── Register (purchase) a domain ──
	domains
		.command("register")
		.argument("<domain>", "Domain name to register (e.g., example.com)")
		.description("Purchase a domain via Name.com")
		.action(async (domainName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!isValidDomain(domainName)) {
					throw new InvalidArgumentError(
						`Invalid domain format: ${domainName}. Use format like: example.com`,
					);
				}

				const client = getApiClient();

				// Check availability
				const _spinner = startSpinner(
					`Checking availability for ${domainName}...`,
				);
				const availability = await client.domainRegistrar.searchDomain.query({
					domainName,
				});

				if (!availability.available) {
					failSpinner();
					error(`${domainName} is not available for registration.`);
					return;
				}

				succeedSpinner();

				if (isJsonMode()) {
					outputData(availability);
					return;
				}

				log("");
				log(`${colors.cyan(domainName)} is ${colors.success("available")}!`);
				log(
					`  Price: ${colors.bold(`${availability.purchasePrice} ${availability.currency}`)}`,
				);
				log(
					`  Renewal: ${colors.dim(`${availability.renewalPrice} ${availability.currency}/yr`)}`,
				);
				if (availability.premium) {
					log(`  ${colors.warn("Premium domain")}`);
				}
				log("");

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Proceed to payment for ${domainName}?`,
						false,
						{
							field: "confirm_register_domain",
							flag: "--yes",
							context: { domain: domainName },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _paySpinner = startSpinner("Creating payment link...");

				const payment =
					await client.domainRegistrar.createRegistrationPayment.mutate({
						domainName,
						years: 1,
						privacyEnabled: true,
						autoRenew: true,
					});

				succeedSpinner();

				box("Domain Registration Payment", [
					`Domain: ${colors.cyan(domainName)}`,
					`Amount: ${payment.amount} SAR`,
					`Payment URL: ${colors.cyan(payment.paymentUrl)}`,
				]);

				log("Open the payment URL above to complete your purchase.");
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── Add external domain ──
	domains
		.command("add-external")
		.argument("<domain>", "Domain name (e.g., example.com)")
		.description(
			"Add an externally-registered domain via CNAME (no nameserver change needed)",
		)
		.action(async (domainName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!isValidDomain(domainName)) {
					throw new InvalidArgumentError(
						`Invalid domain format: ${domainName}. Use format like: example.com`,
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner(
					`Adding external domain ${domainName}...`,
				);

				const result = await client.domainRegistrar.addExternalDomain.mutate({
					domainName,
				});

				succeedSpinner("External domain added!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(result.domain.domainId);

				box("External Domain Added", [
					`Domain: ${colors.cyan(domainName)}`,
					`Domain ID: ${colors.dim(result.domain.domainId)}`,
				]);

				if (result.cnameTarget) {
					log("Add a CNAME record at your DNS provider:");
					log("");
					log(`  Type:   ${colors.cyan("CNAME")}`);
					log(`  Name:   ${colors.cyan("@")}`);
					log(`  Target: ${colors.cyan(result.cnameTarget)}`);
					log("");
					log(
						`Then verify: ${colors.dim(`tarout domains verify ${result.domain.domainId.slice(0, 8)}`)}`,
					);
					log("");
					log(
						colors.dim(
							"SSL is provisioned automatically once the CNAME propagates (usually a few minutes).",
						),
					);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// ── Verify external domain CNAME / nameservers ──
	domains
		.command("verify")
		.argument("<domain>", "Domain ID or domain name")
		.description(
			"Verify CNAME record (or nameserver change) for an external domain",
		)
		.action(async (domainIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);

				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.domainName),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				const isCfSaas = !!domain.cloudflareCustomHostnameId;
				updateSpinner(
					isCfSaas ? "Verifying CNAME record..." : "Verifying nameservers...",
				);

				const result = await client.domainRegistrar.verifyExternalDomain.mutate(
					{
						domainId: domain.domainId,
					},
				);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");

				if (result.verified) {
					success(`Domain ${colors.cyan(domain.domainName)} is verified!`);
					log("");
					log(
						isCfSaas
							? "CNAME is active and SSL is provisioned."
							: "Nameservers are correctly configured. DNS management is now active.",
					);
				} else {
					error(
						isCfSaas
							? `CNAME not yet detected for ${domain.domainName}`
							: `Nameserver change not yet detected for ${domain.domainName}`,
					);
					log("");
					if (isCfSaas && domain.cnameTarget) {
						log("Ensure you have added a CNAME record at your DNS provider:");
						log("");
						log(`  Type:   ${colors.cyan("CNAME")}`);
						log(`  Name:   ${colors.cyan("@")}`);
						log(`  Target: ${colors.cyan(domain.cnameTarget)}`);
						if (result.sslStatus && result.sslStatus !== "active") {
							log("");
							log(
								`  SSL status: ${colors.dim(result.sslStatus.replace(/_/g, " "))}`,
							);
						}
						log("");
						log(
							colors.dim(
								"CNAME changes propagate in minutes. SSL is provisioned automatically.",
							),
						);
					} else if (
						domain.cloudflareNameservers &&
						domain.cloudflareNameservers.length > 0
					) {
						log("Ensure your nameservers are set to:");
						log("");
						for (const ns of domain.cloudflareNameservers) {
							log(`  ${colors.cyan(ns)}`);
						}
						log("");
						log(
							colors.dim(
								"Nameserver changes can take up to 48 hours to propagate.",
							),
						);
					}
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── Add domain to application (kept from old CLI) ──
	domains
		.command("link")
		.argument("<app>", "Application ID or name")
		.argument("<domain>", "Domain name (e.g., app.example.com)")
		.description("Link a custom domain to an application")
		.action(async (appIdentifier, domainName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!isValidDomain(domainName)) {
					throw new InvalidArgumentError(
						`Invalid domain format: ${domainName}. Use format like: app.example.com`,
					);
				}

				const client = getApiClient();

				const _spinner = startSpinner("Finding application...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a: any) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				updateSpinner("Linking domain...");

				const domain = await client.domain.create.mutate({
					host: domainName,
					applicationId: app.applicationId,
				});

				succeedSpinner("Domain linked!");

				if (isJsonMode()) {
					outputData(domain);
					return;
				}

				quietOutput(domain.domainId);

				box("Domain Linked", [
					`Domain: ${colors.cyan(domainName)}`,
					`Application: ${app.name}`,
					`Status: ${domain.isVerified ? colors.success("Verified") : colors.warn("Pending verification")}`,
				]);
			} catch (err) {
				handleError(err);
			}
		});

	// ── Remove app domain ──
	domains
		.command("unlink")
		.argument("<domain>", "Domain ID or hostname")
		.description("Unlink a domain from an application")
		.action(async (domainIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding domain...");
				const allDomains = await client.domain.all.query({
					includeUnlinked: true,
				});
				const domain = findAppDomain(allDomains, domainIdentifier);

				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.host),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Domain: ${colors.bold(domain.host)}`);
					if (domain.application) {
						log(`Application: ${domain.application.name}`);
					}
					log("");

					const confirmed = await confirm(
						`Are you sure you want to unlink "${domain.host}"?`,
						false,
						{
							field: "confirm_unlink_domain",
							flag: "--yes",
							context: { domain: domain.host, domainId: domain.domainId },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Unlinking domain...");

				await client.domain.delete.mutate({
					domainId: domain.domainId,
				});

				succeedSpinner("Domain unlinked!");

				if (isJsonMode()) {
					outputData({ deleted: true, domainId: domain.domainId });
				} else {
					quietOutput(domain.domainId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// ── Return DNS records the user must set ──
	// Wraps subscription.getSetupInstructions so an external agent can read
	// the exact records (type/name/value/ttl) to relay to the user.
	domains
		.command("instructions")
		.argument("<domain>", "Domain ID or hostname")
		.description(
			"Return the DNS records the user must create at their registrar",
		)
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Finding domain...");
				const allDomains = await client.domain.all.query({
					includeUnlinked: true,
				});
				const domain = findAppDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.host),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				const instructions = await client.domain.getSetupInstructions.query({
					domainId: domain.domainId,
				});
				succeedSpinner();

				if (isJsonMode()) {
					outputData({
						domainId: domain.domainId,
						host: domain.host,
						isVerified: domain.isVerified,
						...instructions,
					});
					return;
				}

				box("DNS Setup", [
					`Domain: ${colors.cyan(domain.host)}`,
					`Status: ${domain.isVerified ? colors.success("Verified") : colors.warn("Pending verification")}`,
					instructions.cloudflareManaged
						? colors.success("DNS automatically managed by Tarout")
						: "Add these records at your DNS provider:",
				]);
				if (!instructions.cloudflareManaged && instructions.records?.length) {
					log("");
					for (const r of instructions.records as Array<{
						type: string;
						name: string;
						value: string;
						ttl?: number;
					}>) {
						log(
							`  ${colors.bold(r.type.padEnd(6))} ${colors.cyan(r.name)} → ${r.value}${r.ttl ? `  TTL ${r.ttl}` : ""}`,
						);
					}
					log("");
					log(colors.dim(instructions.instructions));
				}
				if (instructions.cloudflareNameservers?.length) {
					log("");
					log("Or update nameservers to:");
					for (const ns of instructions.cloudflareNameservers as string[]) {
						log(`  ${colors.cyan(ns)}`);
					}
				}
				log("");
				log(
					`Wait for verification: ${colors.dim(`tarout domains wait-verified ${domain.domainId.slice(0, 8)}`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── Poll until verified ──
	domains
		.command("wait-verified")
		.argument("<domain>", "Domain ID or hostname")
		.description("Poll until the domain reports isVerified: true")
		.option(
			"--timeout <seconds>",
			"Maximum wait time in seconds (default 1800)",
			(v) => Number.parseInt(v, 10),
			1800,
		)
		.option(
			"--interval <seconds>",
			"Polling interval in seconds (default 10)",
			(v) => Number.parseInt(v, 10),
			10,
		)
		.action(
			async (
				domainIdentifier: string,
				options: { timeout: number; interval: number },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();

					const _spinner = startSpinner("Finding domain...");
					const allDomains = await client.domain.all.query({
						includeUnlinked: true,
					});
					const domain = findAppDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					succeedSpinner();

					const deadline = Date.now() + options.timeout * 1000;
					let lastVerified = !!domain.isVerified;
					if (lastVerified) {
						if (isJsonMode()) {
							outputData({
								domainId: domain.domainId,
								host: domain.host,
								isVerified: true,
							});
						} else {
							success(`${domain.host} is already verified.`);
						}
						return;
					}
					if (isJsonMode()) {
						outputJsonLine({
							type: "event",
							event: "domain_wait_started",
							domainId: domain.domainId,
							host: domain.host,
						});
					} else {
						log(
							`Polling ${colors.cyan(domain.host)} every ${options.interval}s (up to ${options.timeout}s)...`,
						);
					}

					while (Date.now() < deadline) {
						await new Promise((res) =>
							setTimeout(res, options.interval * 1000),
						);
						const cur = await client.domain.one.query({
							domainId: domain.domainId,
						});
						if (cur.isVerified !== lastVerified) {
							lastVerified = cur.isVerified;
							if (isJsonMode()) {
								outputJsonLine({
									type: "event",
									event: "domain_status_changed",
									domainId: cur.domainId,
									isVerified: cur.isVerified,
								});
							}
						}
						if (cur.isVerified) {
							if (isJsonMode()) {
								outputData({
									domainId: cur.domainId,
									host: cur.host,
									isVerified: true,
								});
							} else {
								success(`${cur.host} is verified!`);
							}
							return;
						}
					}

					outputError(
						"DOMAIN_VERIFY_TIMEOUT",
						`Domain ${domain.host} did not verify within ${options.timeout}s`,
						{ domainId: domain.domainId, host: domain.host },
					);
					exit(ExitCode.GENERAL_ERROR);
				} catch (err) {
					handleError(err);
				}
			},
		);

	// ── DNS subcommand group ──
	const dns = domains
		.command("dns")
		.description("Manage DNS records (via Cloudflare)");

	// dns list <domain>
	dns
		.command("list")
		.alias("ls")
		.argument("<domain>", "Domain ID or domain name")
		.description("List DNS records for a domain")
		.action(async (domainIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching DNS records...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);

				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.domainName),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				const records = await client.dns.listByDomain.query({
					registeredDomainId: domain.domainId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(records);
					return;
				}

				if (!records || records.length === 0) {
					log("");
					log(`No DNS records for ${colors.cyan(domain.domainName)}.`);
					log("");
					log(
						`Add one with: ${colors.dim(`tarout domains dns add ${domain.domainName} A @ 1.2.3.4`)}`,
					);
					return;
				}

				log("");
				log(`DNS records for ${colors.cyan(domain.domainName)}:`);
				log("");
				table(
					["TYPE", "NAME", "CONTENT", "TTL", "PROXIED"],
					records.map((r: any) => [
						colors.bold(r.type),
						r.name,
						truncate(r.content, 40),
						r.ttl === 1 ? "Auto" : `${r.ttl}s`,
						r.proxied ? colors.warn("on") : colors.dim("off"),
					]),
				);
				log("");
				log(
					colors.dim(
						`${records.length} record${records.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// dns add <domain> <type> <name> <content>
	dns
		.command("add")
		.argument("<domain>", "Domain ID or domain name")
		.argument("<type>", "Record type (A, AAAA, CNAME, MX, TXT, NS, SRV, CAA)")
		.argument("<name>", 'Record name (e.g., "@" for root, "www", "sub")')
		.argument("<content>", "Record content (e.g., IP address, hostname)")
		.option(
			"-p, --priority <priority>",
			"Priority (for MX/SRV)",
			Number.parseInt,
		)
		.option(
			"-t, --ttl <ttl>",
			"TTL in seconds (default: auto)",
			Number.parseInt,
		)
		.description("Create a DNS record at Cloudflare")
		.action(async (domainIdentifier, type, name, content, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const upperType = type.toUpperCase();
				const validTypes = [
					"A",
					"AAAA",
					"CNAME",
					"MX",
					"TXT",
					"NS",
					"SRV",
					"CAA",
				];
				if (!validTypes.includes(upperType)) {
					throw new InvalidArgumentError(
						`Invalid record type: ${type}. Must be one of: ${validTypes.join(", ")}`,
					);
				}

				const client = getApiClient();

				const _spinner = startSpinner("Finding domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);

				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.domainName),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				updateSpinner("Creating DNS record...");

				const input: any = {
					registeredDomainId: domain.domainId,
					type: upperType,
					name,
					content,
				};

				if (options.priority !== undefined) {
					input.priority = options.priority;
				}
				if (options.ttl !== undefined) {
					input.ttl = options.ttl;
				}

				const record = await client.dns.create.mutate(input);

				succeedSpinner("DNS record created!");

				if (isJsonMode()) {
					outputData(record);
					return;
				}

				quietOutput(record.recordId);

				box("DNS Record Created", [
					`Type: ${colors.bold(upperType)}`,
					`Name: ${name}`,
					`Content: ${content}`,
					`Domain: ${domain.domainName}`,
				]);
			} catch (err) {
				handleError(err);
			}
		});

	// dns remove <recordId>
	dns
		.command("remove")
		.alias("rm")
		.argument("<recordId>", "DNS record ID")
		.description("Delete a DNS record")
		.action(async (recordId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Are you sure you want to delete DNS record "${recordId}"?`,
						false,
						{
							field: "confirm_delete_dns_record",
							flag: "--yes",
							context: { recordId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _spinner = startSpinner("Deleting DNS record...");

				await client.dns.delete.mutate({ recordId });

				succeedSpinner("DNS record deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, recordId });
				} else {
					quietOutput(recordId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// ── Nameservers ──
	domains
		.command("ns")
		.argument("<domain>", "Domain ID or domain name")
		.description("Show nameservers for a domain")
		.action(async (domainIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching nameservers...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);

				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.domainName),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				const nsData = await client.dns.getNameservers.query({
					registeredDomainId: domain.domainId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(nsData);
					return;
				}

				log("");
				log(`Nameservers for ${colors.cyan(domain.domainName)}:`);
				log("");

				if (
					nsData.cloudflareNameservers &&
					nsData.cloudflareNameservers.length > 0
				) {
					log(`  ${colors.bold("Cloudflare (assigned):")}`);
					for (const ns of nsData.cloudflareNameservers) {
						log(`    ${colors.cyan(ns)}`);
					}
				}

				if (nsData.currentNameservers && nsData.currentNameservers.length > 0) {
					log("");
					log(`  ${colors.bold("Current nameservers:")}`);
					for (const ns of nsData.currentNameservers) {
						log(`    ${ns}`);
					}
				}

				if (nsData.cloudflareZoneStatus) {
					log("");
					log(`  Zone status: ${formatCfStatus(nsData.cloudflareZoneStatus)}`);
				}

				log("");
			} catch (err) {
				handleError(err);
			}
		});
	// ── Registrar readiness ──────────────────────────────────────────────────────
	domains
		.command("registrar-status")
		.description("Check if the domain registrar is configured and ready")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking registrar...");
				const data = await client.domainRegistrar.registrarReadiness.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const r = data as any;
				log(
					`Registrar ready: ${r.ready ? colors.success("yes") : colors.error("no")}`,
				);
				if (r.message) log(colors.dim(r.message));
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Search multiple domains ───────────────────────────────────────────────────
	domains
		.command("search-multiple")
		.argument("<domains>", "Comma-separated domain names to check")
		.description("Check availability for multiple domains at once")
		.action(async (domainsArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const domainNames = domainsArg.split(",").map((d: string) => d.trim());
				const client = getApiClient();
				const _spinner = startSpinner("Checking availability...");
				const results = await client.domainRegistrar.searchMultiple.query({
					domainNames,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(results);
					return;
				}
				const list = Array.isArray(results) ? results : [];
				log("");
				table(
					["DOMAIN", "AVAILABLE", "PRICE"],
					list.map((r: any) => [
						colors.cyan(r.domainName || r.domain || "-"),
						r.available ? colors.success("yes") : colors.dim("no"),
						r.price ? `${r.price} SAR/yr` : "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Search by keyword ─────────────────────────────────────────────────────────
	domains
		.command("search")
		.argument("<keyword>", "Keyword to search domain suggestions")
		.description("Search domain suggestions by keyword")
		.action(async (keyword: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Searching domains...");
				const results = await client.domainRegistrar.searchByKeyword.query({
					keyword,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(results);
					return;
				}
				const list = Array.isArray(results) ? results : [];
				log("");
				table(
					["DOMAIN", "AVAILABLE", "PRICE"],
					list.map((r: any) => [
						colors.cyan(r.domainName || r.domain || "-"),
						r.available ? colors.success("yes") : colors.dim("no"),
						r.price ? `${r.price} SAR/yr` : "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Get domain by ID ──────────────────────────────────────────────────────────
	domains
		.command("info")
		.argument("<domain>", "Domain ID or name")
		.description("Show registered domain details")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const data = await client.domainRegistrar.getById.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold(d.domainName || domainIdentifier));
				log(`  Status:      ${formatStatus(d.status || "-")}`);
				log(
					`  Privacy:     ${d.privacyEnabled ? colors.success("enabled") : "disabled"}`,
				);
				log(`  Auto-renew:  ${d.autoRenew ? colors.success("yes") : "no"}`);
				log(`  Locked:      ${d.locked ? colors.warn("yes") : "no"}`);
				log(
					`  Expires:     ${d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : "-"}`,
				);
				log(`  ID:          ${colors.dim(d.domainId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Renew domain ──────────────────────────────────────────────────────────────
	domains
		.command("renew")
		.argument("<domain>", "Domain ID or name")
		.description("Renew a registered domain")
		.option("-y, --years <n>", "Number of years to renew", "1")
		.action(async (domainIdentifier: string, options: { years?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _renewSpinner = startSpinner("Creating renewal payment...");
				const result = await client.domainRegistrar.createRenewalPayment.mutate(
					{
						domainId: domain.domainId,
						years: Number.parseInt(options.years || "1"),
					},
				);
				succeedSpinner("Renewal payment created.");
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				log("");
				log(colors.bold("Renewal Payment Created"));
				if (r.checkoutUrl) log(`  Checkout: ${colors.cyan(r.checkoutUrl)}`);
				if (r.orderId) log(`  Order ID: ${colors.dim(r.orderId)}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Confirm domain payment ────────────────────────────────────────────────────
	domains
		.command("confirm-payment")
		.description("Confirm a domain registration or renewal payment")
		.option("--order-id <id>", "Order ID")
		.option("--transaction-id <id>", "Transaction ID")
		.action(async (options: { orderId?: string; transactionId?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Confirming payment...");
				const result = await client.domainRegistrar.confirmDomainPayment.mutate(
					{
						orderId: options.orderId,
						transactionId: options.transactionId,
					} as any,
				);
				succeedSpinner("Payment confirmed.");
				if (isJsonMode()) outputData(result);
				else {
					log("");
					log(colors.success("Domain payment confirmed."));
					log("");
				}
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Domain zone controls ──────────────────────────────────────────────────────
	domains
		.command("zone-controls")
		.argument("<domain>", "Domain ID or name")
		.description("Show zone control settings for a domain")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching zone controls...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const data = await client.domainRegistrar.getZoneControls.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const settings = Array.isArray(data)
					? data
					: (data as any)?.settings || [];
				log("");
				log(colors.bold("Zone Controls"));
				table(
					["SETTING", "VALUE", "ID"],
					settings.map((s: any) => [
						s.name || s.id || "-",
						String(s.value ?? "-"),
						colors.dim(s.settingId || s.id || "-"),
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Update zone setting ───────────────────────────────────────────────────────
	domains
		.command("zone-setting")
		.argument("<domain>", "Domain ID or name")
		.argument("<setting-id>", "Setting ID to update")
		.argument("<value>", "New value")
		.description("Update a zone control setting")
		.action(
			async (domainIdentifier: string, settingId: string, value: string) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] = await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					const _updateSpinner = startSpinner("Updating setting...");
					await client.domainRegistrar.updateZoneSetting.mutate({
						domainId: domain.domainId,
						settingId,
						value,
					});
					succeedSpinner("Zone setting updated.");
					if (isJsonMode()) outputData({ updated: true, settingId, value });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── DNSSEC ────────────────────────────────────────────────────────────────────
	domains
		.command("dnssec")
		.argument("<domain>", "Domain ID or name")
		.description("Enable or disable DNSSEC for a domain")
		.option("--enable", "Enable DNSSEC")
		.option("--disable", "Disable DNSSEC")
		.action(
			async (
				domainIdentifier: string,
				options: { enable?: boolean; disable?: boolean },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const enabled = options.enable ? true : !options.disable;
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] = await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					const _dnssecSpinner = startSpinner(
						`${enabled ? "Enabling" : "Disabling"} DNSSEC...`,
					);
					await client.domainRegistrar.updateDNSSEC.mutate({
						domainId: domain.domainId,
						enabled,
					});
					succeedSpinner(`DNSSEC ${enabled ? "enabled" : "disabled"}.`);
					if (isJsonMode()) outputData({ updated: true, dnssec: enabled });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Delete registered domain ──────────────────────────────────────────────────
	domains
		.command("delete")
		.argument("<domain>", "Domain ID or name")
		.description("Delete a registered domain from the platform")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete domain "${domainIdentifier}"?`,
						false,
						{
							field: "confirm_delete_registered_domain",
							flag: "--yes",
							context: { domain: domainIdentifier },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _deleteSpinner = startSpinner("Deleting domain...");
				await client.domainRegistrar.delete.mutate({
					domainId: domain.domainId,
				});
				succeedSpinner("Domain deleted.");
				if (isJsonMode())
					outputData({ deleted: true, domainId: domain.domainId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Sync domain ───────────────────────────────────────────────────────────────
	domains
		.command("sync")
		.argument("<domain>", "Domain ID or name")
		.description("Sync domain status with the registrar")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _syncSpinner = startSpinner("Syncing domain...");
				await client.domainRegistrar.sync.mutate({ domainId: domain.domainId });
				succeedSpinner("Domain synced.");
				if (isJsonMode())
					outputData({ synced: true, domainId: domain.domainId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Toggle privacy ────────────────────────────────────────────────────────────
	domains
		.command("privacy")
		.argument("<domain>", "Domain ID or name")
		.description("Toggle WHOIS privacy for a domain")
		.option("--enable", "Enable privacy")
		.option("--disable", "Disable privacy")
		.action(
			async (
				domainIdentifier: string,
				options: { enable?: boolean; disable?: boolean },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const enabled = options.enable ? true : !options.disable;
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] = await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					const _privacySpinner = startSpinner(
						`${enabled ? "Enabling" : "Disabling"} privacy...`,
					);
					await client.domainRegistrar.togglePrivacy.mutate({
						domainId: domain.domainId,
						enabled,
					});
					succeedSpinner(`Privacy ${enabled ? "enabled" : "disabled"}.`);
					if (isJsonMode()) outputData({ privacy: enabled });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Toggle auto-renew ─────────────────────────────────────────────────────────
	domains
		.command("auto-renew")
		.argument("<domain>", "Domain ID or name")
		.description("Toggle auto-renewal for a domain")
		.option("--enable", "Enable auto-renewal")
		.option("--disable", "Disable auto-renewal")
		.action(
			async (
				domainIdentifier: string,
				options: { enable?: boolean; disable?: boolean },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const enabled = options.enable ? true : !options.disable;
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] = await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					await client.domainRegistrar.toggleAutoRenew.mutate({
						domainId: domain.domainId,
						enabled,
					});
					succeedSpinner(`Auto-renew ${enabled ? "enabled" : "disabled"}.`);
					if (isJsonMode()) outputData({ autoRenew: enabled });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Transfer out ──────────────────────────────────────────────────────────────
	domains
		.command("transfer-out")
		.argument("<domain>", "Domain ID or name")
		.description("Request a transfer-out to another registrar")
		.option("--registrar <name>", "Target registrar")
		.option("--email <email>", "Account email at target registrar")
		.action(
			async (
				domainIdentifier: string,
				options: { registrar?: string; email?: string },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] = await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					const targetRegistrar =
						options.registrar ||
						(await input("Target registrar name:", undefined, {
							field: "target_registrar",
							flag: "--registrar",
							context: { domain: domainIdentifier },
						}));
					const _transferSpinner = startSpinner("Requesting transfer out...");
					await client.domainRegistrar.requestTransferOut.mutate({
						domainId: domain.domainId,
						targetRegistrar,
						accountEmail: options.email,
					});
					succeedSpinner("Transfer out requested.");
					if (isJsonMode())
						outputData({ requested: true, domainId: domain.domainId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Toggle lock ────────────────────────────────────────────────────────────────
	domains
		.command("lock")
		.argument("<domain>", "Domain ID or name")
		.description("Toggle transfer lock for a domain")
		.option("--enable", "Enable transfer lock")
		.option("--disable", "Disable transfer lock")
		.action(
			async (
				domainIdentifier: string,
				options: { enable?: boolean; disable?: boolean },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const locked = options.enable ? true : !options.disable;
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] = await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					await client.domainRegistrar.toggleLock.mutate({
						domainId: domain.domainId,
						locked,
					});
					succeedSpinner(`Transfer lock ${locked ? "enabled" : "disabled"}.`);
					if (isJsonMode()) outputData({ locked });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Get auth code ─────────────────────────────────────────────────────────────
	domains
		.command("auth-code")
		.argument("<domain>", "Domain ID or name")
		.description("Get the EPP/authorization code for domain transfer")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const data = await client.domainRegistrar.getAuthCode.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const r = data as any;
				log("");
				log(colors.bold("Authorization Code"));
				log(`  Code: ${colors.cyan(r.authCode || r.code || String(data))}`);
				log(
					colors.dim("Use this code when transferring to another registrar."),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Set nameservers ───────────────────────────────────────────────────────────
	domains
		.command("set-nameservers")
		.argument("<domain>", "Domain ID or name")
		.argument("<nameservers>", "Comma-separated nameserver list")
		.description("Set custom nameservers for a domain")
		.action(async (domainIdentifier: string, nameserversArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const nameservers = nameserversArg
					.split(",")
					.map((ns: string) => ns.trim());
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _nsSpinner = startSpinner("Setting nameservers...");
				await client.domainRegistrar.setNameservers.mutate({
					domainId: domain.domainId,
					nameservers,
				});
				succeedSpinner("Nameservers updated.");
				if (isJsonMode()) outputData({ updated: true, nameservers });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── SSL status ────────────────────────────────────────────────────────────────
	domains
		.command("ssl")
		.argument("<domain>", "Domain ID or name")
		.description("Check SSL certificate status for a registered domain")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const data = await client.domainRegistrar.getSSLStatus.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const s = data as any;
				log("");
				log(colors.bold("SSL Certificate Status"));
				log(
					`  Status: ${s.valid || s.status === "active" ? colors.success("valid") : colors.error("invalid/missing")}`,
				);
				if (s.expiresAt)
					log(`  Expires: ${new Date(s.expiresAt).toLocaleDateString()}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Retry SSL ─────────────────────────────────────────────────────────────────
	domains
		.command("retry-ssl")
		.argument("<domain>", "Domain ID or name")
		.description("Retry SSL certificate issuance for a domain")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _retrySpinner = startSpinner("Retrying SSL...");
				await client.domainRegistrar.retrySSL.mutate({
					domainId: domain.domainId,
				});
				succeedSpinner("SSL retry initiated.");
				if (isJsonMode()) outputData({ retried: true });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Transaction history ────────────────────────────────────────────────────────
	domains
		.command("transactions")
		.argument("<domain>", "Domain ID or name")
		.description("Show payment transaction history for a domain")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const data = await client.domainRegistrar.transactionHistory.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data) ? data : [];
				if (list.length === 0) {
					log("No transactions found.");
					return;
				}
				log("");
				table(
					["DATE", "TYPE", "AMOUNT", "STATUS"],
					list.map((t: any) => [
						t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "-",
						t.type || "-",
						t.amount ? `${t.amount} SAR` : "-",
						t.status || "-",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Registrar firewall rules ───────────────────────────────────────────────────
	const registrarFw = domains
		.command("firewall")
		.description("Manage domain Cloudflare firewall rules");

	registrarFw
		.command("list")
		.argument("<domain>", "Domain ID or name")
		.description("List firewall rules for a domain")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const zoneData = await client.domainRegistrar.getZoneControls.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(zoneData);
					return;
				}
				const rules = (zoneData as any)?.firewallRules || [];
				if (rules.length === 0) {
					log("No firewall rules found.");
					return;
				}
				log("");
				table(
					["NAME", "ACTION", "ENABLED", "ID"],
					rules.map((r: any) => [
						r.name || "-",
						r.action || "-",
						r.enabled ? colors.success("yes") : "no",
						colors.dim(r.ruleId || r.id || "-"),
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	registrarFw
		.command("add")
		.argument("<domain>", "Domain ID or name")
		.description("Add a Cloudflare firewall rule to a domain")
		.option("-n, --name <name>", "Rule name")
		.option("-e, --expression <expr>", "Firewall expression")
		.option(
			"-a, --action <action>",
			"Action (block, allow, challenge)",
			"block",
		)
		.action(
			async (
				domainIdentifier: string,
				options: { name?: string; expression?: string; action?: string },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] = await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					const name =
						options.name ||
						(await input("Rule name:", undefined, {
							field: "firewall_rule_name",
							flag: "--name",
							context: { domain: domainIdentifier },
						}));
					const expression =
						options.expression ||
						(await input("Firewall expression:", undefined, {
							field: "firewall_expression",
							flag: "--expression",
							context: { domain: domainIdentifier },
						}));
					const action = options.action || "block";
					const _createSpinner = startSpinner("Creating firewall rule...");
					const result = await client.domainRegistrar.createFirewallRule.mutate(
						{
							domainId: domain.domainId,
							name,
							expression,
							action,
							enabled: true,
						},
					);
					succeedSpinner("Firewall rule created.");
					if (isJsonMode()) outputData(result);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	registrarFw
		.command("update <rule-id>")
		.argument("<domain>", "Domain ID or name")
		.description("Update a Cloudflare firewall rule")
		.option("-n, --name <name>", "New name")
		.option("-e, --expression <expr>", "New expression")
		.option("-a, --action <action>", "New action")
		.option("--enable", "Enable the rule")
		.option("--disable", "Disable the rule")
		.action(async (ruleId: string, domainIdentifier: string, options: any) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const enabled = options.enable
					? true
					: options.disable
						? false
						: undefined;
				const _updateSpinner = startSpinner("Updating firewall rule...");
				await client.domainRegistrar.updateFirewallRule.mutate({
					domainId: domain.domainId,
					ruleId,
					name: options.name,
					expression: options.expression,
					action: options.action,
					enabled,
				} as any);
				succeedSpinner("Firewall rule updated.");
				if (isJsonMode()) outputData({ updated: true, ruleId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	registrarFw
		.command("delete <rule-id>")
		.argument("<domain>", "Domain ID or name")
		.description("Delete a Cloudflare firewall rule")
		.action(async (ruleId: string, domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _deleteSpinner = startSpinner("Deleting firewall rule...");
				await client.domainRegistrar.deleteFirewallRule.mutate({
					domainId: domain.domainId,
					ruleId,
				});
				succeedSpinner("Firewall rule deleted.");
				if (isJsonMode()) outputData({ deleted: true, ruleId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── DNS update, getById, sync, setupCommonRecords, updateNameservers, checkPropagation ──
	// Extend the existing dns subgroup:
	const dnsCmd = domains
		.command("dns-ext")
		.description("Extended DNS operations");

	dnsCmd
		.command("update <record-id>")
		.description("Update a DNS record")
		.option("--name <name>", "Record name")
		.option("--content <content>", "Record content/value")
		.option("--ttl <seconds>", "TTL in seconds")
		.action(
			async (
				recordId: string,
				options: { name?: string; content?: string; ttl?: string },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Updating DNS record...");
					await client.dns.update.mutate({
						recordId,
						name: options.name,
						value: options.content,
						ttl: options.ttl ? Number.parseInt(options.ttl) : undefined,
					} as any);
					succeedSpinner("DNS record updated.");
					if (isJsonMode()) outputData({ updated: true, recordId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	dnsCmd
		.command("get <record-id>")
		.description("Show a specific DNS record")
		.action(async (recordId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching record...");
				const data = await client.dns.getById.query({ recordId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const r = data as any;
				log("");
				log(colors.bold(r.name || recordId));
				log(`  Type:    ${colors.cyan(r.type || "-")}`);
				log(`  Content: ${r.content || r.value || "-"}`);
				log(`  TTL:     ${r.ttl || "-"}`);
				log(`  ID:      ${colors.dim(r.id || r.recordId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	dnsCmd
		.command("sync <domain>")
		.description("Sync DNS records with the provider for a domain")
		.action(async (domainIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _syncSpinner = startSpinner("Syncing DNS...");
				await client.dns.sync.mutate({ registeredDomainId: domain.domainId });
				succeedSpinner("DNS synced.");
				if (isJsonMode()) outputData({ synced: true });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	dnsCmd
		.command("setup-records <domain>")
		.description("Setup common DNS records (A, MX, etc.) for a domain")
		.option("--ip <ip>", "IP address for A records")
		.action(async (domainIdentifier: string, options: { ip?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const ipAddress =
					options.ip ||
					(await input("IP address:", undefined, {
						field: "ip_address",
						flag: "--ip",
						context: { domain: domainIdentifier },
					}));
				const _setupSpinner = startSpinner("Setting up DNS records...");
				await client.dns.setupCommonRecords.mutate({
					registeredDomainId: domain.domainId,
					ipAddress,
				});
				succeedSpinner("Common DNS records created.");
				if (isJsonMode()) outputData({ setup: true });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	dnsCmd
		.command("update-nameservers <domain>")
		.argument("<nameservers>", "Comma-separated nameservers")
		.description("Update nameservers for a domain via DNS")
		.action(async (domainIdentifier: string, nameserversArg: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const nameservers = nameserversArg
					.split(",")
					.map((ns: string) => ns.trim());
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const allDomains: any[] = await client.domainRegistrar.getAll.query();
				const domain = findRegisteredDomain(allDomains, domainIdentifier);
				if (!domain) {
					failSpinner();
					throw new NotFoundError("Domain", domainIdentifier);
				}
				const _nsSpinner = startSpinner("Updating nameservers...");
				await client.dns.updateNameservers.mutate({
					domainId: domain.domainId,
					nameservers,
				});
				succeedSpinner("Nameservers updated.");
				if (isJsonMode()) outputData({ updated: true, nameservers });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	dnsCmd
		.command("propagation <record-id>")
		.description("Check DNS propagation for a specific record")
		.action(async (recordId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking propagation...");
				const data = await client.dns.checkPropagation.query({ recordId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const r = data as any;
				log("");
				log(colors.bold("DNS Propagation Status"));
				log(
					`  Propagated: ${r.propagated ? colors.success("yes") : colors.warn("no (still propagating)")}`,
				);
				if (r.regions) {
					for (const [region, status] of Object.entries(r.regions)) {
						log(
							`  ${region}: ${status === "propagated" ? colors.success("✓") : colors.dim("○")}`,
						);
					}
				}
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── App domain management ──────────────────────────────────────────────────────
	const appDomains = domains
		.command("app")
		.description("Manage app-level custom domains");

	appDomains
		.command("list")
		.description("List all app domains in the organization")
		.option("--unlinked", "Include unlinked domains")
		.action(async (options: { unlinked?: boolean }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domains...");
				const data = await client.domain.all.query({
					includeUnlinked: options.unlinked || false,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data) ? data : [];
				if (list.length === 0) {
					log("No domains found.");
					return;
				}
				log("");
				table(
					["HOST", "APP", "HTTPS", "STATUS", "ID"],
					list.map((d: any) => [
						colors.cyan(d.host || "-"),
						d.applicationId || d.application?.name || "-",
						d.https ? colors.success("yes") : "no",
						d.status || "-",
						colors.dim(d.domainId || d.id || "-"),
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	appDomains
		.command("get <domain-id>")
		.description("Show a specific app domain")
		.action(async (domainId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domain...");
				const data = await client.domain.one.query({ domainId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold(d.host || domainId));
				log(`  App:     ${d.applicationId || "-"}`);
				log(`  Port:    ${d.port || "-"}`);
				log(`  HTTPS:   ${d.https ? colors.success("yes") : "no"}`);
				log(`  Status:  ${d.status || "-"}`);
				log(`  ID:      ${colors.dim(d.domainId || d.id || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	appDomains
		.command("update <domain-id>")
		.description("Update an app domain")
		.option("--host <host>", "New hostname")
		.option("--port <port>", "New port")
		.option("--https", "Enable HTTPS")
		.option("--no-https", "Disable HTTPS")
		.action(
			async (
				domainId: string,
				options: { host?: string; port?: string; https?: boolean },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Updating domain...");
					await client.domain.update.mutate({
						domainId,
						host: options.host,
						port: options.port ? Number.parseInt(options.port) : undefined,
						https: options.https,
					} as any);
					succeedSpinner("Domain updated.");
					if (isJsonMode()) outputData({ updated: true, domainId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	appDomains
		.command("validate <hostname>")
		.description("Validate a domain hostname")
		.option("--ip <ip>", "Server IP to validate against")
		.option("--domain-id <id>", "Existing domain ID to re-validate")
		.action(
			async (domain: string, options: { ip?: string; domainId?: string }) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Validating domain...");
					const result = await client.domain.validateDomain.mutate({
						domain,
						serverIp: options.ip,
						domainId: options.domainId,
					} as any);
					succeedSpinner();
					if (isJsonMode()) {
						outputData(result);
						return;
					}
					const r = result as any;
					const valid = r.valid ?? r.isValid ?? true;
					log(
						`Domain "${domain}": ${valid ? colors.success("valid") : colors.error("invalid")}`,
					);
					if (r.message) log(colors.dim(r.message));
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	appDomains
		.command("link-registered")
		.description("Create an app domain from a registered domain")
		.option("--registered-domain <id>", "Registered domain ID")
		.option("--subdomain <subdomain>", "Subdomain (e.g. 'www', 'app')")
		.option("--app <app-id>", "Application ID")
		.action(
			async (options: {
				registeredDomain?: string;
				subdomain?: string;
				app?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const registeredDomainId =
						options.registeredDomain ||
						(await input("Registered domain ID:", undefined, {
							field: "registered_domain_id",
							flag: "--registered-domain",
						}));
					const subdomain =
						options.subdomain ||
						(await input("Subdomain (e.g. www):", undefined, {
							field: "subdomain",
							flag: "--subdomain",
							context: { registeredDomainId },
						}));
					const applicationId =
						options.app ||
						(await input("Application ID:", undefined, {
							field: "application_id",
							flag: "--app",
							context: { registeredDomainId, subdomain },
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Creating domain...");
					const result = await client.domain.createWithRegisteredDomain.mutate({
						registeredDomainId,
						subdomain,
						applicationId,
					} as any);
					succeedSpinner("Domain created.");
					if (isJsonMode()) outputData(result);
					else quietOutput((result as any).domainId || "created");
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	appDomains
		.command("available-registered")
		.description("List registered domains available to use for apps")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching registered domains...");
				const data = await client.domain.getAvailableRegisteredDomains.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data) ? data : [];
				if (list.length === 0) {
					log("No registered domains available.");
					return;
				}
				log("");
				table(
					["DOMAIN", "STATUS", "ID"],
					list.map((d: any) => [
						colors.cyan(d.domainName || d.name || "-"),
						d.status || "-",
						colors.dim(d.domainId || d.id || "-"),
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	appDomains
		.command("server-ip")
		.argument("<app-id>", "Application ID")
		.description("Get the server IP for a deployed application")
		.action(async (applicationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching server IP...");
				const data = await client.domain.getServerIP.query({ applicationId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const r = data as any;
				log(`Server IP: ${colors.cyan(r.ip || String(data))}`);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	appDomains
		.command("setup-instructions <domain-id>")
		.description("Get DNS setup instructions for an app domain")
		.action(async (domainId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching instructions...");
				const data = await client.domain.getSetupInstructions.query({
					domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const r = data as any;
				log("");
				log(colors.bold("DNS Setup Instructions"));
				if (r.records) {
					table(
						["TYPE", "NAME", "VALUE"],
						(r.records as any[]).map((rec: any) => [
							colors.cyan(rec.type || "-"),
							rec.name || "@",
							(rec.value || rec.content || "-").slice(0, 60),
						]),
					);
				} else {
					log(JSON.stringify(r, null, 2));
				}
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	appDomains
		.command("by-app <app-id>")
		.description("List all domains linked to an application")
		.action(async (applicationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching domains...");
				const data = await client.domain.byApplicationId.query({
					applicationId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data) ? data : [];
				if (list.length === 0) {
					log("No domains linked to this application.");
					return;
				}
				log("");
				table(
					["HOST", "HTTPS", "STATUS", "ID"],
					list.map((d: any) => [
						colors.cyan(d.host || "-"),
						d.https ? colors.success("yes") : "no",
						d.status || "-",
						colors.dim(d.domainId || d.id || "-"),
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	appDomains
		.command("available")
		.description("List available (unlinked) domains")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching available domains...");
				const data = await client.domain.getAvailable.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const list = Array.isArray(data) ? data : [];
				if (list.length === 0) {
					log("No available domains.");
					return;
				}
				log("");
				table(
					["HOST", "HTTPS", "ID"],
					list.map((d: any) => [
						colors.cyan(d.host || "-"),
						d.https ? colors.success("yes") : "no",
						colors.dim(d.domainId || d.id || "-"),
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	appDomains
		.command("link-to-app")
		.description("Link an existing domain to an application")
		.option("--domain-id <id>", "Domain ID")
		.option("--app-id <id>", "Application ID")
		.option("--force", "Force link even if already linked")
		.action(
			async (options: {
				domainId?: string;
				appId?: string;
				force?: boolean;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const domainId =
						options.domainId ||
						(await input("Domain ID:", undefined, {
							field: "domain_id",
							flag: "--domain-id",
						}));
					const applicationId =
						options.appId ||
						(await input("Application ID:", undefined, {
							field: "application_id",
							flag: "--app-id",
							context: { domainId },
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Linking domain...");
					await client.domain.linkToApplication.mutate({
						domainId,
						applicationId,
						force: options.force,
					} as any);
					succeedSpinner("Domain linked to application.");
					if (isJsonMode())
						outputData({ linked: true, domainId, applicationId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	appDomains
		.command("unlink-from-app")
		.argument("<domain-id>", "Domain ID to unlink")
		.description("Unlink a domain from its application")
		.action(async (domainId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Unlinking domain...");
				await client.domain.unlinkFromApplication.mutate({ domainId });
				succeedSpinner("Domain unlinked.");
				if (isJsonMode()) outputData({ unlinked: true, domainId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}

// ── Helper functions ──

function findApp(
	apps: Array<{ applicationId: string; name: string; appName?: string }>,
	identifier: string,
) {
	const lowerIdentifier = identifier.toLowerCase();

	return apps.find(
		(app) =>
			app.applicationId === identifier ||
			app.applicationId.startsWith(identifier) ||
			app.name.toLowerCase() === lowerIdentifier ||
			app.appName?.toLowerCase() === lowerIdentifier,
	);
}

/** Find a registered domain by domainId or domainName */
function findRegisteredDomain(domains: any[], identifier: string) {
	const lowerIdentifier = identifier.toLowerCase();

	return domains.find(
		(d: any) =>
			d.domainId === identifier ||
			d.domainId.startsWith(identifier) ||
			d.domainName.toLowerCase() === lowerIdentifier,
	);
}

/** Find an app domain (domain model) by domainId or host */
function findAppDomain(domains: any[], identifier: string) {
	const lowerIdentifier = identifier.toLowerCase();

	return domains.find(
		(d: any) =>
			d.domainId === identifier ||
			d.domainId.startsWith(identifier) ||
			d.host.toLowerCase() === lowerIdentifier,
	);
}

function isValidDomain(domain: string): boolean {
	const pattern =
		/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
	return pattern.test(domain);
}

function formatStatus(status: string): string {
	switch (status) {
		case "active":
			return colors.success("active");
		case "pending":
			return colors.warn("pending");
		case "expired":
			return colors.error("expired");
		case "cancelled":
			return colors.dim("cancelled");
		default:
			return status;
	}
}

function formatCfStatus(status: string | null | undefined): string {
	if (!status) return colors.dim("-");
	switch (status) {
		case "active":
			return colors.success("active");
		case "pending":
			return colors.warn("pending");
		case "moved":
			return colors.warn("moved");
		case "deleted":
			return colors.error("deleted");
		default:
			return status;
	}
}

function formatDate(dateValue: string | Date): string {
	try {
		const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
		return date.toISOString().split("T")[0] || "";
	} catch {
		return String(dateValue);
	}
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 3)}...`;
}
