import { describe, expect, it } from "vitest";
import {
	normalizePath,
	parseJobType,
	parseTimeout,
	withJobGuidance,
} from "../src/commands/jobs";
import { CliError, InvalidArgumentError } from "../src/lib/errors";
import { ExitCode } from "../src/utils/exit-codes";

describe("jobs command contracts", () => {
	it("normalizes --type to the server's discriminator", () => {
		expect(parseJobType("http")).toBe("HTTP");
		expect(parseJobType("Command")).toBe("COMMAND");
		expect(parseJobType(undefined)).toBeUndefined();
		expect(() => parseJobType("webhook")).toThrow(InvalidArgumentError);
	});

	it("rejects an HTTP timeout above the server's 60s cap", () => {
		expect(parseTimeout("45", "HTTP")).toBe(45);
		expect(() => parseTimeout("300", "HTTP")).toThrow(
			/60 or less|--type command/,
		);
		// COMMAND tasks may use the full range.
		expect(parseTimeout("300", "COMMAND")).toBe(300);
		expect(() => parseTimeout("901", "COMMAND")).toThrow(InvalidArgumentError);
		// Unknown kind (an `update` that only changes the timeout) defers to the
		// server, which validates against the stored jobType.
		expect(parseTimeout("300", undefined)).toBe(300);
	});

	it("gives targetPath its required leading slash", () => {
		expect(normalizePath("cron/daily")).toBe("/cron/daily");
		expect(normalizePath("/cron/daily")).toBe("/cron/daily");
		expect(normalizePath(undefined)).toBe("/");
	});

	it("attaches next steps to the server's scheduled-job rejections", () => {
		const notDeployed = withJobGuidance({
			message:
				"Deploy this application before adding a command task — there is no container to run in yet.",
			data: { code: "BAD_REQUEST" },
		});
		expect(notDeployed).toBeInstanceOf(CliError);
		expect((notDeployed as CliError).code).toBe(ExitCode.INVALID_ARGUMENTS);
		expect((notDeployed as CliError).suggestions?.[0]).toContain(
			"tarout deploy",
		);

		const planLimit = withJobGuidance({
			message:
				"You have reached your plan's limit of 2 scheduled job(s). Upgrade or delete a job to add more.",
			data: { code: "FORBIDDEN" },
		});
		expect((planLimit as CliError).code).toBe(ExitCode.PERMISSION_DENIED);
		expect((planLimit as CliError).suggestions?.join(" ")).toContain(
			"tarout billing upgrade",
		);
	});

	it("passes unrelated errors through untouched", () => {
		const err = { message: "Something else broke", data: { code: "TIMEOUT" } };
		expect(withJobGuidance(err)).toBe(err);
	});
});
