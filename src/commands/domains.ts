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
	quietOutput,
	shouldSkipConfirmation,
	success,
	table,
} from "../lib/output.js";
import { confirm } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerDomainsCommands(program: Command) {
	const domains = program
		.command("domains")
		.description("Manage custom domains");

	// List domains
	domains
		.command("list")
		.alias("ls")
		.argument("[app]", "Application ID or name (optional)")
		.description("List domains")
		.action(async (appIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching domains...");

				let domainsList: any[];

				if (appIdentifier) {
					// List domains for specific app
					const apps = await client.application.allByOrganization.query();
					const app = findApp(apps, appIdentifier);

					if (!app) {
						failSpinner();
						const suggestions = findSimilar(
							appIdentifier,
							apps.map((a) => a.name),
						);
						throw new NotFoundError("Application", appIdentifier, suggestions);
					}

					const result = await client.domain.byApplicationId.query({
						applicationId: app.applicationId,
					});
					domainsList = result.domains;
				} else {
					// List all domains
					domainsList = await client.domain.all.query({
						includeUnlinked: true,
					});
				}

				succeedSpinner();

				if (isJsonMode()) {
					outputData(domainsList);
					return;
				}

				if (domainsList.length === 0) {
					log("");
					log("No domains found.");
					log("");
					log(
						`Add one with: ${colors.dim("tarout domains add <app> <domain>")}`,
					);
					return;
				}

				log("");
				table(
					["DOMAIN", "APPLICATION", "VERIFIED", "SSL"],
					domainsList.map((d: any) => [
						colors.cyan(d.host),
						d.application?.name || colors.dim("unlinked"),
						d.isVerified ? colors.success("Yes") : colors.warn("No"),
						d.certificateType || colors.dim("-"),
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

	// Add domain to application
	domains
		.command("add")
		.argument("<app>", "Application ID or name")
		.argument("<domain>", "Domain name (e.g., app.example.com)")
		.description("Add a custom domain to an application")
		.action(async (appIdentifier, domainName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				// Validate domain format
				if (!isValidDomain(domainName)) {
					throw new InvalidArgumentError(
						`Invalid domain format: ${domainName}. Use format like: app.example.com`,
					);
				}

				const client = getApiClient();

				// Find the application
				const _spinner = startSpinner("Finding application...");
				const apps = await client.application.allByOrganization.query();
				const app = findApp(apps, appIdentifier);

				if (!app) {
					failSpinner();
					const suggestions = findSimilar(
						appIdentifier,
						apps.map((a) => a.name),
					);
					throw new NotFoundError("Application", appIdentifier, suggestions);
				}

				updateSpinner("Adding domain...");

				// Create domain
				const domain = await client.domain.create.mutate({
					host: domainName,
					applicationId: app.applicationId,
				});

				succeedSpinner("Domain added!");

				if (isJsonMode()) {
					outputData(domain);
					return;
				}

				quietOutput(domain.domainId);

				box("Domain Added", [
					`Domain: ${colors.cyan(domainName)}`,
					`Application: ${app.name}`,
					`Status: ${domain.isVerified ? colors.success("Verified") : colors.warn("Pending verification")}`,
				]);

				if (!domain.isVerified) {
					log("Next steps:");
					log("  1. Add DNS record pointing to your app");
					log(
						`  2. Verify: ${colors.dim(`tarout domains verify ${domain.domainId.slice(0, 8)}`)}`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Remove domain
	domains
		.command("remove")
		.alias("rm")
		.argument("<domain>", "Domain ID or hostname")
		.description("Remove a domain")
		.action(async (domainIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the domain
				const _spinner = startSpinner("Finding domain...");
				const allDomains = await client.domain.all.query({
					includeUnlinked: true,
				});
				const domain = findDomain(allDomains, domainIdentifier);

				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.host),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				succeedSpinner();

				// Confirm deletion
				if (!shouldSkipConfirmation()) {
					log("");
					log(`Domain: ${colors.bold(domain.host)}`);
					if (domain.application) {
						log(`Application: ${domain.application.name}`);
					}
					log("");

					const confirmed = await confirm(
						`Are you sure you want to remove "${domain.host}"?`,
						false,
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Removing domain...");

				await client.domain.delete.mutate({
					domainId: domain.domainId,
				});

				succeedSpinner("Domain removed!");

				if (isJsonMode()) {
					outputData({ deleted: true, domainId: domain.domainId });
				} else {
					quietOutput(domain.domainId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Verify domain
	domains
		.command("verify")
		.argument("<domain>", "Domain ID or hostname")
		.description("Verify domain DNS configuration")
		.action(async (domainIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Find the domain
				const _spinner = startSpinner("Finding domain...");
				const allDomains = await client.domain.all.query({
					includeUnlinked: true,
				});
				const domain = findDomain(allDomains, domainIdentifier);

				if (!domain) {
					failSpinner();
					const suggestions = findSimilar(
						domainIdentifier,
						allDomains.map((d: any) => d.host),
					);
					throw new NotFoundError("Domain", domainIdentifier, suggestions);
				}

				updateSpinner("Verifying DNS configuration...");

				const result = await client.domain.validateDomain.mutate({
					domainId: domain.domainId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");

				if (result.isValid) {
					success(`Domain ${colors.cyan(domain.host)} is verified!`);
					log("");
					log("DNS records are correctly configured.");
				} else {
					error(`Domain ${domain.host} verification failed`);
					log("");
					log("Please ensure DNS is configured correctly:");
					log("");
					log(`  ${colors.bold("Option 1: CNAME Record")}`);
					log(`    Name: ${domain.host}`);
					log(`    Value: ${colors.cyan("your-app.tarout.app")}`);
					log("");
					log(`  ${colors.bold("Option 2: A Record")}`);
					log(`    Name: ${domain.host}`);
					log(`    Value: ${colors.cyan("(your app's IP address)")}`);
					log("");
					log(colors.dim("DNS changes can take up to 48 hours to propagate."));
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}

// Helper functions
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

function findDomain(domains: any[], identifier: string) {
	const lowerIdentifier = identifier.toLowerCase();

	return domains.find(
		(d) =>
			d.domainId === identifier ||
			d.domainId.startsWith(identifier) ||
			d.host.toLowerCase() === lowerIdentifier,
	);
}

function isValidDomain(domain: string): boolean {
	// Basic domain validation
	const pattern =
		/^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
	return pattern.test(domain);
}

function updateSpinner(text: string) {
	// Import dynamically to avoid circular dependency
	import("../utils/spinner.js").then(({ startSpinner }) => {
		startSpinner(text);
	});
}
