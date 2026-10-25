import { describe, expect, it } from "vitest";
import {
	sanitizeMcpCallResult,
	sanitizeToolResult,
} from "../src/mcp/sanitize-result";

describe("MCP result sanitization", () => {
	it("removes inline images from nested content and serialized JSON text", () => {
		const result = sanitizeMcpCallResult({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						screenshot: "data:image/jpeg;base64,aGVsbG8=",
						name: "app",
					}),
				},
			],
		});

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("data:image/");
		expect(serialized).toContain("inline image omitted");
		expect(serialized).toContain("app");
	});

	it("redacts persisted credentials inside upstream MCP text content", () => {
		const result = sanitizeMcpCallResult({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						databasePassword: "db-secret",
						externalConnectionString:
							"postgresql://user:db-secret@db.example.com/app",
						nested: { root_password: "root-secret" },
						name: "qa-db",
					}),
				},
			],
		});

		const serialized = JSON.stringify(result);
		expect(serialized).toContain("[redacted from MCP response]");
		expect(serialized).toContain("qa-db");
		expect(serialized).not.toContain("db-secret");
		expect(serialized).not.toContain("root-secret");
	});

	it("redacts the new credential key patterns case/format-insensitively", () => {
		const result = sanitizeMcpCallResult({
			apiKey: "ak-123",
			api_key: "ak-456",
			accessToken: "at-789",
			refreshToken: "rt-000",
			privateKey: "-----BEGIN KEY-----",
			connectionString: "server=db;pwd=hunter2",
			DATABASE_URL: "postgres://u:p@h/db",
			SESSION_SECRET: "s3cr3t",
			authToken: "tok-xyz",
			name: "keep-me",
			count: 7,
		}) as Record<string, unknown>;

		expect(result.apiKey).toBe("[redacted from MCP response]");
		expect(result.api_key).toBe("[redacted from MCP response]");
		expect(result.accessToken).toBe("[redacted from MCP response]");
		expect(result.refreshToken).toBe("[redacted from MCP response]");
		expect(result.privateKey).toBe("[redacted from MCP response]");
		expect(result.connectionString).toBe("[redacted from MCP response]");
		expect(result.DATABASE_URL).toBe("[redacted from MCP response]");
		expect(result.SESSION_SECRET).toBe("[redacted from MCP response]");
		expect(result.authToken).toBe("[redacted from MCP response]");
		// Non-sensitive fields are preserved.
		expect(result.name).toBe("keep-me");
		expect(result.count).toBe(7);
	});

	it("recurses through nested arrays of objects", () => {
		const result = sanitizeMcpCallResult({
			services: [
				{ name: "web", token: "leak-1" },
				{ name: "worker", nested: [{ password: "leak-2" }] },
			],
		});

		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("leak-1");
		expect(serialized).not.toContain("leak-2");
		expect(serialized).toContain("web");
		expect(serialized).toContain("worker");
	});

	it("redacts only the password portion of a connection-URL string value", () => {
		const result = sanitizeMcpCallResult({
			// A key NOT on the sensitive list, so the value-level URL redaction is
			// what has to catch the embedded password.
			redisUri: "redis://admin:s3cr3t@cache.example.com:6379/0",
		}) as Record<string, string>;

		expect(result.redisUri).toContain("redis://admin:");
		expect(result.redisUri).toContain("@cache.example.com:6379/0");
		expect(result.redisUri).toContain("[redacted from MCP response]");
		expect(result.redisUri).not.toContain("s3cr3t");
	});

	it("redacts a bare connection-string passed as a plain string", () => {
		const out = sanitizeMcpCallResult(
			"postgres://user:topsecret@db.internal:5432/app",
		);
		expect(out).toContain("postgres://user:");
		expect(out).toContain("@db.internal:5432/app");
		expect(out).not.toContain("topsecret");
	});
});

describe("local file paths a tool wrote", () => {
	const tmpPath = "/var/folders/7l/1bj8h4x52sq5k3n0w0bqgxx40000gn/T/tarout-ai-Ab3XyZ/speech.mp3";

	it("keep mixed-case, digit-heavy paths under path keys (ai_speak, ai_image_generate)", () => {
		const out = sanitizeMcpCallResult({
			path: tmpPath,
			files: ["/tmp/tarout-ai-Ab3XyZ/att_cmh1x2y3z0000abcd1234efgh-1.png"],
		});
		expect(out.path).toBe(tmpPath);
		expect(out.files[0]).toBe("/tmp/tarout-ai-Ab3XyZ/att_cmh1x2y3z0000abcd1234efgh-1.png");
	});

	it("still redacts token shapes inside a path, and the same string under any other key", () => {
		const out = sanitizeMcpCallResult({
			outPath: "/Users/x/out/sk_live_ABCDEFGHIJKLMNOPQRSTUVWX.json",
			note: tmpPath,
		});
		expect(out.outPath).not.toContain("sk_live_");
		expect(out.note).toContain("[redacted from MCP response]");
	});

	it("never exempts a URL under a path key", () => {
		const url =
			"https://storage.googleapis.com/b/tmp/media-images/Xk3pQ9rT2vW8yZ1aB4cD6eF7gH0jK5mN/a.mp3";
		expect(sanitizeMcpCallResult({ path: url }).path).toContain("[redacted from MCP response]");
	});
});

describe("sanitizeToolResult allowlist", () => {
	const secretPayload = {
		content: [
			{
				type: "text",
				text: JSON.stringify({ password: "shh", host: "db.example.com" }),
			},
		],
		structuredContent: { password: "shh", host: "db.example.com" },
	};

	it.each(["db_credentials", "storage_credentials"])(
		"skips sanitization for the explicit credential tool %s",
		(toolName) => {
			const out = sanitizeToolResult(secretPayload, toolName);
			expect(JSON.stringify(out)).toContain("shh");
		},
	);

	it.each(["db_info", "db_create", "call"])(
		"sanitizes results for non-credential tool %s",
		(toolName) => {
			const out = sanitizeToolResult(secretPayload, toolName);
			const serialized = JSON.stringify(out);
			expect(serialized).not.toContain("shh");
			expect(serialized).toContain("[redacted from MCP response]");
			expect(serialized).toContain("db.example.com");
		},
	);

	it("keeps the allowlist narrow", () => {
		const dbInfo = sanitizeToolResult(secretPayload, "db_info");
		const storageCredentials = sanitizeToolResult(
			secretPayload,
			"storage_credentials",
		);

		expect(JSON.stringify(dbInfo)).not.toContain("shh");
		expect(JSON.stringify(storageCredentials)).toContain("shh");
	});
});
