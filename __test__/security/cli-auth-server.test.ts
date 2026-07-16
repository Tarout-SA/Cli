import { describe, expect, it } from "vitest";
import { startAuthServer } from "../../src/lib/auth-server";

function callbackUrl(port: number, params: Record<string, string>) {
	const url = new URL(`http://127.0.0.1:${port}/callback`);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

describe("CLI auth callback server", () => {
	it("requires the expected state before accepting a CLI token", async () => {
		const server = await startAuthServer({ state: "state_1234567890" });
		try {
			const rejected = await fetch(
				callbackUrl(server.port, {
					state: "wrong_state",
					token: "cli_bad",
					userId: "user_1",
					userEmail: "attacker@example.com",
					organizationId: "org_1",
					organizationName: "Org",
					projectId: "project_1",
					projectName: "Project One",
				}),
			);

			expect(rejected.status).toBe(400);

			const wait = server.waitForCallback();
			const accepted = await fetch(
				callbackUrl(server.port, {
					state: "state_1234567890",
					token: "cli_good",
					userId: "user_1",
					userEmail: "user@example.com",
					organizationId: "org_1",
					organizationName: "Org",
					projectId: "project_1",
					projectName: "Project One",
				}),
			);

			expect(accepted.status).toBe(200);
			await expect(wait).resolves.toMatchObject({
				token: "cli_good",
				userEmail: "user@example.com",
				projectId: "project_1",
				projectName: "Project One",
			});
		} finally {
			server.close();
		}
	});

	it("escapes callback error text in the browser response", async () => {
		const server = await startAuthServer({ state: "state_1234567890" });
		try {
			const wait = server.waitForCallback().catch((error) => error);
			const response = await fetch(
				callbackUrl(server.port, {
					state: "state_1234567890",
					error: '<script>alert("xss")</script>',
				}),
			);
			const text = await response.text();

			expect(response.status).toBe(200);
			expect(text).not.toContain("<script>");
			expect(text).toContain("&lt;script&gt;");
			await expect(wait).resolves.toBeInstanceOf(Error);
		} finally {
			server.close();
		}
	});
});
