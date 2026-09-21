import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getCredentialResolutionDir,
	setCredentialResolutionDir,
} from "../../src/lib/project-auth";

vi.mock("../../src/lib/config", () => ({
	isLoggedIn: () => true,
	getToken: () => `token:${getCredentialResolutionDir()}`,
	getApiUrl: () =>
		`https://${getCredentialResolutionDir().split("/").at(-1)}.tarout.sa`,
	getCurrentProfile: () => ({
		projectId: `project:${getCredentialResolutionDir()}`,
	}),
}));

const requests = vi.hoisted(
	() => [] as Array<{ url: string; headers: Record<string, string> }>,
);
vi.mock("../../src/lib/password-gate", () => ({
	platformFetch: async (
		url: string,
		options: { headers: Record<string, string> },
	) => {
		requests.push({ url: String(url), headers: options.headers });
		return new Response(
			JSON.stringify([{ result: { data: { json: { ok: true } } } }]),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	},
}));

import {
	getApiClient,
	getRequestProjectId,
	resetApiClient,
	setRequestProjectId,
} from "../../src/lib/api";
import { withAuth } from "../../src/mcp/runtime";

function barrier() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

afterEach(() => {
	resetApiClient();
	setCredentialResolutionDir(null);
	setRequestProjectId(null);
	requests.length = 0;
});

describe("MCP invocation credential isolation", () => {
	it("keeps origins, tokens, projects, and clients paired across overlapping calls", async () => {
		const aEntered = barrier();
		const bEntered = barrier();
		const aDone = barrier();
		setCredentialResolutionDir("/workspace/default");
		const a = withAuth(
			async (client) => {
				setRequestProjectId("project-a");
				aEntered.release();
				await bEntered.promise;
				expect(getCredentialResolutionDir()).toBe("/workspace/a");
				expect(getApiClient()).toBe(client);
				expect(getRequestProjectId()).toBe("project-a");
				return client.user.get.query();
			},
			undefined,
			{ cwd: "/workspace/a" },
		).finally(aDone.release);
		await aEntered.promise;
		const b = withAuth(
			async (client) => {
				setRequestProjectId("project-b");
				bEntered.release();
				await aDone.promise;
				expect(getCredentialResolutionDir()).toBe("/workspace/b");
				expect(getApiClient()).toBe(client);
				expect(getRequestProjectId()).toBe("project-b");
				return client.user.get.query();
			},
			undefined,
			{ cwd: "/workspace/b" },
		);
		const results = await Promise.all([a, b]);
		expect(results.map((r) => r.isError)).toEqual([undefined, undefined]);
		expect(
			requests.map((r) => ({
				host: new URL(r.url).host,
				token: r.headers["x-api-key"],
				project: r.headers["x-tarout-project"],
			})),
		).toEqual([
			{
				host: "a.tarout.sa",
				token: "token:/workspace/a",
				project: "project-a",
			},
			{
				host: "b.tarout.sa",
				token: "token:/workspace/b",
				project: "project-b",
			},
		]);
		expect(getCredentialResolutionDir()).toBe("/workspace/default");
	});
});
