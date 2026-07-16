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
		expect(getConnectionString("postgres", details)).toBe(
			"postgresql://app_user:****@db.tarout.app:5432/app_db",
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
