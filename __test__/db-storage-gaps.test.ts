import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertDatabaseStatus,
	buildRotationImpactReport,
	DATABASE_STATUS_VALUES,
	describeDatabaseStatusChange,
	resolveCertOutputPath,
} from "../src/commands/db";
import {
	describeFolderDeletionScope,
	formatBucketStatsLines,
	formatBytes,
	normalizeBrowsePrefix,
	normalizeFolderPrefix,
} from "../src/commands/storage";
import { InvalidArgumentError } from "../src/lib/errors";

describe("database status changes", () => {
	it("accepts exactly the statuses the platform's schema enumerates", () => {
		for (const status of DATABASE_STATUS_VALUES) {
			expect(assertDatabaseStatus(status)).toBe(status);
		}
		expect(assertDatabaseStatus("  STOPPED ")).toBe("stopped");
	});

	it("rejects an illegal status rather than letting Zod reject it", () => {
		expect(() => assertDatabaseStatus("paused")).toThrow(InvalidArgumentError);
		expect(() => assertDatabaseStatus("paused")).toThrow(
			/is not a database status/,
		);
		expect(() => assertDatabaseStatus("")).toThrow(InvalidArgumentError);
	});

	it("explains that a status change is an inert column write on both engines", () => {
		const message = describeDatabaseStatusChange("stopped");
		// Keeps the shared lifecycle wording the MCP surface and the existing
		// `db stop` / `db restart` tests assert on.
		expect(message).toContain("cannot be stopped, started or restarted");
		expect(message).toContain("shared hosts");
		expect(message).toContain("postgres.changeStatus / mysql.changeStatus");
		expect(message).toContain('applicationStatus="stopped"');
	});
});

describe("rotate-password downstream impact", () => {
	it("warns that every external client is locked out and says where the new password lives", () => {
		const report = buildRotationImpactReport("main-db", {
			updatedApplicationIds: [],
			failedApplicationIds: [],
		});
		expect(report.updated).toEqual([]);
		expect(report.failed).toEqual([]);
		const text = report.lines.join(" ");
		expect(text).toContain("no longer authenticates");
		expect(text).toContain("pooled connection");
		expect(text).toContain("No applications are attached");
		expect(text).toContain("tarout db connect main-db");
		expect(text).toContain("tarout db info main-db --json");
	});

	it("reports the attached applications the platform re-synced and restarted", () => {
		const report = buildRotationImpactReport("main-db", {
			updatedApplicationIds: ["app-1", "app-2"],
			failedApplicationIds: [],
		});
		expect(report.updated).toEqual(["app-1", "app-2"]);
		const text = report.lines.join(" ");
		expect(text).toContain("2 attached applications");
		expect(text).toContain("DATABASE_URL");
		expect(text).toContain("restarted automatically");
		expect(text).toContain("app-1, app-2");
	});

	it("loudly names the applications still holding the old password, with the manual fix", () => {
		const report = buildRotationImpactReport("main-db", {
			updatedApplicationIds: ["app-1"],
			failedApplicationIds: ["app-9"],
		});
		expect(report.failed).toEqual(["app-9"]);
		const text = report.lines.join(" ");
		expect(text).toContain("could NOT be re-synced");
		expect(text).toContain("app-9");
		expect(text).toContain("tarout env set <app> DATABASE_URL=");
		expect(text).toContain("tarout apps restart <app>");
	});

	it("survives a result payload without the id arrays", () => {
		const report = buildRotationImpactReport("main-db", undefined);
		expect(report.updated).toEqual([]);
		expect(report.failed).toEqual([]);
		expect(report.lines.join(" ")).toContain("No applications are attached");
	});
});

describe("ssl-cert output path", () => {
	it("requires a path and returns an absolute one", () => {
		const resolved = resolveCertOutputPath("ca.pem", "tarout-postgres-ca.pem");
		expect(isAbsolute(resolved)).toBe(true);
		expect(resolved.endsWith("/ca.pem")).toBe(true);
	});

	it("rejects an empty --output instead of writing to nowhere", () => {
		expect(() => resolveCertOutputPath("   ", "ca.pem")).toThrow(
			InvalidArgumentError,
		);
		expect(() => resolveCertOutputPath("", "ca.pem")).toThrow(/--output needs/);
	});

	it("takes the platform filename when the path names a directory", () => {
		expect(
			resolveCertOutputPath("./certs/", "tarout-postgres-ca.pem").endsWith(
				"/certs/tarout-postgres-ca.pem",
			),
		).toBe(true);
		expect(
			resolveCertOutputPath(".", "tarout-postgres-ca.pem").endsWith(
				"/tarout-postgres-ca.pem",
			),
		).toBe(true);
		expect(
			resolveCertOutputPath("..", "tarout-postgres-ca.pem").endsWith(
				"/tarout-postgres-ca.pem",
			),
		).toBe(true);
	});
});

describe("folder path normalization", () => {
	it("normalizes to a single trailing slash with no leading slash", () => {
		expect(normalizeFolderPrefix("logs/2026")).toBe("logs/2026/");
		expect(normalizeFolderPrefix("/logs/2026/")).toBe("logs/2026/");
		expect(normalizeFolderPrefix("  logs  ")).toBe("logs/");
	});

	it("rejects an empty folder path so a delete can never target the whole bucket", () => {
		expect(() => normalizeFolderPrefix("")).toThrow(InvalidArgumentError);
		expect(() => normalizeFolderPrefix("   ")).toThrow(/folder path is required/);
		expect(() => normalizeFolderPrefix("/")).toThrow(InvalidArgumentError);
		expect(() => normalizeFolderPrefix("///")).toThrow(InvalidArgumentError);
	});

	it("rejects a path that tries to escape the folder it names", () => {
		expect(() => normalizeFolderPrefix("../other")).toThrow(
			InvalidArgumentError,
		);
		expect(() => normalizeFolderPrefix("logs/../../etc")).toThrow(
			/"\." or "\.\." segment/,
		);
		expect(() => normalizeFolderPrefix("./logs")).toThrow(InvalidArgumentError);
		expect(() => normalizeFolderPrefix("logs/..")).toThrow(
			InvalidArgumentError,
		);
	});

	it("rejects empty path segments that would match nothing", () => {
		expect(() => normalizeFolderPrefix("logs//2026")).toThrow(
			/empty path segment/,
		);
	});

	it("treats a missing browse prefix as the bucket root but still rejects traversal", () => {
		expect(normalizeBrowsePrefix(undefined)).toBe("");
		expect(normalizeBrowsePrefix("")).toBe("");
		expect(normalizeBrowsePrefix("/")).toBe("");
		expect(normalizeBrowsePrefix("logs")).toBe("logs/");
		expect(normalizeBrowsePrefix("/logs/2026/")).toBe("logs/2026/");
		expect(() => normalizeBrowsePrefix("../other")).toThrow(
			InvalidArgumentError,
		);
	});
});

describe("folder deletion scope", () => {
	it("states the exact count when the listing was complete", () => {
		expect(describeFolderDeletionScope(1, false)).toBe("1 object");
		expect(describeFolderDeletionScope(2048, false)).toBe("2,048 objects");
	});

	it("states a floor when the listing was capped", () => {
		expect(describeFolderDeletionScope(1000, true)).toContain(
			"at least 1,000 objects",
		);
		expect(describeFolderDeletionScope(1000, true)).toContain("may be more");
	});

	it("says so when nothing matches the prefix", () => {
		expect(describeFolderDeletionScope(0, false)).toContain("no objects");
	});
});

describe("byte formatting", () => {
	it("switches unit exactly at each 1024 boundary", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512.0 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
		expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
		expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
	});

	it("clamps instead of rendering an undefined unit past the table", () => {
		expect(formatBytes(1024 ** 5)).toBe("1.0 PB");
		expect(formatBytes(1024 ** 7)).toBe("1048576.0 PB");
	});
});

describe("bucket stats formatting", () => {
	it("renders the live measurement", () => {
		expect(
			formatBucketStatsLines({
				fileCount: 1234,
				totalBytes: 5 * 1024 * 1024,
				noncurrentBytes: 0,
				truncated: false,
			}),
		).toEqual(["Objects: 1,234", "Live size: 5.0 MB"]);
	});

	it("reports retained versions and the billed total separately", () => {
		const lines = formatBucketStatsLines({
			fileCount: 2,
			totalBytes: 1024,
			noncurrentBytes: 1024,
			truncated: false,
		});
		expect(lines).toContain("Objects: 2");
		expect(lines.some((l) => l.startsWith("Retained versions: 1.0 KB"))).toBe(
			true,
		);
		expect(lines).toContain("Billed total: 2.0 KB");
	});

	it("marks truncated counts as floors", () => {
		const lines = formatBucketStatsLines({
			fileCount: 20000,
			totalBytes: 1024 ** 3,
			truncated: true,
		});
		expect(lines[0]).toBe("Objects: at least 20,000");
		expect(lines[1]).toBe("Live size: at least 1.0 GB");
		expect(lines.some((l) => l.startsWith("Truncated: yes"))).toBe(true);
	});

	it("does not invent numbers for a missing payload", () => {
		expect(formatBucketStatsLines({})).toEqual([
			"Objects: 0",
			"Live size: 0 B",
		]);
	});
});
