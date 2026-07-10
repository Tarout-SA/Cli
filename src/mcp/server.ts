/**
 * Assembles the McpServer. Each src/mcp/tools/<domain>.ts exports
 * registerTools(server) — server.ts is the only place that lists them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageJson from "../../package.json" with { type: "json" };
import { registerAppsTools } from "./tools/apps.js";
import { registerCallTools } from "./tools/call.js";
import { registerContextTools } from "./tools/context.js";
import { registerDbTools } from "./tools/db.js";
import { registerEnvTools } from "./tools/env.js";

export function createMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "tarout", version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	registerCallTools(server);
	registerContextTools(server);
	registerEnvTools(server);
	registerAppsTools(server);
	registerDbTools(server);
	return server;
}
