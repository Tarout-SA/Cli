/**
 * Guards CLI coverage of the platform's customer-facing tRPC surface.
 *
 * A 2026-11-05 audit found 104 exposed procedures with no CLI command — not by
 * decision, just drift nobody was measuring. This suite makes the drift loud:
 * every procedure in the snapshot must either be reached from `src/` or carry a
 * stated reason in `src/lib/coverage-exceptions.ts`.
 *
 * The snapshot is a fixture rather than a live query so the suite stays offline
 * and deterministic. Refreshing it (scripts/refresh-surface-snapshot.mjs) is
 * the deliberate act that surfaces newly added platform procedures.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	findEmptyReasons,
	findStaleExceptions,
	findUnexplainedGaps,
	KNOWN_UNCOVERED,
} from "../src/lib/coverage-exceptions";
import { collectSourceText } from "./helpers/source-text";

interface Snapshot {
	platformCommit: string;
	capturedAt: string;
	total: number;
	procedures: string[];
}

const snapshot: Snapshot = JSON.parse(
	readFileSync(
		join(__dirname, "fixtures", "platform-surface.json"),
		"utf8",
	),
);

const sourceText = collectSourceText(join(__dirname, "..", "src"));

/**
 * True when the CLI mentions `client.<router>.<procedure>` anywhere in src/.
 * Deliberately loose: it does not require `.query()`/`.mutate()` to sit
 * adjacent, because prettier-style wrapping and helper indirection both split
 * them across lines. A false "covered" is a tolerable failure mode here; a
 * false "missing" would train people to ignore this suite.
 */
function isCalled(path: string): boolean {
	return sourceText.includes(`client.${path}`);
}

describe("platform surface coverage", () => {
	it("has a non-empty snapshot to check against", () => {
		expect(snapshot.procedures.length).toBe(snapshot.total);
		expect(snapshot.total).toBeGreaterThan(400);
		expect(snapshot.platformCommit).toMatch(/^[0-9a-f]{7,40}$/);
	});

	it("reaches or explains every customer-facing procedure", () => {
		const gaps = findUnexplainedGaps(snapshot.procedures, isCalled);
		expect(
			gaps,
			`${gaps.length} platform procedure(s) have no CLI command and no stated reason.\n\n` +
				`${gaps.map((g) => `  - ${g}`).join("\n")}\n\n` +
				"Either add a command, or add an entry to src/lib/coverage-exceptions.ts\n" +
				"explaining why the CLI withholds it. Do not write 'not implemented yet' —\n" +
				"if it is simply missing, write the command.",
		).toEqual([]);
	});

	it("has no stale exception entries", () => {
		const stale = findStaleExceptions(snapshot.procedures);
		expect(
			stale,
			`These exceptions name procedures that are no longer on the platform surface, ` +
				`so they are dead weight and should be deleted:\n${stale.map((s) => `  - ${s}`).join("\n")}`,
		).toEqual([]);
	});

	it("gives every exception a real reason", () => {
		expect(findEmptyReasons()).toEqual([]);
		for (const [path, reason] of KNOWN_UNCOVERED) {
			expect(reason.length, `${path} needs a fuller reason`).toBeGreaterThan(30);
			expect(
				/not implemented|todo|tbd/i.test(reason),
				`${path}: "not implemented yet" is not a reason — write the command instead`,
			).toBe(false);
		}
	});
});
