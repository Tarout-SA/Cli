import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const CLI_ROOT = resolve(__dirname, "../..");
const SRC_MCP = resolve(CLI_ROOT, "src/mcp");
const DIST = resolve(CLI_ROOT, "dist/mcp/stdio.js");

/** Newest mtime (ms) of any file under `dir`, recursively. 0 if none/absent. */
function maxMtimeMs(dir: string): number {
	let newest = 0;
	let entries: string[];
	try {
		entries = readdirSync(dir, { recursive: true }) as string[];
	} catch {
		return 0;
	}
	for (const rel of entries) {
		const full = join(dir, rel.toString());
		try {
			const s = statSync(full);
			if (s.isFile() && s.mtimeMs > newest) newest = s.mtimeMs;
		} catch {
			// entry vanished between readdir and stat — ignore
		}
	}
	return newest;
}

describe("stdio server — stdout hygiene", () => {
	beforeAll(() => {
		// The test drives the BUILT entrypoint, so it must validate current source.
		// If any src/mcp file is newer than the built artifact (or dist is missing),
		// rebuild before proceeding so stale dist can never mask a regression.
		const distMtime = existsSync(DIST) ? statSync(DIST).mtimeMs : 0;
		if (!existsSync(DIST) || maxMtimeMs(SRC_MCP) > distMtime) {
			execFileSync("bun", ["run", "build"], {
				cwd: CLI_ROOT,
				timeout: 90_000,
				stdio: "inherit",
			});
		}
		if (!existsSync(DIST)) {
			throw new Error(
				`Missing dist entry ${DIST} after build. Run \`bun run build\` manually.`,
			);
		}
	}, 100_000);

	it("writes only JSON-RPC frames to stdout across init + tools/list + a tool call", async () => {
		const child = spawn("node", [DIST], {
			env: { ...process.env, TAROUT_TOKEN: "fake" },
			stdio: ["pipe", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

		// Send an MCP initialize + tools/list + a tool call.
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
		const initialized = JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		const list = JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list",
			params: {},
		});
		// db_sql with a mysql type fails fast (INVALID_ARGUMENTS) before any auth
		// check or network call — a deterministic way to exercise the full tool
		// handler path (guard wrapper + sanitizer + envelope) with no network.
		const call = JSON.stringify({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "db_sql",
				arguments: { type: "mysql", db: "x", sql: "SELECT 1" },
			},
		});
		child.stdin.write(`${init}\n${initialized}\n${list}\n${call}\n`);

		// Give the server a moment to respond, then close stdin.
		await new Promise((r) => setTimeout(r, 500));
		child.stdin.end();

		await new Promise<void>((r) => child.on("exit", () => r()));

		const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
		expect(stdout.length).toBeGreaterThan(0);

		const frames = stdout.split("\n").filter((l) => l.length > 0);
		for (const line of frames) {
			expect(() => JSON.parse(line)).not.toThrow();
			const parsed = JSON.parse(line) as { jsonrpc?: string };
			expect(parsed.jsonrpc).toBe("2.0");
		}

		// The tool-call response (id 3) must have arrived as a JSON-RPC frame.
		const toolResponse = frames
			.map((l) => JSON.parse(l) as { id?: number; result?: unknown })
			.find((m) => m.id === 3);
		expect(toolResponse).toBeDefined();
		expect(toolResponse?.result).toBeDefined();
	}, 10_000);
});
