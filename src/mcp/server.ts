/**
 * Assembles the McpServer. Each src/mcp/tools/<domain>.ts exports
 * registerTools(server) — server.ts is the only place that lists them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageJson from "../../package.json" with { type: "json" };
import { registerAppsTools } from "./tools/apps.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerCallTools } from "./tools/call.js";
import { registerContextTools } from "./tools/context.js";
import { registerDbTools } from "./tools/db.js";
import { registerDeployTools } from "./tools/deploy.js";
import { registerDomainTools } from "./tools/domains.js";
import { registerEnvTools } from "./tools/env.js";
import { registerStorageTools } from "./tools/storage.js";
import { guardServerHandlers } from "./runtime.js";

export function createMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "tarout", version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	// Wrap every handler (exit guard + result sanitization) before any tool is
	// registered so all of them are covered.
	guardServerHandlers(server);
	registerCallTools(server);
	registerContextTools(server);
	registerEnvTools(server);
	registerAppsTools(server);
	registerDbTools(server);
	registerStorageTools(server);
	registerDomainTools(server);
	registerBillingTools(server);
	registerDeployTools(server);
	return server;
}
