import { describe, expect, it } from "vitest";
import { pickServerSshKeys } from "../src/commands/servers.js";
import { NotFoundError } from "../src/lib/errors.js";

// Production 2026-09-23: a key set with `tarout keys default` was not installed
// on a server made by `tarout servers create`, so the user's key could not log in.
const saved = [
	{ id: "k1", name: "laptop", isDefault: true },
	{ id: "k2", name: "ci", isDefault: false },
	{ id: "k3", name: "desktop", isDefault: true },
];

describe("pickServerSshKeys", () => {
	it("installs the default keys when no --key is given", () => {
		expect(pickServerSshKeys(saved, {})).toEqual({ keyIds: ["k1", "k3"], names: ["laptop", "desktop"], source: "default" });
	});

	it("honours --key by name or id over the defaults", () => {
		expect(pickServerSshKeys(saved, { keys: ["ci", "k1"] })).toEqual({ keyIds: ["k2", "k1"], names: ["ci", "laptop"], source: "explicit" });
	});

	it("rejects an unknown --key before anything is created", () => {
		expect(() => pickServerSshKeys(saved, { keys: ["lapto"] })).toThrow(NotFoundError);
	});

	it("generates a key pair only with --generate-key or with no saved default", () => {
		expect(pickServerSshKeys(saved, { generateKey: true }).source).toBe("generated");
		expect(pickServerSshKeys([{ id: "k2", name: "ci" }], {})).toEqual({ keyIds: [], names: [], source: "generated" });
	});
});
