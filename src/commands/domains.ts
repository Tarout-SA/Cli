import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
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
	isQuietMode,
	log,
	outputData,
	outputError,
	outputJsonLine,
	quietOutput,
	shouldSkipConfirmation,
	success,
	table,
	warn,
} from "../lib/output.js";
import { ExitCode, exit } from "../utils/exit-codes.js";
import { confirm, input } from "../utils/prompts.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";
import { formatSarAmount } from "./billing.js";

// `createRegistrationPayment` requires a full registrant `contact`
// (registrantContactSchema). Build it from `--contact <json>`, individual
// `--first-name/...` flags, or interactive prompts for any missing field.
// address2 is the only optional field.
async function collectRegistrantContact(options: any) {
	let base: Record<string, any> = {};
	if (options.contact) {
		try {
			base = JSON.parse(options.contact);
		} catch {
			throw new InvalidArgumentError("--contact must be valid JSON.");
		}
	}
	const contact: Record<string, any> = {
		firstName: base.firstName ?? options.firstName,
		lastName: base.lastName ?? options.lastName,
		email: base.email ?? options.email,
		phone: base.phone ?? options.phone,
		address1: base.address1 ?? options.address1,
		address2: base.address2 ?? options.address2,
		city: base.city ?? options.city,
		state: base.state ?? options.state,
		zip: base.zip ?? options.zip,
		country: base.country ?? options.country,
	};
	const required: Array<[string, string, string]> = [
		["firstName", "First name:", "--first-name"],
		["lastName", "Last name:", "--last-name"],
		["email", "Email:", "--email"],
		["phone", "Phone (e.g. +966500000000):", "--phone"],
		["address1", "Address line 1:", "--address1"],
		["city", "City:", "--city"],
		["state", "State/Region:", "--state"],
		["zip", "Postal/ZIP code:", "--zip"],
		["country", "Country (2-letter ISO, e.g. SA):", "--country"],
	];
	for (const [key, prompt, flag] of required) {
		if (!contact[key]) {
			contact[key] = await input(prompt, undefined, {
				field: `registrant_${key}`,
				flag,
			});
		}
	}
	if (contact.country) contact.country = String(contact.country).toUpperCase();
	if (!contact.address2) contact.address2 = undefined;
	return contact;
}

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

				if (isQuietMode()) {
					for (const d of domainsList) {
						const id = d.domainId || d.domainName;
						if (id) quietOutput(String(id));
					}
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
					["DOMAIN", "SOURCE", "STATUS", "DNS", "EXPIRY", "AUTO-RENEW"],
					domainsList.map((d: any) => [
						colors.cyan(d.domainName),
						d.source === "purchased"
							? colors.info("purchased")
							: colors.dim("external"),
						formatStatus(d.status),
						// The router strips provider columns and renames the zone state
						// to `dnsZoneStatus` (omitProviderFieldsForResponse).
						formatDnsZoneStatus(d.dnsZoneStatus),
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
		.description(
			"Purchase a domain through Tarout's managed registrar (.sa domains are registered from the dashboard)",
		)
		.option(
			"--years <n>",
			"Registration length in years (1-10; defaults to the registry minimum, 1 for most TLDs)",
			(v) => Number.parseInt(v, 10),
			1,
		)
		.option("--no-privacy", "Disable WHOIS privacy protection")
		.option("--no-auto-renew", "Disable auto-renewal")
		.option(
			"--contact <json>",
			"Registrant contact as JSON: {firstName,lastName,email,phone,address1,address2?,city,state,zip,country}",
		)
		.option("--first-name <name>", "Registrant first name")
		.option("--last-name <name>", "Registrant last name")
		.option("--email <email>", "Registrant email")
		.option("--phone <phone>", "Registrant phone (e.g. +966500000000)")
		.option("--address1 <address>", "Registrant address line 1")
		.option("--address2 <address>", "Registrant address line 2")
		.option("--city <city>", "Registrant city")
		.option("--state <state>", "Registrant state/region")
		.option("--zip <zip>", "Registrant postal/ZIP code")
		.option("--country <code>", "Registrant country (2-letter ISO code, e.g. SA)")
		.action(async (domainName, options, command: Command) => {
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
				const availability: any =
					await client.domainRegistrar.searchDomain.query({
						domainName,
					});

				// searchDomain answers with `purchasable` (DomainAvailability in
				// cloud/src/server/services/domain-management.ts). The CLI used to
				// read `available`, which the platform never sends, so every
				// registration stopped here with "not available".
				if (!availability?.purchasable) {
					failSpinner();
					throw new CliError(
						`${domainName} is not available for registration.${availability?.reason ? ` ${availability.reason}` : ""}`,
					);
				}

				// A .sa registration needs a Saudi registry application plus an
				// uploaded identity/business document, and `createRegistrationPayment`
				// refuses the payment without both. This command collects neither, so
				// it stops here - but it no longer dead-ends: `domains saudi` reads the
				// registry's country and document-type codes and creates the document
				// upload, which is everything the registry application needs.
				if (availability.registrationFlow === "saudi") {
					failSpinner();
					throw new CliError(
						`${domainName} is a Saudi (.sa) domain: the registry needs an application and a supporting identity or business document before the registration can be paid for.\nRead the registry's country and document-type codes with \`tarout domains saudi options\`, upload the document with \`tarout domains saudi upload-doc ${domainName} <file> --upload\`, then finish the application in the dashboard (https://tarout.sa/dashboard/domains) - this command cannot collect the application fields yet.`,
						ExitCode.INVALID_ARGUMENTS,
						undefined,
						{
							reason: "saudi_registration_flow",
							domainName,
							nextCommand: "tarout domains saudi options",
						},
					);
				}

				// Some registries sell in multi-year blocks (.ai is two years
				// minimum). The quoted price already covers that minimum term, and
				// the platform rejects a shorter one, so default to it and refuse
				// an explicit shorter term before any money moves.
				const minYears =
					typeof availability.minYears === "number" && availability.minYears > 1
						? availability.minYears
						: 1;
				const yearsFromUser =
					command?.getOptionValueSource?.("years") === "cli";
				const years: number = yearsFromUser
					? options.years
					: Math.max(options.years ?? 1, minYears);
				if (!Number.isInteger(years)) {
					failSpinner();
					throw new InvalidArgumentError("--years must be a whole number.");
				}
				if (years < minYears) {
					failSpinner();
					throw new InvalidArgumentError(
						`.${availability.tld ?? domainName.split(".").pop()} domains must be registered for at least ${minYears} years. Pass --years ${minYears} or more.`,
					);
				}

				succeedSpinner();
				const currency = availability.currency || "SAR";

				// Human availability summary. JSON/agent mode skips the display and
				// proceeds straight through the purchase flow (contact collection →
				// payment link) so an agent can complete a registration end-to-end,
				// mirroring the interactive path below.
				if (!isJsonMode()) {
					log("");
					log(
						`${colors.cyan(domainName)} is ${colors.success("available")}!`,
					);
					log(
						`  Price: ${colors.bold(`${availability.purchasePrice} ${currency}`)}${minYears > 1 ? colors.dim(` (${minYears}-year minimum term)`) : ""}`,
					);
					log(
						`  Renewal: ${colors.dim(`${availability.renewalPrice} ${currency}/yr`)}`,
					);
					if (availability.premium) {
						log(`  ${colors.warn("Premium domain")}`);
					}
					log("");
				}

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

				const contact = await collectRegistrantContact(options);

				const _paySpinner = startSpinner("Creating payment link...");

				const payment =
					await client.domainRegistrar.createRegistrationPayment.mutate({
						domainName,
						years,
						privacyEnabled: options.privacy !== false,
						autoRenew: options.autoRenew !== false,
						contact,
					});

				succeedSpinner();

				if (isJsonMode()) {
					outputData({
						domainId: payment.domainId,
						paymentUrl: payment.paymentUrl,
						amount: payment.amount,
					});
					return;
				}

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

	// ── Transfer a domain in from another registrar ──
	domains
		.command("transfer-in")
		.argument("<domain>", "Domain to transfer in (e.g., example.com)")
		.option(
			"--auth-code <code>",
			"Not sent: support asks for the EPP code over a secure channel after verifying ownership",
		)
		.option("--current-registrar <name>", "Name of the current registrar")
		.option("--note <text>", "Note for the support team")
		.description("Request an inbound domain transfer (opens a support ticket)")
		.action(async (domainName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!isValidDomain(domainName)) {
					throw new InvalidArgumentError(
						`Invalid domain format: ${domainName}. Use format like: example.com`,
					);
				}
				const client = getApiClient();
				const _spinner = startSpinner("Requesting transfer...");
				// requestTransferIn deliberately has no auth-code input: the ticket
				// must never hold the EPP secret, so support requests it through a
				// secure channel once ownership is verified. The CLI used to send
				// it anyway and the platform dropped it without a word.
				const res: any = await client.domainRegistrar.requestTransferIn.mutate({
					domainName,
					currentRegistrar: options.currentRegistrar || undefined,
					note: options.note || undefined,
				});
				succeedSpinner("Transfer requested.");
				const authCodeNotice = options.authCode
					? "The auth code was not sent. Support will ask for it through a secure channel after verifying ownership; do not paste it into the ticket."
					: undefined;
				if (isJsonMode()) {
					outputData(
						authCodeNotice
							? { ...res, authCodeSent: false, notice: authCodeNotice }
							: res,
					);
					return;
				}
				box("Domain Transfer Requested", [
					`Domain: ${colors.cyan(domainName)}`,
					`Support ticket: ${colors.dim(res?.ticketId || "-")}`,
					"Our team will follow up with the next steps.",
				]);
				if (authCodeNotice) warn(authCodeNotice);
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

				// Render the routing contract the server computed (exact relative
				// record names included). Older platforms don't send routingRecords:
				// fall back to deriving A records for a proxied apex, else a CNAME.
				const apexIps: string[] = Array.isArray(result.apexIps)
					? result.apexIps
					: [];
				const routingRecords: Array<{
					type: string;
					name: string;
					value: string;
				}> = Array.isArray(result.routingRecords)
					? result.routingRecords
					: result.isApex && apexIps.length > 0
						? apexIps.map((ip) => ({ type: "A", name: "@", value: ip }))
						: result.cnameTarget
							? [
									{
										type: "CNAME",
										name: result.isApex ? "@" : domainName,
										value: result.cnameTarget,
									},
								]
							: [];
				if (routingRecords.length > 0) {
					log("Add this record at your DNS provider:");
					log("");
					for (const record of routingRecords) {
						log(`  Type:   ${colors.cyan(record.type)}`);
						log(`  Name:   ${colors.cyan(record.name)}`);
						log(`  Value:  ${colors.cyan(record.value)}`);
						log("");
					}
					if (result.apexViaCname) {
						warn(
							"Set the root CNAME to Proxied (orange cloud) in Cloudflare: a DNS-only root record will not route.",
						);
						log("");
					}
				}
				if (result.ownershipVerification) {
					log("Also add this one-time ownership TXT record:");
					log("");
					log(`  Type:   ${colors.cyan("TXT")}`);
					log(`  Name:   ${colors.cyan(result.ownershipVerification.name)}`);
					log(
						`  Value:  ${colors.cyan(result.ownershipVerification.value)}`,
					);
					log("");
				}
				log(
					`Then verify: ${colors.dim(`tarout domains verify ${result.domain.domainId.slice(0, 8)}`)}`,
				);
				log("");
				log(
					colors.dim(
						"SSL is provisioned automatically once the record propagates (usually a few minutes).",
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// ── Verify external domain CNAME / nameservers ──
	domains
		.command("verify")
		.argument("<domain>", "Domain ID or domain name")
		.description(
			"Check the DNS records (A/CNAME and ownership TXT) for an external domain",
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

				updateSpinner("Checking DNS records...");

				const result: any =
					await client.domainRegistrar.verifyExternalDomain.mutate({
						domainId: domain.domainId,
					});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");

				if (result.verified) {
					success(`Domain ${colors.cyan(domain.domainName)} is verified!`);
					log("");
					log("DNS records are in place and SSL is active.");
					log("");
					return;
				}

				// Every external domain now routes through Tarout with A/CNAME
				// records: nameserver delegation is retired (the platform refuses to
				// verify those rows). The router strips the provider ids this used
				// to branch on (cloudflareCustomHostnameId, cloudflareNameservers),
				// so every domain landed in a nameserver message with no records.
				error(`${domain.domainName} is not verified yet.`);
				const reasons: string[] = Array.isArray(result.verificationErrors)
					? result.verificationErrors.filter(Boolean)
					: [];
				if (reasons.length > 0) {
					log("");
					for (const reason of reasons) log(`  - ${reason}`);
				}
				log("");

				const records = pendingVerificationRecords(domain, result);
				if (records.length > 0) {
					log("Make sure these records exist at your DNS provider:");
					log("");
					for (const record of records) {
						log(`  Type:   ${colors.cyan(record.type)}`);
						log(`  Name:   ${colors.cyan(record.name)}`);
						log(`  Value:  ${colors.cyan(record.value)}`);
						log("");
					}
				}
				const apexIps: string[] = Array.isArray(domain.apexIps)
					? domain.apexIps
					: [];
				if (domain.isApex && apexIps.length === 0 && domain.cnameTarget) {
					warn(
						"A root CNAME only works on DNS providers that flatten it at the apex (Cloudflare DNS with the record Proxied). A DNS-only root record will not route.",
					);
					log("");
				}
				if (result.sslStatus && result.sslStatus !== "active") {
					log(`  SSL status: ${colors.dim(String(result.sslStatus).replace(/_/g, " "))}`);
					log("");
				}
				log(
					colors.dim(
						"DNS changes usually propagate within minutes. Tarout re-checks pending domains every minute and issues SSL automatically.",
					),
				);
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

				// The platform has one onboarding flow per kind of hostname, and
				// `domain.create` only serves hosts under a Tarout-registered domain.
				// This used to call it for everything, so after that rule landed
				// every `domains link` failed, including the documented
				// add-external -> verify -> link path (found 2026-09-24).
				const host = domainName.toLowerCase();
				const plan = resolveDomainLinkPlan(
					host,
					await client.domain.all.query({ includeUnlinked: true }),
					await client.domainRegistrar.getAll.query(),
				);

				let domain: any;
				if (plan.kind === "existing") {
					await client.domain.linkToApplication.mutate({
						domainId: plan.domainId,
						applicationId: app.applicationId,
					});
					domain = { domainId: plan.domainId, host, isVerified: plan.isVerified };
				} else if (plan.kind === "registered-subdomain") {
					domain = await client.domain.createWithRegisteredDomain.mutate({
						registeredDomainId: plan.registeredDomainId,
						subdomain: plan.subdomain,
						applicationId: app.applicationId,
					} as any);
				} else {
					failSpinner();
					throw new InvalidArgumentError(plan.message);
				}

				succeedSpinner("Domain linked!");

				if (isJsonMode()) {
					outputData({ ...domain, host, applicationId: app.applicationId, linked: true });
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
		.description(
			"Detach a hostname from its application while keeping the hostname on the account, so `domains link` can attach it again",
		)
		.addHelpText(
			"after",
			"\nThe hostname row survives with no application attached; nothing reaps it.\nTo remove the host row and tear down its routing, run `tarout domains app delete <domain-id>`.\nTo delete a registered (purchased or external) domain, run `tarout domains delete <domain>`.",
		)
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

				// Detach from the app and keep the domain, so `domains link` can
				// attach it again. This used to delete the route row, which the
				// platform refuses for external domains ("Remove it from the Domains
				// page"): the domain would be left without routing. The row then sits
				// with applicationId = null for good - nothing reaps it - so the way
				// to actually remove it is `tarout domains app delete <domain-id>`,
				// and the way to remove the registered domain behind it is
				// `tarout domains delete <domain>`.
				await client.domain.unlinkFromApplication.mutate({
					domainId: domain.domainId,
				});

				succeedSpinner("Domain unlinked!");

				if (isJsonMode()) {
					outputData({
						unlinked: true,
						domainId: domain.domainId,
						nextCommand: `tarout domains app delete ${domain.domainId}`,
					});
				} else {
					quietOutput(domain.domainId);
					log("");
					log(
						colors.dim(
							`${domain.host} is still on the account with no application attached. Re-attach it with \`tarout domains link <app> ${domain.host}\`, or remove it for good with \`tarout domains app delete ${domain.domainId}\`.`,
						),
					);
					log("");
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
					instructions.managedDns
						? colors.success("DNS automatically managed by Tarout")
						: "Add these records at your DNS provider:",
				]);
				if (!instructions.managedDns && instructions.records?.length) {
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
				if (instructions.nameservers?.length) {
					log("");
					log("Or update nameservers to:");
					for (const ns of instructions.nameservers as string[]) {
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
				// registrarReadiness returns { configured, available, ... }; there is
				// no `ready` field, so this always printed "no".
				const r = data as any;
				const ready = Boolean(r.configured && r.available);
				log(
					`Registrar ready: ${ready ? colors.success("yes") : colors.error("no")}`,
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
					list.map(availabilityRow),
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
					list.map(availabilityRow),
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
				// getById returns the registered_domain columns (whoisPrivacy,
				// expiryDate) minus provider fields; `privacyEnabled` and
				// `expiresAt` never existed, so privacy always read "disabled" and
				// expiry "-".
				const d = data as any;
				const purchased = d.source === "purchased";
				log("");
				log(colors.bold(d.domainName || domainIdentifier));
				log(`  Source:      ${d.source || "-"}`);
				log(`  Status:      ${formatStatus(d.status || "-")}`);
				log(`  DNS:         ${formatDnsZoneStatus(d.dnsZoneStatus)}`);
				log(
					`  SSL:         ${d.sslStatus ? String(d.sslStatus).replace(/_/g, " ") : "-"}`,
				);
				if (purchased) {
					log(
						`  Privacy:     ${d.whoisPrivacy ? colors.success("enabled") : "disabled"}`,
					);
					log(`  Auto-renew:  ${d.autoRenew ? colors.success("yes") : "no"}`);
					log(`  Locked:      ${d.locked ? colors.warn("yes") : "no"}`);
					log(
						`  Expires:     ${d.expiryDate ? formatDate(d.expiryDate) : "-"}`,
					);
				}
				log(`  ID:          ${colors.dim(d.domainId || "-")}`);
				const linkedHosts: any[] = Array.isArray(d.linkedHosts)
					? d.linkedHosts
					: [];
				if (linkedHosts.length > 0) {
					log("");
					log(colors.bold("Hostnames"));
					for (const host of linkedHosts) {
						const target = host.application
							? host.application.name || host.application.appName
							: colors.dim("not linked");
						log(`  ${host.host} -> ${target}`);
					}
				}
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
		.description(
			"Open a checkout that renews a registered domain for another term, and print the payment link the customer pays at",
		)
		.option("-y, --years <n>", "Number of years to renew", "1")
		.option(
			"--dry-run",
			"Price the renewal and report its state without opening a checkout or charging anything (the same read as `domains renew-quote`)",
		)
		.action(
			async (
				domainIdentifier: string,
				options: { years?: string; dryRun?: boolean },
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
					if (options.dryRun) {
						updateSpinner("Pricing renewal...");
						const quote = await client.domainRegistrar.getRenewalQuote.query({
							domainId: domain.domainId,
						});
						succeedSpinner();
						if (isJsonMode()) {
							outputData({ dryRun: true, domainId: domain.domainId, ...quote });
							return;
						}
						quietOutput(describeRenewalQuote(quote).scalar);
						renderRenewalQuote(domain.domainName || domainIdentifier, quote);
						log(
							colors.dim(
								`Nothing was charged. Drop --dry-run to open the checkout: tarout domains renew ${domainIdentifier}`,
							),
						);
						log("");
						return;
					}
					const _renewSpinner = startSpinner("Creating renewal payment...");
					const result =
						await client.domainRegistrar.createRenewalPayment.mutate({
							domainId: domain.domainId,
							years: Number.parseInt(options.years || "1"),
						});
					succeedSpinner("Renewal payment created.");
					if (isJsonMode()) {
						outputData(result);
						return;
					}
					const r = result as any;
					log("");
					log(colors.bold("Renewal Payment Created"));
					if (r.amount !== undefined) log(`  Amount: ${r.amount} SAR`);
					if (r.paymentUrl) log(`  Payment URL: ${colors.cyan(r.paymentUrl)}`);
					log("");
					log("Open the payment URL above to complete the renewal.");
					log("");
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Renewal quote (read-only renewal state + exact checkout price) ──
	domains
		.command("renew-quote")
		.argument("<domain>", "Domain ID or name")
		.description(
			"Report whether a registered domain can be renewed right now and, when it can, the exact VAT-inclusive amount its checkout will charge - a read-only price check that never opens a checkout and never moves money",
		)
		.addHelpText(
			"after",
			"\nStates: renewable (a price is quoted), checkout_open (an unpaid order already exists for this expiry cycle - pay that one instead of opening a second), paid, processing, refund_pending, and unavailable (with the reason).\nKnown limitation: the platform's getRenewalQuote procedure takes no `years` input, so this quote is ALWAYS for one year even when you intend to renew for longer. `tarout domains renew --years N` is priced for N years at checkout time, which is not the amount shown here. Cloudflare-registered domains renew one year at a time regardless of --years.",
		)
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
				updateSpinner("Pricing the renewal...");
				const quote = await client.domainRegistrar.getRenewalQuote.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(quote);
					return;
				}
				quietOutput(describeRenewalQuote(quote).scalar);
				renderRenewalQuote(domain.domainName || domainIdentifier, quote);
			} catch (err) {
				stopSpinner();
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

	// ── Mark a domain checkout abandoned (advisory, never a refund) ──
	domains
		.command("cancel-payment")
		.requiredOption(
			"--order-id <id>",
			"The domain order to mark abandoned; always starts with `dom_` (from `domains renew-quote`, the checkout URL, or `domains transactions`)",
		)
		.option(
			"--reason <text>",
			"Free-text note about why the checkout was abandoned (the platform accepts this field and discards it - it is not stored or reported anywhere)",
		)
		.description(
			"Tell the platform a domain checkout was abandoned so the browser failure page has somewhere to report to. This does NOT refund, cancel, or reverse anything",
		)
		.addHelpText(
			"after",
			"\nThis is NOT a refund and NOT a cancellation. It is deliberately a near-no-op: the call reads the order, checks it belongs to your organization, and returns which domain and order kind it was. It changes no payment, no transaction status and no domain.\nThat is on purpose - this path is an unsigned browser redirect, not a trust boundary, and destructively failing the order here would race the signature-verified payment webhook and could stop a genuinely paid order from being fulfilled (charge-without-fulfil).\nTerminal failure comes from the signed PAYMENT_FAILED/CANCELED webhook; abandoned pending rows are reaped by the platform's reconciliation sweep. For money back, open a support ticket with `tarout tickets create`.",
		)
		.action(async (options: { orderId?: string; reason?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const orderId = parseDomainOrderId(options.orderId);
				const client = getApiClient();
				const _spinner = startSpinner("Reporting the abandoned checkout...");
				const result =
					await client.domainRegistrar.cancelDomainPayment.mutate({
						orderId,
						...(options.reason ? { reason: options.reason } : {}),
					});
				succeedSpinner("Checkout reported as abandoned.");
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = (result ?? {}) as {
					domainId?: string | null;
					transactionType?: string | null;
				};
				quietOutput(r.domainId || orderId);
				log("");
				log(colors.bold("Abandoned checkout reported"));
				log(`  Order:  ${colors.dim(orderId)}`);
				log(`  Domain: ${r.domainId ? colors.dim(r.domainId) : colors.dim("-")}`);
				log(`  Kind:   ${r.transactionType || colors.dim("unknown order")}`);
				log("");
				warn(
					"Nothing was refunded or cancelled: this call is advisory only and changes no payment state.",
				);
				log(
					colors.dim(
						"The signed payment webhook still decides the order's final state. If you were charged and want the money back, open a support ticket: tarout tickets create",
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
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
				// getSSLStatus returns { status, message, activatedAt,
				// usesTaroutRouting }. There is no `valid` or `expiresAt`, so a
				// pending certificate read "invalid/missing".
				const s = data as any;
				log("");
				log(colors.bold("SSL Certificate Status"));
				log(`  Status:    ${formatSslStatus(s.status)}`);
				if (s.message) log(`  ${colors.dim(s.message)}`);
				if (s.activatedAt) log(`  Activated: ${formatDate(s.activatedAt)}`);
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

	// ── Live certificate details ──
	domains
		.command("cert")
		.argument("<domain>", "Domain ID or name")
		.description(
			"Show the live TLS certificate Tarout serves for a registered domain - issuer, certificate authority, issue and expiry dates, and the days left before expiry",
		)
		.addHelpText(
			"after",
			"\nEvery certificate here is issued and auto-renewed by Tarout, so autoRenew is always true and there is nothing to renew by hand.\nA source of \"none\" means no certificate exists yet (the domain is not routed through Tarout, or issuance has not finished) - `tarout domains ssl <domain>` reports the issuance state and `tarout domains retry-ssl <domain>` retries it.\nFull-zone domains report status only: the issuer and validity window are not published per zone, so those fields stay empty.",
		)
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
				updateSpinner("Reading the certificate...");
				const cert = await client.domainRegistrar.getCertificate.query({
					domainId: domain.domainId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(cert);
					return;
				}
				const c = (cert ?? {}) as {
					source?: string;
					sslStatus?: string | null;
					issuer?: string | null;
					certificateAuthority?: string | null;
					issuedOn?: string | null;
					expiresOn?: string | null;
					daysUntilExpiry?: number | null;
					autoRenew?: boolean;
				};
				quietOutput(String(c.sslStatus ?? "unknown"));
				log("");
				log(colors.bold(`Certificate for ${domain.domainName || domainIdentifier}`));
				log(`  Status:     ${formatSslStatus(c.sslStatus)}`);
				log(
					`  Managed by: ${c.source === "managed" ? "Tarout" : colors.dim("no certificate yet")}`,
				);
				log(`  Issuer:     ${c.issuer || colors.dim("-")}`);
				log(`  Authority:  ${c.certificateAuthority || colors.dim("-")}`);
				log(`  Issued:     ${c.issuedOn ? formatDate(c.issuedOn) : colors.dim("-")}`);
				log(
					`  Expires:    ${c.expiresOn ? formatDate(c.expiresOn) : colors.dim("-")}${formatExpiryCountdown(c.daysUntilExpiry)}`,
				);
				log(
					`  Auto-renew: ${c.autoRenew === false ? colors.warn("no") : colors.success("yes")}`,
				);
				log("");
				if (c.source !== "managed") {
					log(
						colors.dim(
							`No certificate is being served yet. Check issuance with \`tarout domains ssl ${domainIdentifier}\`, then retry it with \`tarout domains retry-ssl ${domainIdentifier}\`.`,
						),
					);
					log("");
				}
			} catch (err) {
				stopSpinner();
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

	// ── Apex (root domain) redirect/serve mode ──
	domains
		.command("apex-mode")
		.argument("<domain>", "Domain ID or name of the root domain to switch")
		.description(
			"Choose how Tarout's gateway answers a root domain: --redirect sends the bare domain to www with a 308 and makes www canonical, --serve proxies the bare domain straight to the linked application and makes the bare domain canonical",
		)
		.option(
			"--redirect",
			"Bare domain 308-redirects to www; www is the canonical hostname (the platform's default)",
		)
		.option(
			"--serve",
			"Gateway proxies the bare domain to the linked application with the Host preserved; the bare domain is canonical and no redirect happens",
		)
		.addHelpText(
			"after",
			"\nThis switches LIVE traffic for the root domain the moment it succeeds, and asks for confirmation first unless the global --yes is passed. Pass exactly one of --redirect or --serve; there is no default.\nOnly root domains connected through the Tarout apex gateway have a mode at all (the domain must have gateway apex IPs and must not be on the full-zone or custom-hostname path).\n--serve additionally needs the bare hostname linked to a deployed application that has a reachable server address: run `tarout domains link <app> <domain>` and deploy it first.\nThe DNS records do not change either way, and the switch is reversible by running the command with the other flag.",
		)
		.action(
			async (
				domainIdentifier: string,
				options: { redirect?: boolean; serve?: boolean },
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const mode = resolveApexMode(options);
					const client = getApiClient();
					const _spinner = startSpinner("Fetching domain...");
					const allDomains: any[] =
						await client.domainRegistrar.getAll.query();
					const domain = findRegisteredDomain(allDomains, domainIdentifier);
					if (!domain) {
						failSpinner();
						throw new NotFoundError("Domain", domainIdentifier);
					}
					succeedSpinner();
					const host = domain.domainName || domainIdentifier;
					if (!shouldSkipConfirmation()) {
						const confirmed = await confirm(
							mode === "serve"
								? `Serve ${host} itself from its linked application? Live traffic to the bare domain stops redirecting to www immediately.`
								: `Redirect ${host} to www? Live traffic to the bare domain starts 308-redirecting immediately.`,
							false,
							{
								field: "confirm_set_apex_mode",
								flag: "--yes",
								context: { domain: host, domainId: domain.domainId, mode },
							},
						);
						if (!confirmed) {
							log("Cancelled.");
							return;
						}
					}
					const _modeSpinner = startSpinner(
						mode === "serve"
							? `Pointing the gateway at the app for ${host}...`
							: `Switching ${host} back to redirecting to www...`,
					);
					try {
						const result = await client.domainRegistrar.setApexMode.mutate({
							domainId: domain.domainId,
							mode,
						});
						succeedSpinner(`Apex mode set to ${mode}.`);
						if (isJsonMode()) {
							outputData({ domainId: domain.domainId, ...(result as any) });
							return;
						}
						quietOutput(mode);
						log("");
						log(
							mode === "serve"
								? `${colors.cyan(host)} is now served directly by its linked application; ${colors.dim(`www.${host}`)} is no longer the canonical hostname.`
								: `${colors.cyan(host)} now 308-redirects to ${colors.cyan(`www.${host}`)}, which is the canonical hostname.`,
						);
						log("");
					} catch (modeErr) {
						const refusal = apexModeRefusal(modeErr, {
							identifier: domainIdentifier,
							host,
							mode,
						});
						throw refusal ?? modeErr;
					}
				} catch (err) {
					stopSpinner();
					handleError(err);
				}
			},
		);

	// ── Can this organization connect domains to apps at all? ──
	domains
		.command("can-connect")
		.description(
			"Report whether this organization's plan allows connecting a domain to an application. Buying a domain is never gated, but connecting one needs the custom-domain entitlement - check this before paying a registrar for a domain you cannot route",
		)
		.addHelpText(
			"after",
			"\nThe check fails open: if the entitlement lookup itself errors, the platform answers true rather than blocking a sale, so a true answer is permissive and a create call can still be refused.\nIn --quiet mode this prints only `true` or `false`, which is the form to branch on in a script.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking the custom-domain entitlement...");
				const result = await client.domainRegistrar.canConnectDomains.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const canConnect = Boolean(
					(result as { canConnectToApps?: boolean } | null)?.canConnectToApps,
				);
				quietOutput(String(canConnect));
				log("");
				if (canConnect) {
					log(
						`${colors.success("Yes")} - this organization can connect domains to applications.`,
					);
					log(
						colors.dim(
							"Connect one with `tarout domains link <app> <domain>`.",
						),
					);
				} else {
					log(
						`${colors.warn("No")} - this organization's plan has no custom-domain entitlement, so a purchased domain could not be routed to an app.`,
					);
					log(
						colors.dim(
							"Buying a domain would still succeed. Add the entitlement first with `tarout billing plans` and `tarout billing upgrade <plan>`.",
						),
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
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

	// ── DNS update, getById, sync, setupCommonRecords, checkPropagation ──
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
						content: options.content,
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
		.command("delete")
		.argument(
			"<domain-id>",
			"App-domain ID, ID prefix, or hostname to delete (list them with `tarout domains app list --unlinked`)",
		)
		.description(
			"Delete a hostname row and tear down its routing - removes the host from its application's router, from the edge routing table, and the A records Tarout created for it, then deletes the row itself",
		)
		.addHelpText(
			"after",
			"\nThis is the only command that actually removes a hostname row. `tarout domains unlink` only detaches it from its application and leaves the row behind with no application attached, for good.\nIt is irreversible and takes the hostname offline immediately; it asks for confirmation unless the global --yes is passed. Re-adding the hostname afterwards means `tarout domains add-external` (or `tarout domains app link-registered`) and verifying it again.\nA hostname belonging to a connected EXTERNAL domain is refused here on purpose - deleting only its route would strand its certificate and leave it billed. Remove those with `tarout domains delete <domain>`, which releases the certificate too.",
		)
		.action(async (domainId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding domain...");
				const allDomains = await client.domain.all.query({
					includeUnlinked: true,
				});
				const domain = findAppDomain(allDomains as any[], domainId);
				if (!domain) {
					failSpinner();
					throw new NotFoundError(
						"App domain",
						domainId,
						findSimilar(
							domainId,
							(allDomains as any[]).map((d: any) => d.host),
						),
					);
				}
				succeedSpinner();
				if (!shouldSkipConfirmation()) {
					log("");
					log(`Hostname:    ${colors.bold(domain.host)}`);
					log(
						`Application: ${domain.application?.name || colors.dim("not linked")}`,
					);
					log("");
					const confirmed = await confirm(
						`Delete ${domain.host} and tear down its routing? This takes the hostname offline and cannot be undone.`,
						false,
						{
							field: "confirm_delete_app_domain",
							flag: "--yes",
							context: { domain: domain.host, domainId: domain.domainId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const _deleteSpinner = startSpinner("Deleting domain and routing...");
				try {
					await client.domain.delete.mutate({ domainId: domain.domainId });
				} catch (deleteErr) {
					throw (
						appDomainDeleteRefusal(deleteErr, {
							host: domain.host,
						}) ?? deleteErr
					);
				}
				succeedSpinner("Domain deleted.");
				if (isJsonMode()) {
					outputData({
						deleted: true,
						domainId: domain.domainId,
						host: domain.host,
					});
					return;
				}
				quietOutput(domain.domainId);
				log("");
				log(
					`${colors.bold(domain.host)} is gone: its routing was removed and the record deleted.`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

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

	// ── Saudi (.sa) registry application pieces ──
	const saudi = domains
		.command("saudi")
		.description(
			"Pieces of the Saudi (.sa) registry application: the registry's country and document-type codes, and the document upload a .sa registration cannot be paid for without",
		)
		.addHelpText(
			"after",
			"\nA .sa registration is not a plain purchase: the Saudi registry wants an application (registrant country, document type, document issuer) plus a supporting identity or business document, and the platform refuses the registration payment until both are attached.\nThese commands read the registry's own code lists and create the signed upload for the document. Filling in and submitting the application itself is still a dashboard step (https://tarout.sa/dashboard/domains).\nThe whole .sa path sits behind a platform feature gate that is OFF by default while the registry integration finishes staging verification. Until it is turned on, every command here answers that Saudi domain registration is unavailable - that is the gate, not a broken command.",
		);

	saudi
		.command("options")
		.description(
			"List the Saudi registry's accepted countries and document types with the exact IDs the registry application expects, so an application can be filled in without guessing codes",
		)
		.option(
			"--filter <text>",
			"Only show countries and document types whose name or code contains this text (case-insensitive)",
		)
		.option(
			"--countries",
			"Always print the full country list instead of summarising it (the registry returns a couple of hundred rows)",
		)
		.action(async (options: { filter?: string; countries?: boolean }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching Saudi registry options...");
				// The procedure's input is `z.object({})`: an empty object is REQUIRED,
				// so passing nothing fails validation before the call leaves.
				let result: any;
				try {
					result =
						await client.domainRegistrar.getSaudiDomainApplicationOptions.query(
							{},
						);
				} catch (optionsErr) {
					throw saudiFlowRefusal(optionsErr) ?? optionsErr;
				}
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const countries: any[] = Array.isArray(result?.countries)
					? result.countries
					: [];
				const documentTypes: any[] = Array.isArray(result?.documentTypes)
					? result.documentTypes
					: [];
				const needle = options.filter?.trim().toLowerCase();
				const matchingCountries = needle
					? countries.filter((c: any) =>
							[c.code, c.nameEn, c.nameAr, c.nationalityEn]
								.filter(Boolean)
								.some((v: string) => String(v).toLowerCase().includes(needle)),
						)
					: countries;
				const matchingTypes = needle
					? documentTypes.filter((t: any) =>
							[t.id, t.nameEn, t.nameAr]
								.filter(Boolean)
								.some((v: string) => String(v).toLowerCase().includes(needle)),
						)
					: documentTypes;
				if (isQuietMode()) {
					for (const t of matchingTypes) {
						if (t?.id) quietOutput(String(t.id));
					}
					return;
				}
				log("");
				log(colors.bold("Document types"));
				if (matchingTypes.length === 0) {
					log(colors.dim("  none"));
				} else {
					table(
						["ID", "NAME", "ISSUER ID", "ACTIVITY ID"],
						matchingTypes.map((t: any) => [
							colors.cyan(String(t.id ?? "-")),
							truncate(String(t.nameEn || t.nameAr || "-"), 44),
							String(t.issuerId ?? "-"),
							String(t.activityId ?? "-"),
						]),
					);
				}
				log("");
				const showAllCountries =
					Boolean(options.countries) ||
					Boolean(needle) ||
					matchingCountries.length <= 25;
				log(colors.bold("Countries"));
				if (matchingCountries.length === 0) {
					log(colors.dim("  none"));
				} else if (showAllCountries) {
					table(
						["ID", "CODE", "NAME", "NATIONALITY"],
						matchingCountries.map((c: any) => [
							colors.cyan(String(c.id ?? "-")),
							String(c.code ?? "-"),
							truncate(String(c.nameEn || c.nameAr || "-"), 32),
							truncate(String(c.nationalityEn || "-"), 24),
						]),
					);
				} else {
					log(
						colors.dim(
							`  ${matchingCountries.length} countries. Narrow them with --filter <text>, print them all with --countries, or read the full list with --json.`,
						),
					);
				}
				log("");
				log(
					colors.dim(
						"Next: upload the supporting document with `tarout domains saudi upload-doc <domain> <file> --upload`.",
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	saudi
		.command("upload-doc")
		.alias("upload-url")
		.argument("<domain>", "The .sa domain name the document is being filed for")
		.argument(
			"<file>",
			"Path to the local PDF, JPEG or PNG to upload (its name and byte size are read from disk unless --file-name / --size override them)",
		)
		.description(
			"Create the pre-signed upload for a .sa registry document and, with --upload, send the file's bytes to it - returns the storage key the registry application references",
		)
		.option(
			"--content-type <type>",
			`MIME type of the document; one of ${SAUDI_DOCUMENT_CONTENT_TYPES.join(", ")} (inferred from the file extension when omitted)`,
		)
		.option(
			"--size <bytes>",
			"Byte size of the document, if it should not be read from the file on disk",
			(v: string) => Number.parseInt(v, 10),
		)
		.option(
			"--file-name <name>",
			"File name to register with the registry instead of the local file's name",
		)
		.option(
			"--upload",
			"Also PUT the file's bytes to the returned URL, so the document is actually stored rather than just addressable",
		)
		.addHelpText(
			"after",
			"\nThe returned URL is a pre-signed PUT that expires 15 minutes after it is issued, and nothing uploads itself: without --upload you must PUT the bytes yourself before it expires (`curl -X PUT --upload-file <file> -H 'Content-Type: <type>' '<url>'`), exactly like the `tarout tickets upload-url` then `tarout tickets attach` pair.\nThe `domainId` that comes back is a fresh identifier minted for this upload, not an existing domain: it is part of the document's storage path and has to be quoted together with the storage key when the application is submitted.\nThe platform re-checks the document after upload (size, declared type, and the file's real magic bytes), so a mismatched --size or --content-type is rejected later, not here. Documents larger than the platform's limit (5 MB by default) are refused.\nTreat the URL as a credential: anyone holding it can write that object until it expires. It is printed in the human output but never in --quiet output.",
		)
		.action(
			async (
				domainName: string,
				filePath: string,
				options: {
					contentType?: string;
					size?: number;
					fileName?: string;
					upload?: boolean;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					// Read the bytes/size up front: the platform signs the URL for an
					// exact content type and later verifies the stored object's size and
					// magic bytes against what was declared here.
					let body: Buffer | undefined;
					if (options.upload) {
						try {
							body = readFileSync(filePath);
						} catch (readErr) {
							throw new CliError(
								`Could not read "${filePath}": ${readErr instanceof Error ? readErr.message : String(readErr)}`,
							);
						}
					}
					let fileSize = options.size;
					if (fileSize === undefined) {
						if (body) {
							fileSize = body.byteLength;
						} else {
							try {
								fileSize = statSync(filePath).size;
							} catch (statErr) {
								throw new CliError(
									`Could not read "${filePath}": ${statErr instanceof Error ? statErr.message : String(statErr)}. Pass --size <bytes> to declare the size without the file on disk.`,
								);
							}
						}
					}
					const upload = buildSaudiDocumentUpload({
						domainName,
						fileName: options.fileName || basename(filePath),
						contentType: options.contentType,
						fileSize,
					});
					const client = getApiClient();
					const _spinner = startSpinner("Creating the document upload...");
					let created: any;
					try {
						created =
							await client.domainRegistrar.createSaudiDomainDocumentUpload.mutate(
								upload,
							);
					} catch (createErr) {
						throw saudiFlowRefusal(createErr, upload.domainName) ?? createErr;
					}
					if (!created?.uploadUrl) {
						failSpinner();
						throw new CliError(
							"The platform did not return an upload URL for this document.",
						);
					}
					let uploaded = false;
					if (body) {
						updateSpinner(`Uploading ${upload.fileSize} bytes...`);
						// The URL is signed for this exact content type, so send it back
						// verbatim or the signature check fails.
						const putRes = await fetch(created.uploadUrl, {
							method: "PUT",
							headers: { "Content-Type": upload.contentType },
							body,
						});
						if (!putRes.ok) {
							failSpinner();
							const detail = await putRes.text().catch(() => "");
							throw new CliError(
								`Upload failed (HTTP ${putRes.status} ${putRes.statusText})${detail ? `: ${detail.slice(0, 200)}` : ""}. The signed URL expires 15 minutes after it was issued; run the command again to get a fresh one.`,
							);
						}
						uploaded = true;
					}
					succeedSpinner(
						uploaded ? "Document uploaded." : "Upload URL created.",
					);
					if (isJsonMode()) {
						outputData({ ...created, uploaded, ...upload });
						return;
					}
					// Never the signed URL: it is a write capability, and quiet output
					// is what gets piped into logs and scripts.
					quietOutput(String(created.storageKey));
					log("");
					log(colors.bold(`Saudi domain document for ${upload.domainName}`));
					log(`  File:        ${upload.fileName}`);
					log(`  Type:        ${upload.contentType}`);
					log(`  Size:        ${upload.fileSize} bytes`);
					log(`  Domain ID:   ${colors.dim(String(created.domainId))}`);
					log(`  Storage key: ${colors.dim(String(created.storageKey))}`);
					if (!uploaded) {
						log(`  Upload URL:  ${colors.cyan(String(created.uploadUrl))}`);
					}
					log("");
					if (uploaded) {
						log(
							`${colors.success("Stored.")} Quote the domain ID and storage key above on the registry application.`,
						);
					} else {
						warn(
							"Nothing has been stored yet: the URL above expires in 15 minutes and the bytes still have to be PUT to it.",
						);
						log(
							colors.dim(
								`  curl -X PUT --upload-file ${filePath} -H 'Content-Type: ${upload.contentType}' '<upload url>'`,
							),
						);
						log(
							colors.dim(
								"  Or re-run this command with --upload to send them from here.",
							),
						);
					}
					log("");
					log(
						colors.dim(
							"Finish the registry application (country, document type, issuer) at https://tarout.sa/dashboard/domains - `tarout domains register` cannot submit it yet.",
						),
					);
					log("");
				} catch (err) {
					stopSpinner();
					handleError(err);
				}
			},
		);
}

// ── Helper functions ──

export type DomainLinkPlan =
	| { kind: "existing"; domainId: string; isVerified: boolean }
	| { kind: "registered-subdomain"; registeredDomainId: string; subdomain: string }
	| { kind: "unavailable"; message: string };

/**
 * How `domains link` attaches `host`: an app-domain row that already exists
 * (added with `domains add-external`, or created earlier) is linked as is; a
 * single-label subdomain of a domain registered through Tarout is created
 * under it; anything else has to be added first.
 */
export function resolveDomainLinkPlan(
	host: string,
	appDomains: any[],
	registeredDomains: any[],
): DomainLinkPlan {
	const existing = appDomains.find((d: any) => d.host?.toLowerCase() === host);
	if (existing) {
		return {
			kind: "existing",
			domainId: existing.domainId,
			isVerified: Boolean(existing.isVerified),
		};
	}
	const parent = registeredDomains
		.filter((r: any) => typeof r.domainName === "string" && host.endsWith(`.${r.domainName.toLowerCase()}`))
		.sort((a: any, b: any) => b.domainName.length - a.domainName.length)[0];
	if (parent) {
		const subdomain = host.slice(0, -(parent.domainName.length + 1));
		if (/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(subdomain)) {
			return {
				kind: "registered-subdomain",
				registeredDomainId: parent.domainId ?? parent.id,
				subdomain,
			};
		}
	}
	return {
		kind: "unavailable",
		message: `${host} has not been added yet. Run \`tarout domains add-external ${host}\`, create the record from \`tarout domains instructions ${host}\`, run \`tarout domains verify ${host}\`, then link it again.`,
	};
}

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

/**
 * One search result row. The platform answers with `purchasable` and
 * `purchasePrice` (DomainAvailability); `available` and `price` were never
 * sent, so every result read "no" with no price. `purchasePrice` covers the
 * registry's minimum term, which is two years for TLDs such as .ai.
 */
function availabilityRow(r: any): string[] {
	const term =
		typeof r.minYears === "number" && r.minYears > 1 ? `${r.minYears}yr` : "yr";
	return [
		colors.cyan(r.domainName || "-"),
		r.purchasable ? colors.success("yes") : colors.dim("no"),
		r.purchasable && typeof r.purchasePrice === "number"
			? `${r.purchasePrice} ${r.currency || "SAR"}/${term}`
			: "-",
	];
}

type DnsRecordHint = { type: string; name: string; value: string };

/**
 * The records an unverified external domain still needs, built from what the
 * platform actually returns: the routing contract from the domainRegistrar
 * row (`apexIps` for a gateway apex, `cnameTarget` otherwise) plus the
 * challenges from verifyExternalDomain (ownership TXT, the edge's activation
 * TXT, a wildcard's certificate TXT, and a CAA grant when a CAA policy blocks
 * issuance).
 */
function pendingVerificationRecords(
	domain: any,
	result: any,
): DnsRecordHint[] {
	const records: DnsRecordHint[] = [];
	const apexIps: string[] = Array.isArray(domain?.apexIps) ? domain.apexIps : [];
	if (domain?.isApex && apexIps.length > 0) {
		for (const ip of apexIps) records.push({ type: "A", name: "@", value: ip });
	} else if (domain?.cnameTarget) {
		records.push({
			type: "CNAME",
			name: domain.isApex ? "@" : domain.domainName,
			value: domain.cnameTarget,
		});
	}
	for (const challenge of [
		result?.ownershipVerification,
		result?.cfOwnershipVerification,
	]) {
		if (challenge?.name && challenge?.value) {
			records.push({ type: "TXT", name: challenge.name, value: challenge.value });
		}
	}
	if (result?.dcvTxtName && result?.dcvTxtValue) {
		records.push({ type: "TXT", name: result.dcvTxtName, value: result.dcvTxtValue });
	}
	if (result?.caaBlock?.recordName && result?.caaBlock?.recordValue) {
		records.push({
			type: "CAA",
			name: result.caaBlock.recordName,
			value: result.caaBlock.recordValue,
		});
	}
	return records;
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

function formatSslStatus(status: string | null | undefined): string {
	switch (status) {
		case "active":
			return colors.success("active");
		case "failed":
			return colors.error("failed");
		case undefined:
		case null:
		case "":
			return colors.warn("pending");
		default:
			return colors.warn(String(status).replace(/_/g, " "));
	}
}

function formatDnsZoneStatus(status: string | null | undefined): string {
	if (!status) return colors.dim("-");
	// Abandoned external domains carry a `cleanup_<stage>:<lease>` marker while
	// the platform removes them; the lease suffix means nothing to a customer.
	if (status.startsWith("cleanup_")) return colors.dim("removing");
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

// ── Apex mode ──

/**
 * Which apex mode `domains apex-mode` asks the platform for. `setApexMode`
 * requires the mode and has no default - it switches live traffic for a root
 * domain - so exactly one of the two flags has to be given, and neither flag
 * is treated as "leave it alone".
 */
export function resolveApexMode(options: {
	redirect?: boolean;
	serve?: boolean;
}): "redirect" | "serve" {
	if (options.redirect && options.serve) {
		throw new InvalidArgumentError(
			"--redirect and --serve are opposites: pass only one. --redirect sends the bare domain to www, --serve answers on the bare domain itself.",
		);
	}
	if (options.redirect) return "redirect";
	if (options.serve) return "serve";
	throw new InvalidArgumentError(
		"Pass --redirect or --serve. This command switches live traffic for a root domain, so there is deliberately no default: --redirect 308s the bare domain to www, --serve proxies the bare domain to its linked application. Read the current mode with `tarout domains info <domain>`.",
	);
}

/**
 * The gateway contract behind `setApexMode` is narrow - a root domain with
 * gateway apex IPs and no full zone or custom hostname, plus (for serve mode) a
 * deployed app behind the bare hostname. Turn each of its PRECONDITION_FAILED
 * refusals into the command that fixes it.
 */
export function apexModeRefusal(
	err: unknown,
	opts: { identifier: string; host: string; mode: "redirect" | "serve" },
): CliError | null {
	if (trpcCode(err) !== "PRECONDITION_FAILED") return null;
	const message = String((err as { message?: unknown } | null)?.message ?? "");
	if (/apex gateway|redirect\/serve mode/i.test(message)) {
		return new CliError(
			`${opts.host} is not routed through the Tarout apex gateway, so it has no redirect/serve mode. Only a root domain that Tarout answers on its own gateway addresses has one; a domain on the full-zone or custom-hostname path answers directly and is configured with DNS records instead.\nCheck how it is routed with \`tarout domains info ${opts.identifier}\`, and read the records it expects with \`tarout domains instructions ${opts.host}\`.`,
			ExitCode.INVALID_ARGUMENTS,
			undefined,
			{
				reason: "not_on_apex_gateway",
				nextCommand: `tarout domains info ${opts.identifier}`,
			},
		);
	}
	if (/deployed application|link .* to a deployed/i.test(message)) {
		return new CliError(
			`Serve mode proxies ${opts.host} straight to an application, so the bare hostname has to be linked to one that is already deployed. Nothing changed.\nLink it with \`tarout domains link <app> ${opts.host}\`, deploy that app with \`tarout deploy\`, then run this command again. To leave the apex redirecting to www in the meantime, run \`tarout domains apex-mode ${opts.identifier} --redirect\`.`,
			ExitCode.INVALID_ARGUMENTS,
			undefined,
			{
				reason: "apex_not_linked_to_deployed_app",
				nextCommand: `tarout domains link <app> ${opts.host}`,
			},
		);
	}
	if (/reachable address|externalIp|no reachable/i.test(message)) {
		return new CliError(
			`The application behind ${opts.host} has no reachable server address yet, so the gateway has nowhere to send the bare domain. Nothing changed.\nDeploy the application and try again once it is running: \`tarout deploy\`, then \`tarout domains apex-mode ${opts.identifier} --serve\`.`,
			ExitCode.INVALID_ARGUMENTS,
			undefined,
			{
				reason: "app_server_unreachable",
				nextCommand: `tarout domains apex-mode ${opts.identifier} --serve`,
			},
		);
	}
	if (/origin route|origin record/i.test(message)) {
		return new CliError(
			`The gateway route for ${opts.host} could not be ${opts.mode === "serve" ? "published" : "removed"}, so nothing changed and the apex is still in its previous mode. This is usually transient - run the same command again.`,
			ExitCode.GENERAL_ERROR,
			undefined,
			{
				reason: "gateway_route_write_failed",
				nextCommand: `tarout domains apex-mode ${opts.identifier} --${opts.mode}`,
			},
		);
	}
	return null;
}

// ── Domain checkout orders ──

/**
 * The order id every domain checkout carries. The platform derives the local
 * transaction from the `dom_` prefix and rejects anything else as "Invalid
 * payment order", which tells the caller nothing - a subscription order
 * (`sub_`) or a renewal order from another surface is the usual mistake.
 */
export function parseDomainOrderId(orderId: string | undefined): string {
	const value = orderId?.trim();
	if (!value) {
		throw new InvalidArgumentError(
			"--order-id <dom_...> is required. Domain orders are the ones that start with `dom_`; find yours with `tarout domains renew-quote <domain>`, `tarout domains transactions <domain>`, or in the checkout URL.",
		);
	}
	if (!value.startsWith("dom_") || value.length <= "dom_".length) {
		throw new InvalidArgumentError(
			`"${value}" is not a domain order id. Domain orders start with \`dom_\` followed by the transaction id. A subscription order (\`sub_\`) belongs to \`tarout billing confirm\` instead.`,
		);
	}
	return value;
}

// ── Saudi (.sa) registry documents ──

/** The only content types the platform will sign a .sa document upload for. */
export const SAUDI_DOCUMENT_CONTENT_TYPES = [
	"application/pdf",
	"image/jpeg",
	"image/png",
] as const;

export type SaudiDocumentContentType =
	(typeof SAUDI_DOCUMENT_CONTENT_TYPES)[number];

const SAUDI_DOCUMENT_EXTENSIONS: Record<string, SaudiDocumentContentType> = {
	".pdf": "application/pdf",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
};

export interface SaudiDocumentUpload {
	domainName: string;
	fileName: string;
	contentType: SaudiDocumentContentType;
	fileSize: number;
}

/**
 * The exact `createSaudiDomainDocumentUpload` input, validated here so a bad
 * type or size is an argument error instead of a round trip that ends in a
 * generic BAD_REQUEST. The content type is signed into the upload URL and
 * re-checked against the stored object's real magic bytes afterwards, so it has
 * to describe the file rather than merely be allowed.
 */
export function buildSaudiDocumentUpload(input: {
	domainName: string;
	fileName: string;
	contentType?: string;
	fileSize?: number;
}): SaudiDocumentUpload {
	const domainName = input.domainName?.trim().toLowerCase() ?? "";
	if (!isValidDomain(domainName) || !domainName.endsWith(".sa")) {
		throw new InvalidArgumentError(
			`"${input.domainName}" is not a Saudi domain. Registry documents only exist for .sa names; every other TLD registers with \`tarout domains register <domain>\` and needs no document.`,
		);
	}
	const fileName = input.fileName?.trim() ?? "";
	if (!fileName) {
		throw new InvalidArgumentError(
			"The document needs a file name. Pass --file-name <name> when the path does not end in one.",
		);
	}
	if (fileName.length > 255) {
		throw new InvalidArgumentError(
			"The document file name must be 255 characters or fewer. Pass a shorter --file-name <name>.",
		);
	}
	const declared = input.contentType?.trim().toLowerCase();
	let contentType: SaudiDocumentContentType;
	if (declared) {
		const match = SAUDI_DOCUMENT_CONTENT_TYPES.find((t) => t === declared);
		if (!match) {
			throw new InvalidArgumentError(
				`The Saudi registry accepts ${SAUDI_DOCUMENT_CONTENT_TYPES.join(", ")} documents; "${input.contentType}" is not one of them. Convert the file, then pass --content-type with the matching type.`,
			);
		}
		contentType = match;
	} else {
		const inferred = SAUDI_DOCUMENT_EXTENSIONS[extname(fileName).toLowerCase()];
		if (!inferred) {
			throw new InvalidArgumentError(
				`Could not tell what kind of document "${fileName}" is. Pass --content-type with one of ${SAUDI_DOCUMENT_CONTENT_TYPES.join(", ")}, or rename the file with a .pdf, .jpg or .png extension.`,
			);
		}
		contentType = inferred;
	}
	const fileSize = input.fileSize;
	if (
		typeof fileSize !== "number" ||
		!Number.isFinite(fileSize) ||
		!Number.isInteger(fileSize) ||
		fileSize <= 0
	) {
		throw new InvalidArgumentError(
			`The document size must be a whole number of bytes greater than zero${fileSize === 0 ? " - the file on disk is empty" : ""}. Pass --size <bytes>, or point the command at a readable file so it can measure one.`,
		);
	}
	return { domainName, fileName, contentType, fileSize };
}

/**
 * The .sa path is gated by platform configuration (the Saudi registry
 * integration is off until its staging verification finishes), and the gate
 * answers with the same PRECONDITION_FAILED as a genuinely bad request. Say
 * which it is instead of relaying "not available".
 */
export function saudiFlowRefusal(
	err: unknown,
	domainName?: string,
): CliError | null {
	if (trpcCode(err) !== "PRECONDITION_FAILED") return null;
	const message = String((err as { message?: unknown } | null)?.message ?? "");
	if (!/saudi|not available|unavailable/i.test(message)) return null;
	return new CliError(
		`Saudi (.sa) domain registration is switched off on this platform${domainName ? ` - nothing was created for ${domainName}` : ""}. The registry integration is behind a configuration gate that stays off until its verification completes, so every .sa search, document upload and registration is refused until it is turned on. This is the gate, not a problem with the command or the file.\nOther TLDs are unaffected: \`tarout domains search <keyword>\` and \`tarout domains register <domain>\` work normally. For a .sa domain today, ask support to register it: \`tarout tickets create\`.`,
		ExitCode.GENERAL_ERROR,
		undefined,
		{
			reason: "saudi_registration_disabled",
			nextCommand: "tarout tickets create",
		},
	);
}

// ── App domain rows ──

/**
 * `domain.delete` refuses the host row of a connected external domain: deleting
 * only the route would leave the certificate and the registered domain behind,
 * billed and unattachable. Point at the command that removes both.
 */
export function appDomainDeleteRefusal(
	err: unknown,
	opts: { host: string },
): CliError | null {
	if (trpcCode(err) !== "PRECONDITION_FAILED") return null;
	const message = String((err as { message?: unknown } | null)?.message ?? "");
	if (!/external/i.test(message)) return null;
	return new CliError(
		`${opts.host} is the route of a connected external domain, so deleting it on its own is refused: its certificate and registered-domain record would survive with nothing attached - still listed, still billed, and impossible to attach again.\nRemove the whole thing with \`tarout domains delete ${opts.host}\`, which releases the certificate and the routing together. To keep the domain but take the app off it, use \`tarout domains unlink ${opts.host}\`.`,
		ExitCode.INVALID_ARGUMENTS,
		undefined,
		{
			reason: "external_domain_route",
			nextCommand: `tarout domains delete ${opts.host}`,
		},
	);
}

// ── Renewal quotes ──

export interface RenewalQuoteView {
	/** The `state` discriminant the platform answered with. */
	state: string;
	/** The single value --quiet prints: an amount, an order id, or the state. */
	scalar: string;
	headline: string;
	/** Label/value lines, already formatted, in display order. */
	lines: Array<[string, string]>;
	/** Whether a fresh renewal checkout can be opened right now. */
	renewable: boolean;
	/** What to run next, when the state implies something. */
	nextCommand?: string;
	/** Set when the state is a warning rather than plain information. */
	note?: string;
}

/**
 * Flatten the `getRenewalQuote` union into something printable. Every branch
 * carries different fields - only `renewable` has a price, only
 * `checkout_open` has an order and payment links, and `unavailable` has no
 * `newExpiry` at all - so each is spelled out rather than merged.
 */
export function describeRenewalQuote(quote: unknown): RenewalQuoteView {
	const q = (quote ?? {}) as Record<string, any>;
	const state = typeof q.state === "string" ? q.state : "";
	const currentExpiry = q.currentExpiry
		? formatDate(q.currentExpiry)
		: "unknown";
	const newExpiry = q.newExpiry ? formatDate(q.newExpiry) : "unknown";
	switch (state) {
		case "renewable": {
			const years = typeof q.years === "number" ? q.years : 1;
			const lines: Array<[string, string]> = [
				["Term", `${years} year${years === 1 ? "" : "s"}`],
				["Price", `${formatSarAmount(q.amountHalalas)} (VAT included)`],
			];
			if (typeof q.taxHalalas === "number" && q.taxHalalas > 0) {
				lines.push(["Of which VAT", formatSarAmount(q.taxHalalas)]);
			}
			lines.push(["Expires now", currentExpiry]);
			lines.push(["After renewal", newExpiry]);
			return {
				state,
				scalar: String(q.amountHalalas ?? ""),
				headline: "Renewable - this is exactly what the checkout will charge",
				lines,
				renewable: true,
			};
		}
		case "checkout_open": {
			const orderId = String(q.orderId ?? "");
			return {
				state,
				scalar: orderId,
				headline:
					"A renewal checkout for this expiry cycle is already open and still payable",
				lines: [
					["Order", orderId || "unknown"],
					["Amount", formatSarAmount(q.amountHalalas)],
					["Pay at", String(q.paymentUrl ?? "-")],
					["Shareable link", String(q.publicPaymentUrl ?? "-")],
					["Expires now", currentExpiry],
					["After renewal", newExpiry],
				],
				renewable: false,
				nextCommand: orderId
					? `tarout domains confirm-payment --order-id ${orderId}`
					: undefined,
				note: "Pay this order rather than starting a second one - the platform allows only one live renewal per expiry cycle and will refuse another.",
			};
		}
		case "paid":
			return {
				state,
				scalar: state,
				headline: "Already renewed and paid for this expiry cycle",
				lines: [
					["Cycle renewed", currentExpiry],
					["Now expires", newExpiry],
				],
				renewable: false,
			};
		case "processing":
			return {
				state,
				scalar: state,
				headline:
					"Paid and being applied - the registrar has not confirmed the new expiry yet",
				lines: [
					["Cycle renewed", currentExpiry],
					["Will expire", newExpiry],
				],
				renewable: false,
				note: "No second payment is needed. The platform finishes this on its own.",
			};
		case "refund_pending":
			return {
				state,
				scalar: state,
				headline: "A refund for this renewal is in progress",
				lines: [
					["Cycle", currentExpiry],
					["Would have expired", newExpiry],
				],
				renewable: false,
				note: "The cycle frees up once the refund settles; renewing again before then is refused.",
			};
		case "unavailable": {
			const reason = typeof q.reason === "string" ? q.reason : "unavailable";
			const lines: Array<[string, string]> = [["Reason", reason]];
			if (typeof q.message === "string" && q.message) {
				lines.push(["Detail", q.message]);
			}
			lines.push(["Expires", q.currentExpiry ? currentExpiry : "unknown"]);
			return {
				state,
				scalar: reason,
				headline: "Not renewable right now",
				lines,
				renewable: false,
			};
		}
		default:
			return {
				state: state || "unknown",
				scalar: state || "unknown",
				headline: `Unrecognised renewal state${state ? ` "${state}"` : ""}`,
				lines: [],
				renewable: false,
				note: "This CLI is older than the platform it is talking to. Read the raw answer with --json, or update with `tarout upgrade`.",
			};
	}
}

/** Human rendering of one renewal quote, shared by `renew-quote` and `renew --dry-run`. */
function renderRenewalQuote(host: string, quote: unknown): void {
	const view = describeRenewalQuote(quote);
	const width = view.lines.reduce((max, [label]) => Math.max(max, label.length), 0);
	log("");
	log(colors.bold(`Renewal for ${host}`));
	log(`  ${view.headline}`);
	if (view.lines.length > 0) log("");
	for (const [label, value] of view.lines) {
		log(`  ${label.padEnd(width)}  ${value}`);
	}
	log("");
	if (view.renewable) {
		log(
			colors.dim(
				"Quoted for one year: the platform's renewal quote takes no term, so a longer `--years` is priced at checkout and will not match this amount.",
			),
		);
	}
	if (view.note) log(colors.warn(view.note));
	if (view.nextCommand) log(`Next: ${colors.dim(view.nextCommand)}`);
	if (view.renewable || view.note || view.nextCommand) log("");
}

// ── Shared formatting ──

/** " (N days left)" for a certificate expiry, or nothing when it is unknown. */
function formatExpiryCountdown(days: number | null | undefined): string {
	if (typeof days !== "number" || !Number.isFinite(days)) return "";
	if (days < 0) {
		return ` ${colors.error(`(expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago)`)}`;
	}
	const text = `(${days} day${days === 1 ? "" : "s"} left)`;
	return ` ${days <= 14 ? colors.warn(text) : colors.dim(text)}`;
}

/** tRPC v10 puts the structured code on `.data.code`; older shapes use `.code`. */
function trpcCode(err: unknown): string | undefined {
	const e = err as { code?: unknown; data?: { code?: unknown } } | null;
	const code = e?.data?.code ?? e?.code;
	return typeof code === "string" ? code : undefined;
}
