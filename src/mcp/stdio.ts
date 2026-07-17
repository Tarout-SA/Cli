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
import { installExitGuard } from "./runtime.js";
import { createMcpServer } from "./server.js";

setGlobalOptions({
	json: true,
	quiet: true,
	nonInteractive: true,
	yes: true,
	noColor: true,
});

// A tool handler that transitively hits process.exit() (e.g. an un-annotated
// prompt → exit(NEEDS_INPUT)) would otherwise kill the whole stdio server. Arm
// the guard so such an exit throws a catchable error while a handler is running.
installExitGuard();

// Redirect anything that leaks through console.log to stderr so JSON-RPC on
// stdout stays clean. Do this BEFORE connecting the transport.
//
// We deliberately do NOT patch process.stdout.write: StdioServerTransport emits
// every JSON-RPC frame through it, so a blanket redirect or filter there would
// corrupt the transport itself. CLI helpers reused by tool handlers write human
// output via console.log (redirected above) or the outputJson* path (also
// console.log), never raw process.stdout.write — so the console.log hook is the
// correct, targeted chokepoint. The stdout-hygiene test exercises a real tool
// call and asserts stdout carries only valid JSON-RPC frames to cover the risk.
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
