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
	table,
} from "../lib/output.js";
import { input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerWhatsappCommands(program: Command) {
	const wa = program
		.command("whatsapp")
		.description("Manage WhatsApp messaging configuration and logs");

	// ── Get config ───────────────────────────────────────────────────────────────
	wa.command("config")
		.description("Show WhatsApp configuration for an environment")
		.option("-e, --env <environment-id>", "Environment ID")
		.action(async (options: { env?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching WhatsApp config...");
				const data = await client.whatsapp.getConfig.query({ environmentId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const c = data as any;
				log("");
				log(colors.bold("WhatsApp Configuration"));
				log(`  Provider:  ${c.provider || "-"}`);
				log(`  Number:    ${c.whatsappNumber || "-"}`);
				log(
					`  Enabled:   ${c.isEnabled ? colors.success("yes") : colors.dim("no")}`,
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Create config ────────────────────────────────────────────────────────────
	wa.command("setup")
		.description("Create WhatsApp configuration")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-p, --provider <provider>", "Provider (twilio, meta)")
		.option("--api-key <key>", "API key / token")
		.option("--number <number>", "WhatsApp business number")
		.option("--enabled", "Enable WhatsApp", true)
		.action(
			async (options: {
				env?: string;
				provider?: string;
				apiKey?: string;
				number?: string;
				enabled?: boolean;
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
							"WhatsApp provider:",
							[
								{ name: "Meta (official)", value: "meta" },
								{ name: "Twilio", value: "twilio" },
							],
							{ field: "whatsapp_provider", flag: "--provider" },
						));
					const apiKey =
						options.apiKey ||
						(await input("API Key / Token:", undefined, {
							field: "api_key",
							flag: "--api-key",
							sensitive: true,
						}));
					const whatsappNumber =
						options.number ||
						(await input(
							"WhatsApp business number (e.g. +1234567890):",
							undefined,
							{ field: "whatsapp_number", flag: "--number" },
						));
					const client = getApiClient();
					const _spinner = startSpinner("Creating WhatsApp config...");
					const result = await client.whatsapp.createConfig.mutate({
						environmentId,
						provider,
						apiKey,
						whatsappNumber,
						isEnabled: options.enabled ?? true,
					} as any);
					succeedSpinner("WhatsApp configuration created.");
					if (isJsonMode()) outputData(result);
					else quietOutput(environmentId);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Update config ────────────────────────────────────────────────────────────
	wa.command("update")
		.description("Update WhatsApp configuration")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-p, --provider <provider>", "New provider")
		.option("--api-key <key>", "New API key")
		.option("--number <number>", "New WhatsApp number")
		.option("--enable", "Enable WhatsApp")
		.option("--disable", "Disable WhatsApp")
		.action(
			async (options: {
				env?: string;
				provider?: string;
				apiKey?: string;
				number?: string;
				enable?: boolean;
				disable?: boolean;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const isEnabled = options.enable
						? true
						: options.disable
							? false
							: undefined;
					const client = getApiClient();
					const _spinner = startSpinner("Updating WhatsApp config...");
					await client.whatsapp.updateConfig.mutate({
						environmentId,
						provider: options.provider,
						apiKey: options.apiKey,
						whatsappNumber: options.number,
						isEnabled,
					} as any);
					succeedSpinner("WhatsApp configuration updated.");
					if (isJsonMode()) outputData({ updated: true, environmentId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Send message ─────────────────────────────────────────────────────────────
	wa.command("send")
		.description("Send a WhatsApp message")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("--to <number>", "Recipient phone number")
		.option("-m, --message <text>", "Message body")
		.option("--template <name>", "Template name")
		.action(
			async (options: {
				env?: string;
				to?: string;
				message?: string;
				template?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const to =
						options.to ||
						(await input("Recipient phone number:", undefined, {
							field: "recipient_phone",
							flag: "--to",
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Sending WhatsApp message...");
					const result = await client.whatsapp.send.mutate({
						environmentId,
						to,
						body: options.message,
						templateName: options.template,
						messageType: options.template ? "template" : "text",
					} as any);
					succeedSpinner("Message sent.");
					if (isJsonMode()) outputData(result);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Logs ─────────────────────────────────────────────────────────────────────
	wa.command("logs")
		.description("View WhatsApp message logs")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-n, --limit <n>", "Number of logs to show", "50")
		.option("--status <status>", "Filter by status")
		.action(
			async (options: { env?: string; limit?: string; status?: string }) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
					const client = getApiClient();
					const _spinner = startSpinner("Fetching logs...");
					const logs = await client.whatsapp.getLogs.query({
						environmentId,
						status: options.status,
						limit: Number.parseInt(options.limit || "50"),
					} as any);
					succeedSpinner();
					if (isJsonMode()) {
						outputData(logs);
						return;
					}
					const list = Array.isArray(logs) ? logs : (logs as any)?.items || [];
					if (list.length === 0) {
						log("No WhatsApp logs found.");
						return;
					}
					log("");
					table(
						["DATE", "TO", "TYPE", "STATUS", "MESSAGE"],
						list.map((l: any) => [
							l.createdAt ? new Date(l.createdAt).toLocaleString() : "-",
							l.to || "-",
							l.messageType || "text",
							l.status === "sent"
								? colors.success(l.status)
								: l.status === "failed"
									? colors.error(l.status)
									: colors.warn(l.status || "-"),
							(l.body || l.message || "-").slice(0, 40),
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
	wa.command("stats")
		.description("Show WhatsApp messaging statistics")
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
				const stats = await client.whatsapp.getStats.query({
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
				log(colors.bold("WhatsApp Statistics"));
				log(`  Total Sent: ${colors.cyan(String(s.total || s.sent || 0))}`);
				log(`  Delivered:  ${colors.success(String(s.delivered || 0))}`);
				log(`  Failed:     ${colors.error(String(s.failed || 0))}`);
				log(`  Read:       ${colors.dim(String(s.read || 0))}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
