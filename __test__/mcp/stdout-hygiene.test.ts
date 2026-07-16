import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const DIST = resolve(__dirname, "../../dist/mcp/stdio.js");

describe("stdio server — stdout hygiene", () => {
	beforeAll(() => {
		// The test drives the built entrypoint. Callers must build first.
		if (!existsSync(DIST)) {
			throw new Error(
				`Missing dist entry ${DIST}. Run \`bun run build\` before this test.`,
			);
		}
	});

	it("writes only JSON-RPC frames to stdout for tools/list", async () => {
		const child = spawn("node", [DIST], {
			env: { ...process.env, TAROUT_TOKEN: "fake" },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

		// Send an MCP initialize + tools/list request.
		const init = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "hygiene-test", version: "0" },
			},
		});
		const list = JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		});
		child.stdin.write(`${init}\n${list}\n`);

		// Give the server a moment to respond, then close stdin.
		await new Promise((r) => setTimeout(r, 300));
		child.stdin.end();

		await new Promise<void>((r) => child.on("exit", () => r()));

		const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
		expect(stdout.length).toBeGreaterThan(0);

		for (const line of stdout.split("\n").filter((l) => l.length > 0)) {
			expect(() => JSON.parse(line)).not.toThrow();
			const parsed = JSON.parse(line) as { jsonrpc?: string };
			expect(parsed.jsonrpc).toBe("2.0");
		}
	}, 10_000);
});
