#!/usr/bin/env node
/**
 * Refresh __test__/fixtures/platform-surface.json — the list of customer-facing
 * tRPC procedures the CLI is expected to reach.
 *
 * Run this after the platform adds or removes procedures:
 *   node scripts/refresh-surface-snapshot.mjs [path-to-platform-repo]
 *
 * Then run the suite. `__test__/surface-coverage.test.ts` will name any new
 * procedure that has neither a command nor a reason in
 * src/lib/coverage-exceptions.ts, which is the whole point: the gap is only
 * invisible while nobody regenerates this file.
 *
 * Scope mirrors the platform's own surface-scope.ts — whole platform-ops
 * routers (EXCLUDED_ROUTERS) and individually withheld procedures
 * (EXCLUDED_PROCEDURES) are dropped. Parsing is textual rather than by import
 * because the platform is a separate package this repo cannot require.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const platformRoot = process.argv[2] ?? join(repoRoot, "..", "platform");
const apiDir = join(platformRoot, "src", "server", "api");
const routersDir = join(apiDir, "routers");

let scopeSource;
try {
	scopeSource = readFileSync(join(apiDir, "surface-scope.ts"), "utf8");
} catch {
	console.error(
		`Could not read ${join(apiDir, "surface-scope.ts")}.\n` +
			"Pass the platform repo path: node scripts/refresh-surface-snapshot.mjs ../platform",
	);
	process.exit(1);
}

const section = (from, to) =>
	scopeSource.slice(scopeSource.indexOf(from), scopeSource.indexOf(to));

const excludedRouters = new Set(
	[...section("EXCLUDED_ROUTERS", "EXCLUDED_PROCEDURES").matchAll(/^\t"(\w+)",/gm)].map(
		(m) => m[1],
	),
);
const excludedProcedures = new Set(
	[
		...section("EXCLUDED_PROCEDURES", "NON_OBJECT_INPUT_ALLOWLIST").matchAll(
			/\["?(\w+\.\w+)"?,/g,
		),
	].map((m) => m[1]),
);
for (const m of scopeSource.matchAll(/^\t\t"(\w+\.\w+)",/gm)) {
	excludedProcedures.add(m[1]);
}

// router file -> the key it is mounted under in appRouter
const rootSource = readFileSync(join(apiDir, "root.ts"), "utf8");
const fileByVar = new Map(
	[...rootSource.matchAll(/import \{ (\w+) \} from "\.\/routers\/([\w-]+)"/g)].map(
		(m) => [m[1], m[2]],
	),
);
const keyByVar = new Map(
	[...rootSource.matchAll(/^\t(\w+):\s*(\w+),/gm)].map((m) => [m[2], m[1]]),
);

const procedures = [];
for (const [variable, file] of fileByVar) {
	const key = keyByVar.get(variable);
	if (!key || excludedRouters.has(key)) continue;
	const src = readFileSync(join(routersDir, `${file}.ts`), "utf8");
	for (const m of src.matchAll(/^\t([a-zA-Z0-9_]+):\s*[a-zA-Z]*[Pp]rocedure/gm)) {
		const path = `${key}.${m[1]}`;
		if (!excludedProcedures.has(path)) procedures.push(path);
	}
}
procedures.sort();

let platformCommit = "unknown";
try {
	platformCommit = execFileSync("git", ["-C", platformRoot, "rev-parse", "--short", "HEAD"], {
		encoding: "utf8",
	}).trim();
} catch {
	// a tarball checkout with no git metadata is fine; the snapshot still works
}

const target = join(repoRoot, "__test__", "fixtures", "platform-surface.json");
const previous = (() => {
	try {
		return JSON.parse(readFileSync(target, "utf8")).procedures ?? [];
	} catch {
		return [];
	}
})();

writeFileSync(
	target,
	`${JSON.stringify(
		{
			_comment:
				"Snapshot of the platform's customer-facing tRPC surface. Regenerate with scripts/refresh-surface-snapshot.mjs when the platform adds procedures; __test__/surface-coverage.test.ts fails until each new path is either reached by a command or given a reason in src/lib/coverage-exceptions.ts.",
			platformCommit,
			capturedAt: new Date().toISOString().slice(0, 10),
			total: procedures.length,
			procedures,
		},
		null,
		1,
	)}\n`,
);

const added = procedures.filter((p) => !previous.includes(p));
const removed = previous.filter((p) => !procedures.includes(p));
console.log(`Wrote ${procedures.length} in-scope procedures @ ${platformCommit}`);
if (added.length) console.log(`  + ${added.length} new:\n${added.map((p) => `      ${p}`).join("\n")}`);
if (removed.length)
	console.log(`  - ${removed.length} gone:\n${removed.map((p) => `      ${p}`).join("\n")}`);
if (!added.length && !removed.length) console.log("  no change");
