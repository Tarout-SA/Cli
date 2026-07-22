import { describe, expect, it } from "vitest";
import { analyzeDeploymentError } from "../src/lib/errors.js";

/**
 * analyzeDeploymentError classifies deploy failures into an actionable category
 * with a concrete remedy. The most common failure on a fresh managed-Postgres
 * deploy — a node-postgres client hitting the TLS-negotiating pooler without SSL
 * — must land in `database_tls` (not the generic `network`/`unknown`) so the
 * agent gets the exact ssl fix. Selection is by most-matches with ties broken by
 * array order, and `database_tls` is ordered before `network` on purpose.
 */
describe("analyzeDeploymentError — database TLS classification", () => {
	it("classifies a Postgres 'no pg_hba/no encryption' failure as database_tls", () => {
		const result = analyzeDeploymentError([
			"FATAL: no pg_hba.conf entry for host, no encryption",
		]);
		expect(result.category).toBe("database_tls");
		expect(result.type).toBe("runtime_error");
		expect(result.suggestedFixes.join(" ")).toMatch(/ssl|sslmode/i);
	});

	it("classifies a 'SSL connection is required' failure as database_tls", () => {
		const result = analyzeDeploymentError(
			[],
			"error: SSL connection is required. Please specify SSL options and retry.",
		);
		expect(result.category).toBe("database_tls");
	});

	it("prefers database_tls over network when a line carries both signals", () => {
		// A TLS refusal can also surface a connection-refused; the precise DB
		// remedy must win the tie (database_tls is ordered before network).
		const result = analyzeDeploymentError([
			"connect ECONNREFUSED 10.0.0.1:6432 sslmode=require",
		]);
		expect(result.category).toBe("database_tls");
	});

	it("still classifies a pure network error as network", () => {
		const result = analyzeDeploymentError(["getaddrinfo ENOTFOUND registry"]);
		expect(result.category).toBe("network");
	});
});
