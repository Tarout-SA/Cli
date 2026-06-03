import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerFirewallCommands(program: Command) {
	const fw = program
		.command("firewall")
		.description("Manage firewall templates for cloud servers");

	// List firewall templates
	fw.command("list")
		.alias("ls")
		.description("List all firewall templates")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching firewall templates...");
				const templates = await client.firewallTemplate.list.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(templates);
					return;
				}
				const list = Array.isArray(templates) ? templates : [];
				if (!list.length) {
					log("");
					log("No firewall templates found.");
					log(`Create one with: ${colors.dim("tarout firewall create")}`);
					return;
				}
				log("");
				table(
					["ID", "NAME", "RULES"],
					list.map((t: any) => [
						colors.cyan((t.id || "").slice(0, 8)),
						t.name || "-",
						String(t.rules?.length || t.ruleCount || 0),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get a firewall template
	fw.command("get")
		.argument("<id>", "Firewall template ID")
		.description("Show details of a firewall template")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching firewall template...");
				const tpl = await client.firewallTemplate.get.query({ id } as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(tpl);
					return;
				}
				const t = tpl as any;
				log("");
				log(colors.bold(t.name || "Firewall Template"));
				log(colors.dim(t.id || id));
				log("");
				const rules = t.rules || [];
				if (rules.length) {
					table(
						["PROTOCOL", "PORT RANGE", "DIRECTION", "SOURCE"],
						rules.map((r: any) => [
							r.protocol || "-",
							r.portRange || "-",
							r.direction || "ingress",
							r.sourceRanges || "0.0.0.0/0",
						]),
					);
				} else {
					log("  No rules defined.");
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Create a firewall template
	fw.command("create")
		.description("Create a new firewall template")
		.option("-n, --name <name>", "Template name")
		.option(
			"--rules <json>",
			"JSON array of rules: [{protocol,portRange,direction,sourceRanges}]",
		)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const name =
					options.name ||
					(await input("Template name:", undefined, {
						field: "firewall_template_name",
						flag: "--name",
					}));
				log("");
				log("Add rules interactively (leave protocol empty to finish):");
				const rules: any[] = [];
				for (let i = 0; i < 10; i++) {
					const protocol = await select(
						`Rule ${i + 1} protocol (or skip):`,
						[
							{ name: "TCP", value: "tcp" },
							{ name: "UDP", value: "udp" },
							{ name: "ICMP", value: "icmp" },
							{ name: "Done — no more rules", value: "__done__" },
						],
						{
							field: `firewall_rule_${i}_protocol`,
							flag: "--rules",
							context: { ruleIndex: i },
						},
					);
					if (protocol === "__done__") break;
					const portRange = await input(
						"Port range (e.g. 80 or 8080-8090):",
						undefined,
						{
							field: `firewall_rule_${i}_port_range`,
							flag: "--rules",
							context: { ruleIndex: i },
						},
					);
					const direction = await select(
						"Direction:",
						[
							{ name: "Ingress (inbound)", value: "ingress" },
							{ name: "Egress (outbound)", value: "egress" },
						],
						{
							field: `firewall_rule_${i}_direction`,
							flag: "--rules",
							context: { ruleIndex: i },
						},
					);
					const sourceRanges =
						(await input("Source CIDR (default 0.0.0.0/0):", undefined, {
							field: `firewall_rule_${i}_source_ranges`,
							flag: "--rules",
							context: { ruleIndex: i },
						})) || "0.0.0.0/0";
					rules.push({ protocol, portRange, direction, sourceRanges });
				}
				const client = getApiClient();
				const _spinner = startSpinner("Creating firewall template...");
				const result = await client.firewallTemplate.create.mutate({
					name,
					rules,
				} as any);
				succeedSpinner("Firewall template created!");
				if (isJsonMode()) outputData(result);
				else {
					quietOutput((result as any)?.id || name);
					box("Firewall Template Created", [
						`Name: ${colors.cyan(name)}`,
						`Rules: ${rules.length}`,
					]);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Update a firewall template
	fw.command("update")
		.argument("<id>", "Firewall template ID")
		.description("Update a firewall template name")
		.option("-n, --name <name>", "New template name")
		.action(async (id, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const name =
					options.name ||
					(await input("New name:", undefined, {
						field: "firewall_template_name",
						flag: "--name",
						context: { templateId: id },
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Updating firewall template...");
				const result = await client.firewallTemplate.update.mutate({
					id,
					name,
				} as any);
				succeedSpinner("Firewall template updated!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	// Delete a firewall template
	fw.command("delete")
		.argument("<id>", "Firewall template ID")
		.description("Delete a firewall template")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete firewall template "${id}"?`,
						false,
						{
							field: "confirm_delete_firewall_template",
							flag: "--yes",
							context: { templateId: id },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Deleting firewall template...");
				await client.firewallTemplate.delete.mutate({ id } as any);
				succeedSpinner("Firewall template deleted!");
				if (isJsonMode()) outputData({ deleted: true, id });
			} catch (err) {
				handleError(err);
			}
		});

	// Apply firewall template to a server
	fw.command("apply")
		.argument("<template-id>", "Firewall template ID")
		.argument("<server-id>", "Cloud server ID")
		.description("Apply a firewall template to a cloud server")
		.action(async (templateId, serverId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Applying firewall template...");
				const result = await client.firewallTemplate.applyToServer.mutate({
					id: templateId,
					serverId,
				} as any);
				succeedSpinner("Firewall template applied to server!");
				if (isJsonMode()) outputData(result);
				else {
					log("");
					log(
						colors.success(
							`Template ${templateId} applied to server ${serverId}.`,
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Remove firewall template from a server
	fw.command("remove")
		.argument("<template-id>", "Firewall template ID")
		.argument("<server-id>", "Cloud server ID")
		.description("Remove a firewall template from a cloud server")
		.action(async (templateId, serverId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Remove firewall template from server ${serverId}?`,
						false,
						{
							field: "confirm_remove_firewall_template",
							flag: "--yes",
							context: { templateId, serverId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Removing firewall template...");
				await client.firewallTemplate.removeFromServer.mutate({
					id: templateId,
					serverId,
				} as any);
				succeedSpinner("Firewall template removed from server!");
				if (isJsonMode()) outputData({ removed: true, templateId, serverId });
			} catch (err) {
				handleError(err);
			}
		});

	// List template assignments (which servers have which templates)
	fw.command("assignments")
		.argument("<template-id>", "Firewall template ID")
		.description("List servers that have this firewall template applied")
		.action(async (templateId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching assignments...");
				const result = await client.firewallTemplate.listAssignments.query({
					id: templateId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const list = Array.isArray(result)
					? result
					: (result as any)?.assignments || [];
				if (!list.length) {
					log(`\nNo servers have template "${templateId}" applied.\n`);
					return;
				}
				log("");
				table(
					["SERVER ID", "SERVER NAME", "APPLIED AT"],
					list.map((a: any) => [
						colors.cyan((a.serverId || a.id || "").slice(0, 8)),
						a.serverName || a.name || "-",
						a.appliedAt ? new Date(a.appliedAt).toLocaleDateString() : "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}
