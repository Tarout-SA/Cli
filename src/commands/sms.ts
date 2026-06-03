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

export function registerSmsCommands(program: Command) {
	const sms = program
		.command("sms")
		.description("Manage SMS messaging configuration and logs");

	// ── Get config ───────────────────────────────────────────────────────────────
	sms
		.command("config")
		.description("Show SMS configuration for an environment")
		.option("-e, --env <environment-id>", "Environment ID")
		.action(async (options: { env?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching SMS config...");
				const data = await client.sms.getConfig.query({ environmentId });
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const c = data as any;
				log("");
				log(colors.bold("SMS Configuration"));
				log(`  Provider:    ${c.provider || "-"}`);
				log(`  From Number: ${c.fromNumber || "-"}`);
				log(
					`  Enabled:     ${c.isEnabled ? colors.success("yes") : colors.dim("no")}`,
				);
				log(`  Env ID:      ${colors.dim(environmentId)}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Create config ────────────────────────────────────────────────────────────
	sms
		.command("setup")
		.description("Create SMS configuration for an environment")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-p, --provider <provider>", "SMS provider (twilio, vonage, sinch)")
		.option("--api-key <key>", "API key / Account SID")
		.option("--api-secret <secret>", "API secret / Auth token")
		.option("--from <number>", "From phone number")
		.option("--enabled", "Enable SMS sending", true)
		.action(
			async (options: {
				env?: string;
				provider?: string;
				apiKey?: string;
				apiSecret?: string;
				from?: string;
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
							"SMS provider:",
							[
								{ name: "Twilio", value: "twilio" },
								{ name: "Vonage", value: "vonage" },
								{ name: "Sinch", value: "sinch" },
							],
							{ field: "sms_provider", flag: "--provider" },
						));
					const apiKey =
						options.apiKey ||
						(await input("API Key / Account SID:", undefined, {
							field: "api_key",
							flag: "--api-key",
							sensitive: true,
						}));
					const apiSecret =
						options.apiSecret ||
						(await input("API Secret / Auth Token:", undefined, {
							field: "api_secret",
							flag: "--api-secret",
							sensitive: true,
						}));
					const fromNumber =
						options.from ||
						(await input(
							"From phone number (e.g. +1234567890):",
							undefined,
							{ field: "from_number", flag: "--from" },
						));
					const client = getApiClient();
					const _spinner = startSpinner("Creating SMS config...");
					const result = await client.sms.createConfig.mutate({
						environmentId,
						provider,
						apiKey,
						apiSecret,
						fromNumber,
						isEnabled: options.enabled ?? true,
					} as any);
					succeedSpinner("SMS configuration created.");
					if (isJsonMode()) outputData(result);
					else quietOutput(environmentId);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Update config ────────────────────────────────────────────────────────────
	sms
		.command("update")
		.description("Update SMS configuration")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-p, --provider <provider>", "New provider")
		.option("--api-key <key>", "New API key")
		.option("--api-secret <secret>", "New API secret")
		.option("--from <number>", "New from number")
		.option("--enable", "Enable SMS")
		.option("--disable", "Disable SMS")
		.action(
			async (options: {
				env?: string;
				provider?: string;
				apiKey?: string;
				apiSecret?: string;
				from?: string;
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
					const _spinner = startSpinner("Updating SMS config...");
					await client.sms.updateConfig.mutate({
						environmentId,
						provider: options.provider,
						apiKey: options.apiKey,
						apiSecret: options.apiSecret,
						fromNumber: options.from,
						isEnabled,
					} as any);
					succeedSpinner("SMS configuration updated.");
					if (isJsonMode()) outputData({ updated: true, environmentId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Send SMS ─────────────────────────────────────────────────────────────────
	sms
		.command("send")
		.description("Send an SMS message")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("--to <number>", "Recipient phone number")
		.option("-m, --message <text>", "Message body")
		.action(
			async (options: { env?: string; to?: string; message?: string }) => {
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
					const body =
						options.message ||
						(await input("Message:", undefined, {
							field: "message_body",
							flag: "--message",
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Sending SMS...");
					const result = await client.sms.send.mutate({
						environmentId,
						to,
						body,
					} as any);
					succeedSpinner("SMS sent.");
					if (isJsonMode()) outputData(result);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Logs ─────────────────────────────────────────────────────────────────────
	sms
		.command("logs")
		.description("View SMS message logs")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("-n, --limit <n>", "Number of logs to show", "50")
		.option("--status <status>", "Filter by status (sent, failed, pending)")
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
					const logs = await client.sms.getLogs.query({
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
						log("No SMS logs found.");
						return;
					}
					log("");
					table(
						["DATE", "TO", "STATUS", "MESSAGE"],
						list.map((l: any) => [
							l.createdAt ? new Date(l.createdAt).toLocaleString() : "-",
							l.to || "-",
							l.status === "sent"
								? colors.success(l.status)
								: l.status === "failed"
									? colors.error(l.status)
									: colors.warn(l.status || "-"),
							(l.body || l.message || "-").slice(0, 50),
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
	sms
		.command("stats")
		.description("Show SMS sending statistics")
		.option("-e, --env <environment-id>", "Environment ID")
		.option("--start <date>", "Start date (ISO format)")
		.option("--end <date>", "End date (ISO format)")
		.action(async (options: { env?: string; start?: string; end?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const environmentId = options.env || (await input("Environment ID:", undefined, {
						field: "environment_id",
						flag: "--env",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Fetching stats...");
				const stats = await client.sms.getStats.query({
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
				log(colors.bold("SMS Statistics"));
				log(`  Total Sent:   ${colors.cyan(String(s.total || s.sent || 0))}`);
				log(`  Delivered:    ${colors.success(String(s.delivered || 0))}`);
				log(`  Failed:       ${colors.error(String(s.failed || 0))}`);
				log(`  Pending:      ${colors.warn(String(s.pending || 0))}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
