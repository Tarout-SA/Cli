import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyManifestResources,
	generateSecretValue,
	ManifestError,
	manifestBuildConfig,
	missingGeneratedSecrets,
	readProjectManifest,
} from "../src/lib/project-manifest";

/**
 * `.tarout/config.json` is the project's declared deploy contract. Its whole
 * value is that it beats inference — so the two properties that matter are
 * (a) a declaration always wins, including a negative one, and (b) a malformed
 * manifest fails loudly instead of silently falling back to guessing, which
 * would deploy something other than what the file says.
 */

function projectWith(contents: string): string {
	const root = mkdtempSync(join(tmpdir(), "tarout-manifest-"));
	mkdirSync(join(root, ".tarout"), { recursive: true });
	writeFileSync(join(root, ".tarout", "config.json"), contents);
	return root;
}

describe("readProjectManifest", () => {
	it("returns null when there is no manifest", () => {
		expect(readProjectManifest(mkdtempSync(join(tmpdir(), "empty-")))).toBeNull();
	});

	it("reads the documented shape", () => {
		const root = projectWith(
			JSON.stringify({
				healthCheck: { path: "/healthz", expectedStatus: 204 },
				smokePaths: ["/", "/ar"],
				releaseCommand: "bunx prisma migrate deploy",
				releaseCommandTimeoutSec: 120,
				build: { buildCommand: "bun run build" },
				resources: { postgres: true, storage: false },
				generatedSecrets: ["SESSION_SECRET"],
			}),
		);
		const manifest = readProjectManifest(root);
		expect(manifest?.healthCheck?.path).toBe("/healthz");
		expect(manifest?.smokePaths).toEqual(["/", "/ar"]);
		expect(manifest?.releaseCommand).toBe("bunx prisma migrate deploy");
		expect(manifest?.resources?.postgres).toBe(true);
		expect(manifest?.generatedSecrets).toEqual(["SESSION_SECRET"]);
	});

	it("fails loudly on invalid JSON rather than falling back to guessing", () => {
		// Silently ignoring a broken manifest would deploy something other than
		// what the file says — the one failure mode a declared contract must not
		// have.
		const root = projectWith("{ not json");
		expect(() => readProjectManifest(root)).toThrow(ManifestError);
	});

	it("names the offending field", () => {
		const root = projectWith(JSON.stringify({ smokePaths: ["ar"] }));
		expect(() => readProjectManifest(root)).toThrow(/smokePaths\[0\]/);
	});

	it("rejects a status code that isn't one", () => {
		const root = projectWith(
			JSON.stringify({ healthCheck: { expectedStatus: 99 } }),
		);
		expect(() => readProjectManifest(root)).toThrow(/expectedStatus/);
	});

	it("rejects asking for two different databases", () => {
		const root = projectWith(
			JSON.stringify({ resources: { postgres: true, mysql: true } }),
		);
		expect(() => readProjectManifest(root)).toThrow(/both postgres and mysql/);
	});

	it("rejects a release timeout beyond the execution ceiling", () => {
		const root = projectWith(JSON.stringify({ releaseCommandTimeoutSec: 5000 }));
		expect(() => readProjectManifest(root)).toThrow(/between 1 and 900/);
	});
});

describe("applyManifestResources", () => {
	const detected = { database: "postgres", storage: true };

	it("leaves detection alone when nothing is declared", () => {
		expect(applyManifestResources(detected, null)).toEqual(detected);
		expect(applyManifestResources(detected, {})).toEqual(detected);
	});

	it("honours an explicit NO over a positive detection", () => {
		// A repo that depends on `pg` for a script it never deploys should not
		// get a database — and be billed for it — because of that dependency.
		const result = applyManifestResources(detected, {
			resources: { postgres: false },
		});
		expect(result.database).toBe("none");
	});

	it("honours an explicit YES over a negative detection", () => {
		const result = applyManifestResources(
			{ database: "none", storage: false },
			{ resources: { postgres: true, storage: true } },
		);
		expect(result.database).toBe("postgres");
		expect(result.storage).toBe(true);
	});

	it("switches engine when the manifest asks for mysql", () => {
		const result = applyManifestResources(detected, {
			resources: { mysql: true },
		});
		expect(result.database).toBe("mysql");
	});
});

describe("manifestBuildConfig", () => {
	it("maps declared settings onto the saveBuildConfig payload", () => {
		const config = manifestBuildConfig({
			healthCheck: { path: "/healthz", expectedStatus: 204 },
			smokePaths: ["/ar"],
			releaseCommand: "bunx prisma migrate deploy",
			build: { buildCommand: "bun run build" },
		});
		expect(config).toEqual({
			healthCheckPath: "/healthz",
			healthCheckReturnCode: 204,
			smokePaths: ["/ar"],
			releaseCommand: "bunx prisma migrate deploy",
			buildCommand: "bun run build",
		});
	});

	it("sends nothing when the manifest only declares resources", () => {
		// resources drive provisioning, not the app's build config — an empty
		// payload must not be sent as an update.
		expect(manifestBuildConfig({ resources: { postgres: true } })).toBeNull();
	});

	it("passes an explicit empty smokePaths through so the gate can be turned off", () => {
		expect(manifestBuildConfig({ smokePaths: [] })).toEqual({ smokePaths: [] });
	});
});

describe("generated secrets", () => {
	it("only reports the ones that don't exist yet", () => {
		const missing = missingGeneratedSecrets(
			{ generatedSecrets: ["SESSION_SECRET", "ENCRYPTION_KEY"] },
			new Set(["SESSION_SECRET", "DATABASE_URL"]),
		);
		expect(missing).toEqual(["ENCRYPTION_KEY"]);
	});

	it("never rotates a secret that already exists", () => {
		// Regenerating SESSION_SECRET on a deploy would sign out every user of
		// the app — and doing it silently, from a config file, would be the kind
		// of thing nobody could debug.
		expect(
			missingGeneratedSecrets(
				{ generatedSecrets: ["SESSION_SECRET"] },
				new Set(["SESSION_SECRET"]),
			),
		).toEqual([]);
	});

	it("does nothing when the manifest declares none", () => {
		expect(missingGeneratedSecrets(null, new Set())).toEqual([]);
		expect(missingGeneratedSecrets({}, new Set())).toEqual([]);
	});

	it("generates a value long enough to be a secret, and a different one each time", () => {
		const a = generateSecretValue();
		const b = generateSecretValue();
		expect(a).not.toBe(b);
		expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
		// base64url so it survives a shell, a URL and a YAML file unquoted.
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("rejects a name that isn't a usable environment variable", () => {
		const root = projectWith(
			JSON.stringify({ generatedSecrets: ["not-a-valid-name"] }),
		);
		expect(() => readProjectManifest(root)).toThrow(/generatedSecrets\[0\]/);
	});
});
