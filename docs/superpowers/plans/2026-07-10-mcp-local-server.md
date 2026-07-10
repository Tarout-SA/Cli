# Tarout local MCP server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 69-line stdio proxy at `src/mcp/stdio.ts` with a self-contained local MCP server that gives coding agents CLI parity — ~36 curated tools + a generic `call` escape hatch — while reusing verified CLI internals.

**Architecture:** A `McpServer` (SDK high-level) assembled in `src/mcp/server.ts` from per-domain tool modules under `src/mcp/tools/`. Every handler goes through `runtime.ts::withAuth` (lazy per-call auth, JSON error envelope). Reuses `inspectCurrentProject`, `uploadCurrentDirectorySource`, `createAppFromCurrentDirectory`, `performBillingChange`, `getProjectConfig`/`setProjectConfig`, and the existing untyped tRPC client from `lib/api.ts`. Long-tail procedures reachable via `call` / `list_procedures` / `describe_procedure`, powered by an extracted `surface-manifest.ts` lib.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk` ^1.29.0, `@trpc/client` (untyped proxy), Zod, vitest.

## Global Constraints

- Work only in the worktree `/home/stanoid/tarout/cli-mcp-local` on branch `feat/mcp-local-server`. Do NOT edit `/home/stanoid/tarout/cli` directly.
- One small platform PR: `platform/public/agent-setup/prompt.md`. Everything else lives under `@tarout/cli`.
- MCP tool names MUST match `^[a-zA-Z0-9_-]{1,64}$` — validated in the contract test.
- Handlers MUST NOT `process.exit`, MUST NOT call `handleError()` from `lib/errors.ts`, MUST NOT call `outputJsonLine`, `promptOrEmit`, or `emitNeedsUpgrade`. Errors flow through `runtime.ts::toEnvelope`.
- Every FS-touching tool accepts an optional `path` param defaulting to the server process cwd.
- Deploy timeout is an outcome (`status: "in_progress"` + `deploymentId`), not an error.
- Curated tool names use `snake_case`. Long-tail procedures reached via `call { procedure: "router.name" }` keep the tRPC dot-path.
- Reuse the untyped tRPC client from `getApiClient()` (`src/lib/api.ts`). Add `// biome-ignore lint/suspicious/noExplicitAny` where the SDK requires `any` on client-side procedure return shapes.
- Node ^18.
- MCP SDK entry points to use:
  - `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`
  - `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"`
  - `import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"` (tests only)
  - `import { Client } from "@modelcontextprotocol/sdk/client/index.js"` (tests + `describe_procedure`)
  - `import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"` (`describe_procedure` only)
- `registerTool(name, config, cb)` config shape: `{ title?, description?, inputSchema?, annotations? }`. `inputSchema` is a **ZodRawShape** (a plain object of Zod fields — not `z.object({...})`).
- Test commands: `bun run test:vitest`, `bun run typecheck`, `bun run lint`. Baseline before changes: run `bun run test:vitest` and record the number — every task's success gate must include "existing tests still pass."
- Commit style: conventional (`feat(mcp):`/`fix(mcp):`/`refactor(cli):`/`docs(mcp):`) with the trailer:

  ```
  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```

## File Structure

New (CLI):
- `src/mcp/runtime.ts` — auth guard, error envelope, result helpers.
- `src/mcp/server.ts` — assembles `McpServer`, registers all tool modules.
- `src/mcp/tools/call.ts` — `call`, `list_procedures`, `describe_procedure`.
- `src/mcp/tools/context.ts` — `context_status`, `context_switch`, `link_app`, `unlink_app`.
- `src/mcp/tools/env.ts` — `env_list`, `env_set`, `env_unset`, `env_pull`, `env_push`.
- `src/mcp/tools/apps.ts` — 7 curated app tools.
- `src/mcp/tools/db.ts` — 6 curated db tools.
- `src/mcp/tools/storage.ts` — 6 curated storage tools.
- `src/mcp/tools/domains.ts` — 3 curated domain tools.
- `src/mcp/tools/billing.ts` — `billing_status`, `billing_upgrade`.
- `src/mcp/tools/deploy.ts` — `deploy`, `deployment_status`, `deployment_logs`.
- `src/lib/env-core.ts` — extracted dotenv parse/serialize + app resolver.
- `src/lib/surface-manifest.ts` — extracted manifest cache (from `commands/call.ts`).

Modified (CLI):
- `src/mcp/stdio.ts` — replace proxy with new boot sequence.
- `src/commands/call.ts` — thin re-export over `src/lib/surface-manifest.ts`.
- `src/commands/env.ts` — call `src/lib/env-core.ts` for parse/serialize.
- `src/commands/deploy.ts` — promote `createSourceArchive` to `export`.
- `README.md` — MCP install section (Claude Code / Cursor / Claude Desktop).
- `CHANGELOG.md` — `[1.2.0]` entry.
- `package.json` — bump `version` to `1.2.0`.

Tests (CLI):
- `__test__/mcp/runtime.test.ts`
- `__test__/mcp/stdout-hygiene.test.ts`
- `__test__/mcp/tools-call.test.ts`
- `__test__/mcp/tools-env.test.ts`
- `__test__/mcp/tools-context.test.ts`
- `__test__/mcp/tools-apps.test.ts`
- `__test__/mcp/tools-db.test.ts`
- `__test__/mcp/tools-storage.test.ts`
- `__test__/mcp/tools-domains.test.ts`
- `__test__/mcp/tools-billing.test.ts`
- `__test__/mcp/tools-deploy.test.ts`
- `__test__/mcp/integration-catalog.test.ts`
- `__test__/env-core.test.ts` (moved from inline in `env.ts`)
- `__test__/surface-manifest.test.ts` (moved from inline in `call.ts`)

New (platform, separate PR):
- `platform/public/agent-setup/prompt.md`

---

### Task 1: Baseline

**Files:** none (verification only).

**Interfaces:** produces `TESTS_BASELINE=<N>` for later tasks' success gates.

- [ ] **Step 1: Confirm worktree + branch**

Run: `git rev-parse --show-toplevel && git branch --show-current`
Expected: `/home/stanoid/tarout/cli-mcp-local` and `feat/mcp-local-server`.

- [ ] **Step 2: Confirm `node_modules` symlink**

Run: `ls -la node_modules | head -1`
Expected: `node_modules -> /home/stanoid/tarout/cli/node_modules` (symlink).

- [ ] **Step 3: Record baseline**

Run: `bun run test:vitest 2>&1 | tail -20`
Expected: all tests PASS. Record the number of tests as `TESTS_BASELINE`. Every subsequent task's success gate is "existing tests still pass, and my new tests pass on top."

Run: `bun run typecheck && bun run lint`
Expected: both PASS.

- [ ] **Step 4: No commit for this task** — verification only.

---

### Task 2: `runtime.ts` — auth guard + error envelope

**Files:**
- Create: `src/mcp/runtime.ts`
- Create: `__test__/mcp/runtime.test.ts`

**Interfaces:**
- Produces:
  - `type Envelope = { error: string; code: string; remediation?: string; details?: unknown }`
  - `type ToolText = { content: [{ type: "text"; text: string }]; isError?: boolean; structuredContent?: unknown }`
  - `okResult(data: unknown): ToolText` — returns `{ content: [{ type:"text", text: JSON.stringify(data,null,2) }], structuredContent: data }`.
  - `errorResult(env: Envelope): ToolText` — `isError: true`.
  - `toEnvelope(err: unknown, procedurePath?: string): Envelope` — maps `AuthError`, `CliError`, tRPC errors, deploy errors, unknowns.
  - `withAuth<T>(fn: (client: TrpcClient) => Promise<T>): Promise<ToolText>` — checks `isLoggedIn()`, calls `getApiClient()`, invokes `fn`, wraps any throw via `toEnvelope`, returns `okResult(result)` on success.

- [ ] **Step 1: Write the failing tests**

```ts
// __test__/mcp/runtime.test.ts
import { describe, expect, it, vi } from "vitest";
import { AuthError, CliError, DeploymentFailedError } from "../../src/lib/errors";
import { errorResult, okResult, toEnvelope, withAuth } from "../../src/mcp/runtime";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: vi.fn(),
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));
vi.mock("../../src/lib/api", () => ({
	getApiClient: vi.fn(),
	resetApiClient: vi.fn(),
}));

// biome-ignore lint/suspicious/noExplicitAny: test-only untyped import.
import { isLoggedIn } from "../../src/lib/config" as any;
// biome-ignore lint/suspicious/noExplicitAny: test-only untyped import.
import { getApiClient } from "../../src/lib/api" as any;

describe("okResult", () => {
	it("serializes JSON and mirrors data on structuredContent", () => {
		const r = okResult({ x: 1 });
		expect(r.isError).toBeUndefined();
		expect(r.content[0].text).toBe(JSON.stringify({ x: 1 }, null, 2));
		expect(r.structuredContent).toEqual({ x: 1 });
	});

	it("stringifies raw strings verbatim", () => {
		const r = okResult("hi");
		expect(r.content[0].text).toBe('"hi"');
	});
});

describe("toEnvelope", () => {
	it("maps AuthError to AUTH_ERROR with login remediation", () => {
		const e = toEnvelope(new AuthError());
		expect(e.code).toBe("AUTH_ERROR");
		expect(e.remediation).toMatch(/tarout login/);
	});

	it("maps CliError to its own code", () => {
		const e = toEnvelope(new CliError("nope", "NOT_FOUND"));
		expect(e.code).toBe("NOT_FOUND");
		expect(e.error).toBe("nope");
	});

	it("maps DeploymentFailedError and preserves deploymentId", () => {
		const e = toEnvelope(new DeploymentFailedError("bad", { deploymentId: "d1" }));
		expect(e.code).toBe("DEPLOYMENT_FAILED");
		expect((e.details as { deploymentId?: string }).deploymentId).toBe("d1");
	});

	it("maps tRPC-shaped errors via data.code", () => {
		const err = Object.assign(new Error("no slot"), {
			data: { code: "FORBIDDEN" },
		});
		const e = toEnvelope(err);
		expect(e.code).toBe("FORBIDDEN");
		expect(e.error).toBe("no slot");
	});

	it("falls back to GENERAL_ERROR", () => {
		const e = toEnvelope(new Error("boom"));
		expect(e.code).toBe("GENERAL_ERROR");
		expect(e.error).toBe("boom");
	});
});

describe("withAuth", () => {
	it("returns AUTH_ERROR envelope when not logged in", async () => {
		(isLoggedIn as any).mockReturnValue(false);
		const r = await withAuth(async () => "unused");
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("AUTH_ERROR");
	});

	it("passes the tRPC client to the handler and wraps success", async () => {
		(isLoggedIn as any).mockReturnValue(true);
		const fakeClient = { user: { get: { query: async () => ({ id: "u1" }) } } };
		(getApiClient as any).mockReturnValue(fakeClient);
		const r = await withAuth(async (c) => await c.user.get.query());
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { id: string };
		expect(body.id).toBe("u1");
	});

	it("catches handler throws and maps them via toEnvelope", async () => {
		(isLoggedIn as any).mockReturnValue(true);
		(getApiClient as any).mockReturnValue({});
		const r = await withAuth(async () => {
			throw new AuthError();
		});
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content[0].text).code).toBe("AUTH_ERROR");
	});
});

describe("errorResult", () => {
	it("stamps isError:true and JSON envelope", () => {
		const r = errorResult({ error: "x", code: "GENERAL_ERROR" });
		expect(r.isError).toBe(true);
		expect(JSON.parse(r.content[0].text)).toEqual({ error: "x", code: "GENERAL_ERROR" });
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/runtime.test.ts`
Expected: FAIL — module `src/mcp/runtime` not found.

- [ ] **Step 3: Implement `src/mcp/runtime.ts`**

```ts
/**
 * MCP tool runtime — shared auth guard, error → JSON envelope mapping, and
 * result helpers used by every tool handler.
 *
 * Handlers NEVER call process.exit(), handleError(), or any CLI output helper
 * that writes to stdout (outputJsonLine / promptOrEmit / emitNeedsUpgrade).
 * They return one of the two shapes below via okResult()/errorResult().
 */
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	BuildFailedError,
	CliError,
	DeploymentFailedError,
	DeploymentTimeoutError,
	NotFoundError,
} from "../lib/errors.js";

export interface Envelope {
	error: string;
	code: string;
	remediation?: string;
	details?: unknown;
}

export interface ToolText {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	structuredContent?: unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
export type TrpcClient = any;

export function okResult(data: unknown): ToolText {
	const text =
		typeof data === "string" ? JSON.stringify(data) : JSON.stringify(data, null, 2);
	return {
		content: [{ type: "text", text }],
		structuredContent: data === undefined ? null : (data as unknown),
	};
}

export function errorResult(env: Envelope): ToolText {
	return {
		content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
		isError: true,
	};
}

const AUTH_REMEDIATION =
	"Run `tarout login` on the machine running this MCP server, or set the TAROUT_TOKEN env var to an API key.";

export function toEnvelope(err: unknown, procedurePath?: string): Envelope {
	if (err instanceof AuthError) {
		return { error: err.message, code: "AUTH_ERROR", remediation: AUTH_REMEDIATION };
	}
	if (err instanceof DeploymentFailedError) {
		return {
			error: err.message,
			code: "DEPLOYMENT_FAILED",
			details: { deploymentId: err.deploymentId, errorAnalysis: err.errorAnalysis },
		};
	}
	if (err instanceof BuildFailedError) {
		return {
			error: err.message,
			code: "BUILD_FAILED",
			details: { deploymentId: err.deploymentId },
		};
	}
	if (err instanceof DeploymentTimeoutError) {
		return {
			error: err.message,
			code: "DEPLOYMENT_TIMEOUT",
			details: { deploymentId: err.deploymentId },
		};
	}
	if (err instanceof NotFoundError) {
		return { error: err.message, code: "NOT_FOUND" };
	}
	if (err instanceof CliError) {
		return { error: err.message, code: err.code, details: err.details };
	}
	// tRPC client errors carry a `.data.code` from the server (FORBIDDEN, ...).
	if (
		err &&
		typeof err === "object" &&
		"data" in err &&
		err.data &&
		typeof (err as { data: { code?: unknown } }).data.code === "string"
	) {
		const e = err as { message?: string; data: { code: string } };
		return {
			error: e.message ?? "tRPC error",
			code: e.data.code,
			details: procedurePath ? { procedure: procedurePath } : undefined,
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return { error: message, code: "GENERAL_ERROR" };
}

export async function withAuth(
	fn: (client: TrpcClient) => Promise<unknown>,
	procedurePath?: string,
): Promise<ToolText> {
	if (!isLoggedIn()) {
		return errorResult({
			error: "Not authenticated.",
			code: "AUTH_ERROR",
			remediation: AUTH_REMEDIATION,
		});
	}
	try {
		const client = getApiClient();
		const result = await fn(client);
		return okResult(result);
	} catch (err) {
		return errorResult(toEnvelope(err, procedurePath));
	}
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/runtime.test.ts && bun run typecheck && bun run lint`
Expected: all tests PASS; typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/runtime.ts __test__/mcp/runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add runtime — auth guard, envelope, result helpers

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Server scaffold + stdio hygiene

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/mcp/stdio.ts` (replace proxy)
- Create: `__test__/mcp/stdout-hygiene.test.ts`

**Interfaces:**
- Produces:
  - `createMcpServer(): McpServer` in `src/mcp/server.ts` — returns an assembled server with all tool modules registered (initially only the discovery module; subsequent tasks add more via `registerTools(server)` from `tools/*.ts`).
  - Convention: every `src/mcp/tools/<domain>.ts` exports `registerTools(server: McpServer): void`. `server.ts` imports each and calls them.

- [ ] **Step 1: Write the failing hygiene test** — spawns the built server as a child process, sends a `tools/list` JSON-RPC frame on stdin, asserts stdout only contains valid JSON-RPC frames.

```ts
// __test__/mcp/stdout-hygiene.test.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
		if (!stdout) return; // No frames yet: OK, at least nothing garbage.

		for (const line of stdout.split("\n").filter((l) => l.length > 0)) {
			expect(() => JSON.parse(line)).not.toThrow();
			const parsed = JSON.parse(line) as { jsonrpc?: string };
			expect(parsed.jsonrpc).toBe("2.0");
		}
	}, 10_000);
});
```

- [ ] **Step 2: Run — expect FAIL** (either missing dist or transport writes text). Expected: FAIL.

Run: `bun run build && bun run test:vitest __test__/mcp/stdout-hygiene.test.ts`
Expected: FAIL — `src/mcp/server` module not found, or dist missing after the current proxy is deleted.

- [ ] **Step 3: Implement `src/mcp/server.ts`**

```ts
/**
 * Assembles the McpServer. Each src/mcp/tools/<domain>.ts exports
 * registerTools(server) — server.ts is the only place that lists them.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageJson from "../../package.json" with { type: "json" };

export function createMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "tarout", version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	// Tool modules are wired in by later tasks:
	//   registerCallTools(server); registerContextTools(server); ...
	return server;
}
```

- [ ] **Step 4: Replace `src/mcp/stdio.ts`** with the new boot sequence.

```ts
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
```

- [ ] **Step 5: Verify `setGlobalOptions` accepts these keys**

Run: `grep -n "quiet\|nonInteractive\|noColor\|yes\|json" src/lib/output.ts | head`
Expected: all five keys present in the `globalOptions` shape. If any key doesn't exist, extend the shape in `src/lib/output.ts` and add the field to `setGlobalOptions`'s `Partial<>` argument (no test needed — the type widens by inclusion).

- [ ] **Step 6: Rebuild + rerun the hygiene test**

Run: `bun run build && bun run test:vitest __test__/mcp/stdout-hygiene.test.ts`
Expected: PASS.

- [ ] **Step 7: Full sweep**

Run: `bun run test:vitest && bun run typecheck && bun run lint`
Expected: all PASS (existing baseline + new hygiene test).

- [ ] **Step 8: Commit**

```bash
git add src/mcp/server.ts src/mcp/stdio.ts __test__/mcp/stdout-hygiene.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): replace stdio proxy with local McpServer scaffold

Sets global non-interactive options + redirects console.log to stderr so
stray CLI prints can't corrupt JSON-RPC on stdout. Tool modules wire in
via server.ts in subsequent commits.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Extract `surface-manifest.ts`

**Files:**
- Create: `src/lib/surface-manifest.ts`
- Modify: `src/commands/call.ts` (delete inline manifest helpers; import from the new lib)
- Create: `__test__/surface-manifest.test.ts`

**Interfaces:**
- Produces:
  - `type ManifestEntry = { path: string; type: "query" | "mutation" | "subscription"; router: string }`
  - `fetchManifestFresh(client: TrpcClient, apiUrl: string): Promise<ManifestEntry[]>`
  - `loadManifest(client: TrpcClient, apiUrl: string): Promise<ManifestEntry[]>` — TTL 5 min, cache under `~/.tarout/surface-manifest-cache.json`.
  - `manifestCachePath(): string` (for tests).

- [ ] **Step 1: Write the failing test**

```ts
// __test__/surface-manifest.test.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redirect HOME so the cache file lands in a scratch dir per test.
const SCRATCH = join(tmpdir(), `tarout-manifest-${process.pid}`);
vi.stubGlobal("process", { ...process, env: { ...process.env, HOME: SCRATCH } });

import { fetchManifestFresh, loadManifest } from "../src/lib/surface-manifest";

beforeEach(() => {
	rmSync(SCRATCH, { recursive: true, force: true });
	mkdirSync(SCRATCH, { recursive: true });
});
afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

function fakeClient(list: Array<{ path: string; type: string; router: string }>) {
	return {
		settings: {
			getSurfaceManifest: { query: vi.fn().mockResolvedValue(list) },
		},
	};
}

describe("surface-manifest", () => {
	it("fetchManifestFresh calls settings.getSurfaceManifest and writes cache", async () => {
		const client = fakeClient([{ path: "user.get", type: "query", router: "user" }]);
		const list = await fetchManifestFresh(client, "https://api.test");
		expect(list).toHaveLength(1);
		expect(client.settings.getSurfaceManifest.query).toHaveBeenCalledTimes(1);
		expect(existsSync(join(SCRATCH, ".tarout", "surface-manifest-cache.json"))).toBe(true);
	});

	it("loadManifest returns cached result inside TTL without refetching", async () => {
		const client = fakeClient([{ path: "user.get", type: "query", router: "user" }]);
		await fetchManifestFresh(client, "https://api.test");
		client.settings.getSurfaceManifest.query.mockClear();
		const list = await loadManifest(client, "https://api.test");
		expect(list).toHaveLength(1);
		expect(client.settings.getSurfaceManifest.query).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/surface-manifest.test.ts`
Expected: FAIL — module `src/lib/surface-manifest` not found.

- [ ] **Step 3: Create `src/lib/surface-manifest.ts` by lifting from `src/commands/call.ts`**

```ts
/**
 * Cached fetch of the platform's surface manifest (list of exposed tRPC
 * procedures). Shared by `tarout call` and by the local MCP server's
 * discovery + escape-hatch tools. TTL is 5 min; a cache MISS for a requested
 * path triggers a fresh refetch upstream (never a false "unknown procedure").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export interface ManifestEntry {
	path: string;
	type: "query" | "mutation" | "subscription";
	router: string;
}

const MANIFEST_TTL_MS = 5 * 60 * 1000;

export function manifestCachePath(): string {
	return join(homedir(), ".tarout", "surface-manifest-cache.json");
}

export async function fetchManifestFresh(
	client: TrpcClient,
	apiUrl: string,
): Promise<ManifestEntry[]> {
	const manifest = (await client.settings.getSurfaceManifest.query()) as ManifestEntry[];
	try {
		const dir = join(homedir(), ".tarout");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		let cache: Record<string, { at: number; manifest: ManifestEntry[] }> = {};
		try {
			cache = JSON.parse(readFileSync(manifestCachePath(), "utf8"));
		} catch {
			// no/invalid cache — start fresh
		}
		cache[apiUrl] = { at: Date.now(), manifest };
		writeFileSync(manifestCachePath(), JSON.stringify(cache), { mode: 0o600 });
	} catch {
		// caching is best-effort
	}
	return manifest;
}

export async function loadManifest(
	client: TrpcClient,
	apiUrl: string,
): Promise<ManifestEntry[]> {
	try {
		const cache = JSON.parse(readFileSync(manifestCachePath(), "utf8")) as Record<
			string,
			{ at: number; manifest: ManifestEntry[] }
		>;
		const entry = cache[apiUrl];
		if (
			entry &&
			Date.now() - entry.at < MANIFEST_TTL_MS &&
			Array.isArray(entry.manifest)
		) {
			return entry.manifest;
		}
	} catch {
		// cache miss/corruption
	}
	return fetchManifestFresh(client, apiUrl);
}
```

- [ ] **Step 4: Rewrite `src/commands/call.ts`** to import from the new lib.

In `src/commands/call.ts`:
1. Delete the local `ManifestEntry` interface, `MANIFEST_TTL_MS`, `manifestCachePath`, `fetchManifestFresh`, `loadManifest` (all currently inlined).
2. Add: `import { fetchManifestFresh, loadManifest, type ManifestEntry } from "../lib/surface-manifest.js";`

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest && bun run typecheck && bun run lint`
Expected: new manifest tests PASS; existing `call.test.ts` still PASSes; typecheck + lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/surface-manifest.ts src/commands/call.ts __test__/surface-manifest.test.ts
git commit -m "$(cat <<'EOF'
refactor(cli): extract surface-manifest to a shared lib

Same behavior as commands/call.ts — moved out so the local MCP server's
call / list_procedures / describe_procedure tools can reuse it.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `call`, `list_procedures`, `describe_procedure`

**Files:**
- Create: `src/mcp/tools/call.ts`
- Modify: `src/mcp/server.ts` (call `registerCallTools(server)`)
- Create: `__test__/mcp/tools-call.test.ts`

**Interfaces:**
- Consumes: `withAuth`, `okResult`, `errorResult`, `toEnvelope` from `runtime.ts`; `fetchManifestFresh`, `loadManifest` from `surface-manifest.ts`; `getApiUrl` from `lib/config.ts`.
- Produces: `registerCallTools(server: McpServer): void`.
- Tool names (final, MCP-legal): `call`, `list_procedures`, `describe_procedure`.

- [ ] **Step 1: Write the failing test**

```ts
// __test__/mcp/tools-call.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient: {
	settings: { getSurfaceManifest: { query: ReturnType<typeof vi.fn> } };
	user: { get: { query: ReturnType<typeof vi.fn> } };
	application: { create: { mutate: ReturnType<typeof vi.fn> } };
} = {
	settings: {
		getSurfaceManifest: {
			query: vi.fn().mockResolvedValue([
				{ path: "user.get", type: "query", router: "user" },
				{ path: "application.create", type: "mutation", router: "application" },
			]),
		},
	},
	user: { get: { query: vi.fn().mockResolvedValue({ id: "u1" }) } },
	application: { create: { mutate: vi.fn().mockResolvedValue({ id: "a1" }) } },
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCallTools } from "../../src/mcp/tools/call";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerCallTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("call tool", () => {
	it("dispatches queries via the manifest", async () => {
		const r = await invoke("call", { procedure: "user.get", input: {} });
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content[0].text)).toEqual({ id: "u1" });
		expect(fakeClient.user.get.query).toHaveBeenCalledWith({});
	});

	it("dispatches mutations via the manifest", async () => {
		const r = await invoke("call", {
			procedure: "application.create",
			input: { name: "x" },
		});
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.create.mutate).toHaveBeenCalledWith({ name: "x" });
	});

	it("returns a structured error for unknown procedures", async () => {
		const r = await invoke("call", { procedure: "does.not.exist", input: {} });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("NOT_FOUND");
	});
});

describe("list_procedures tool", () => {
	it("returns the full manifest with no filter", async () => {
		const r = await invoke("list_procedures", {});
		const body = JSON.parse(r.content[0].text) as { count: number };
		expect(body.count).toBeGreaterThanOrEqual(2);
	});

	it("filters by substring", async () => {
		const r = await invoke("list_procedures", { filter: "application" });
		const body = JSON.parse(r.content[0].text) as { count: number };
		expect(body.count).toBe(1);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-call.test.ts`
Expected: FAIL — `src/mcp/tools/call` not found.

- [ ] **Step 3: Implement `src/mcp/tools/call.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getApiClient } from "../../lib/api.js";
import { getApiUrl } from "../../lib/config.js";
import {
	fetchManifestFresh,
	loadManifest,
	type ManifestEntry,
} from "../../lib/surface-manifest.js";
import { errorResult, okResult, toEnvelope, withAuth } from "../runtime.js";

async function resolveEntry(procedure: string): Promise<ManifestEntry | undefined> {
	const client = getApiClient();
	const apiUrl = getApiUrl();
	let manifest = await loadManifest(client, apiUrl);
	let entry = manifest.find((m) => m.path === procedure);
	if (!entry) {
		manifest = await fetchManifestFresh(client, apiUrl);
		entry = manifest.find((m) => m.path === procedure);
	}
	return entry;
}

export function registerCallTools(server: McpServer): void {
	server.registerTool(
		"call",
		{
			title: "Call a raw platform procedure",
			description:
				"Dispatches any exposed tRPC procedure (dot-path). Use list_procedures / describe_procedure to discover shapes. Prefer curated tools when they exist.",
			inputSchema: {
				procedure: z
					.string()
					.describe("Procedure dot-path, e.g. `application.allByOrganization`."),
				input: z
					.record(z.unknown())
					.optional()
					.describe("JSON input for the procedure. Default: empty object."),
			},
		},
		async ({ procedure, input }) => {
			return withAuth(async (client) => {
				const entry = await resolveEntry(procedure);
				if (!entry) {
					throw Object.assign(new Error(`Unknown procedure: ${procedure}`), {
						code: "NOT_FOUND",
					});
				}
				const [routerKey, procKey] = procedure.split(".") as [string, string];
				const node = client[routerKey]?.[procKey];
				if (!node) {
					throw Object.assign(new Error(`Procedure path not on client: ${procedure}`), {
						code: "NOT_FOUND",
					});
				}
				return entry.type === "mutation"
					? await node.mutate(input ?? {})
					: await node.query(input ?? {});
			}, procedure).then((r) => {
				// Rewrite NOT_FOUND thrown above as a real NOT_FOUND envelope
				// (toEnvelope defaults unknown Errors to GENERAL_ERROR).
				if (r.isError) {
					try {
						const body = JSON.parse(r.content[0].text) as { error: string; code: string };
						if (body.error.startsWith("Unknown procedure") || body.error.startsWith("Procedure path")) {
							return errorResult({
								error: body.error,
								code: "NOT_FOUND",
								remediation: "Run list_procedures to see the current surface.",
							});
						}
					} catch {
						/* not JSON — leave as-is */
					}
				}
				return r;
			});
		},
	);

	server.registerTool(
		"list_procedures",
		{
			title: "List all callable platform procedures",
			description:
				"Returns the full manifest (name + query/mutation). Optional `filter` matches procedures whose path contains the substring.",
			inputSchema: {
				filter: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ filter }) =>
			withAuth(async (client) => {
				const manifest = await fetchManifestFresh(client, getApiUrl());
				const matched = manifest.filter((m) => !filter || m.path.includes(filter));
				return { count: matched.length, procedures: matched };
			}),
	);

	server.registerTool(
		"describe_procedure",
		{
			title: "Describe a procedure's input schema",
			description:
				"Returns the JSON Schema the hosted MCP endpoint advertises for a given procedure. Useful before calling `call`.",
			inputSchema: {
				procedure: z.string(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ procedure }) =>
			withAuth(async () => {
				// The hosted /api/mcp `tools/list` builds JSON schemas via zodToJsonSchema.
				// Fetch it once per process and cache in a module-local Map.
				const cached = await describeCache();
				const key = procedure.replace(/\./g, "__");
				const found = cached.get(key);
				if (!found) {
					throw Object.assign(new Error(`Unknown procedure: ${procedure}`), {
						code: "NOT_FOUND",
					});
				}
				return found;
			}, procedure),
	);
}

// Module-local cache of the hosted `/api/mcp` tools/list response.
// biome-ignore lint/suspicious/noExplicitAny: SDK types leak into the client.
let describeCachePromise: Promise<Map<string, any>> | undefined;

// biome-ignore lint/suspicious/noExplicitAny: MCP tool objects are untyped here.
async function describeCache(): Promise<Map<string, any>> {
	if (describeCachePromise) return describeCachePromise;
	describeCachePromise = (async () => {
		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const { StreamableHTTPClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/streamableHttp.js"
		);
		const { getToken } = await import("../../lib/config.js");
		const token = getToken() ?? "";
		const client = new Client(
			{ name: "tarout-mcp-describe", version: "0" },
			{ capabilities: {} },
		);
		const transport = new StreamableHTTPClientTransport(
			new URL(`${getApiUrl()}/api/mcp`),
			{ requestInit: { headers: token ? { "x-api-key": token } : {} } },
		);
		await client.connect(transport);
		const list = await client.listTools();
		await client.close();
		// biome-ignore lint/suspicious/noExplicitAny: MCP tool objects are untyped here.
		const map = new Map<string, any>();
		for (const tool of list.tools) map.set(tool.name, tool);
		return map;
	})().catch((err) => {
		// Reset on failure so a transient network error doesn't poison the cache.
		describeCachePromise = undefined;
		throw err;
	});
	return describeCachePromise;
}
```

- [ ] **Step 4: Wire into `src/mcp/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageJson from "../../package.json" with { type: "json" };
import { registerCallTools } from "./tools/call.js";

export function createMcpServer(): McpServer {
	const server = new McpServer(
		{ name: "tarout", version: packageJson.version },
		{ capabilities: { tools: {} } },
	);
	registerCallTools(server);
	return server;
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-call.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/call.ts src/mcp/server.ts __test__/mcp/tools-call.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add call, list_procedures, describe_procedure

Escape hatch that covers every long-tail procedure not surfaced as a
curated tool. describe_procedure caches the hosted /api/mcp tools/list
per process.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Extract `env-core.ts` (dotenv + app resolver)

**Files:**
- Create: `src/lib/env-core.ts`
- Modify: `src/commands/env.ts` (import parse/serialize from new lib)
- Create: `__test__/env-core.test.ts`

**Interfaces:**
- Produces:
  - `parseDotenv(text: string): Record<string, string>` — supports `KEY=value`, quoted values, `#` comments, empty lines. Values NOT re-interpolated.
  - `serializeDotenv(vars: Record<string, string>): string` — quotes values containing whitespace, `=`, `"`, or `\n`; deterministic key order (sorted).
  - `resolveAppRef(client: TrpcClient, ref: string): Promise<{ applicationId: string; name: string }>` — accepts an id (starts with `app_` or is a UUID-shape) or a name; queries `application.allByOrganization` when needed. Throws `NotFoundError` if no match.

- [ ] **Step 1: Write the failing test**

```ts
// __test__/env-core.test.ts
import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "../src/lib/errors";
import { parseDotenv, resolveAppRef, serializeDotenv } from "../src/lib/env-core";

describe("parseDotenv", () => {
	it("parses plain KEY=value pairs", () => {
		expect(parseDotenv("A=1\nB=2\n")).toEqual({ A: "1", B: "2" });
	});

	it("supports double-quoted values", () => {
		expect(parseDotenv('A="hello world"\n')).toEqual({ A: "hello world" });
	});

	it("supports single-quoted values with escapes ignored", () => {
		expect(parseDotenv("A='raw\\nstring'\n")).toEqual({ A: "raw\\nstring" });
	});

	it("strips inline comments only outside quoted values", () => {
		expect(parseDotenv("A=1 # note\nB=\"x # keep\"\n")).toEqual({
			A: "1",
			B: "x # keep",
		});
	});

	it("ignores blank lines and full-line comments", () => {
		expect(parseDotenv("\n# c\nA=1\n")).toEqual({ A: "1" });
	});
});

describe("serializeDotenv", () => {
	it("sorts keys and quotes values with whitespace", () => {
		const out = serializeDotenv({ B: "with space", A: "1" });
		expect(out).toBe('A=1\nB="with space"\n');
	});

	it("escapes double quotes inside quoted values", () => {
		expect(serializeDotenv({ K: 'a"b' })).toBe('K="a\\"b"\n');
	});
});

describe("resolveAppRef", () => {
	function client(apps: Array<{ applicationId: string; name: string }>) {
		return {
			application: {
				allByOrganization: {
					query: vi.fn().mockResolvedValue(apps),
				},
			},
		};
	}

	it("returns id + name when ref matches an id", async () => {
		const c = client([{ applicationId: "app_1", name: "web" }]);
		const r = await resolveAppRef(c, "app_1");
		expect(r).toEqual({ applicationId: "app_1", name: "web" });
	});

	it("returns id + name when ref matches a name", async () => {
		const c = client([{ applicationId: "app_1", name: "web" }]);
		const r = await resolveAppRef(c, "web");
		expect(r).toEqual({ applicationId: "app_1", name: "web" });
	});

	it("throws NotFoundError when ref matches nothing", async () => {
		const c = client([{ applicationId: "app_1", name: "web" }]);
		await expect(resolveAppRef(c, "other")).rejects.toBeInstanceOf(NotFoundError);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/env-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/env-core.ts`**

```ts
import { NotFoundError } from "./errors.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (!key) continue;
		let value = line.slice(eq + 1);
		// Preserve leading space inside quotes; trim only when unquoted.
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
				out[key] = value.slice(1, -1);
				continue;
			}
		}
		value = value.trim();
		const hash = value.indexOf(" #");
		if (hash !== -1) value = value.slice(0, hash).trim();
		out[key] = value;
	}
	return out;
}

export function serializeDotenv(vars: Record<string, string>): string {
	const keys = Object.keys(vars).sort();
	return `${keys
		.map((k) => {
			const v = vars[k] ?? "";
			const needsQuote = /[\s="\\]/.test(v);
			if (!needsQuote) return `${k}=${v}`;
			const escaped = v.replace(/"/g, '\\"');
			return `${k}="${escaped}"`;
		})
		.join("\n")}\n`;
}

const ID_SHAPE = /^(app_|[0-9a-f]{8}-)/i;

export async function resolveAppRef(
	client: TrpcClient,
	ref: string,
): Promise<{ applicationId: string; name: string }> {
	const apps = (await client.application.allByOrganization.query()) as Array<{
		applicationId: string;
		name: string;
	}>;
	if (ID_SHAPE.test(ref)) {
		const byId = apps.find((a) => a.applicationId === ref);
		if (byId) return { applicationId: byId.applicationId, name: byId.name };
	}
	const byName = apps.find((a) => a.name === ref);
	if (byName) return { applicationId: byName.applicationId, name: byName.name };
	throw new NotFoundError(`No application matches "${ref}".`);
}
```

- [ ] **Step 4: Rewrite the parse/serialize call sites in `src/commands/env.ts`**

Search for inline dotenv parsing in `env.ts` (the `push` action around line 321 reads a file and splits `\n` manually) and replace with `parseDotenv`. Search for any inline serialization in `pull` and replace with `serializeDotenv`. If `pull` today uses the server's `envVariable.export.query({ format: "dotenv" })` result directly (a string), leave it alone.

Concrete step: run `grep -n 'split.*"="\|split.*"\\\\n"' src/commands/env.ts` to find the inline parse; replace the ~5-line manual splitter with a single `parseDotenv(readFileSync(path, "utf8"))` call, importing from `../lib/env-core.js`.

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest && bun run typecheck && bun run lint`
Expected: env-core tests PASS; existing env.ts tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/env-core.ts src/commands/env.ts __test__/env-core.test.ts
git commit -m "$(cat <<'EOF'
refactor(cli): extract env-core (dotenv parse/serialize + app resolver)

Same behavior as commands/env.ts inline logic — factored out so the local
MCP server's env_* tools can reuse it.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `env_*` tools

**Files:**
- Create: `src/mcp/tools/env.ts`
- Modify: `src/mcp/server.ts` (call `registerEnvTools(server)`)
- Create: `__test__/mcp/tools-env.test.ts`

**Interfaces:**
- Consumes: `runtime.ts`, `env-core.ts`, `application.allByOrganization` + `envVariable.list|export|import` on the tRPC client.
- Produces: `registerEnvTools(server): void`; tools: `env_list`, `env_set`, `env_unset`, `env_pull`, `env_push`.

- [ ] **Step 1: Write the failing test** — cover the canonical path (`env_list`) + a write path (`env_push`) with resolver interaction.

```ts
// __test__/mcp/tools-env.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
	},
	envVariable: {
		list: {
			query: vi.fn().mockResolvedValue([
				{ key: "A", value: "1" },
				{ key: "B", value: "2" },
			]),
		},
		import: { mutate: vi.fn().mockResolvedValue({ inserted: 2 }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEnvTools } from "../../src/mcp/tools/env";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerEnvTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("env_list", () => {
	it("resolves app by name and returns keys", async () => {
		const r = await invoke("env_list", { app: "web" });
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { keys: string[] };
		expect(body.keys).toEqual(["A", "B"]);
	});
});

describe("env_push", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "envpush-"));
		writeFileSync(join(dir, ".env"), "A=1\nB=hi\n");
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("reads a dotenv file, resolves app, calls import", async () => {
		const r = await invoke("env_push", { app: "web", path: dir });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.envVariable.import.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationId: "app_1",
				format: "dotenv",
				merge: true,
			}),
		);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/env.ts`**

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseDotenv, resolveAppRef, serializeDotenv } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");
const path = z.string().optional().describe("Directory (defaults to cwd).");

export function registerEnvTools(server: McpServer): void {
	server.registerTool(
		"env_list",
		{
			title: "List environment variables of an app",
			description:
				"Returns keys (and values when reveal=true) for the selected environment. Wraps envVariable.list.",
			inputSchema: {
				app,
				reveal: z.boolean().optional().default(false),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, reveal }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const vars = (await client.envVariable.list.query({
					applicationId,
					includeValues: reveal,
				})) as Array<{ key: string; value?: string }>;
				return {
					app: { applicationId, name },
					keys: vars.map((v) => v.key),
					vars: reveal ? Object.fromEntries(vars.map((v) => [v.key, v.value ?? ""])) : undefined,
				};
			}),
	);

	server.registerTool(
		"env_set",
		{
			title: "Set environment variables on an app",
			description:
				"Merges (upsert) the given key/values into the app's environment. Wraps envVariable.import with merge=true.",
			inputSchema: {
				app,
				vars: z
					.record(z.string())
					.describe("Object of KEY → value pairs to upsert."),
				restart: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, vars, restart }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const content = serializeDotenv(vars);
				const result = (await client.envVariable.import.mutate({
					applicationId,
					content,
					format: "dotenv",
					merge: true,
					restart,
				})) as unknown;
				return { app: { applicationId, name }, result };
			}),
	);

	server.registerTool(
		"env_unset",
		{
			title: "Remove environment variables from an app",
			description:
				"Removes the given keys from the app's environment. Uses envVariable.import with a synthetic empty dotenv that only lists the removed keys.",
			inputSchema: {
				app,
				keys: z.array(z.string()).min(1),
				restart: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, keys, restart }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const existing = (await client.envVariable.list.query({
					applicationId,
					includeValues: true,
				})) as Array<{ key: string; value?: string }>;
				const keep = existing
					.filter((v) => !keys.includes(v.key))
					.reduce<Record<string, string>>((acc, v) => {
						acc[v.key] = v.value ?? "";
						return acc;
					}, {});
				const content = serializeDotenv(keep);
				const result = (await client.envVariable.import.mutate({
					applicationId,
					content,
					format: "dotenv",
					merge: false,
					restart,
				})) as unknown;
				return { app: { applicationId, name }, removed: keys, result };
			}),
	);

	server.registerTool(
		"env_pull",
		{
			title: "Write the app's environment to a local .env file",
			description:
				"Downloads variables via envVariable.export (dotenv format) and writes them to <path>/<file>.",
			inputSchema: {
				app,
				path,
				file: z.string().optional().default(".env"),
				maskSecrets: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, path: dir, file, maskSecrets }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const text = (await client.envVariable.export.query({
					applicationId,
					format: "dotenv",
					maskSecrets,
				})) as string;
				const target = resolve(dir ?? process.cwd(), file ?? ".env");
				writeFileSync(target, text, { mode: 0o600 });
				return { app: { applicationId, name }, wrote: target, bytes: text.length };
			}),
	);

	server.registerTool(
		"env_push",
		{
			title: "Push a local .env file to the app",
			description:
				"Reads <path>/<file> as dotenv and uploads via envVariable.import (merge default true).",
			inputSchema: {
				app,
				path,
				file: z.string().optional().default(".env"),
				merge: z.boolean().optional().default(true),
				restart: z.boolean().optional().default(false),
			},
		},
		async ({ app: appRef, path: dir, file, merge, restart }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const source = resolve(dir ?? process.cwd(), file ?? ".env");
				const raw = readFileSync(source, "utf8");
				const content = serializeDotenv(parseDotenv(raw));
				const result = (await client.envVariable.import.mutate({
					applicationId,
					content,
					format: "dotenv",
					merge,
					restart,
				})) as unknown;
				return { app: { applicationId, name }, source, result };
			}),
	);
}
```

- [ ] **Step 4: Wire into `server.ts`**

Add to the imports and body of `createMcpServer`:

```ts
import { registerEnvTools } from "./tools/env.js";
// ...
registerEnvTools(server);
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-env.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/env.ts src/mcp/server.ts __test__/mcp/tools-env.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add env_list, env_set, env_unset, env_pull, env_push

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `context_*` + `link_app` / `unlink_app`

**Files:**
- Create: `src/mcp/tools/context.ts`
- Modify: `src/mcp/server.ts` (call `registerContextTools(server)`)
- Create: `__test__/mcp/tools-context.test.ts`

**Interfaces:**
- Consumes: `user.get`, `organization.all`/`setActive`, `project.all`/`getActive`/`setActive`, `environment.getActive`/`setActive`, `application.allByOrganization`; `getProjectConfig`, `setProjectConfig`, `removeProjectConfig`, `isProjectLinked` from `lib/config.ts`.
- Produces: `registerContextTools(server): void`; tools: `context_status`, `context_switch`, `link_app`, `unlink_app`.

- [ ] **Step 1: Write the failing test**

```ts
// __test__/mcp/tools-context.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/config")>(
		"../../src/lib/config",
	);
	return {
		...actual,
		isLoggedIn: () => true,
		getToken: () => "tok",
		getApiUrl: () => "https://api.test",
	};
});

const fakeClient = {
	user: { get: { query: vi.fn().mockResolvedValue({ id: "u1", email: "e" }) } },
	organization: {
		all: { query: vi.fn().mockResolvedValue([{ organizationId: "o1", name: "Acme" }]) },
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	project: {
		all: { query: vi.fn().mockResolvedValue([{ id: "p1", slug: "web", name: "Web" }]) },
		getActive: { query: vi.fn().mockResolvedValue({ id: "p1" }) },
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	environment: {
		getActive: { query: vi.fn().mockResolvedValue({ id: "e1", slug: "production" }) },
		setActive: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContextTools } from "../../src/mcp/tools/context";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ctx-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerContextTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("context_status", () => {
	it("returns whoami + active context + link info", async () => {
		const r = await invoke("context_status", { path: dir });
		const body = JSON.parse(r.content[0].text) as {
			user: { id: string };
			project: { id: string };
			link: { linked: boolean };
		};
		expect(body.user.id).toBe("u1");
		expect(body.project.id).toBe("p1");
		expect(body.link.linked).toBe(false);
	});
});

describe("link_app / unlink_app", () => {
	it("links a directory to an app by name", async () => {
		const r = await invoke("link_app", { app: "web", path: dir });
		const body = JSON.parse(r.content[0].text) as { linked: boolean };
		expect(body.linked).toBe(true);
	});

	it("unlink removes the local link", async () => {
		await invoke("link_app", { app: "web", path: dir });
		const r = await invoke("unlink_app", { path: dir });
		const body = JSON.parse(r.content[0].text) as { unlinked: boolean };
		expect(body.unlinked).toBe(true);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/context.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	getProjectConfig,
	isProjectLinked,
	removeProjectConfig,
	setProjectConfig,
} from "../../lib/config.js";
import { resolveAppRef } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

const path = z.string().optional().describe("Directory (defaults to cwd).");

export function registerContextTools(server: McpServer): void {
	server.registerTool(
		"context_status",
		{
			title: "Current org / project / env + link info",
			description:
				"Returns the whoami identity, active org / project / environment, and whether the given directory is linked to an app.",
			inputSchema: { path },
			annotations: { readOnlyHint: true },
		},
		async ({ path: dir }) =>
			withAuth(async (client) => {
				const cwd = dir ?? process.cwd();
				const [user, project, environment] = await Promise.all([
					client.user.get.query(),
					client.project.getActive.query().catch(() => null),
					client.environment.getActive.query().catch(() => null),
				]);
				const link = isProjectLinked(cwd)
					? { linked: true, ...getProjectConfig(cwd) }
					: { linked: false };
				return { user, project, environment, link, cwd };
			}),
	);

	server.registerTool(
		"context_switch",
		{
			title: "Switch active organization / project / environment",
			description:
				"Any subset of the three can be provided (id or slug). Only the fields you supply are changed.",
			inputSchema: {
				organization: z.string().optional(),
				project: z.string().optional(),
				environment: z.string().optional(),
			},
		},
		async ({ organization, project, environment }) =>
			withAuth(async (client) => {
				const changes: Record<string, unknown> = {};
				if (organization) {
					const orgs = (await client.organization.all.query()) as Array<{
						organizationId: string;
						name: string;
					}>;
					const match = orgs.find(
						(o) => o.organizationId === organization || o.name === organization,
					);
					if (!match) throw new Error(`Unknown organization: ${organization}`);
					await client.organization.setActive.mutate({ organizationId: match.organizationId });
					changes.organization = match;
				}
				if (project) {
					const projs = (await client.project.all.query()) as Array<{
						id: string;
						slug?: string;
						name?: string;
					}>;
					const match = projs.find(
						(p) => p.id === project || p.slug === project || p.name === project,
					);
					if (!match) throw new Error(`Unknown project: ${project}`);
					await client.project.setActive.mutate({ projectId: match.id });
					changes.project = match;
				}
				if (environment) {
					await client.environment.setActive.mutate({ environmentId: environment });
					changes.environment = { id: environment };
				}
				return changes;
			}),
	);

	server.registerTool(
		"link_app",
		{
			title: "Link a directory to an app",
			description:
				"Writes `.tarout/project.json` in the given directory so future deploy/env tools can infer the target.",
			inputSchema: { app: z.string(), path },
		},
		async ({ app: appRef, path: dir }) =>
			withAuth(async (client) => {
				const cwd = dir ?? process.cwd();
				const { applicationId, name } = await resolveAppRef(client, appRef);
				// The tRPC procedure results carry organizationId; re-query to fetch it.
				const apps = (await client.application.allByOrganization.query()) as Array<{
					applicationId: string;
					name: string;
					organizationId?: string;
				}>;
				const full = apps.find((a) => a.applicationId === applicationId);
				setProjectConfig(
					{
						applicationId,
						name,
						organizationId: full?.organizationId ?? "",
						linkedAt: new Date().toISOString(),
					},
					cwd,
				);
				return { linked: true, applicationId, name, cwd };
			}),
	);

	server.registerTool(
		"unlink_app",
		{
			title: "Remove a directory's link",
			description: "Deletes `.tarout/project.json` in the given directory.",
			inputSchema: { path },
		},
		async ({ path: dir }) =>
			withAuth(async () => {
				const cwd = dir ?? process.cwd();
				removeProjectConfig(cwd);
				return { unlinked: true, cwd };
			}),
	);
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { registerContextTools } from "./tools/context.js";
// ...
registerContextTools(server);
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-context.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/context.ts src/mcp/server.ts __test__/mcp/tools-context.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add context_status, context_switch, link_app, unlink_app

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Apps tools

**Files:**
- Create: `src/mcp/tools/apps.ts`
- Modify: `src/mcp/server.ts` (call `registerAppsTools(server)`)
- Create: `__test__/mcp/tools-apps.test.ts`

**Interfaces:**
- Consumes: `resolveAppRef` from `env-core.ts`; procedures `application.allByOrganization|one|create|getApplicationLogs|restart|stop|delete`.
- Produces: `registerAppsTools(server): void`; tools: `app_list`, `app_info`, `app_create`, `app_logs`, `app_restart`, `app_stop`, `app_delete`.

- [ ] **Step 1: Write the failing test**

```ts
// __test__/mcp/tools-apps.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([
				{ applicationId: "app_1", name: "web", status: "running", plan: "SHARED" },
			]),
		},
		one: {
			query: vi.fn().mockResolvedValue({ applicationId: "app_1", name: "web" }),
		},
		create: {
			mutate: vi.fn().mockResolvedValue({ applicationId: "app_2", name: "api" }),
		},
		getApplicationLogs: {
			query: vi.fn().mockResolvedValue({ logs: [{ line: "hi" }] }),
		},
		restart: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		stop: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
		delete: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppsTools } from "../../src/mcp/tools/apps";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerAppsTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("apps tools", () => {
	it("app_list trims to essentials", async () => {
		const r = await invoke("app_list", {});
		const body = JSON.parse(r.content[0].text) as { apps: Array<{ id: string }> };
		expect(body.apps).toHaveLength(1);
		expect(body.apps[0]?.id).toBe("app_1");
	});

	it("app_info resolves by name and returns the full object", async () => {
		const r = await invoke("app_info", { app: "web" });
		const body = JSON.parse(r.content[0].text) as { app: { name: string } };
		expect(body.app.name).toBe("web");
	});

	it("app_delete calls application.delete", async () => {
		const r = await invoke("app_delete", { app: "web" });
		expect(r.isError).toBeUndefined();
		expect(fakeClient.application.delete.mutate).toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-apps.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/apps.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAppRef } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");

export function registerAppsTools(server: McpServer): void {
	server.registerTool(
		"app_list",
		{
			title: "List applications in the active organization",
			description: "Wraps application.allByOrganization; returns trimmed fields.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const all = (await client.application.allByOrganization.query()) as Array<
					Record<string, unknown>
				>;
				return {
					count: all.length,
					apps: all.map((a) => ({
						id: a.applicationId,
						name: a.name,
						status: a.status,
						plan: a.plan,
						url: a.deployedUrl ?? a.url ?? null,
					})),
				};
			}),
	);

	server.registerTool(
		"app_info",
		{
			title: "Full details for one application",
			description: "Resolves the app by name or id then calls application.one.",
			inputSchema: { app },
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const one = (await client.application.one.query({ applicationId })) as unknown;
				return { app: one };
			}),
	);

	server.registerTool(
		"app_create",
		{
			title: "Create a new application",
			description:
				"Creates an app in the active organization. Prefer the `deploy` tool for a full deploy-from-local-directory flow.",
			inputSchema: {
				name: z.string().min(1),
				description: z.string().optional(),
				plan: z.enum(["FREE", "SHARED", "DEDICATED"]).optional(),
			},
		},
		async (input) =>
			withAuth(async (client) => {
				const created = (await client.application.create.mutate(input)) as unknown;
				return { created };
			}),
	);

	server.registerTool(
		"app_logs",
		{
			title: "Tail runtime logs for an application",
			description: "Wraps application.getApplicationLogs.",
			inputSchema: {
				app,
				lines: z.number().int().positive().max(1000).optional().default(200),
				level: z.enum(["debug", "info", "warn", "error"]).optional(),
				timeRange: z.enum(["5m", "15m", "1h", "24h"]).optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, lines, level, timeRange }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const logs = (await client.application.getApplicationLogs.query({
					applicationId,
					lines,
					level,
					timeRange,
				})) as unknown;
				return logs;
			}),
	);

	server.registerTool(
		"app_restart",
		{
			title: "Restart an application",
			description: "Wraps application.restart.",
			inputSchema: { app },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const result = (await client.application.restart.mutate({ applicationId })) as unknown;
				return { restarted: true, result };
			}),
	);

	server.registerTool(
		"app_stop",
		{
			title: "Stop an application",
			description: "Wraps application.stop.",
			inputSchema: { app },
			annotations: { destructiveHint: true },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId } = await resolveAppRef(client, appRef);
				const result = (await client.application.stop.mutate({ applicationId })) as unknown;
				return { stopped: true, result };
			}),
	);

	server.registerTool(
		"app_delete",
		{
			title: "Delete an application (irreversible)",
			description: "Wraps application.delete.",
			inputSchema: { app },
			annotations: { destructiveHint: true },
		},
		async ({ app: appRef }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const result = (await client.application.delete.mutate({ applicationId })) as unknown;
				return { deleted: true, applicationId, name, result };
			}),
	);
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { registerAppsTools } from "./tools/apps.js";
// ...
registerAppsTools(server);
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-apps.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/apps.ts src/mcp/server.ts __test__/mcp/tools-apps.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add app_list/info/create/logs/restart/stop/delete

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: DB tools (postgres + mysql)

**Files:**
- Create: `src/mcp/tools/db.ts`
- Modify: `src/mcp/server.ts`
- Create: `__test__/mcp/tools-db.test.ts`

**Interfaces:**
- Consumes: `postgres.*` and `mysql.*` `allByOrganization`/`one`/`create`/`remove`; `postgres.updateExternalAccess` (for credentials context); `postgres.executeSql`; `resolveDbRef(client, ref, type)` private helper (postgres vs mysql lookup).
- Produces: `registerDbTools(server): void`; tools: `db_list`, `db_create`, `db_info`, `db_credentials`, `db_sql`, `db_delete`.
- `db_sql` is **postgres-only** — mysql input returns `INVALID_ARGUMENTS`.

- [ ] **Step 1: Write the failing test**

```ts
// __test__/mcp/tools-db.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	postgres: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ postgresId: "pg_1", name: "prod", plan: "STARTER" }]),
		},
		one: { query: vi.fn().mockResolvedValue({ postgresId: "pg_1", name: "prod" }) },
		executeSql: {
			mutate: vi.fn().mockResolvedValue({ rows: [{ n: 1 }] }),
		},
	},
	mysql: {
		allByOrganization: { query: vi.fn().mockResolvedValue([]) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDbTools } from "../../src/mcp/tools/db";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerDbTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("db tools", () => {
	it("db_list returns both engines", async () => {
		const r = await invoke("db_list", {});
		const body = JSON.parse(r.content[0].text) as { postgres: unknown[]; mysql: unknown[] };
		expect(body.postgres).toHaveLength(1);
		expect(body.mysql).toHaveLength(0);
	});

	it("db_sql calls postgres.executeSql for a postgres db", async () => {
		const r = await invoke("db_sql", { db: "prod", type: "postgres", sql: "SELECT 1" });
		const body = JSON.parse(r.content[0].text) as { rows: unknown[] };
		expect(body.rows).toEqual([{ n: 1 }]);
	});

	it("db_sql rejects mysql with INVALID_ARGUMENTS", async () => {
		const r = await invoke("db_sql", { db: "any", type: "mysql", sql: "SELECT 1" });
		expect(r.isError).toBe(true);
		const body = JSON.parse(r.content[0].text) as { code: string };
		expect(body.code).toBe("INVALID_ARGUMENTS");
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/db.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CliError } from "../../lib/errors.js";
import { withAuth } from "../runtime.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

const dbType = z.enum(["postgres", "mysql"]).describe("Database engine.");

async function resolveDbRef(
	client: TrpcClient,
	ref: string,
	type: "postgres" | "mysql",
): Promise<{ id: string; name: string }> {
	const router = type === "postgres" ? client.postgres : client.mysql;
	const list = (await router.allByOrganization.query()) as Array<Record<string, unknown>>;
	const idKey = type === "postgres" ? "postgresId" : "mysqlId";
	const match = list.find((d) => d[idKey] === ref || d.name === ref);
	if (!match) {
		throw new CliError(`No ${type} database matches "${ref}".`, "NOT_FOUND");
	}
	return { id: match[idKey] as string, name: match.name as string };
}

export function registerDbTools(server: McpServer): void {
	server.registerTool(
		"db_list",
		{
			title: "List Postgres + MySQL databases in the organization",
			description: "Wraps postgres.allByOrganization + mysql.allByOrganization.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const [pg, my] = await Promise.all([
					client.postgres.allByOrganization.query(),
					client.mysql.allByOrganization.query(),
				]);
				return { postgres: pg, mysql: my };
			}),
	);

	server.registerTool(
		"db_create",
		{
			title: "Create a database",
			description:
				"Creates a Postgres or MySQL database with the given plan. Uses postgres.create / mysql.create.",
			inputSchema: {
				type: dbType,
				name: z.string().min(1),
				plan: z.enum(["STARTER", "STANDARD", "PRO"]),
				description: z.string().optional(),
			},
		},
		async ({ type, name, plan, description }) =>
			withAuth(async (client) => {
				const router = type === "postgres" ? client.postgres : client.mysql;
				const created = (await router.create.mutate({ name, plan, description })) as unknown;
				return { type, created };
			}),
	);

	server.registerTool(
		"db_info",
		{
			title: "Details for one database",
			description: "postgres.one / mysql.one.",
			inputSchema: { type: dbType, db: z.string() },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, type);
				const router = type === "postgres" ? client.postgres : client.mysql;
				const idKey = type === "postgres" ? "postgresId" : "mysqlId";
				const info = (await router.one.query({ [idKey]: id })) as unknown;
				return { type, db: info };
			}),
	);

	server.registerTool(
		"db_credentials",
		{
			title: "Connection credentials for a database",
			description:
				"Returns the connection object (host / port / user / password / database). Uses postgres.one / mysql.one which include credentials for owner roles.",
			inputSchema: { type: dbType, db: z.string() },
			annotations: { readOnlyHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, type);
				const router = type === "postgres" ? client.postgres : client.mysql;
				const idKey = type === "postgres" ? "postgresId" : "mysqlId";
				const info = (await router.one.query({ [idKey]: id })) as Record<string, unknown>;
				return {
					type,
					host: info.host ?? info.externalHost ?? null,
					port: info.port ?? info.externalPort ?? null,
					database: info.databaseName ?? info.database ?? null,
					user: info.databaseUser ?? info.user ?? null,
					password: info.databasePassword ?? info.password ?? null,
				};
			}),
	);

	server.registerTool(
		"db_sql",
		{
			title: "Run a SQL statement (Postgres only)",
			description:
				"Wraps postgres.executeSql. MySQL is not supported by the platform — use `call` if you need mysql-specific ops.",
			inputSchema: { type: dbType, db: z.string(), sql: z.string() },
		},
		async ({ type, db, sql }) => {
			if (type !== "postgres") {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									error: "db_sql is postgres-only; use `call` for mysql-specific ops.",
									code: "INVALID_ARGUMENTS",
								},
								null,
								2,
							),
						},
					],
					isError: true,
				};
			}
			return withAuth(async (client) => {
				const { id } = await resolveDbRef(client, db, "postgres");
				const result = (await client.postgres.executeSql.mutate({
					postgresId: id,
					sql,
				})) as unknown;
				return result;
			});
		},
	);

	server.registerTool(
		"db_delete",
		{
			title: "Delete a database (irreversible)",
			description: "postgres.remove / mysql.remove.",
			inputSchema: { type: dbType, db: z.string() },
			annotations: { destructiveHint: true },
		},
		async ({ type, db }) =>
			withAuth(async (client) => {
				const { id, name } = await resolveDbRef(client, db, type);
				const router = type === "postgres" ? client.postgres : client.mysql;
				const idKey = type === "postgres" ? "postgresId" : "mysqlId";
				const result = (await router.remove.mutate({ [idKey]: id })) as unknown;
				return { type, deleted: true, id, name, result };
			}),
	);
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { registerDbTools } from "./tools/db.js";
// ...
registerDbTools(server);
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-db.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/db.ts src/mcp/server.ts __test__/mcp/tools-db.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add db_list/create/info/credentials/sql/delete

db_sql is postgres-only, mirroring the CLI. MySQL routes to `call` for
engine-specific ops.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Storage tools

**Files:**
- Create: `src/mcp/tools/storage.ts`
- Modify: `src/mcp/server.ts`
- Create: `__test__/mcp/tools-storage.test.ts`

**Interfaces:**
- Consumes: `storage.allByOrganization|create|findById|getCredentials|getFiles|delete`.
- Produces: `registerStorageTools(server): void`; tools: `storage_list`, `storage_create`, `storage_info`, `storage_credentials`, `storage_files`, `storage_delete`.
- Private helper `resolveBucketRef(client, ref)` mirrors `resolveAppRef` (id or name).

- [ ] **Step 1: Write the failing test**

```ts
// __test__/mcp/tools-storage.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	storage: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ bucketId: "buk_1", name: "assets" }]),
		},
		findById: { query: vi.fn().mockResolvedValue({ bucketId: "buk_1", name: "assets" }) },
		create: { mutate: vi.fn().mockResolvedValue({ bucketId: "buk_2", name: "logs" }) },
		getCredentials: {
			query: vi.fn().mockResolvedValue({ accessKeyId: "AKIA", secretAccessKey: "SEC" }),
		},
		getFiles: { query: vi.fn().mockResolvedValue({ files: [{ key: "a.txt" }] }) },
		delete: { mutate: vi.fn().mockResolvedValue({ ok: true }) },
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStorageTools } from "../../src/mcp/tools/storage";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerStorageTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("storage tools", () => {
	it("storage_list returns buckets", async () => {
		const r = await invoke("storage_list", {});
		const body = JSON.parse(r.content[0].text) as { buckets: Array<{ id: string }> };
		expect(body.buckets[0]?.id).toBe("buk_1");
	});

	it("storage_credentials resolves by name and returns HMAC keys", async () => {
		const r = await invoke("storage_credentials", { bucket: "assets" });
		const body = JSON.parse(r.content[0].text) as { accessKeyId: string };
		expect(body.accessKeyId).toBe("AKIA");
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-storage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/storage.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CliError } from "../../lib/errors.js";
import { withAuth } from "../runtime.js";

// biome-ignore lint/suspicious/noExplicitAny: tRPC proxy client is untyped in the CLI package.
type TrpcClient = any;

const bucketRef = z.string().describe("Bucket name or id.");

async function resolveBucketRef(
	client: TrpcClient,
	ref: string,
): Promise<{ bucketId: string; name: string }> {
	const buckets = (await client.storage.allByOrganization.query()) as Array<{
		bucketId: string;
		name: string;
	}>;
	const match = buckets.find((b) => b.bucketId === ref || b.name === ref);
	if (!match) throw new CliError(`No bucket matches "${ref}".`, "NOT_FOUND");
	return { bucketId: match.bucketId, name: match.name };
}

export function registerStorageTools(server: McpServer): void {
	server.registerTool(
		"storage_list",
		{
			title: "List storage buckets",
			description: "Wraps storage.allByOrganization.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const list = (await client.storage.allByOrganization.query()) as Array<
					Record<string, unknown>
				>;
				return {
					count: list.length,
					buckets: list.map((b) => ({
						id: b.bucketId,
						name: b.name,
						plan: b.plan,
						publicAccess: b.publicAccess,
					})),
				};
			}),
	);

	server.registerTool(
		"storage_create",
		{
			title: "Create a storage bucket",
			description: "Wraps storage.create.",
			inputSchema: {
				name: z.string().min(1),
				plan: z.enum(["STARTER", "STANDARD", "PRO"]),
				description: z.string().optional(),
				publicAccess: z.boolean().optional().default(false),
			},
		},
		async (input) =>
			withAuth(async (client) => (await client.storage.create.mutate(input)) as unknown),
	);

	server.registerTool(
		"storage_info",
		{
			title: "Details for one bucket",
			description: "Wraps storage.findById.",
			inputSchema: { bucket: bucketRef },
			annotations: { readOnlyHint: true },
		},
		async ({ bucket }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const info = (await client.storage.findById.query({ bucketId })) as unknown;
				return { bucket: info };
			}),
	);

	server.registerTool(
		"storage_credentials",
		{
			title: "S3-compatible HMAC keys for a bucket",
			description: "Wraps storage.getCredentials.",
			inputSchema: { bucket: bucketRef },
			annotations: { readOnlyHint: true },
		},
		async ({ bucket }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const creds = (await client.storage.getCredentials.query({
					bucketId,
				})) as unknown;
				return creds;
			}),
	);

	server.registerTool(
		"storage_files",
		{
			title: "List files in a bucket (prefix filter)",
			description: "Wraps storage.getFiles.",
			inputSchema: {
				bucket: bucketRef,
				prefix: z.string().optional(),
				maxResults: z.number().int().positive().max(1000).optional().default(100),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ bucket, prefix, maxResults }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const files = (await client.storage.getFiles.query({
					bucketId,
					prefix,
					maxResults,
				})) as unknown;
				return files;
			}),
	);

	server.registerTool(
		"storage_delete",
		{
			title: "Delete a bucket (irreversible)",
			description: "Wraps storage.delete.",
			inputSchema: { bucket: bucketRef },
			annotations: { destructiveHint: true },
		},
		async ({ bucket }) =>
			withAuth(async (client) => {
				const { bucketId, name } = await resolveBucketRef(client, bucket);
				const result = (await client.storage.delete.mutate({ bucketId })) as unknown;
				return { deleted: true, bucketId, name, result };
			}),
	);
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { registerStorageTools } from "./tools/storage.js";
// ...
registerStorageTools(server);
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-storage.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/storage.ts src/mcp/server.ts __test__/mcp/tools-storage.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add storage_list/create/info/credentials/files/delete

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Domain tools

**Files:**
- Create: `src/mcp/tools/domains.ts`
- Modify: `src/mcp/server.ts`
- Create: `__test__/mcp/tools-domains.test.ts`

**Interfaces:**
- Consumes: `domainRegistrar.getAll`, `domainRegistrar.verifyExternalDomain`, `domain.create`, `domain.one`, `resolveAppRef`.
- Produces: `registerDomainTools(server): void`; tools: `domain_list`, `domain_link`, `domain_verify`.

- [ ] **Step 1: Write the failing test**

```ts
// __test__/mcp/tools-domains.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	domainRegistrar: {
		getAll: { query: vi.fn().mockResolvedValue([{ domainId: "d1", host: "acme.sa" }]) },
		verifyExternalDomain: {
			mutate: vi.fn().mockResolvedValue({ verified: true }),
		},
	},
	domain: {
		create: { mutate: vi.fn().mockResolvedValue({ domainId: "d2", host: "www.acme.sa" }) },
		one: { query: vi.fn().mockResolvedValue({ domainId: "d2", verified: true }) },
	},
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDomainTools } from "../../src/mcp/tools/domains";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerDomainTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("domain tools", () => {
	it("domain_list returns registered domains", async () => {
		const r = await invoke("domain_list", {});
		const body = JSON.parse(r.content[0].text) as { domains: Array<{ host: string }> };
		expect(body.domains[0]?.host).toBe("acme.sa");
	});

	it("domain_link resolves app + creates domain", async () => {
		const r = await invoke("domain_link", { app: "web", host: "www.acme.sa" });
		const body = JSON.parse(r.content[0].text) as { linked: boolean };
		expect(body.linked).toBe(true);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-domains.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/domains.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAppRef } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

const app = z.string().describe("Application name or id.");

export function registerDomainTools(server: McpServer): void {
	server.registerTool(
		"domain_list",
		{
			title: "List registered / external domains",
			description: "Wraps domainRegistrar.getAll.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const list = (await client.domainRegistrar.getAll.query()) as Array<
					Record<string, unknown>
				>;
				return { count: list.length, domains: list };
			}),
	);

	server.registerTool(
		"domain_link",
		{
			title: "Link a custom domain to an application",
			description:
				"Creates a domain record pointing at the given app and returns DNS instructions.",
			inputSchema: {
				app,
				host: z.string().describe("Hostname to link (e.g. www.example.com)."),
			},
		},
		async ({ app: appRef, host }) =>
			withAuth(async (client) => {
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const created = (await client.domain.create.mutate({
					applicationId,
					host,
				})) as Record<string, unknown>;
				return { linked: true, app: { applicationId, name }, domain: created };
			}),
	);

	server.registerTool(
		"domain_verify",
		{
			title: "Verify an external domain's DNS",
			description:
				"Runs the verification check. When `wait` is true, polls domain.one until `verified` flips.",
			inputSchema: {
				domainId: z.string(),
				wait: z.boolean().optional().default(false),
				timeoutSeconds: z.number().int().positive().max(1800).optional().default(120),
			},
		},
		async ({ domainId, wait, timeoutSeconds }) =>
			withAuth(async (client) => {
				const first = (await client.domainRegistrar.verifyExternalDomain.mutate({
					domainId,
				})) as { verified?: boolean };
				if (!wait || first.verified) return first;
				const deadline = Date.now() + timeoutSeconds * 1000;
				while (Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 5000));
					const next = (await client.domain.one.query({ domainId })) as {
						verified?: boolean;
					};
					if (next.verified) return { verified: true, domain: next };
				}
				return { verified: false, timedOut: true };
			}),
	);
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { registerDomainTools } from "./tools/domains.js";
// ...
registerDomainTools(server);
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-domains.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/domains.ts src/mcp/server.ts __test__/mcp/tools-domains.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add domain_list, domain_link, domain_verify

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Billing tools

**Files:**
- Create: `src/mcp/tools/billing.ts`
- Modify: `src/mcp/server.ts`
- Create: `__test__/mcp/tools-billing.test.ts`

**Interfaces:**
- Consumes: `subscription.getCurrent`, `subscription.getUsage`, `performBillingChange` (from `lib/billing-upgrade.ts`).
- Produces: `registerBillingTools(server): void`; tools: `billing_status`, `billing_upgrade`.

- [ ] **Step 1: Write the failing test**

```ts
// __test__/mcp/tools-billing.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
}));

const fakeClient = {
	subscription: {
		getCurrent: {
			query: vi.fn().mockResolvedValue({ planKey: "shared", status: "ACTIVE" }),
		},
		getUsage: {
			query: vi.fn().mockResolvedValue({ apps: 3, storageGB: 2 }),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

vi.mock("../../src/lib/billing-upgrade", () => ({
	performBillingChange: vi.fn().mockResolvedValue({
		status: "applied",
		kind: "plan",
		target: "dedicated_small",
	}),
}));

import { performBillingChange } from "../../src/lib/billing-upgrade";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBillingTools } from "../../src/mcp/tools/billing";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerBillingTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("billing tools", () => {
	it("billing_status returns subscription + usage", async () => {
		const r = await invoke("billing_status", {});
		const body = JSON.parse(r.content[0].text) as { subscription: { planKey: string } };
		expect(body.subscription.planKey).toBe("shared");
	});

	it("billing_upgrade delegates to performBillingChange", async () => {
		const r = await invoke("billing_upgrade", { plan: "dedicated_small", wait: true });
		expect(r.isError).toBeUndefined();
		expect(performBillingChange).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ kind: "plan", planKey: "dedicated_small", wait: true }),
		);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-billing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/mcp/tools/billing.ts`**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { performBillingChange } from "../../lib/billing-upgrade.js";
import { withAuth } from "../runtime.js";

export function registerBillingTools(server: McpServer): void {
	server.registerTool(
		"billing_status",
		{
			title: "Current subscription + usage summary",
			description:
				"Returns subscription.getCurrent + subscription.getUsage in one call.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const [subscription, usage] = await Promise.all([
					client.subscription.getCurrent.query(),
					client.subscription.getUsage.query().catch(() => null),
				]);
				return { subscription, usage };
			}),
	);

	server.registerTool(
		"billing_upgrade",
		{
			title: "Upgrade / add addon / adjust quantity",
			description:
				"Delegates to performBillingChange. Provide exactly one of {plan}, {addon}, {planQuantity}. When wait=true, polls hosted checkout to a terminal status.",
			inputSchema: {
				plan: z.string().optional(),
				addon: z.string().optional(),
				quantity: z.number().int().positive().optional(),
				planQuantity: z.number().int().positive().optional(),
				billingPeriod: z.enum(["MONTHLY", "YEARLY"]).optional(),
				wait: z.boolean().optional().default(true),
				timeoutSeconds: z.number().int().positive().max(3600).optional().default(600),
			},
		},
		async ({ plan, addon, quantity, planQuantity, billingPeriod, wait, timeoutSeconds }) =>
			withAuth(async (client) => {
				const kind = plan ? "plan" : addon ? "addon" : "plan_quantity";
				// biome-ignore lint/suspicious/noExplicitAny: PerformBillingChangeInput is a discriminated union we build dynamically.
				const input: any = { kind, wait, timeoutMs: timeoutSeconds * 1000 };
				if (plan) {
					input.planKey = plan;
					input.billingPeriod = billingPeriod;
				}
				if (addon) {
					input.addonKey = addon;
					input.quantity = quantity ?? 1;
				}
				if (planQuantity !== undefined) {
					input.planQuantity = planQuantity;
				}
				const result = await performBillingChange(client, input);
				return result;
			}),
	);
}
```

- [ ] **Step 4: Wire into `server.ts`**

```ts
import { registerBillingTools } from "./tools/billing.js";
// ...
registerBillingTools(server);
```

- [ ] **Step 5: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-billing.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/billing.ts src/mcp/server.ts __test__/mcp/tools-billing.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add billing_status, billing_upgrade

Delegates hosted-checkout wait to performBillingChange (already exit-free
and non-interactive).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Export `createSourceArchive`; add `deployment_status` + `deployment_logs`

**Files:**
- Modify: `src/commands/deploy.ts` (promote `createSourceArchive` to `export`)
- Create: `src/mcp/tools/deploy.ts` — with `deployment_status` and `deployment_logs` (deploy tool comes in Task 15).
- Modify: `src/mcp/server.ts`
- Create: `__test__/mcp/tools-deploy.test.ts` — starts with status/logs cases; expanded in Task 15.

**Interfaces:**
- Consumes: `application.allByOrganization`, `application.getDeploymentStatus`, `deployment.one`, `deployment.getDeploymentLogs`.
- Produces:
  - `export async function createSourceArchive(): Promise<string>` (was private in `deploy.ts:3984`).
  - `registerDeployTools(server): void`; tools registered so far: `deployment_status`, `deployment_logs`.

- [ ] **Step 1: Promote `createSourceArchive` to a public export**

In `src/commands/deploy.ts` around line 3984, change:

```ts
async function createSourceArchive(): Promise<string> {
```

to:

```ts
export async function createSourceArchive(): Promise<string> {
```

No other call sites change (existing callers inside the same file resolve the export identically).

- [ ] **Step 2: Write the failing test**

```ts
// __test__/mcp/tools-deploy.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => "tok",
	getApiUrl: () => "https://api.test",
	getProjectConfig: () => null,
	setProjectConfig: () => {},
	isProjectLinked: () => false,
	removeProjectConfig: () => {},
}));

const fakeClient = {
	application: {
		allByOrganization: {
			query: vi.fn().mockResolvedValue([{ applicationId: "app_1", name: "web" }]),
		},
		getDeploymentStatus: {
			query: vi
				.fn()
				.mockResolvedValue({ status: "done", latestDeploymentId: "dep_1" }),
		},
	},
	deployment: {
		one: {
			query: vi.fn().mockResolvedValue({ deploymentId: "dep_1", status: "done" }),
		},
		getDeploymentLogs: {
			query: vi.fn().mockResolvedValue({ logs: [{ line: "hi" }], nextOffset: 1 }),
		},
	},
};

vi.mock("../../src/lib/api", () => ({
	getApiClient: () => fakeClient,
	resetApiClient: () => {},
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDeployTools } from "../../src/mcp/tools/deploy";

async function invoke(name: string, args: unknown) {
	const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
	registerDeployTools(server);
	// biome-ignore lint/suspicious/noExplicitAny: RegisteredTool.callback is private-ish.
	const reg = (server as any)._registeredTools[name];
	return (await reg.callback(args)) as { content: [{ text: string }]; isError?: boolean };
}

describe("deployment_status", () => {
	it("resolves app by name then queries getDeploymentStatus", async () => {
		const r = await invoke("deployment_status", { app: "web" });
		const body = JSON.parse(r.content[0].text) as { status: string };
		expect(body.status).toBe("done");
	});

	it("uses deploymentId when provided", async () => {
		const r = await invoke("deployment_status", { deploymentId: "dep_1" });
		const body = JSON.parse(r.content[0].text) as { deploymentId: string };
		expect(body.deploymentId).toBe("dep_1");
	});
});

describe("deployment_logs", () => {
	it("returns log lines for a deployment id", async () => {
		const r = await invoke("deployment_logs", { deploymentId: "dep_1" });
		const body = JSON.parse(r.content[0].text) as { logs: unknown[] };
		expect(body.logs).toHaveLength(1);
	});
});
```

- [ ] **Step 3: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-deploy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/mcp/tools/deploy.ts`** (status + logs only for now)

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveAppRef } from "../../lib/env-core.js";
import { withAuth } from "../runtime.js";

export function registerDeployTools(server: McpServer): void {
	server.registerTool(
		"deployment_status",
		{
			title: "Current deployment status of an app or a specific deployment",
			description:
				"Provide `deploymentId` for a specific deployment, or `app` (name/id) for the app's latest.",
			inputSchema: {
				app: z.string().optional(),
				deploymentId: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ app: appRef, deploymentId }) =>
			withAuth(async (client) => {
				if (deploymentId) {
					const one = (await client.deployment.one.query({ deploymentId })) as unknown;
					return one;
				}
				if (!appRef) {
					throw Object.assign(new Error("Provide either `deploymentId` or `app`."), {
						code: "INVALID_ARGUMENTS",
					});
				}
				const { applicationId, name } = await resolveAppRef(client, appRef);
				const status = (await client.application.getDeploymentStatus.query({
					applicationId,
				})) as Record<string, unknown>;
				return { app: { applicationId, name }, ...status };
			}),
	);

	server.registerTool(
		"deployment_logs",
		{
			title: "Build + runtime logs for a deployment",
			description: "Wraps deployment.getDeploymentLogs. Pass `offset` to paginate.",
			inputSchema: {
				deploymentId: z.string(),
				offset: z.number().int().nonnegative().optional(),
				limit: z.number().int().positive().max(2000).optional().default(500),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ deploymentId, offset, limit }) =>
			withAuth(async (client) => {
				const logs = (await client.deployment.getDeploymentLogs.query({
					deploymentId,
					offset,
					limit,
				})) as unknown;
				return logs;
			}),
	);
}
```

- [ ] **Step 5: Wire into `server.ts`**

```ts
import { registerDeployTools } from "./tools/deploy.js";
// ...
registerDeployTools(server);
```

- [ ] **Step 6: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-deploy.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/deploy.ts src/mcp/tools/deploy.ts src/mcp/server.ts __test__/mcp/tools-deploy.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add deployment_status + deployment_logs; export createSourceArchive

createSourceArchive() is used by the deploy tool in the next commit; this
commit lands the read-only pieces so the deploy pipeline goes in cleanly.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: `deploy` — flagship pipeline (inspect → resolve/create → upload → trigger → poll)

**Files:**
- Modify: `src/mcp/tools/deploy.ts` (add the `deploy` tool)
- Modify: `__test__/mcp/tools-deploy.test.ts` (add deploy tests)

**Interfaces:**
- Consumes: `inspectCurrentProject(cwd?)`, `createAppFromCurrentDirectory(client, options, inspection)`, `uploadCurrentDirectorySource(client, applicationId, appName)`, `buildConfigFromOptions(options, inspection)`, `isEntitlementError(err)`, `extractEntitlementKeyFromError(err)`, `resolveEntitlementRemedy` from `lib/entitlement-remedy.ts`, `application.deployToCloud`, `deployment.one`, `deployment.getDeploymentLogs`, `getProjectConfig`, `setProjectConfig`.
- Produces: `deploy` tool with signature `{ path?, name?, wait=true, timeoutSeconds=600, createIfMissing=true, plan?, source? }` → `{ status: "done"|"in_progress"|..., appUrl?, deploymentId, logsTail? }`.
- Deploy timeout is an outcome (`in_progress` + deploymentId), NOT an error.

- [ ] **Step 1: Extend the test file** — append these cases to `__test__/mcp/tools-deploy.test.ts`:

```ts
// Append to __test__/mcp/tools-deploy.test.ts

describe("deploy tool", () => {
	it("wait=false returns the deployment id immediately", async () => {
		// Stub the pieces the deploy tool needs.
		const client = fakeClient as unknown as {
			application: {
				deployToCloud: { mutate: ReturnType<typeof vi.fn> };
			};
		};
		// biome-ignore lint/suspicious/noExplicitAny: augmenting fake for this test only.
		(client.application as any).deployToCloud = {
			mutate: vi.fn().mockResolvedValue({ deploymentId: "dep_9" }),
		};
		const r = await invoke("deploy", {
			path: process.cwd(),
			name: "web",
			wait: false,
			createIfMissing: false,
		});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { deploymentId: string };
		expect(body.deploymentId).toBe("dep_9");
	});

	it("times out cleanly and returns in_progress (not an error)", async () => {
		const client = fakeClient as unknown as {
			deployment: { one: { query: ReturnType<typeof vi.fn> } };
			application: {
				deployToCloud: { mutate: ReturnType<typeof vi.fn> };
			};
		};
		// biome-ignore lint/suspicious/noExplicitAny: augmenting fake.
		(client.application as any).deployToCloud = {
			mutate: vi.fn().mockResolvedValue({ deploymentId: "dep_slow" }),
		};
		// Always report "running" so the poll loop hits the deadline.
		(client.deployment.one.query as ReturnType<typeof vi.fn>).mockResolvedValue({
			deploymentId: "dep_slow",
			status: "running",
		});
		const r = await invoke("deploy", {
			path: process.cwd(),
			name: "web",
			wait: true,
			createIfMissing: false,
			timeoutSeconds: 1, // fastest possible cap
			// The tool's internal poll is fake-timed via the deadline check.
		});
		expect(r.isError).toBeUndefined();
		const body = JSON.parse(r.content[0].text) as { status: string };
		expect(body.status).toBe("in_progress");
	}, 5000);
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `bun run test:vitest __test__/mcp/tools-deploy.test.ts`
Expected: FAIL — `deploy` tool not registered.

- [ ] **Step 3: Extend `src/mcp/tools/deploy.ts`** with the `deploy` tool.

Add to the top imports:

```ts
import {
	buildConfigFromOptions,
	createAppFromCurrentDirectory,
	extractEntitlementKeyFromError,
	inspectCurrentProject,
	isEntitlementError,
	uploadCurrentDirectorySource,
} from "../../commands/deploy.js";
import { getProjectConfig, setProjectConfig } from "../../lib/config.js";
import { resolveEntitlementRemedy } from "../../lib/entitlement-remedy.js";
import { errorResult, okResult } from "../runtime.js";
```

Add the tool registration inside `registerDeployTools` — after the existing `deployment_status` / `deployment_logs` registrations:

```ts
	server.registerTool(
		"deploy",
		{
			title: "Deploy the current directory to an app",
			description:
				"Inspects the given directory, resolves an app (by linked config, `name`, or new), uploads a source archive, triggers a deploy, and (when wait=true) polls until done. On timeout returns { status: 'in_progress', deploymentId }.",
			inputSchema: {
				path: z.string().optional(),
				name: z.string().optional(),
				wait: z.boolean().optional().default(true),
				timeoutSeconds: z.number().int().positive().max(3600).optional().default(600),
				createIfMissing: z.boolean().optional().default(true),
				plan: z.enum(["FREE", "SHARED", "DEDICATED"]).optional(),
			},
		},
		// biome-ignore lint/suspicious/noExplicitAny: tRPC client and helper options intentionally untyped here.
		async ({ path: dir, name, wait, timeoutSeconds, createIfMissing, plan }, extra: any) => {
			const cwd = dir ?? process.cwd();
			try {
				const { isLoggedIn } = await import("../../lib/config.js");
				if (!isLoggedIn()) {
					return errorResult({
						error: "Not authenticated.",
						code: "AUTH_ERROR",
						remediation:
							"Run `tarout login` on the machine running this MCP server, or set TAROUT_TOKEN.",
					});
				}
				const { getApiClient } = await import("../../lib/api.js");
				const client = getApiClient();

				// 1) Inspect the project.
				const inspection = inspectCurrentProject(cwd);

				// 2) Resolve target: linked > name > create.
				let applicationId: string | undefined;
				let appName: string | undefined;
				const linked = getProjectConfig(cwd);
				if (linked) {
					applicationId = linked.applicationId;
					appName = linked.name;
				} else if (name) {
					const apps = (await client.application.allByOrganization.query()) as Array<{
						applicationId: string;
						name: string;
					}>;
					const match = apps.find((a) => a.name === name || a.applicationId === name);
					if (match) {
						applicationId = match.applicationId;
						appName = match.name;
					}
				}
				if (!applicationId) {
					if (!createIfMissing) {
						return errorResult({
							error: `No linked or matching app for ${cwd}. Pass createIfMissing=true to create one.`,
							code: "NOT_FOUND",
						});
					}
					try {
						const options = buildConfigFromOptions(
							{
								name: name ?? inspection.suggestedName ?? undefined,
								yes: true,
								nonInteractive: true,
								json: true,
								plan,
							},
							inspection,
						);
						const created = (await createAppFromCurrentDirectory(
							client,
							options,
							inspection,
						)) as { applicationId: string; name: string; organizationId?: string };
						applicationId = created.applicationId;
						appName = created.name;
						setProjectConfig(
							{
								applicationId,
								name: appName,
								organizationId: created.organizationId ?? "",
								linkedAt: new Date().toISOString(),
							},
							cwd,
						);
					} catch (err) {
						if (isEntitlementError(err)) {
							const catalog = (await client.subscription.getCatalog
								.query()
								.catch(() => ({ plans: [], addons: [] }))) as {
								plans: Array<{ planKey: string }>;
								addons: Array<{ addonKey: string }>;
							};
							const failedKey = extractEntitlementKeyFromError(err);
							const remedy = failedKey
								? resolveEntitlementRemedy(failedKey, catalog, {})
								: null;
							return errorResult({
								error: err instanceof Error ? err.message : String(err),
								code: "PERMISSION_DENIED",
								remediation:
									"Upgrade or add an addon: call `billing_upgrade` with the remedy below.",
								details: { remedy, entitlementKey: failedKey },
							});
						}
						throw err;
					}
				}

				// 3) Upload source archive.
				await uploadCurrentDirectorySource(client, applicationId, appName ?? "app");

				// 4) Trigger deploy.
				const started = (await client.application.deployToCloud.mutate({
					applicationId,
				})) as { deploymentId: string };
				const deploymentId = started.deploymentId;

				// 5) wait=false: return the id.
				if (!wait) {
					return okResult({ status: "started", deploymentId, applicationId });
				}

				// 6) Poll with progress notifications.
				const deadline = Date.now() + timeoutSeconds * 1000;
				let last: Record<string, unknown> | undefined;
				let progressToken = 0;
				while (Date.now() < deadline) {
					last = (await client.deployment.one.query({ deploymentId })) as Record<
						string,
						unknown
					>;
					const status = String(last.status ?? "").toLowerCase();
					// biome-ignore lint/suspicious/noExplicitAny: SDK notification helper.
					const progress = (extra as any)?.sendNotification;
					if (typeof progress === "function") {
						progressToken += 1;
						void progress({
							method: "notifications/progress",
							params: {
								progressToken,
								message: `deployment ${deploymentId}: ${status}`,
							},
						});
					}
					if (status === "done" || status === "success") {
						const logs = (await client.deployment.getDeploymentLogs
							.query({ deploymentId, limit: 200 })
							.catch(() => ({ logs: [] }))) as { logs?: Array<Record<string, unknown>> };
						return okResult({
							status: "done",
							deploymentId,
							appUrl: (last as { url?: string }).url,
							logsTail: (logs.logs ?? []).slice(-80),
						});
					}
					if (status === "error" || status === "failed") {
						return errorResult({
							error: "Deployment failed.",
							code: "DEPLOYMENT_FAILED",
							details: { deploymentId, snapshot: last },
						});
					}
					await new Promise((r) => setTimeout(r, 3000));
				}
				return okResult({
					status: "in_progress",
					deploymentId,
					hint: "Poll `deployment_status` / `deployment_logs`.",
				});
			} catch (err) {
				const { toEnvelope } = await import("../runtime.js");
				return errorResult(toEnvelope(err));
			}
		},
	);
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun run test:vitest __test__/mcp/tools-deploy.test.ts && bun run test:vitest && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/deploy.ts __test__/mcp/tools-deploy.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add flagship deploy tool

Blocking by default with wait=false opt-out; timeout returns
in_progress + deploymentId (an outcome, not an error). Emits MCP
progress notifications each poll. Entitlement failures return a
structured remedy for billing_upgrade.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Integration + contract catalog test

**Files:**
- Create: `__test__/mcp/integration-catalog.test.ts`

**Interfaces:**
- Consumes: `createMcpServer` from `src/mcp/server.ts`; `Client` and `InMemoryTransport` from the SDK.
- Produces: no new production code — only tests.

- [ ] **Step 1: Write the test**

```ts
// __test__/mcp/integration-catalog.test.ts
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
	"db_delete",
	// Storage
	"storage_list",
	"storage_create",
	"storage_info",
	"storage_credentials",
	"storage_files",
	"storage_delete",
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
```

- [ ] **Step 2: Run**

Run: `bun run test:vitest __test__/mcp/integration-catalog.test.ts`
Expected: PASS (if it fails on names, the diff will show which tool is missing / mis-named — fix the offending task's registration and re-run).

- [ ] **Step 3: Full sweep**

Run: `bun run test:vitest && bun run typecheck && bun run lint`
Expected: everything PASSES.

- [ ] **Step 4: Commit**

```bash
git add __test__/mcp/integration-catalog.test.ts
git commit -m "$(cat <<'EOF'
test(mcp): integration + contract snapshot for the curated catalog

Uses InMemoryTransport to drive a real MCP Client against the assembled
server, asserts the exact list of 39 tool names + regex + logged-out
auth envelope.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Platform — `agent-setup/prompt.md`

**Files:**
- Create: `/home/stanoid/tarout/platform/public/agent-setup/prompt.md` (separate repo — see steps).

**Interfaces:** none (a static file). Served at `https://tarout.sa/agent-setup/prompt.md` by Next.js's default static handler.

- [ ] **Step 1: Verify the platform side is a distinct repo**

Run: `cd /home/stanoid/tarout/platform && git rev-parse --show-toplevel`
Expected: `/home/stanoid/tarout/platform` (a separate git repo).

- [ ] **Step 2: Create a feature branch on the platform**

Run: `git -C /home/stanoid/tarout/platform checkout -b docs/agent-setup-prompt`
Expected: branch created and checked out.

- [ ] **Step 3: Write the file**

Create `/home/stanoid/tarout/platform/public/agent-setup/prompt.md` with:

```markdown
# Tarout Agent Setup Instructions

Install the Tarout CLI and register its local MCP server with Claude Code:

```
npm i -g @tarout/cli
claude mcp add tarout -- tarout-mcp
```

Then restart Claude Code (or run `/mcp` and reconnect the `tarout` server).

The first Tarout tool call triggers a browser sign-in if you're not
already authenticated (`tarout login` writes a token to
`~/.tarout/config.json`; or set `TAROUT_TOKEN` for CI). No OAuth
integration inside Claude Code — the local CLI owns the token.

For Cursor / Claude Desktop, see the `README` section in
https://github.com/Tarout-SA/cli#mcp — the same `tarout-mcp` binary
plugs into their `mcp.json` / `claude_desktop_config.json`.

The full setup prompt is at https://tarout.sa/agent-setup/prompt.md.
```

- [ ] **Step 4: Commit on the platform repo**

```bash
git -C /home/stanoid/tarout/platform add public/agent-setup/prompt.md
git -C /home/stanoid/tarout/platform -c commit.gpgsign=false commit -m "$(cat <<'EOF'
docs(agent-setup): add tarout MCP bootstrap prompt

Fetch-and-follow doc that installs @tarout/cli and registers tarout-mcp
with Claude Code, matching the Cloudflare agent-setup/prompt.md pattern.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Verify the file is served after next deploy (post-merge)**

After the platform PR merges + deploys, run: `curl -sI https://tarout.sa/agent-setup/prompt.md | head -5`
Expected: `HTTP/2 200` and a content-type (`application/octet-stream` or `text/markdown`). Either is fine for Claude Code's fetcher; if you need to force `text/markdown`, add to `platform/next.config.mjs`:

```js
async headers() {
	return [
		{
			source: "/agent-setup/:path*.md",
			headers: [{ key: "Content-Type", value: "text/markdown; charset=utf-8" }],
		},
	];
},
```

- [ ] **Step 6: No commit on the CLI worktree for this task.**

---

### Task 18: Release — README, CHANGELOG, version bump

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (`version` → `1.2.0`)

**Interfaces:** none (docs + version).

- [ ] **Step 1: Update `README.md`** — insert this section under a top-level `## MCP server` header (or at the end if there's no existing MCP section):

```markdown
## MCP server

`tarout-mcp` is a local MCP server that gives coding agents (Claude Code,
Cursor, Claude Desktop) the CLI's capabilities as first-class tools:
deploy from the current directory, sync `.env`, run SQL against Postgres,
switch org/project/env, upgrade billing, and more — with a `call` escape
hatch covering the entire platform API.

### Setup

**Claude Code**

```
npm i -g @tarout/cli
claude mcp add tarout -- tarout-mcp
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
	"mcpServers": {
		"tarout": { "command": "tarout-mcp" }
	}
}
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
	"mcpServers": {
		"tarout": { "command": "tarout-mcp" }
	}
}
```

### Auth

The server reads your CLI profile (`~/.tarout/config.json`) or the
`TAROUT_TOKEN` env var. If neither is set, tool calls return a structured
`AUTH_ERROR` — run `tarout login` on the same machine.

### Bootstrap URL

Point an agent at `https://tarout.sa/agent-setup/prompt.md` and it will
install the CLI + register the server in one shot.
```

- [ ] **Step 2: Update `CHANGELOG.md`** — insert this entry above the `[Unreleased]` section (or under `[1.2.0]` if you prefer to close it):

```markdown
## [1.2.0]

### Added

- **`tarout-mcp` is now a self-contained local MCP server** (was a thin stdio
  proxy). ~36 curated tools plus a `call` / `list_procedures` /
  `describe_procedure` escape hatch cover the CLI's real capabilities —
  deploy from the current directory, sync `.env`, connection credentials for
  Postgres/MySQL/S3-compatible buckets, org/project/env switching, billing
  upgrade with hosted-checkout polling. Auth is lazy: the server stays alive
  when logged out; the first tool call returns an `AUTH_ERROR` envelope with
  remediation.
- `https://tarout.sa/agent-setup/prompt.md` — fetch-and-follow install
  bootstrap for coding agents (Claude Code, Cursor, Claude Desktop).

### Changed

- `src/commands/call.ts` reuses `src/lib/surface-manifest.ts` (extracted).
- `src/commands/env.ts` reuses `src/lib/env-core.ts` (extracted).
- `src/commands/deploy.ts::createSourceArchive` is now exported.
```

- [ ] **Step 3: Bump `package.json`**

Change:

```json
"version": "1.1.0",
```

to:

```json
"version": "1.2.0",
```

- [ ] **Step 4: Full green build**

Run: `bun run build && bun run test:vitest && bun run typecheck && bun run lint`
Expected: all PASS. Confirm `dist/mcp/stdio.js` exists.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "$(cat <<'EOF'
chore(cli): release 1.2.0 — local MCP server + bootstrap prompt

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Push branch + open PR**

```bash
git push -u origin feat/mcp-local-server
gh pr create --title "feat(mcp): local MCP server with CLI parity (v1.2.0)" --body "$(cat <<'EOF'
## Summary
- Replaces the stdio proxy at \`src/mcp/stdio.ts\` with a self-contained local MCP server (\`src/mcp/{server,runtime,tools/*}.ts\`).
- 36 curated tools (deploy, env, apps, db, storage, domains, billing, context) + 3 discovery (\`call\`, \`list_procedures\`, \`describe_procedure\`).
- Lazy per-call auth — the server no longer dies when logged out; \`AUTH_ERROR\` remediation instead.
- Companion platform PR: static \`public/agent-setup/prompt.md\` served at https://tarout.sa/agent-setup/prompt.md.

## Test plan
- [ ] \`bun run test:vitest\` — new mcp/* specs + existing baseline
- [ ] \`bun run typecheck && bun run lint\`
- [ ] Manual: \`claude mcp add tarout -- tarout-mcp\` in Claude Code, run \`context_status\` then \`deployment_status app=<one-of-my-apps>\`
- [ ] Manual: unauthenticated \`env_list\` returns \`AUTH_ERROR\` envelope (server stays alive)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL. Do NOT merge — leave open for review.

---

## Self-Review

- **Spec coverage.** Each section of the spec maps to a task:
  - "Runtime" (spec §Auth model + §Error handling) → Task 2.
  - "Boot sequence" (§Boot) → Task 3.
  - Surface-manifest extraction (§ new libs) → Task 4.
  - Discovery + call escape hatch (§Tool catalog "Escape hatch") → Task 5.
  - env-core extraction + env_* tools → Tasks 6, 7.
  - context_* / link → Task 8.
  - Apps / db / storage / domains / billing curated bundles → Tasks 9–13.
  - Deploy pipeline (§Deploy pipeline) → Tasks 14 (status/logs + export) + 15 (deploy).
  - Integration + contract test (§Testing) → Task 16.
  - Agent bootstrap (§ new "Agent bootstrap") → Task 17.
  - Packaging & rollout (§Packaging) → Task 18.
- **Placeholder scan.** No TBDs, "similar to Task N", or vague "add error handling" — every step shows the code. The "Interfaces" blocks include exact function names / return shapes for downstream tasks.
- **Type consistency.** `resolveAppRef` (defined in Task 6, used in Tasks 7–15) returns `{ applicationId, name }` everywhere. `withAuth(fn)` (Task 2) is used identically in every tool module. `registerCallTools/registerEnvTools/…` all take `(server: McpServer)` and return `void`. `ManifestEntry` re-imported consistently from `../lib/surface-manifest.js`.
- **Known gaps.** `db_credentials` reads credentials off `postgres.one`/`mysql.one` responses. Field names (`host` vs. `externalHost`, etc.) come from actual server payloads and are covered via `??`-fallback; if the server changes those, the test's fake needs the same key rename — that's a maintenance cost we accept in exchange for not adding a bespoke credentials endpoint.
