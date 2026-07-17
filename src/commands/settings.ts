import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData } from "../lib/output.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerSettingsCommands(program: Command) {
	const settings = program
		.command("settings")
		.description("Platform settings and information");

	// ── Platform version ─────────────────────────────────────────────────────────
	settings
		.command("version")
		.description("Show the Tarout platform version")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching version...");
				const data = await client.settings.getTaroutVersion.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const v = data as any;
				log("");
				log(
					`Platform version: ${colors.cyan(v.version || v.taroutVersion || String(data))}`,
				);
				if (v.releaseTag) log(`Release tag:      ${colors.dim(v.releaseTag)}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Release tag ──────────────────────────────────────────────────────────────
	settings
		.command("release-tag")
		.description("Show the current release tag")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching release tag...");
				const data = await client.settings.getReleaseTag.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				log(`Release tag: ${colors.cyan(String(data))}`);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Health check ─────────────────────────────────────────────────────────────
	settings
		.command("health")
		.description("Check platform health status")
		.action(async () => {
			try {
				const client = getApiClient();
				const _spinner = startSpinner("Checking health...");
				const data = await client.settings.health.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const h = data as any;
				log("");
				log(colors.bold("Platform Health"));
				log(
					`  Status:   ${h.status === "ok" || h.healthy ? colors.success("healthy") : colors.error("unhealthy")}`,
				);
				if (h.db !== undefined)
					log(
						`  Database: ${h.db ? colors.success("ok") : colors.error("error")}`,
					);
				if (h.redis !== undefined)
					log(
						`  Redis:    ${h.redis ? colors.success("ok") : colors.error("error")}`,
					);
				if (h.version) log(`  Version:  ${colors.dim(h.version)}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Is cloud ─────────────────────────────────────────────────────────────────
	settings
		.command("is-cloud")
		.description("Check if running in Tarout Cloud mode")
		.action(async () => {
			try {
				const client = getApiClient();
				const _spinner = startSpinner("Checking deployment mode...");
				const data = await client.settings.isCloud.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const isCloud = (data as any)?.isCloud ?? data;
				log(
					`Cloud mode: ${isCloud ? colors.success("yes") : colors.dim("no")}`,
				);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Subscription check ────────────────────────────────────────────────────────
	// Subscriptions are per-project. This reads the ACTIVE project's subscription
	// (same source as `tarout billing status`). It used to call
	// `settings.isUserSubscribed`, which only returns "does the org own any app?"
	// — a boolean that is NOT plan/billing status and was surfaced misleadingly.
	settings
		.command("subscription-status")
		.description("Check the active project's subscription status")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking subscription...");
				const sub = await client.subscription.getCurrent.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(sub);
					return;
				}
				log("");
				log(colors.bold("Subscription Status"));
				const profile = getCurrentProfile();
				if (profile?.projectName) {
					log(`  ${colors.dim(`Project: ${profile.projectName}`)}`);
				}
				if (!sub?.planKey) {
					log(`  Plan:   ${colors.dim("No active subscription (free tier)")}`);
				} else {
					log(`  Plan:   ${colors.cyan(sub.planKey)}`);
					log(`  Status: ${sub.status || colors.dim("active")}`);
					if (sub.currentPeriodEnd)
						log(
							`  Renews: ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`,
						);
				}
				log("");
				log(colors.dim("Manage your plan with: tarout billing"));
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── OpenAPI document ──────────────────────────────────────────────────────────
	settings
		.command("openapi")
		.description("Output the OpenAPI specification document")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching OpenAPI spec...");
				const data = await client.settings.getOpenApiDocument.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				log(JSON.stringify(data, null, 2));
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
