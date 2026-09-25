import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, CliError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	isQuietMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
	warn,
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
 * gone: API-key sessions now have the same authority as an interactive session
 * over the organization's own resources (cloud/src/server/lib/session-custody.ts),
 * and a gateway key is a resource, not an auth credential.
 *
 * `aiGateway.generateKey` remains in the platform's EXCLUDED_PROCEDURES, which
 * keeps a one-time secret off the generic `tarout call` / MCP / REST surfaces.
 * That is response hygiene, not an authorization rule, and it does not affect
 * these curated commands; they speak native tRPC.
 *
 * Gateway keys are not tied to a model. One key calls every model in the
 * catalog and each request picks one with its `model` field, so `keys create`
 * takes no model. Keys created while keys were pinned may still report a
 * `modelId`; it is informational and no longer restricts what the key calls.
 */
const KEY_MANAGEMENT_DASHBOARD_URL =
	"https://tarout.sa/dashboard/ai-models/keys";

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

				const catalog = await client.aiGateway.getAvailableModels.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(catalog);
					return;
				}

				const modelList = flattenModelCatalog(catalog);
				if (!modelList.length) {
					log("");
					log("No AI models available.");
					return;
				}

				// Quiet mode: one callable model id per line. table()'s own quiet
				// rendering would print every row, unavailable models included.
				if (isQuietMode()) {
					for (const model of modelList) {
						if (model.available) quietOutput(model.id);
					}
					return;
				}

				log("");
				// Prices are what the customer pays (markup included), in USD per
				// million tokens, exactly as the catalog reports them. Usage is
				// billed in SAR; `tarout ai usage` shows spend in SAR.
				table(
					["MODEL", "NAME", "REGION", "CONTEXT", "IN $/1M", "OUT $/1M", "STATUS"],
					modelList.map((model) => [
						colors.cyan(model.id),
						model.name,
						model.region,
						model.contextWindow ? model.contextWindow.toLocaleString("en-US") : "-",
						formatUsd(model.input),
						formatUsd(model.output),
						model.available
							? colors.success("available")
							: colors.error("unavailable"),
					]),
				);
				log("");
				log(
					colors.dim(
						"Any key calls any available model: set `model` in each request. Aliases (glm, gpt-oss-local, ...) also work.",
					),
				);
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
					log(
						`Create one with: ${colors.cyan("tarout ai keys create --name <name>")}`,
					);
					log(`Or in the dashboard: ${colors.dim(KEY_MANAGEMENT_DASHBOARD_URL)}`);
					return;
				}

				log("");
				// No MODEL column: a key is not tied to a model.
				table(
					["ID", "NAME", "ENABLED", "CREATED"],
					items.map((k: any) => [
						// Full id: every other key command takes the complete id.
						colors.cyan(k.id || k.keyId || ""),
						k.keyName || k.name || "",
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
		.description("Create an AI Gateway API key that works with every model")
		.option("-n, --name <name>", "Key name")
		// Deprecated: keys used to be pinned to one model. Both flags still parse
		// so older scripts keep running, but they only warn and are never sent.
		// --provider has no default, or the warning would fire on every run.
		.option(
			"-m, --model <modelId>",
			"Deprecated and ignored: keys work with every model; set model per request",
		)
		.option(
			"-p, --provider <provider>",
			"Deprecated and ignored: keys work with every model; set model per request",
		)
		.option(
			"--monthly-cap <sar>",
			"Monthly credit limit in SAR (0 or omitted = no limit)",
		)
		.option(
			"--expires <when>",
			"Expiry: a number of days (30), an ISO date (2026-12-31), or never",
		)
		.action(
			async (options: {
				name?: string;
				model?: string;
				provider?: string;
				monthlyCap?: string;
				expires?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					if (options.model !== undefined || options.provider !== undefined) {
						warn(
							"--model and --provider are deprecated and ignored: AI Gateway keys now work with every model. Pass `model` in each request instead.",
						);
					}

					const keyName =
						options.name ?? (await input("Key name (e.g., production):"));

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

					const expiresAt =
						options.expires === undefined
							? undefined
							: parseExpires(options.expires);

					const client = getApiClient();
					const _spinner = startSpinner("Creating AI Gateway key...");

					const result = await client.aiGateway.generateKey.mutate({
						keyName,
						...(monthlySpendCapHalalas === undefined
							? {}
							: { monthlySpendCapHalalas }),
						...(expiresAt ? { expiresAt } : {}),
					});

					succeedSpinner("AI Gateway key created.");

					if (isJsonMode()) {
						outputData(result);
						return;
					}

					const secret = (result as any).apiKey ?? (result as any).key ?? "";
					quietOutput(String((result as any).id ?? (result as any).keyId ?? ""));

					log("");
					box("AI Gateway key created", [
						`Name: ${colors.bold(keyName)}`,
						`ID: ${(result as any).id ?? (result as any).keyId ?? ""}`,
						...(monthlySpendCapHalalas
							? [`Monthly credit limit: ${colors.bold(`${(monthlySpendCapHalalas / 100).toFixed(2)} SAR`)}`]
							: []),
						...(expiresAt ? [`Expires: ${formatDate(expiresAt)}`] : []),
						...(secret ? [`Key: ${colors.cyan(secret)}`] : []),
						`Models: every model in the catalog (see ${colors.cyan("tarout ai models")})`,
					]);
					if (secret) {
						log(colors.warn("Save this key now. It will not be shown again."));
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
				// Only keys created while keys were pinned still carry a model. It is shown
				// for reference and no longer limits what the key can call.
				if ((key as any).modelId) {
					log(
						`  Model: ${(key as any).modelId} ${colors.dim("(legacy, not enforced)")}`,
					);
					if ((key as any).modelProvider) {
						log(`  Provider: ${(key as any).modelProvider}`);
					}
				}
				log(
					`  Status: ${(key as any).isEnabled !== false ? colors.success("enabled") : colors.error("disabled")}`,
				);
				if ((key as any).monthlySpendCapHalalas) {
					log(
						`  Monthly credit limit: ${(Number((key as any).monthlySpendCapHalalas) / 100).toFixed(2)} SAR`,
					);
				}
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

				const days = clampDays(options.days, 7);
				if (isJsonMode()) {
					const data = await client.aiGateway.getKeyUsage.query({ keyId, days });
					succeedSpinner();
					outputData(data);
					return;
				}

				// Activity is what the dashboard shows: the same window, the same
				// SAR amounts. getKeyUsage mixes an all-time total with a windowed
				// history and reports cost in USD.
				const activity = (await client.aiGateway.getActivity.query({
					days,
					keyId,
				})) as ActivityData;

				succeedSpinner();

				log("");
				log(colors.bold(`Key usage: last ${activity.days ?? days} days`));
				log("");
				printActivityTotals(activity);

				const perDay = dailyTotals(activity.daily ?? []);
				if (perDay.length > 0) {
					log("");
					table(
						["DATE", "REQUESTS", "TOKENS", "COST SAR"],
						perDay
							.slice(-10)
							.map((day) => [
								day.date,
								String(day.requests),
								String(day.tokens),
								formatSar(day.costHalalas),
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
		.description(
			"Revoke an AI Gateway key permanently (unlike --disable, it cannot be re-enabled)",
		)
		.action(async (keyId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Revoke AI Gateway key ${keyId}? Applications using it will start failing, and a revoked key can never be re-enabled.`,
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
		.description(
			"Rename, enable or disable, cap, or change the expiry of an AI Gateway key",
		)
		.option("-n, --name <name>", "New key name")
		.option("--enable", "Enable the key")
		.option("--disable", "Disable the key")
		.option(
			"--monthly-cap <sar>",
			"Monthly spend ceiling in SAR (0 clears the cap)",
		)
		.option(
			"--expires <when>",
			"New expiry: a number of days, an ISO date, or never (clears it)",
		)
		.action(
			async (
				keyId: string,
				options: {
					name?: string;
					enable?: boolean;
					disable?: boolean;
					monthlyCap?: string;
					expires?: string;
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

					const expiresAt =
						options.expires === undefined
							? undefined
							: parseExpires(options.expires);

					if (
						options.name === undefined &&
						isEnabled === undefined &&
						monthlySpendCapHalalas === undefined &&
						expiresAt === undefined
					) {
						throw new CliError(
							"Nothing to update. Pass --name, --enable/--disable, --monthly-cap, or --expires.",
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
						...(expiresAt === undefined ? {} : { expiresAt }),
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
		.description(
			"Delete an AI Gateway key (it stops working; its usage history is kept)",
		)
		.action(async (keyId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const ok = await confirm(
						`Delete AI Gateway key ${keyId}? It stops working immediately. Its usage history stays in Activity.`,
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

				const days = clampDays(options.days, 30);
				if (isJsonMode()) {
					const data = await client.aiGateway.getOrganizationUsage.query({
						days,
					});
					succeedSpinner();
					outputData(data);
					return;
				}

				const activity = (await client.aiGateway.getActivity.query({
					days,
				})) as ActivityData;

				succeedSpinner();

				log("");
				log(colors.bold(`Organization AI usage: last ${activity.days ?? days} days`));
				log("");
				printActivityTotals(activity);

				const models = activity.byModel ?? [];
				if (models.length > 0) {
					log("");
					log(colors.bold("By model:"));
					table(
						["MODEL", "REQUESTS", "TOKENS", "COST SAR"],
						models
							.slice(0, 10)
							.map((m) => [
								m.modelId,
								String(m.requests),
								String(m.promptTokens + m.completionTokens),
								formatSar(m.costHalalas),
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
				// apiCreateAi requires `model`, so prompt when not supplied.
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
				// apiUpdateAi expects apiUrl/apiKey (not url/key); map the flags so
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

interface CatalogModel {
	id: string;
	name?: string;
	region?: string;
	contextWindow?: number;
	providerStatus?: string;
	costPer1MTokens?: { input: number | null; output: number | null };
}

interface ListedModel {
	id: string;
	name: string;
	region: string;
	contextWindow: number;
	input: number | null;
	output: number | null;
	available: boolean;
}

/**
 * `aiGateway.getAvailableModels` returns the catalog per product
 * (`{ global: { isEnabled, models }, saudi: {...} }`). The CLI used to expect a
 * flat array and printed "No AI models available" for every account.
 */
export function flattenModelCatalog(catalog: unknown): ListedModel[] {
	if (!catalog || typeof catalog !== "object") return [];
	const products = Array.isArray(catalog)
		? [{ isEnabled: true, models: catalog }]
		: Object.values(catalog as Record<string, unknown>);
	const rows: ListedModel[] = [];
	for (const product of products) {
		if (!product || typeof product !== "object") continue;
		const { models, isEnabled } = product as {
			models?: CatalogModel[];
			isEnabled?: boolean;
		};
		for (const model of models ?? []) {
			if (!model?.id) continue;
			rows.push({
				id: model.id,
				name: model.name ?? model.id,
				region: model.region === "saudi" ? "Saudi Arabia" : "Global",
				contextWindow: model.contextWindow ?? 0,
				input: model.costPer1MTokens?.input ?? null,
				output: model.costPer1MTokens?.output ?? null,
				available:
					isEnabled !== false && (model.providerStatus ?? "available") === "available",
			});
		}
	}
	return rows;
}

function formatUsd(value: number | null): string {
	return value === null ? "-" : `$${value.toFixed(2)}`;
}

function formatSar(halalas: number): string {
	return (Number(halalas || 0) / 100).toFixed(4);
}

function clampDays(raw: string | undefined, fallback: number): number {
	const days = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(days) || days < 1) return fallback;
	return Math.min(days, 90);
}

/**
 * `--expires 30` (days from now), `--expires 2026-12-31` (ISO date), or
 * `--expires never`. `never` returns null, which clears an expiry on update.
 */
export function parseExpires(raw: string): Date | null {
	const value = raw.trim().toLowerCase();
	if (value === "never" || value === "none") return null;
	if (/^\d+$/.test(value)) {
		const days = Number(value);
		if (days < 1) {
			throw new CliError(
				`Invalid --expires "${raw}". Pass a positive number of days, an ISO date, or never.`,
				ExitCode.INVALID_ARGUMENTS,
			);
		}
		return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
	}
	const date = new Date(raw);
	if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
		throw new CliError(
			`Invalid --expires "${raw}". Pass a positive number of days, a future ISO date, or never.`,
			ExitCode.INVALID_ARGUMENTS,
		);
	}
	return date;
}

interface ActivityData {
	days?: number;
	totals?: {
		requests: number;
		promptTokens: number;
		completionTokens: number;
		costHalalas: number;
	};
	daily?: Array<{
		date: string;
		requests: number;
		promptTokens: number;
		completionTokens: number;
		costHalalas: number;
	}>;
	byModel?: Array<{
		modelId: string;
		requests: number;
		promptTokens: number;
		completionTokens: number;
		costHalalas: number;
	}>;
}

function printActivityTotals(activity: ActivityData): void {
	const totals = activity.totals ?? {
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		costHalalas: 0,
	};
	log(`  Requests: ${colors.cyan(String(totals.requests))}`);
	log(
		`  Tokens: ${colors.cyan(String(totals.promptTokens + totals.completionTokens))} ${colors.dim(`(${totals.promptTokens} in, ${totals.completionTokens} out)`)}`,
	);
	log(`  Spend: ${colors.cyan(`${formatSar(totals.costHalalas)} SAR`)}`);
}

/** The activity series is per day per model; the key view wants per day. */
function dailyTotals(daily: NonNullable<ActivityData["daily"]>) {
	const byDate = new Map<
		string,
		{ date: string; requests: number; tokens: number; costHalalas: number }
	>();
	for (const row of daily) {
		const day = byDate.get(row.date) ?? {
			date: row.date,
			requests: 0,
			tokens: 0,
			costHalalas: 0,
		};
		day.requests += row.requests;
		day.tokens += row.promptTokens + row.completionTokens;
		day.costHalalas += row.costHalalas;
		byDate.set(row.date, day);
	}
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function formatDate(date: string | Date | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
