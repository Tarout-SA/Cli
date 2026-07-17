import { afterEach, describe, expect, it } from "vitest";
import {
	type DeployOptions,
	type ProjectInspection,
	resolveDatabaseChoice,
	resolveStorageChoice,
} from "../src/commands/deploy";
import { setGlobalOptions } from "../src/lib/output";

/**
 * A piped, non-JSON deploy (`--non-interactive` without `--json`) must take the
 * auto-detected resource default instead of dead-ending on a TTY prompt at
 * exit 6. These guards must treat non-interactive mode exactly like json mode.
 */

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

const INSPECTION: ProjectInspection = {
	database: "postgres",
	databaseReasons: ["found prisma schema"],
	git: { hasGit: false },
	storage: true,
	storageReasons: ["found multer usage"],
};

const OPTIONS: DeployOptions = {};

afterEach(() => {
	setGlobalOptions(RESET);
});

describe("resolveDatabaseChoice — non-interactive", () => {
	it("returns the auto-detected default without prompting", async () => {
		setGlobalOptions({ ...RESET, nonInteractive: true });
		await expect(resolveDatabaseChoice(OPTIONS, INSPECTION)).resolves.toBe(
			"postgres",
		);
	});

	it("still returns the default in json mode", async () => {
		setGlobalOptions({ ...RESET, json: true });
		await expect(resolveDatabaseChoice(OPTIONS, INSPECTION)).resolves.toBe(
			"postgres",
		);
	});
});

describe("resolveStorageChoice — non-interactive", () => {
	it("returns the auto-detected default without prompting", async () => {
		setGlobalOptions({ ...RESET, nonInteractive: true });
		await expect(resolveStorageChoice(OPTIONS, INSPECTION)).resolves.toBe(true);
	});

	it("still returns the default in json mode", async () => {
		setGlobalOptions({ ...RESET, json: true });
		await expect(resolveStorageChoice(OPTIONS, INSPECTION)).resolves.toBe(true);
	});
});
