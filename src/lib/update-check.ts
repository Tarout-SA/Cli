/**
 * @fileoverview Self-update on deploy. When `tarout up` / `tarout deploy`
 * starts, the CLI asks the npm registry for the latest published version; if a
 * newer one exists it installs it (`npm install -g @tarout/cli@<latest>` — the
 * same channel install.sh and the docs use) and re-executes the original
 * command with the fresh binary, so every deploy runs the current CLI without
 * the user doing anything.
 *
 * Deliberately conservative:
 *   - Fail-open everywhere: registry unreachable, npm missing, install error —
 *     the original command continues on the current version.
 *   - Opt-outs: `--no-update-check` and TAROUT_NO_UPDATE_CHECK=1.
 *   - Loop guard: the re-executed child runs with TAROUT_UPDATE_REEXEC=1 and
 *     skips the check entirely.
 *   - Never wired into `tarout-mcp` — replacing the package mid-session would
 *     break the stdio JSON-RPC stream.
 * @module lib/update-check
 */

import { spawnSync } from "node:child_process";
import { stringifyJson } from "../utils/json.js";
import { colors, info, isJsonMode, isQuietMode, warn } from "./output.js";

const REGISTRY_LATEST_URL = "https://registry.npmjs.org/@tarout/cli/latest";
const FETCH_TIMEOUT_MS = 2500;

/** Numeric-triple semver comparison; prerelease/build suffixes are ignored. */
export function isNewerVersion(current: string, latest: string): boolean {
	const parse = (v: string): number[] =>
		v
			.replace(/^v/, "")
			.split(/[-+]/, 1)[0]
			.split(".")
			.map((part) => Number.parseInt(part, 10));
	const cur = parse(current);
	const next = parse(latest);
	if (cur.some(Number.isNaN) || next.some(Number.isNaN)) return false;
	for (let i = 0; i < 3; i++) {
		const a = cur[i] ?? 0;
		const b = next[i] ?? 0;
		if (b > a) return true;
		if (b < a) return false;
	}
	return false;
}

/** Latest published version from the npm registry, or null on any failure. */
export async function fetchLatestVersion(
	timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(REGISTRY_LATEST_URL, {
			signal: controller.signal,
			headers: { accept: "application/json" },
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { version?: unknown };
		return typeof body.version === "string" ? body.version : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function announceUpdate(from: string, to: string): void {
	if (isQuietMode()) return;
	if (isJsonMode()) {
		// Same convention as agent_setup_required: stdout stays a single JSON
		// envelope, advisory events go to stderr as NDJSON for agents that watch it.
		console.error(
			stringifyJson({ type: "event", event: "cli_update", from, to }),
		);
		return;
	}
	info(`Updating Tarout CLI ${from} → ${to}…`);
}

/**
 * Check for a newer published CLI and, when found, install it and re-exec the
 * current invocation on the new version. Returns normally (without updating)
 * on any failure or opt-out; only a successful update exits the process (with
 * the re-executed child's exit code).
 */
export async function maybeSelfUpdate(options: {
	currentVersion: string;
	disabled?: boolean;
}): Promise<void> {
	if (options.disabled) return;
	if (process.env.TAROUT_UPDATE_REEXEC) return;
	if (
		process.env.TAROUT_NO_UPDATE_CHECK &&
		process.env.TAROUT_NO_UPDATE_CHECK !== "0"
	) {
		return;
	}

	const latest = await fetchLatestVersion();
	if (!latest || !isNewerVersion(options.currentVersion, latest)) return;

	announceUpdate(options.currentVersion, latest);

	const install = spawnSync(
		"npm",
		["install", "-g", `@tarout/cli@${latest}`, "--quiet", "--no-fund"],
		{
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			shell: process.platform === "win32",
			timeout: 120_000,
		},
	);
	if (install.error || install.status !== 0) {
		if (!isQuietMode() && !isJsonMode()) {
			warn(
				`Could not auto-update (${install.error?.message ?? `npm exited ${install.status}`}). ` +
					`Run: npm install -g @tarout/cli@${latest}`,
			);
		}
		return;
	}

	// The global bin path is unchanged; re-running the same entry now loads the
	// freshly installed package. Inherit stdio so the deploy behaves exactly as
	// if it had been started on the new version.
	const entry = process.argv[1];
	if (!entry) return;
	const child = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
		stdio: "inherit",
		env: { ...process.env, TAROUT_UPDATE_REEXEC: "1" },
	});
	if (!isQuietMode() && !isJsonMode() && child.status === 0) {
		console.error(colors.dim(`  (ran on updated Tarout CLI ${latest})`));
	}
	process.exit(child.status ?? 0);
}
