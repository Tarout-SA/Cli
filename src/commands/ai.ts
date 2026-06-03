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
					log(`Create one with: ${colors.dim("tarout ai keys create")}`);
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
		.description("Create a new AI Gateway API key")
		.option("-n, --name <name>", "Key name")
		.option("-m, --model <modelId>", "Model ID")
		.option("-p, --provider <provider>", "Model provider (global)", "global")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let keyName = options.name;
				let modelId = options.model;
				const modelProvider = options.provider || "global";

				if (!keyName) {
					keyName = await input("Key name:", undefined, {
						field: "name",
						flag: "--name",
					});
				}

				if (!modelId) {
					const client = getApiClient();
					try {
						const models = await client.aiGateway.getAvailableModels.query();
						const modelList = Array.isArray(models)
							? models
							: (models as any)?.models || [];
						if (modelList.length > 0) {
							modelId = await select(
								"Select model:",
								modelList.map((m: any) => ({
									name: m.name || m.displayName || m.id || m.modelId,
									value: m.id || m.modelId,
								})),
								{
									field: "model_id",
									flag: "--model",
									context: { keyName },
								},
							);
						}
					} catch {
						// ignore
					}
					if (!modelId) {
						modelId = await input("Model ID (e.g., gpt-4o):", undefined, {
							field: "model_id",
							flag: "--model",
							context: { keyName },
						});
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Creating AI key...");

				const result = await client.aiGateway.generateKey.mutate({
					keyName,
					modelId,
					modelProvider: modelProvider as "global",
				});

				succeedSpinner("AI key created!");

				const keyId = (result as any).keyId || (result as any).id;

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(keyId || keyName);

				box("AI Gateway Key Created", [
					`ID: ${colors.cyan(keyId || "")}`,
					`Name: ${keyName}`,
					`Model: ${modelId}`,
					`Key: ${colors.cyan((result as any).key || (result as any).apiKey || "")}`,
				]);

				log(colors.warn("Save this key — it will not be shown again."));
				log("");
			} catch (err) {
				handleError(err);
			}
		});

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

	// Revoke key
	keys
		.command("revoke")
		.argument("<key-id>", "Key ID to revoke")
		.description("Revoke (disable) an AI Gateway key")
		.action(async (keyId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Revoking key...");

				await client.aiGateway.revokeKey.mutate({ keyId });

				succeedSpinner("Key revoked!");

				if (isJsonMode()) {
					outputData({ revoked: true, keyId });
				} else {
					log("");
					log(
						colors.warn(
							"Key has been revoked and will no longer accept requests.",
						),
					);
					log(
						`Re-enable: ${colors.dim(`tarout ai keys update ${keyId} --enable`)}`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Update key
	keys
		.command("update")
		.argument("<key-id>", "Key ID to update")
		.description("Update an AI Gateway key")
		.option("-n, --name <name>", "New key name")
		.option("--enable", "Enable the key")
		.option("--disable", "Disable the key")
		.action(async (keyId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const updates: Record<string, unknown> = { keyId };
				if (options.name) updates.keyName = options.name;
				if (options.enable) updates.isEnabled = true;
				if (options.disable) updates.isEnabled = false;

				const client = getApiClient();
				const _spinner = startSpinner("Updating key...");

				const result = await client.aiGateway.updateKey.mutate(updates as any);

				succeedSpinner("Key updated!");

				if (isJsonMode()) {
					outputData(result);
				} else {
					log("");
					log(colors.success("Key updated successfully."));
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Delete key
	keys
		.command("delete")
		.argument("<key-id>", "Key ID to delete")
		.description("Permanently delete an AI Gateway key")
		.action(async (keyId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Permanently delete key "${keyId}"?`,
						false,
						{
							field: "confirm_delete_ai_key",
							flag: "--yes",
							context: { keyId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting key...");

				await client.aiGateway.deleteKey.mutate({ keyId });

				succeedSpinner("Key deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, keyId });
				}
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
				const client = getApiClient();
				const _spinner = startSpinner("Creating AI provider...");
				const result = await client.ai.create.mutate({
					name,
					apiUrl,
					apiKey,
				} as any);
				succeedSpinner("AI provider created!");
				if (isJsonMode()) outputData(result);
				else {
					quietOutput((result as any)?.aiId || name);
					box("AI Provider Created", [
						`Name: ${colors.cyan(name)}`,
						`URL: ${apiUrl}`,
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
		.action(async (aiId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Updating AI provider...");
				await client.ai.update.mutate({ aiId, ...options } as any);
				succeedSpinner("AI provider updated!");
				if (isJsonMode()) outputData({ updated: true, aiId });
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
