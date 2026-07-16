import { describe, expect, it } from "vitest";
import { sanitizeMcpCallResult } from "../src/mcp/sanitize-result";

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
});
