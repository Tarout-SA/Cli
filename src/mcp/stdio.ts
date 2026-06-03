/**
 * Tarout MCP stdio bridge.
 *
 * Lets local agents (Claude Desktop, Cursor) that speak MCP over stdio use the
 * hosted Tarout MCP endpoint. It is a thin proxy: a stdio MCP server whose
 * tools/list and tools/call are forwarded to `${apiUrl}/api/mcp` (Streamable
 * HTTP) authenticated with the CLI's existing x-api-key. No tool logic is
 * duplicated — the catalog and handlers live server-side.
 *
 * Configure in Claude Desktop:
 *   { "mcpServers": { "tarout": { "command": "tarout-mcp" } } }
 * The token is read from the active CLI profile or the TAROUT_TOKEN env var.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getApiUrl, getToken, isLoggedIn } from "../lib/config.js";

async function main() {
	if (!isLoggedIn()) {
		console.error(
			"tarout-mcp: not authenticated. Run `tarout auth login` or set TAROUT_TOKEN.",
		);
		process.exit(1);
	}

	const token = getToken();
	const apiUrl = getApiUrl();

	// Upstream: hosted Tarout MCP endpoint over Streamable HTTP + x-api-key.
	const upstream = new Client(
		{ name: "tarout-mcp-bridge", version: "0.1.0" },
		{ capabilities: {} },
	);
	const upstreamTransport = new StreamableHTTPClientTransport(
		new URL(`${apiUrl}/api/mcp`),
		{
			requestInit: {
				headers: token ? { "x-api-key": token } : {},
			},
		},
	);
	await upstream.connect(upstreamTransport);

	// Downstream: expose the same tools to the local stdio client, forwarding
	// each request upstream.
	const server = new Server(
		{ name: "tarout", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () =>
		upstream.listTools(),
	);
	server.setRequestHandler(CallToolRequestSchema, async (request) =>
		upstream.callTool(request.params),
	);

	await server.connect(new StdioServerTransport());
}

main().catch((err) => {
	console.error("tarout-mcp bridge failed:", err);
	process.exit(1);
});
