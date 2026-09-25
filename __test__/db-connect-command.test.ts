import { describe, expect, it } from "vitest";
import {
	getConnectCommand,
	getConnectionString,
} from "../src/commands/db.js";

const details = {
	poolerHost: "10.216.15.204",
	poolerPort: 6432,
	directHost: "172.27.176.5",
	directPort: 5432,
	databaseUser: "app_user",
	databasePassword: "secret",
	databaseName: "app_db",
	externalAccessEnabled: true,
	externalPoolerHost: "db.tarout.app",
	externalPoolerPort: 5432,
	externalSslRequired: true,
};

describe("database connection endpoint selection", () => {
	it("uses the public endpoint for a workstation CLI when external access is enabled", () => {
		const connection = getConnectCommand("postgres", details);

		expect(connection).toEqual({
			command: "psql",
			args: [
				"-h",
				"db.tarout.app",
				"-p",
				"5432",
				"-U",
				"app_user",
				"-d",
				"app_db",
			],
			env: { PGPASSWORD: "secret", PGSSLMODE: "require" },
		});
		// Matches the platform's externalConnectionString, which always carries
		// sslmode=require (external access is TLS-only).
		expect(getConnectionString("postgres", details)).toBe(
			"postgresql://app_user:****@db.tarout.app:5432/app_db?sslmode=require",
		);
	});

	it("falls back to the pooler port 6432, never the backend port 5432", () => {
		const connection = getConnectCommand("postgres", {
			...details,
			externalPoolerPort: null,
		});

		expect(connection.args).toEqual([
			"-h",
			"db.tarout.app",
			"-p",
			"6432",
			"-U",
			"app_user",
			"-d",
			"app_db",
		]);
	});

	it("always requires TLS on the external endpoint, even for a legacy externalSslRequired: false row", () => {
		const connection = getConnectCommand("postgres", {
			...details,
			externalSslRequired: false,
		});

		expect(connection.env).toEqual({ PGPASSWORD: "secret", PGSSLMODE: "require" });
	});

	it("reads host and port from externalConnectionString when the split fields are missing", () => {
		const connection = getConnectCommand("postgres", {
			...details,
			externalPoolerHost: null,
			externalPoolerPort: null,
			externalConnectionString:
				"postgresql://app_user:secret@pg.tarout.sa:6543/app_db?sslmode=require",
		});

		expect(connection.args.slice(0, 4)).toEqual([
			"-h",
			"pg.tarout.sa",
			"-p",
			"6543",
		]);
	});

	it("points at `tarout db external-access`, not the dashboard, when external access is off", () => {
		const internal = { ...details, externalAccessEnabled: false };

		expect(() => getConnectCommand("postgres", internal)).toThrow(
			/tarout db external-access/,
		);
		expect(() => getConnectCommand("postgres", internal)).not.toThrow(
			/dashboard/i,
		);
	});

	it("refuses to fall back to a private endpoint when external access is disabled", () => {
		const internal = { ...details, externalAccessEnabled: false };

		expect(() => getConnectCommand("postgres", internal)).toThrow(
			/External access is disabled or unavailable/,
		);
		expect(() => getConnectionString("postgres", internal)).toThrow(
			/External access is disabled or unavailable/,
		);
	});
});
