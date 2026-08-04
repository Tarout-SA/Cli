import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => false,
	getToken: () => null,
	getApiUrl: () => "https://api.test",
	getProjectConfig: () => null,
	setProjectConfig: () => {},
	isProjectLinked: () => false,
	removeProjectConfig: () => {},
}));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server";

const EXPECTED_TOOLS = [
	// Discovery
	"call",
	"list_procedures",
	"describe_procedure",
	// Context
	"context_status",
	"context_switch",
	"link_app",
	"unlink_app",
	// Env
	"env_list",
	"env_set",
	"env_unset",
	"env_pull",
	"env_push",
	// Apps
	"app_list",
	"app_info",
	"app_create",
	"app_logs",
	"app_restart",
	"app_stop",
	"app_delete",
	// DB
	"db_list",
	"db_create",
	"db_info",
	"db_credentials",
	"db_sql",
	"db_import",
	"db_delete",
	"db_tables",
	"db_preview",
	"db_analytics",
	"db_stats",
	"db_backups",
	"db_backup_now",
	"db_backup_download",
	"db_restore",
	"db_restart",
	"db_stop",
	"db_reactivate",
	"db_update",
	"db_attach",
	"db_detach",
	"db_external_access",
	// Storage
	"storage_list",
	"storage_create",
	"storage_info",
	"storage_credentials",
	"storage_files",
	"storage_delete",
	"storage_upload",
	"storage_download",
	"storage_delete_file",
	"storage_create_folder",
	"storage_move",
	"storage_file_versions",
	"storage_restore_version",
	"storage_access_keys",
	"storage_access_key_create",
	"storage_access_key_revoke",
	// Domains
	"domain_list",
	"domain_link",
	"domain_verify",
	// Billing
	"billing_status",
	"billing_upgrade",
	// Deploy
	"deploy",
	"deployment_status",
	"deployment_logs",
	"deployment_retry",
	// Scheduled tasks (cron)
	"job_list",
	"job_info",
	"job_create",
	"job_update",
	"job_delete",
	"job_run",
	"job_runs",
] as const;

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

describe("MCP integration — catalog + auth envelope", () => {
	it("advertises every curated + discovery tool with legal names", async () => {
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const server = createMcpServer();
		await server.connect(st);
		const client = new Client(
			{ name: "test", version: "0" },
			{ capabilities: {} },
		);
		await client.connect(ct);
		try {
			const list = await client.listTools();
			const names = list.tools.map((t) => t.name).sort();
			const expected = [...EXPECTED_TOOLS].sort();
			expect(names).toEqual(expected);
			for (const name of names) {
				expect(name).toMatch(NAME_RE);
			}
		} finally {
			await client.close();
			await server.close();
		}
	});

	it("returns AUTH_ERROR envelope when not authenticated", async () => {
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const server = createMcpServer();
		await server.connect(st);
		const client = new Client(
			{ name: "test", version: "0" },
			{ capabilities: {} },
		);
		await client.connect(ct);
		try {
			const result = await client.callTool({
				name: "app_list",
				arguments: {},
			});
			expect(result.isError).toBe(true);
			const body = JSON.parse(
				(result.content as [{ text: string }])[0].text,
			) as { code: string };
			expect(body.code).toBe("AUTH_ERROR");
		} finally {
			await client.close();
			await server.close();
		}
	});
});
