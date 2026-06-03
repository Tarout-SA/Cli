import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import { colors, isJsonMode, log, outputData, table } from "../lib/output.js";
import {
	failSpinner,
	startSpinner,
	succeedSpinner,
} from "../utils/spinner.js";

interface ManifestEntry {
	path: string;
	type: "query" | "mutation" | "subscription";
	router: string;
}

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
			"Call any platform API procedure directly (e.g. application.create). Use --list to discover.",
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
					const manifest =
						(await client.settings.getSurfaceManifest.query()) as ManifestEntry[];
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
				const manifest =
					(await client.settings.getSurfaceManifest.query()) as ManifestEntry[];
				const entry = manifest.find((m) => m.path === procedure);
				if (!entry) {
					throw new Error(
						`Unknown or non-exposed procedure: "${procedure}". Run \`tarout call --list\` to see what's available.`,
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
						throw new Error(
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
				outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}
