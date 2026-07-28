import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError } from "../lib/errors.js";
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
import { ExitCode } from "../utils/exit-codes.js";
import { confirm, input } from "../utils/prompts.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

/**
 * AI Gateway key management over the CLI.
 *
 * These four commands used to be permanent stubs: `aiGateway.generateKey` /
 * `updateKey` / `revokeKey` / `deleteKey` refused every `x-api-key` session, and
 * the CLI has no other transport, so they could never succeed. That refusal is
 * gone — API-key sessions now have the same authority as an interactive session
 * over the organization's own resources (cloud/src/server/lib/session-custody.ts),
 * and a gateway key is a resource, not an auth credential.
 *
 * `aiGateway.generateKey` remains in the platform's EXCLUDED_PROCEDURES, which
 * keeps a one-time secret off the generic `tarout call` / MCP / REST surfaces.
 * That is response hygiene, not an authorization rule, and it does not affect
 * these curated commands — they speak native tRPC.
 */
const KEY_MANAGEMENT_DASHBOARD_URL = "https://tarout.sa/dashboard/ai-models";

export function registerAiCommands(program: Command) {
	const ai = program
		.command("ai")
		.description("Manage AI Gateway models and API keys");

	// List available models
	ai.command("models")
		.description("List available AI models")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching AI models...");

				const models = await client.aiGateway.getAvailableModels.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(models);
					return;
				}

				const modelList = Array.isArray(models)
					? models
					: (models as any)?.models || [];

				if (!modelList.length) {
					log("");
					log("No AI models available.");
					return;
				}

				// Quiet mode: emit one model id per line (this list doesn't use
				// table(), so there is no automatic quiet rendering).
				for (const model of modelList) {
					quietOutput(String(model.id || model.modelId || ""));
				}

				log("");
				log(colors.bold("Available AI Models"));
				log("");

				for (const model of modelList) {
					const id = model.id || model.modelId || "";
					const name = model.name || model.displayName || id;
					const provider = model.provider || model.modelProvider || "";
					const desc = model.description || "";
					log(`  ${colors.cyan(id)}`);
					if (name !== id) log(`    Name: ${name}`);
					if (provider) log(`    Provider: ${provider}`);
					if (desc) log(`    ${colors.dim(desc)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Check provider availability
	ai.command("status")
		.description("Check AI provider availability")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Checking provider status...");

				const status = await client.aiGateway.checkProviderAvailability.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(status);
					return;
				}

				log("");
				log(colors.bold("AI Provider Status"));
				log("");
				for (const [region, available] of Object.entries(status || {})) {
					log(
						`  ${region}: ${available ? colors.success("available") : colors.error("unavailable")}`,
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// AI keys subgroup
	const keys = ai.command("keys").description("Manage AI Gateway API keys");

	// List keys
	keys
		.command("list")
		.alias("ls")
		.description("List AI Gateway API keys")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching AI keys...");

				const keyList = await client.aiGateway.listKeys.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(keyList);
					return;
				}

				const items = Array.isArray(keyList) ? keyList : [];

				if (!items.length) {
					log("");
					log("No AI Gateway keys found.");
					log("");
					// Not `tarout ai keys create` — that command cannot work over an
					// API-key session (see the guard note at the top of this file).
					log(`Create one at: ${colors.dim(KEY_MANAGEMENT_DASHBOARD_URL)}`);
					return;
				}

				log("");
				table(
					["ID", "NAME", "MODEL", "ENABLED", "CREATED"],
					items.map((k: any) => [
						colors.cyan((k.keyId || k.id || "").slice(0, 8)),
						k.keyName || k.name || "",
						k.modelId || k.model || "",
						k.isEnabled || k.enabled
							? colors.success("yes")
							: colors.error("no"),
						formatDate(k.createdAt),
					]),
				);
				log("");
				log(colors.dim(`${items.length} key${items.length === 1 ? "" : "s"}`));
			} catch (err) {
				handleError(err);
			}
		});

	// Create key
	keys
		.command("create")
		.description("Create an AI Gateway API key")
		.option("-n, --name <name>", "Key name")
		.option("-m, --model <modelId>", "Model ID")
		.option("-p, --provider <provider>", "Model provider (global|saudi)", "global")
		.option(
			"--monthly-cap <sar>",
			"Monthly spend ceiling in SAR (0 or omitted = no cap)",
		)
		.action(
			async (options: {
				name?: string;
				model?: string;
				provider?: string;
				monthlyCap?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					const keyName =
						options.name ?? (await input("Key name (e.g., production):"));
					const modelId =
						options.model ?? (await input("Model ID (e.g., gpt-4o):"));

					const provider = (options.provider ?? "global").toLowerCase();
					if (provider !== "global" && provider !== "saudi") {
						throw new CliError(
							`Invalid provider "${options.provider}". Use "global" or "saudi".`,
							ExitCode.INVALID_ARGUMENTS,
						);
					}

					// The API takes halalas (1 SAR = 100 halalas); the flag takes SAR
					// because that is what the dashboard and invoices show.
					let monthlySpendCapHalalas: number | undefined;
					if (options.monthlyCap !== undefined) {
						const sar = Number(options.monthlyCap);
						if (!Number.isFinite(sar) || sar < 0) {
							throw new CliError(
								`Invalid --monthly-cap "${options.monthlyCap}". Pass a non-negative number of SAR.`,
								ExitCode.INVALID_ARGUMENTS,
							);
						}
						monthlySpendCapHalalas = Math.round(sar * 100);
					}

					const client = getApiClient();
					const _spinner = startSpinner("Creating AI Gateway key...");

					const result = await client.aiGateway.generateKey.mutate({
						keyName,
						modelId,
						modelProvider: provider,
						...(monthlySpendCapHalalas === undefined
							? {}
							: { monthlySpendCapHalalas }),
					});

					succeedSpinner("AI Gateway key created.");

					if (isJsonMode()) {
						outputData(result);
						return;
					}

					const secret = (result as any).apiKey ?? (result as any).key ?? "";
					quietOutput(String((result as any).keyId ?? ""));

					log("");
					box("AI Gateway key created", [
						`Name: ${colors.bold(keyName)}`,
						`Model: ${colors.bold(modelId)}`,
						`Provider: ${colors.bold(provider)}`,
						...(secret ? [`Key: ${colors.cyan(secret)}`] : []),
					]);
					if (secret) {
						log(colors.warn("Save this key — it will not be shown again."));
					}
					log("");
				} catch (err) {
					handleError(err);
				}
			},
		);

	// Get key details
	keys
		.command("info")
		.argument("<key-id>", "Key ID")
		.description("Show AI Gateway key details")
		.action(async (keyId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching key details...");

				const key = await client.aiGateway.getKeyDetails.query({ keyId });

				succeedSpinner();

				if (isJsonMode()) {
					outputData(key);
					return;
				}

				quietOutput(String((key as any).keyId || keyId));

				log("");
				log(colors.bold((key as any).keyName || (key as any).name || keyId));
				log(colors.dim((key as any).keyId || keyId));
				log("");
				log(`  Model: ${(key as any).modelId || "-"}`);
				log(`  Provider: ${(key as any).modelProvider || "-"}`);
				log(
					`  Status: ${(key as any).isEnabled !== false ? colors.success("enabled") : colors.error("disabled")}`,
				);
				if ((key as any).expiresAt) {
					log(`  Expires: ${formatDate((key as any).expiresAt)}`);
				}
				log(`  Created: ${formatDate((key as any).createdAt)}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Key usage
	keys
		.command("usage")
		.argument("<key-id>", "Key ID")
		.description("Show usage statistics for an AI key")
		.option("-d, --days <days>", "Days of history", "7")
		.action(async (keyId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching usage...");

				const data = await client.aiGateway.getKeyUsage.query({
					keyId,
					days: Number.parseInt(options.days) || 7,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				log("");
				log(colors.bold(`Key Usage — last ${options.days} days`));
				log("");

				const agg = (data as any).aggregated;
				if (agg) {
					log(
						`  Total requests: ${colors.cyan(String(agg.totalRequests || 0))}`,
					);
					log(`  Total tokens: ${colors.cyan(String(agg.totalTokens || 0))}`);
					log(
						`  Cost: ${colors.cyan(`${(Number(agg.totalCostHalalas || agg.totalCost || 0) / 100).toFixed(4)} SAR`)}`,
					);
				}

				const history = (data as any).history;
				if (history && history.length > 0) {
					log("");
					table(
						["DATE", "REQUESTS", "TOKENS", "COST SAR"],
						history
							.slice(0, 10)
							.map((h: any) => [
								formatDate(h.date || h.timestamp),
								String(h.requests || h.requestCount || 0),
								String(h.tokens || h.totalTokens || 0),
								(Number(h.costHalalas || h.cost || 0) / 100).toFixed(4),
							]),
					);
				}

				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Revoke: disables the key server-side. Destructive, so it confirms unless
	// --yes / --json (shouldSkipConfirmation) says otherwise.
	keys
		.command("revoke")
		.argument("<key-id>", "Key ID to revoke")
		.description("Revoke an AI Gateway key")
		.action(async (keyId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Revoke AI Gateway key ${keyId}? Applications using it will start failing.`,
						false,
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Revoking key...");
				await client.aiGateway.revokeKey.mutate({ keyId });
				succeedSpinner("Key revoked.");

				if (isJsonMode()) {
					outputData({ revoked: true, keyId });
					return;
				}
				quietOutput(keyId);
			} catch (err) {
				handleError(err);
			}
		});

	keys
		.command("update")
		.argument("<key-id>", "Key ID to update")
		.description("Rename, enable, or disable an AI Gateway key")
		.option("-n, --name <name>", "New key name")
		.option("--enable", "Enable the key")
		.option("--disable", "Disable the key")
		.option(
			"--monthly-cap <sar>",
			"Monthly spend ceiling in SAR (0 clears the cap)",
		)
		.action(
			async (
				keyId: string,
				options: {
					name?: string;
					enable?: boolean;
					disable?: boolean;
					monthlyCap?: string;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					if (options.enable && options.disable) {
						throw new CliError(
							"Pass either --enable or --disable, not both.",
							ExitCode.INVALID_ARGUMENTS,
						);
					}

					let monthlySpendCapHalalas: number | null | undefined;
					if (options.monthlyCap !== undefined) {
						const sar = Number(options.monthlyCap);
						if (!Number.isFinite(sar) || sar < 0) {
							throw new CliError(
								`Invalid --monthly-cap "${options.monthlyCap}". Pass a non-negative number of SAR.`,
								ExitCode.INVALID_ARGUMENTS,
							);
						}
						monthlySpendCapHalalas = sar === 0 ? null : Math.round(sar * 100);
					}

					const isEnabled = options.enable
						? true
						: options.disable
							? false
							: undefined;

					if (
						options.name === undefined &&
						isEnabled === undefined &&
						monthlySpendCapHalalas === undefined
					) {
						throw new CliError(
							"Nothing to update. Pass --name, --enable/--disable, or --monthly-cap.",
							ExitCode.INVALID_ARGUMENTS,
						);
					}

					const client = getApiClient();
					const _spinner = startSpinner("Updating key...");
					const result = await client.aiGateway.updateKey.mutate({
						keyId,
						...(options.name === undefined ? {} : { keyName: options.name }),
						...(isEnabled === undefined ? {} : { isEnabled }),
						...(monthlySpendCapHalalas === undefined
							? {}
							: { monthlySpendCapHalalas }),
					});
					succeedSpinner("Key updated.");

					if (isJsonMode()) {
						outputData(result);
						return;
					}
					quietOutput(keyId);
				} catch (err) {
					handleError(err);
				}
			},
		);

	keys
		.command("delete")
		.argument("<key-id>", "Key ID to delete")
		.description("Permanently delete an AI Gateway key")
		.action(async (keyId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Permanently delete AI Gateway key ${keyId}? This cannot be undone.`,
						false,
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting key...");
				await client.aiGateway.deleteKey.mutate({ keyId });
				succeedSpinner("Key deleted.");

				if (isJsonMode()) {
					outputData({ deleted: true, keyId });
					return;
				}
				quietOutput(keyId);
			} catch (err) {
				handleError(err);
			}
		});

	// Organization usage
	ai.command("usage")
		.description("Show organization-wide AI Gateway usage")
		.option("-d, --days <days>", "Days of history", "30")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching usage...");

				const data = await client.aiGateway.getOrganizationUsage.query({
					days: Number.parseInt(options.days) || 30,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				log("");
				log(colors.bold(`Organization AI Usage — last ${options.days} days`));
				log("");

				const d = data as any;
				if (d.totalRequests !== undefined)
					log(`  Total requests: ${colors.cyan(String(d.totalRequests))}`);
				if (d.totalTokens !== undefined)
					log(`  Total tokens: ${colors.cyan(String(d.totalTokens))}`);
				if (d.totalCostHalalas !== undefined || d.totalCost !== undefined) {
					const halalas = d.totalCostHalalas ?? d.totalCost ?? 0;
					log(
						`  Total cost: ${colors.cyan(`${(Number(halalas) / 100).toFixed(4)} SAR`)}`,
					);
				}

				const models = d.byModel || d.models || [];
				if (models.length > 0) {
					log("");
					log(colors.bold("By model:"));
					table(
						["MODEL", "REQUESTS", "TOKENS", "COST SAR"],
						models
							.slice(0, 10)
							.map((m: any) => [
								m.modelId || m.model || "-",
								String(m.requests || m.requestCount || 0),
								String(m.tokens || m.totalTokens || 0),
								(Number(m.costHalalas || m.cost || 0) / 100).toFixed(4),
							]),
					);
				}

				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── AI Provider Configurations (client.ai.*) ────────────────────────────────

	const aiProvider = ai
		.command("provider")
		.description("Manage custom AI provider configurations");

	aiProvider
		.command("list")
		.alias("ls")
		.description("List custom AI provider configurations")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching AI providers...");
				const providers = await client.ai.getAll.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(providers);
					return;
				}
				const list = Array.isArray(providers)
					? providers
					: (providers as any)?.providers || [];
				if (!list.length) {
					log("\nNo AI provider configurations found.\n");
					return;
				}
				log("");
				table(
					["ID", "NAME", "URL"],
					list.map((p: any) => [
						colors.cyan((p.aiId || p.id || "").slice(0, 8)),
						p.name || "-",
						p.apiUrl || p.url || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	aiProvider
		.command("get")
		.argument("<id>", "AI configuration ID")
		.description("Get details of an AI provider configuration")
		.action(async (aiId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching AI provider...");
				const p = await client.ai.one.query({ aiId } as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(p);
					return;
				}
				const prov = p as any;
				quietOutput(String(prov.aiId || prov.id || aiId));
				log("");
				log(colors.bold(prov.name || "AI Provider"));
				log(`  ID:  ${colors.dim(aiId)}`);
				log(`  URL: ${prov.apiUrl || prov.url || "-"}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	aiProvider
		.command("get-by-config")
		.argument("<config-id>", "Configuration ID")
		.description("Get an AI configuration by config ID")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching AI config...");
				const p = await client.ai.get.query({ id } as any);
				succeedSpinner();
				if (isJsonMode()) outputData(p);
				else {
					const prov = p as any;
					quietOutput(String(prov.aiId || prov.id || id));
					log(
						`\n${colors.bold(prov.name || "AI Config")}: ${prov.apiUrl || "-"}\n`,
					);
				}
			} catch (err) {
				handleError(err);
			}
		});

	aiProvider
		.command("get-models")
		.argument("<api-url>", "Provider API URL")
		.argument("<api-key>", "Provider API key")
		.description("Get available models from a custom AI provider")
		.action(async (apiUrl, apiKey) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching models...");
				const models = await client.ai.getModels.query({
					apiUrl,
					apiKey,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(models);
					return;
				}
				const list = Array.isArray(models)
					? models
					: (models as any)?.models || [];
				if (!list.length) {
					log("\nNo models found.\n");
					return;
				}
				log("");
				table(
					["MODEL ID", "NAME"],
					list.map((m: any) => [
						colors.cyan(m.id || m.modelId || "-"),
						m.name || m.id || "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	aiProvider
		.command("create")
		.description("Create a custom AI provider configuration (org owner only)")
		.option("--name <name>", "Provider name")
		.option("--url <url>", "Provider API URL")
		.option("--key <key>", "Provider API key")
		.option("--model <model>", "Default model (e.g. gpt-4o)")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const name =
					options.name ||
					(await input("Provider name:", undefined, {
						field: "name",
						flag: "--name",
					}));
				const apiUrl =
					options.url ||
					(await input("Provider API URL:", undefined, {
						field: "api_url",
						flag: "--url",
					}));
				const apiKey =
					options.key ||
					(await input("Provider API key:", undefined, {
						field: "api_key",
						flag: "--key",
						sensitive: true,
					}));
				// apiCreateAi requires `model` — prompt when not supplied.
				const model =
					options.model ||
					(await input("Default model (e.g. gpt-4o):", undefined, {
						field: "model",
						flag: "--model",
						context: { name },
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Creating AI provider...");
				const result = await client.ai.create.mutate({
					name,
					apiUrl,
					apiKey,
					model,
				} as any);
				succeedSpinner("AI provider created!");
				if (isJsonMode()) outputData(result);
				else {
					quietOutput((result as any)?.aiId || name);
					box("AI Provider Created", [
						`Name: ${colors.cyan(name)}`,
						`URL: ${apiUrl}`,
						`Model: ${model}`,
					]);
				}
			} catch (err) {
				handleError(err);
			}
		});

	aiProvider
		.command("update")
		.argument("<id>", "AI configuration ID")
		.description("Update a custom AI provider configuration")
		.option("--name <name>", "New name")
		.option("--url <url>", "New API URL")
		.option("--key <key>", "New API key")
		.option("--model <model>", "New default model")
		.action(async (aiId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Updating AI provider...");
				// apiUpdateAi expects apiUrl/apiKey (not url/key) — map the flags so
				// they aren't silently dropped by Zod.
				const payload: Record<string, unknown> = { aiId };
				if (options.name !== undefined) payload.name = options.name;
				if (options.url !== undefined) payload.apiUrl = options.url;
				if (options.key !== undefined) payload.apiKey = options.key;
				if (options.model !== undefined) payload.model = options.model;
				await client.ai.update.mutate(payload as any);
				succeedSpinner("AI provider updated!");
				if (isJsonMode()) outputData({ updated: true, aiId });
				else quietOutput(aiId);
			} catch (err) {
				handleError(err);
			}
		});

	aiProvider
		.command("delete")
		.argument("<id>", "AI configuration ID")
		.description("Delete a custom AI provider configuration")
		.action(async (aiId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Delete AI provider configuration "${aiId}"?`,
						false,
						{
							field: "confirm_delete_ai_provider",
							flag: "--yes",
							context: { aiId },
						},
					);
					if (!ok) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Deleting AI provider...");
				await client.ai.delete.mutate({ aiId } as any);
				succeedSpinner("AI provider deleted!");
				if (isJsonMode()) outputData({ deleted: true, aiId });
				else quietOutput(aiId);
			} catch (err) {
				handleError(err);
			}
		});
}

function formatDate(date: string | Date | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
