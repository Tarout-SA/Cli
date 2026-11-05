/**
 * @fileoverview Agent webhooks (`tarout agent-webhooks`) — the machine wake-up
 * channel. Wraps the platform's `agentWebhook` tRPC router.
 *
 * A webhook is an https endpoint you own. When a platform event fires
 * (deployment failed, app unhealthy, monitor down, backup failed, approval
 * requested, scheduled task failed/recovered) Tarout POSTs a small signed JSON
 * body to every enabled webhook in the organization that subscribed to that
 * event, so an agent or CI job can react without polling.
 *
 * Each delivery carries three headers:
 *   x-tarout-event:     the event name, e.g. deployment.failed
 *   x-tarout-timestamp: unix seconds
 *   x-tarout-signature: sha256=HMAC_SHA256(webhook secret, raw request body)
 * Sign the received bytes as-is — never re-serialize the JSON before verifying.
 *
 * Failed deliveries are retried by the platform with exponential backoff (5
 * attempts, 10s/20s/40s/80s) and the last 50 attempts per webhook are kept as
 * delivery history (`tarout agent-webhooks deliveries <webhook>`).
 * @module commands/agent-webhooks
 */

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
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import { confirm } from "../utils/prompts.js";
import { startSpinner, stopSpinner, succeedSpinner } from "../utils/spinner.js";

/**
 * Every event an agent webhook can subscribe to. Mirrors
 * `AGENT_WEBHOOK_EVENTS` in the platform's `services/agent-webhook.ts`; the
 * server rejects anything else, so the CLI validates locally for a clear error.
 */
export const AGENT_WEBHOOK_EVENTS = [
	"deployment.failed",
	"application.unhealthy",
	"monitor.down",
	"backup.failed",
	"approval.requested",
	"scheduled_task.failed",
	"scheduled_task.recovered",
] as const;

export type AgentWebhookEvent = (typeof AGENT_WEBHOOK_EVENTS)[number];

/** Per-organization cap enforced by the platform on create. */
export const MAX_WEBHOOKS_PER_ORG = 10;

/** The platform keeps this many delivery rows per webhook. */
export const MAX_DELIVERY_HISTORY = 50;

/** `deliveries --limit` bounds, from the server's Zod schema. */
export const DEFAULT_DELIVERIES_LIMIT = 50;
export const MAX_DELIVERIES_LIMIT = 100;

/** The event the platform sends for `agent-webhooks test`. */
export const TEST_DELIVERY_EVENT = "deployment.failed";

/** Longest URL the server accepts. */
const MAX_URL_LENGTH = 2048;

/** Longest name the server accepts. */
const MAX_NAME_LENGTH = 100;

export interface AgentWebhook {
	id: string;
	organizationId: string;
	name: string;
	url: string;
	/** Returned by `get` and `create` only — `list`/`update` strip it. */
	secret?: string;
	events: string[];
	enabled: boolean;
	createdAt?: string | Date;
	updatedAt?: string | Date;
}

export interface AgentWebhookDelivery {
	id: string;
	event: string;
	ok: boolean;
	statusCode: number | null;
	attempts: number;
	error: string | null;
	deliveredAt: string | Date;
}

export function isAgentWebhookEvent(value: string): value is AgentWebhookEvent {
	return (AGENT_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Parse the repeatable `--event` flag (plus `--all-events`) into the exact
 * event array the server expects. Accepts comma-separated values in a single
 * flag, lowercases, de-duplicates, and preserves the order given.
 *
 * Returns `undefined` when the caller passed no event flags at all, so
 * `update` can leave the subscription list untouched.
 */
export function parseWebhookEvents(
	values: string[] | undefined,
	allEvents = false,
): AgentWebhookEvent[] | undefined {
	if (allEvents) return [...AGENT_WEBHOOK_EVENTS];
	if (!values || values.length === 0) return undefined;

	const names = values
		.flatMap((value) => String(value).split(","))
		.map((value) => value.trim().toLowerCase())
		.filter((value) => value.length > 0);

	if (names.length === 0) {
		throw new InvalidArgumentError(
			`Subscribe to at least one event. Valid events: ${AGENT_WEBHOOK_EVENTS.join(", ")}.`,
		);
	}

	const events: AgentWebhookEvent[] = [];
	for (const name of names) {
		if (!isAgentWebhookEvent(name)) {
			const similar = findSimilar(name, [...AGENT_WEBHOOK_EVENTS]);
			throw new InvalidArgumentError(
				`Unknown event "${name}".${similar.length ? ` Did you mean ${similar.join(", ")}?` : ""} Valid events: ${AGENT_WEBHOOK_EVENTS.join(", ")}.`,
			);
		}
		if (!events.includes(name)) events.push(name);
	}
	return events;
}

/**
 * Local copy of the server's create/update-time URL check: https only, and no
 * endpoint that obviously points back inside the network. The authoritative
 * SSRF guard runs at delivery time (it re-resolves DNS per request); this one
 * exists so a typo fails instantly with a readable message instead of a round
 * trip. Returns the trimmed URL exactly as it will be sent.
 */
export function assertPublicHttpsUrl(url: string): string {
	const trimmed = String(url ?? "").trim();
	if (!trimmed) {
		throw new InvalidArgumentError(
			"A webhook URL is required, e.g. tarout agent-webhooks create https://example.com/tarout-hook",
		);
	}
	if (trimmed.length > MAX_URL_LENGTH) {
		throw new InvalidArgumentError(
			`Webhook URL is too long (${trimmed.length} characters, max ${MAX_URL_LENGTH}).`,
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new InvalidArgumentError(
			`"${trimmed}" is not a valid URL. Pass a full https endpoint, e.g. https://example.com/tarout-hook`,
		);
	}
	if (parsed.protocol !== "https:") {
		throw new InvalidArgumentError(
			`Webhook URL must use https:// (got ${parsed.protocol}//). Tarout refuses to send signed events over plaintext.`,
		);
	}
	if (isPrivateHostname(parsed.hostname)) {
		throw new InvalidArgumentError(
			`"${parsed.hostname}" is not reachable from Tarout. A webhook URL must be a public https endpoint — it may not resolve to a private, loopback, link-local, or cloud-metadata address.`,
		);
	}
	return trimmed;
}

/** Obvious non-public hosts, checked without DNS (literals and localhost). */
function isPrivateHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host === "metadata.google.internal" || host.endsWith(".internal")) {
		return true;
	}
	if (host === "::1" || host === "0.0.0.0") return true;

	const parts = host.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
		return false;
	}
	const [a, b] = parts.map((part) => Number(part)) as [
		number,
		number,
		number,
		number,
	];
	if (a === 10 || a === 127 || a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}

/**
 * Default webhook name when `--name` is omitted: the endpoint's host plus its
 * first path segment, so a webhook is recognizable in `list` without forcing
 * an interactive prompt on an agent.
 */
export function suggestWebhookName(url: string): string {
	let host = url;
	let segment = "";
	try {
		const parsed = new URL(url);
		host = parsed.hostname;
		segment = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
	} catch {
		// Not parseable — assertPublicHttpsUrl reports that; fall back to the raw
		// string so this helper never throws on its own.
	}
	const name = segment ? `${host}/${segment}` : host;
	return name.slice(0, MAX_NAME_LENGTH);
}

function assertWebhookName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new InvalidArgumentError(
			"Webhook name cannot be empty. Pass --name <name> or drop the flag to name it after the URL host.",
		);
	}
	if (trimmed.length > MAX_NAME_LENGTH) {
		throw new InvalidArgumentError(
			`Webhook name is too long (${trimmed.length} characters, max ${MAX_NAME_LENGTH}).`,
		);
	}
	return trimmed;
}

export interface CreateWebhookFlags {
	name?: string;
	event?: string[];
	allEvents?: boolean;
	disabled?: boolean;
}

/** The exact `agentWebhook.create` input contract. */
export function buildCreateWebhookInput(
	url: string,
	options: CreateWebhookFlags = {},
): {
	name: string;
	url: string;
	events: AgentWebhookEvent[];
	enabled: boolean;
} {
	const safeUrl = assertPublicHttpsUrl(url);
	const events = parseWebhookEvents(options.event, options.allEvents);
	if (!events || events.length === 0) {
		throw new InvalidArgumentError(
			`Subscribe to at least one event: --event <event> (repeatable) or --all-events. Valid events: ${AGENT_WEBHOOK_EVENTS.join(", ")}.`,
		);
	}
	return {
		name: assertWebhookName(options.name ?? suggestWebhookName(safeUrl)),
		url: safeUrl,
		events,
		enabled: !options.disabled,
	};
}

export interface UpdateWebhookFlags {
	name?: string;
	url?: string;
	event?: string[];
	allEvents?: boolean;
	enable?: boolean;
	disable?: boolean;
}

/**
 * The exact `agentWebhook.update` input contract. Only the fields the caller
 * asked for are sent; `events` REPLACES the whole subscription list on the
 * server (there is no append), so it is only included when event flags were
 * given.
 */
export function buildUpdateWebhookInput(
	id: string,
	options: UpdateWebhookFlags = {},
): {
	id: string;
	name?: string;
	url?: string;
	events?: AgentWebhookEvent[];
	enabled?: boolean;
} {
	if (options.enable && options.disable) {
		throw new InvalidArgumentError(
			"Pass either --enable or --disable, not both.",
		);
	}

	const input: {
		id: string;
		name?: string;
		url?: string;
		events?: AgentWebhookEvent[];
		enabled?: boolean;
	} = { id };

	if (options.name !== undefined) input.name = assertWebhookName(options.name);
	if (options.url !== undefined) input.url = assertPublicHttpsUrl(options.url);
	const events = parseWebhookEvents(options.event, options.allEvents);
	if (events) input.events = events;
	if (options.enable) input.enabled = true;
	if (options.disable) input.enabled = false;

	if (Object.keys(input).length === 1) {
		throw new InvalidArgumentError(
			"Nothing to update. Pass at least one of --name, --url, --event, --all-events, --enable, --disable.",
		);
	}
	return input;
}

/** Validate `deliveries --limit` against the server's 1-100 window. */
export function parseDeliveriesLimit(value: string | undefined): number {
	if (value === undefined) return DEFAULT_DELIVERIES_LIMIT;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) {
		throw new InvalidArgumentError(
			`--limit must be a whole number between 1 and ${MAX_DELIVERIES_LIMIT}.`,
		);
	}
	if (parsed < 1 || parsed > MAX_DELIVERIES_LIMIT) {
		throw new InvalidArgumentError(
			`--limit must be between 1 and ${MAX_DELIVERIES_LIMIT} (the platform keeps the last ${MAX_DELIVERY_HISTORY} deliveries per webhook).`,
		);
	}
	return parsed;
}

/**
 * Resolve a `<webhook>` argument: exact id, then exact name or URL
 * (case-insensitive), then a unique id prefix. Ambiguous input throws and
 * lists the candidates instead of acting on a coin flip.
 */
export function findAgentWebhook(
	webhooks: AgentWebhook[],
	identifier: string,
): AgentWebhook | undefined {
	const wanted = String(identifier ?? "").trim();
	if (!wanted) return undefined;

	const exact = webhooks.find((hook) => hook.id === wanted);
	if (exact) return exact;

	const lower = wanted.toLowerCase();
	const byName = webhooks.filter(
		(hook) => String(hook.name ?? "").toLowerCase() === lower,
	);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) throw ambiguousWebhook(wanted, "name", byName);

	const byUrl = webhooks.filter(
		(hook) => String(hook.url ?? "").toLowerCase() === lower,
	);
	if (byUrl.length === 1) return byUrl[0];
	if (byUrl.length > 1) throw ambiguousWebhook(wanted, "URL", byUrl);

	const byPrefix = webhooks.filter((hook) => {
		const id = String(hook.id ?? "");
		return id !== "" && id.startsWith(wanted);
	});
	if (byPrefix.length === 1) return byPrefix[0];
	if (byPrefix.length > 1) throw ambiguousWebhook(wanted, "id prefix", byPrefix);

	return undefined;
}

function ambiguousWebhook(
	identifier: string,
	kind: "name" | "URL" | "id prefix",
	matches: AgentWebhook[],
): InvalidArgumentError {
	const candidates = matches
		.map((hook) => `${hook.id} (${hook.name})`)
		.join(", ");
	return new InvalidArgumentError(
		`Webhook ${kind} "${identifier}" matches ${matches.length} webhooks: ${candidates}. Pass the full webhook id instead.`,
	);
}

/** Plain-text outcome of one delivery attempt (no colors, safe to reuse). */
export function describeDeliveryOutcome(
	delivery: Pick<AgentWebhookDelivery, "ok" | "statusCode" | "error">,
): string {
	if (delivery.ok) {
		return delivery.statusCode ? `ok ${delivery.statusCode}` : "ok";
	}
	if (delivery.statusCode) return `failed ${delivery.statusCode}`;
	return delivery.error ? "failed (no response)" : "failed";
}

/** Map a server-side webhook error onto actionable next steps. */
export function withWebhookGuidance(err: unknown): unknown {
	if (err instanceof CliError) return err;
	const raw = err as {
		message?: string;
		code?: string;
		data?: { code?: string };
	};
	const message = typeof raw?.message === "string" ? raw.message : "";
	if (!message) return err;

	let suggestions: string[] | undefined;
	if (/limit of \d+ agent webhook/i.test(message)) {
		suggestions = [
			"List what exists: tarout agent-webhooks list",
			"Delete one you no longer need: tarout agent-webhooks delete <webhook>",
			"One webhook can subscribe to every event, so you rarely need more than a few",
		];
	} else if (/must use https/i.test(message)) {
		suggestions = ["Use an https:// endpoint — plaintext targets are refused"];
	} else if (/public https endpoint/i.test(message)) {
		suggestions = [
			"Expose the endpoint on a public hostname (a tunnel works for local development)",
			"Private, loopback, link-local and cloud-metadata addresses are refused",
		];
	} else if (/Subscribe to at least one event/i.test(message)) {
		suggestions = [
			`Pass --event <event> (repeatable) or --all-events. Valid events: ${AGENT_WEBHOOK_EVENTS.join(", ")}`,
		];
	} else if (/Agent webhook not found/i.test(message)) {
		suggestions = [
			"List the organization's webhooks: tarout agent-webhooks list",
			"A webhook only exists inside the organization that created it",
		];
	}

	if (!suggestions) return err;

	const code = raw.data?.code ?? (typeof raw.code === "string" ? raw.code : "");
	const exitCode =
		code === "FORBIDDEN"
			? ExitCode.PERMISSION_DENIED
			: code === "NOT_FOUND"
				? ExitCode.NOT_FOUND
				: code === "BAD_REQUEST"
					? ExitCode.INVALID_ARGUMENTS
					: ExitCode.GENERAL_ERROR;
	return new CliError(message, exitCode, suggestions);
}

export function registerAgentWebhookCommands(program: Command) {
	const webhooks = program
		.command("agent-webhooks")
		.alias("agent-webhook")
		.description(
			"Manage agent webhooks: signed HTTPS callbacks that wake an agent or CI job when a platform event fires (deployment failed, app unhealthy, monitor down, backup failed, approval requested, scheduled task failed or recovered)",
		)
		.addHelpText(
			"after",
			() =>
				`\nEvents: ${AGENT_WEBHOOK_EVENTS.join(", ")}\n` +
				`Each delivery POSTs JSON with x-tarout-event, x-tarout-timestamp and x-tarout-signature: sha256=HMAC_SHA256(secret, raw body).\n` +
				`Verify the signature over the received bytes as-is, before doing any work. Up to ${MAX_WEBHOOKS_PER_ORG} webhooks per organization.`,
		);

	// ── list ─────────────────────────────────────────────────────────────────────
	webhooks
		.command("list")
		.alias("ls")
		.description(
			"List the organization's agent webhooks with the events each one subscribes to (the signing secret is not included — read it with `tarout agent-webhooks get <webhook>`)",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Fetching agent webhooks...");
				const hooks = (await client.agentWebhook.list.query()) as AgentWebhook[];
				succeedSpinner();

				if (isJsonMode()) {
					outputData(hooks);
					return;
				}

				const rows = Array.isArray(hooks) ? hooks : [];
				if (!rows.length) {
					log("");
					log("No agent webhooks in this organization.");
					log("");
					log(
						`Create one with: ${colors.dim("tarout agent-webhooks create https://example.com/tarout-hook --all-events")}`,
					);
					log("");
					return;
				}

				log("");
				table(
					["ID", "NAME", "URL", "EVENTS", "ENABLED", "CREATED"],
					rows.map((hook) => [
						colors.cyan(shortId(hook.id)),
						hook.name || "-",
						truncate(hook.url, 40),
						formatEvents(hook.events),
						hook.enabled ? colors.success("yes") : colors.dim("no"),
						formatDateTime(hook.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${rows.length} of ${MAX_WEBHOOKS_PER_ORG} webhook${rows.length === 1 ? "" : "s"}`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(withWebhookGuidance(err));
			}
		});

	// ── get ──────────────────────────────────────────────────────────────────────
	webhooks
		.command("get")
		.argument("<webhook>", "Webhook id, name, URL, or a unique id prefix")
		.description(
			"Show one agent webhook in full, including the HMAC signing secret your endpoint needs to verify the x-tarout-signature header (the secret stays readable, so this is the place to fetch it again)",
		)
		.action(async (identifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Fetching agent webhook...");
				const summary = await resolveWebhook(client, identifier);
				const hook = (await client.agentWebhook.get.query({
					id: summary.id,
				})) as AgentWebhook;
				succeedSpinner();

				if (isJsonMode()) {
					outputData(hook);
					return;
				}

				// Quiet mode emits the id only — the secret never reaches bare stdout.
				quietOutput(hook.id);

				log("");
				log(colors.bold(hook.name));
				log("");
				log(`  ID: ${colors.cyan(hook.id)}`);
				log(`  URL: ${colors.cyan(hook.url)}`);
				log(`  Events: ${formatEvents(hook.events)}`);
				log(
					`  Enabled: ${hook.enabled ? colors.success("yes") : colors.dim("no")}`,
				);
				log(`  Created: ${formatDateTime(hook.createdAt)}`);
				log(`  Updated: ${formatDateTime(hook.updatedAt)}`);
				log("");
				if (hook.secret) printSigningSecret(hook.secret);
				log(
					`Delivery history: ${colors.dim(`tarout agent-webhooks deliveries ${hook.id}`)}`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(withWebhookGuidance(err));
			}
		});

	// ── create ───────────────────────────────────────────────────────────────────
	webhooks
		.command("create")
		.argument("<url>", "Public https endpoint that receives the signed POSTs")
		.description(
			"Register an https endpoint and subscribe it to one or more platform events; the platform generates the HMAC signing secret and returns it (you can read it again with `agent-webhooks get`)",
		)
		.option(
			"-n, --name <name>",
			"Label shown in listings (defaults to the URL host and first path segment)",
		)
		.option(
			"-e, --event <event>",
			`Event to subscribe to; repeat the flag or pass a comma-separated list. One of: ${AGENT_WEBHOOK_EVENTS.join(", ")}`,
			collectEvent,
			[] as string[],
		)
		.option("--all-events", "Subscribe to every event Tarout can send")
		.option(
			"--disabled",
			"Register the webhook without enabling it (no deliveries until you run `agent-webhooks update <webhook> --enable`)",
		)
		.action(async (url: string, options: CreateWebhookFlags) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const input = buildCreateWebhookInput(url, options);
				const client = getApiClient();

				const _spinner = startSpinner("Creating agent webhook...");
				const hook = (await client.agentWebhook.create.mutate(
					input,
				)) as AgentWebhook;
				succeedSpinner("Agent webhook created.");

				if (isJsonMode()) {
					outputData(hook);
					return;
				}

				// Quiet mode emits the id only — never the signing secret.
				quietOutput(hook.id);

				box("Agent Webhook Created", [
					`ID: ${colors.cyan(hook.id)}`,
					`Name: ${hook.name}`,
					`URL: ${colors.cyan(hook.url)}`,
					`Events: ${formatEvents(hook.events)}`,
					`Enabled: ${hook.enabled ? colors.success("yes") : colors.dim("no")}`,
				]);

				if (hook.secret) printSigningSecret(hook.secret);
				log(
					`Send a sample delivery with: ${colors.dim(`tarout agent-webhooks test ${hook.id}`)}`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(withWebhookGuidance(err));
			}
		});

	// ── update ───────────────────────────────────────────────────────────────────
	webhooks
		.command("update")
		.argument("<webhook>", "Webhook id, name, URL, or a unique id prefix")
		.description(
			"Change a webhook's name, endpoint, subscribed events, or enabled state (the signing secret is unchanged and is not re-displayed here)",
		)
		.option("-n, --name <name>", "New label for the webhook")
		.option("-u, --url <url>", "New public https endpoint")
		.option(
			"-e, --event <event>",
			`REPLACES the whole subscription list — the webhook ends up subscribed to exactly the events you pass here, so repeat every event you want to keep. One of: ${AGENT_WEBHOOK_EVENTS.join(", ")}`,
			collectEvent,
			[] as string[],
		)
		.option(
			"--all-events",
			"Replace the subscription list with every event Tarout can send",
		)
		.option("--enable", "Resume deliveries to this webhook")
		.option("--disable", "Stop deliveries without deleting the webhook")
		.action(async (identifier: string, options: UpdateWebhookFlags) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Finding agent webhook...");
				const summary = await resolveWebhook(client, identifier);
				const input = buildUpdateWebhookInput(summary.id, options);

				const hook = (await client.agentWebhook.update.mutate(
					input,
				)) as AgentWebhook;
				succeedSpinner("Agent webhook updated.");

				if (isJsonMode()) {
					outputData(hook);
					return;
				}

				quietOutput(hook.id);

				log("");
				log(colors.success(`Updated ${hook.name}.`));
				log(`  URL: ${colors.cyan(hook.url)}`);
				log(`  Events: ${formatEvents(hook.events)}`);
				log(
					`  Enabled: ${hook.enabled ? colors.success("yes") : colors.dim("no")}`,
				);
				if (input.events) {
					log(
						colors.dim(
							"  --event replaced the subscription list; the events above are the complete set now.",
						),
					);
				}
				log("");
			} catch (err) {
				stopSpinner();
				handleError(withWebhookGuidance(err));
			}
		});

	// ── delete ───────────────────────────────────────────────────────────────────
	webhooks
		.command("delete")
		.alias("rm")
		.argument("<webhook>", "Webhook id, name, URL, or a unique id prefix")
		.description(
			"Delete an agent webhook and its delivery history; events stop reaching that endpoint immediately (use `update --disable` instead if you only want to pause it)",
		)
		.action(async (identifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Finding agent webhook...");
				const hook = await resolveWebhook(client, identifier);
				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Webhook: ${colors.bold(hook.name)}`);
					log(`URL: ${colors.dim(hook.url)}`);
					log(`Events: ${formatEvents(hook.events)}`);
					log("");

					const confirmed = await confirm(
						`Delete agent webhook "${hook.name}"? Its delivery history goes with it.`,
						false,
						{
							field: "confirm_delete_agent_webhook",
							flag: "--yes",
							context: { id: hook.id, name: hook.name, url: hook.url },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting agent webhook...");
				const result = await client.agentWebhook.delete.mutate({ id: hook.id });
				succeedSpinner("Agent webhook deleted.");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(hook.id);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(withWebhookGuidance(err));
			}
		});

	// ── test ─────────────────────────────────────────────────────────────────────
	webhooks
		.command("test")
		.argument("<webhook>", "Webhook id, name, URL, or a unique id prefix")
		.description(
			`Queue one sample signed delivery to this webhook so you can verify your endpoint and signature check; it sends a ${TEST_DELIVERY_EVENT} payload marked "sample": true to this webhook only, even if it is not subscribed to that event`,
		)
		.action(async (identifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				const _spinner = startSpinner("Finding agent webhook...");
				const hook = await resolveWebhook(client, identifier);

				const result = await client.agentWebhook.test.mutate({ id: hook.id });
				succeedSpinner("Test delivery queued.");

				if (isJsonMode()) {
					outputData({ ...(result as object), webhookId: hook.id });
					return;
				}

				quietOutput(hook.id);

				log("");
				log(
					`Queued a ${colors.cyan(TEST_DELIVERY_EVENT)} sample delivery to ${colors.cyan(hook.url)}.`,
				);
				log(
					colors.dim(
						"Delivery runs on a worker, so it lands a moment later and is retried on failure.",
					),
				);
				log("");
				log(
					`Check the result: ${colors.dim(`tarout agent-webhooks deliveries ${hook.id}`)}`,
				);
				log("");
				if (!hook.enabled) {
					log(
						colors.warn(
							"This webhook is disabled: the test will NOT be sent — it is recorded as a failed delivery with \"Webhook is disabled\". Enable it first with `tarout agent-webhooks update <webhook> --enable`.",
						),
					);
					log("");
				}
			} catch (err) {
				stopSpinner();
				handleError(withWebhookGuidance(err));
			}
		});

	// ── deliveries ───────────────────────────────────────────────────────────────
	webhooks
		.command("deliveries")
		.argument("<webhook>", "Webhook id, name, URL, or a unique id prefix")
		.description(
			`Show recent delivery attempts for a webhook — event, HTTP status, attempt count and error — which is where you confirm an endpoint is answering (the platform keeps the last ${MAX_DELIVERY_HISTORY} per webhook)`,
		)
		.option(
			"-n, --limit <n>",
			`How many attempts to show, 1 to ${MAX_DELIVERIES_LIMIT} (default ${DEFAULT_DELIVERIES_LIMIT})`,
		)
		.option("--failed", "Only show attempts that did not succeed")
		.action(
			async (identifier: string, options: { limit?: string; failed?: boolean }) => {
				try {
					if (!isLoggedIn()) throw new AuthError();

					const limit = parseDeliveriesLimit(options.limit);
					const client = getApiClient();

					const _spinner = startSpinner("Fetching delivery history...");
					const hook = await resolveWebhook(client, identifier);
					const all = (await client.agentWebhook.deliveries.query({
						id: hook.id,
						limit,
					})) as AgentWebhookDelivery[];
					succeedSpinner();

					const rows = (Array.isArray(all) ? all : []).filter((delivery) =>
						options.failed ? !delivery.ok : true,
					);

					if (isJsonMode()) {
						outputData(rows);
						return;
					}

					if (!rows.length) {
						log("");
						log(
							options.failed
								? `No failed deliveries for ${colors.cyan(hook.name)}.`
								: `No deliveries yet for ${colors.cyan(hook.name)}.`,
						);
						log("");
						log(
							`Send a sample one with: ${colors.dim(`tarout agent-webhooks test ${hook.id}`)}`,
						);
						log("");
						return;
					}

					log("");
					log(`Deliveries for ${colors.cyan(hook.name)}:`);
					log("");
					table(
						["WHEN", "EVENT", "RESULT", "ATTEMPTS", "ERROR"],
						rows.map((delivery) => [
							formatDateTime(delivery.deliveredAt),
							delivery.event,
							delivery.ok
								? colors.success(describeDeliveryOutcome(delivery))
								: colors.error(describeDeliveryOutcome(delivery)),
							String(delivery.attempts ?? 1),
							delivery.error ? truncate(delivery.error, 40) : colors.dim("-"),
						]),
					);
					log("");
					log(
						colors.dim(
							`${rows.length} attempt${rows.length === 1 ? "" : "s"}${options.failed ? " (failed only)" : ""}`,
						),
					);
					log("");
				} catch (err) {
					stopSpinner();
					handleError(withWebhookGuidance(err));
				}
			},
		);
}

/** Commander collector for the repeatable `--event`. */
function collectEvent(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/**
 * Turn a `<webhook>` argument into the webhook it names. `list` is the only
 * procedure that can see every webhook, so resolution always goes through it —
 * which also gives a candidate list when the input is wrong.
 */
async function resolveWebhook(
	client: {
		agentWebhook: { list: { query: () => Promise<AgentWebhook[]> } };
	},
	identifier: string,
): Promise<AgentWebhook> {
	const hooks = (await client.agentWebhook.list.query()) as AgentWebhook[];
	const list = Array.isArray(hooks) ? hooks : [];
	const hook = findAgentWebhook(list, identifier);
	if (!hook) {
		stopSpinner();
		const suggestions = findSimilar(
			identifier,
			list.map((candidate) => candidate.name),
		);
		throw new NotFoundError("Agent webhook", identifier, suggestions);
	}
	return hook;
}

function printSigningSecret(secret: string): void {
	log(`Signing secret: ${colors.cyan(secret)}`);
	log(
		colors.dim(
			"Each delivery carries x-tarout-event, x-tarout-timestamp and x-tarout-signature: sha256=HMAC_SHA256(secret, raw request body). Verify it over the received bytes before doing work.",
		),
	);
	log(
		colors.dim(
			"Keep the secret out of logs and commits. Read it again any time with `tarout agent-webhooks get <webhook>`.",
		),
	);
	log("");
}

function formatEvents(events: string[] | undefined): string {
	const list = Array.isArray(events) ? events : [];
	if (!list.length) return colors.dim("none");
	if (list.length === AGENT_WEBHOOK_EVENTS.length) {
		return `${colors.bold("all")} ${colors.dim(`(${list.length})`)}`;
	}
	return list.join(", ");
}

function shortId(id: string): string {
	const value = String(id ?? "");
	return value.length > 12 ? value.slice(0, 8) : value;
}

function formatDateTime(date: Date | string | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function truncate(str: string, max: number): string {
	const value = String(str ?? "");
	if (value.length <= max) return value;
	return `${value.slice(0, max - 3)}...`;
}
