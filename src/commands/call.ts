import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getApiUrl, isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	handleError,
	InvalidArgumentError,
} from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, table } from "../lib/output.js";
import {
	fetchManifestFresh,
	loadManifest,
	type ManifestEntry,
} from "../lib/surface-manifest.js";
import { ExitCode } from "../utils/exit-codes.js";
import {
	failSpinner,
	startSpinner,
	succeedSpinner,
} from "../utils/spinner.js";

/**
 * Generic escape hatch: call ANY exposed platform procedure directly, the same
 * way the REST and MCP surfaces do. Gives the CLI 100% coverage of the control
 * surface without a bespoke command per procedure. The curated commands remain
 * for ergonomics; `tarout call` covers everything else.
 *
 *   tarout call --list [filter]
 *   tarout call application.create --input '{"name":"my-app", ...}'
 *   tarout call deployment.all --input '{"applicationId":"..."}' --json
 */
export function registerCallCommand(program: Command) {
	program
		.command("call [procedure]")
		.description(
			"Call any platform API procedure directly (e.g. application.create). Use --list to discover. Exit codes: an unknown/non-exposed procedure exits NOT_FOUND (4); malformed --input JSON exits INVALID_ARGUMENTS (2).",
		)
		.option("-i, --input <json>", "JSON input for the procedure", "{}")
		.option("--input-file <path>", "Read JSON input from a file")
		.option(
			"-l, --list [filter]",
			"List callable procedures (optionally filtered by substring)",
		)
		.action(async (procedure: string | undefined, opts) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();

				// ── Discovery mode ──────────────────────────────────────────────
				if (opts.list !== undefined || !procedure) {
					startSpinner("Loading control surface...");
					// Always fetch fresh for discovery so the listing is never stale.
					const manifest = await fetchManifestFresh(client, getApiUrl());
					succeedSpinner();

					const filter =
						typeof opts.list === "string" ? opts.list : undefined;
					const matched = manifest.filter(
						(m) => !filter || m.path.includes(filter),
					);

					if (isJsonMode()) {
						outputData(matched);
						return;
					}

					if (!procedure && opts.list === undefined) {
						log(
							colors.dim(
								"No procedure given. Available procedures (call one with `tarout call <procedure> --input '{...}'`):",
							),
						);
						log("");
					}
					table(
						["Procedure", "Type"],
						matched.map((m) => [m.path, m.type]),
					);
					log("");
					log(colors.dim(`${matched.length} procedures`));
					return;
				}

				// ── Resolve the procedure's call type from the manifest ─────────
				const apiUrl = getApiUrl();
				let manifest = await loadManifest(client, apiUrl);
				let entry = manifest.find((m) => m.path === procedure);
				if (!entry) {
					// Not in the (possibly cached) manifest — refetch live before
					// declaring it unknown, so a just-added procedure still works.
					manifest = await fetchManifestFresh(client, apiUrl);
					entry = manifest.find((m) => m.path === procedure);
				}
				if (!entry) {
					throw new CliError(
						`Unknown or non-exposed procedure: "${procedure}". Run \`tarout call --list\` to see what's available.`,
						ExitCode.NOT_FOUND,
					);
				}

				// ── Parse input ─────────────────────────────────────────────────
				let input: unknown = {};
				const rawInput: string = opts.inputFile
					? readFileSync(opts.inputFile, "utf8")
					: opts.input;
				if (rawInput && rawInput.trim()) {
					try {
						input = JSON.parse(rawInput);
					} catch {
						throw new InvalidArgumentError(
							`--input must be valid JSON. Received: ${rawInput}`,
						);
					}
				}

				// ── Dispatch via the untyped tRPC proxy ─────────────────────────
				const [routerKey, procKey] = procedure.split(".");
				const node = (client as Record<string, any>)[routerKey ?? ""]?.[
					procKey ?? ""
				];
				if (!node) {
					throw new Error(`Procedure path not found on client: ${procedure}`);
				}

				startSpinner(`Calling ${procedure}...`);
				const result =
					entry.type === "mutation"
						? await node.mutate(input)
						: await node.query(input);
				succeedSpinner();
				// outputData only prints under --json; in human mode it would be a
				// silent no-op (the call looks like it did nothing). Print the result.
				if (isJsonMode()) {
					outputData(result);
				} else {
					log(
						typeof result === "string"
							? result
							: JSON.stringify(result, null, 2),
					);
				}
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
