import { afterEach, describe, expect, it } from "vitest";
import { buildApplicationUpdatePlan } from "../src/commands/apps";
import {
	buildDeploymentTypeQuery,
	shouldConfirmRollback,
} from "../src/commands/deploy";
import { InvalidArgumentError } from "../src/lib/errors";
import { setGlobalOptions } from "../src/lib/output";

describe("CLI command contracts", () => {
	afterEach(() => {
		setGlobalOptions({ yes: false });
	});

	it("sends the exact deployment.allByType input contract", () => {
		expect(buildDeploymentTypeQuery("app-1", "application")).toEqual({
			id: "app-1",
			type: "application",
		});
		expect(buildDeploymentTypeQuery("preview-1", "previewDeployment")).toEqual(
			{
				id: "preview-1",
				type: "previewDeployment",
			},
		);
		expect(buildDeploymentTypeQuery("backup-1", "backup")).toEqual({
			id: "backup-1",
			type: "backup",
		});
	});

	it("rejects the old source-type vocabulary", () => {
		expect(() => buildDeploymentTypeQuery("app-1", "git")).toThrow(
			InvalidArgumentError,
		);
	});

	it("honors the global --yes flag for rollback", () => {
		setGlobalOptions({ yes: false });
		expect(shouldConfirmRollback()).toBe(true);
		setGlobalOptions({ yes: true });
		expect(shouldConfirmRollback()).toBe(false);
	});

	it("rejects empty or missing application updates", () => {
		expect(() => buildApplicationUpdatePlan("app-1", {})).toThrow(
			InvalidArgumentError,
		);
		expect(() =>
			buildApplicationUpdatePlan("app-1", { name: "   " }),
		).toThrow("Application name cannot be empty");
	});

	it("allows clearing a description and trims names", () => {
		expect(
			buildApplicationUpdatePlan("app-1", {
				name: "  New name  ",
				description: "",
			}),
		).toEqual({
			application: {
				applicationId: "app-1",
				name: "New name",
				description: "",
			},
			subdomain: null,
		});
	});
});
