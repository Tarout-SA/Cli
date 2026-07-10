#!/usr/bin/env node
/**
 * Tarout MCP stdio server — local, in-process replacement for the old proxy.
 *
 * Boot:
 *   1) Set global CLI options so any reused helper stays silent + non-interactive.
 *   2) Redirect console.log → stderr so a stray CLI print can't corrupt stdout.
 *      (StdioServerTransport writes JSON-RPC frames directly to process.stdout,
 *      bypassing console.*)
 *   3) Connect via StdioServerTransport. Auth is checked lazily per tool call.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setGlobalOptions } from "../lib/output.js";
import { createMcpServer } from "./server.js";

setGlobalOptions({
	json: true,
	quiet: true,
	nonInteractive: true,
	yes: true,
	noColor: true,
});

// Redirect anything that leaks through console.log to stderr so JSON-RPC on
// stdout stays clean. Do this BEFORE connecting the transport.
console.log = (...args: unknown[]) => {
	console.error(...args);
};

async function main() {
	const server = createMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error("tarout-mcp failed to start:", err);
	process.exit(1);
});
