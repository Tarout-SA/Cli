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
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

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

				// A .sa registration needs a Saudi registry application and a
				// supporting document upload that this command cannot collect; the
				// platform refuses the payment without them.
				if (availability.registrationFlow === "saudi") {
					failSpinner();
					throw new CliError(
						`${domainName} needs a Saudi registry application with a supporting document. Register it from the dashboard: https://tarout.sa/dashboard/domains`,
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

				// Detach from the app and keep the domain, so `domains link` can
				// attach it again. This used to delete the route row, which the
				// platform refuses for external domains ("Remove it from the Domains
				// page"): the domain would be left without routing. Removing a domain
				// for good is `tarout domains delete`.
				await client.domain.unlinkFromApplication.mutate({
					domainId: domain.domainId,
				});

				succeedSpinner("Domain unlinked!");

				if (isJsonMode()) {
					outputData({ unlinked: true, domainId: domain.domainId });
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
				if (r.amount !== undefined) log(`  Amount: ${r.amount} SAR`);
				if (r.paymentUrl) log(`  Payment URL: ${colors.cyan(r.paymentUrl)}`);
				log("");
				log("Open the payment URL above to complete the renewal.");
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
