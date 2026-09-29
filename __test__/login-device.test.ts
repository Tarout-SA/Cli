import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout login --device` end to end through the real command: the code is
 * shown (a box for humans, one `device_code` event line under --json), the CLI
 * polls the platform, and on approval the credential goes through the SAME
 * resolve/persist/report path the loopback browser login uses. Denied,
 * expired, unsupported (404) and Ctrl+C all end unauthenticated with exit 3
 * and nothing saved. Only the network (global fetch) and the credential
 * stores are faked.
 */

const m = vi.hoisted(() => ({
	setProfile: vi.fn(),
	setCurrentProfile: vi.fn(),
	isLoggedIn: vi.fn(() => false),
	getCurrentProfile: vi.fn(() => null),
	resolveProfileFromCredential: vi.fn(),
	getProjectCredential: vi.fn(() => null),
	setProjectCredential: vi.fn(() => "/tmp/project/.tarout/auth.json"),
	isProjectTokenCommitted: vi.fn(() => false),
	setProjectTokenCommitted: vi.fn(() => true),
	probeCredentialInGit: vi.fn(() => ({ ignored: null, tracked: null })),
	resolveCredentialPlacement: vi.fn(
		(requested: "project" | "global" | "auto") =>
			requested === "global"
				? { scope: "global" as const }
				: { scope: "project" as const, projectDir: "/tmp/project" },
	),
	startCliBrowserAuth: vi.fn(),
	resolveActiveProject: vi.fn(async () => null),
}));

vi.mock("../src/lib/config.js", () => ({
	setProfile: m.setProfile,
	setCurrentProfile: m.setCurrentProfile,
	isLoggedIn: m.isLoggedIn,
	getCurrentProfile: m.getCurrentProfile,
	getGlobalProfile: vi.fn(() => null),
	getAuthScope: vi.fn(() => ({ scope: "none" })),
	getToken: vi.fn(() => undefined),
	getApiUrl: vi.fn(() => "https://tarout.sa"),
	getConfig: vi.fn(() => ({ currentProfile: "default", profiles: {} })),
	deleteProfile: vi.fn(),
	listProfiles: vi.fn(() => []),
	clearConfig: vi.fn(),
}));

vi.mock("../src/lib/project-auth.js", () => ({
	getProjectCredential: m.getProjectCredential,
	setProjectCredential: m.setProjectCredential,
	removeProjectCredential: vi.fn(),
	resolveCredentialPlacement: m.resolveCredentialPlacement,
	isProjectTokenCommitted: m.isProjectTokenCommitted,
	setProjectTokenCommitted: m.setProjectTokenCommitted,
	probeCredentialInGit: m.probeCredentialInGit,
}));

vi.mock("../src/lib/auth-profile.js", () => ({
	resolveProfileFromCredential: m.resolveProfileFromCredential,
	createCredentialClient: vi.fn(),
}));

vi.mock("../src/lib/active-project.js", () => ({
	resolveActiveProject: m.resolveActiveProject,
}));

// Only the loopback server is faked; the credential parser stays real so the
// device flow validates its 200 body exactly as the exchange does.
vi.mock("../src/lib/auth-server.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/auth-server.js")>()),
	startCliBrowserAuth: m.startCliBrowserAuth,
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

import { Command } from "commander";
import { registerAuthCommands } from "../src/commands/auth";
import { setGlobalOptions } from "../src/lib/output";

const RESET = {
	json: false,
	quiet: false,
	verbose: false,
	noColor: false,
	yes: false,
	nonInteractive: false,
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars.
const ANSI = /\x1b\[[0-9;]*m/g;

// A tiny interval keeps the real-timer polling loop fast.
const CODE_BODY = {
	device_code: "dc_secret_do_not_print",
	user_code: "ABCD-EFGH",
	verification_uri: "https://tarout.sa/device",
	verification_uri_complete: "https://tarout.sa/device?code=ABCD-EFGH",
	expires_in: 600,
	interval: 0.01,
};

const CREDENTIAL = {
	token: "cli_tok_abc",
	userId: "user-1",
	userEmail: "owner@example.com",
	userName: "Owner",
	organizationId: "org-1",
	organizationName: "Acme",
};

const RESOLVED = {
	...CREDENTIAL,
	apiUrl: "https://tarout.sa",
	projectId: "project-1",
	projectName: "Project One",
	projectSlug: "project-one",
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

let stdout: string[];
let stderr: string[];
let exitCodes: number[];
let requests: Array<{ url: string; body: unknown }>;
let tokenResponses: Array<() => Response>;
let codeResponse: () => Response;

beforeEach(() => {
	stdout = [];
	stderr = [];
	exitCodes = [];
	requests = [];
	tokenResponses = [];
	codeResponse = () => json(200, CODE_BODY);
	vi.clearAllMocks();
	m.isLoggedIn.mockReturnValue(false);
	m.getProjectCredential.mockReturnValue(null);
	m.resolveProfileFromCredential.mockResolvedValue(RESOLVED);
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
			if (url.endsWith("/api/cli/device/code")) return codeResponse();
			if (url.endsWith("/api/cli/device/token")) {
				const next = tokenResponses.shift();
				if (!next) throw new Error("unexpected extra poll");
				return next();
			}
			throw new Error(`unexpected request to ${url}`);
		}),
	);
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	// nonInteractive keeps the post-login project picker out of the way.
	setGlobalOptions({ ...RESET, noColor: true, nonInteractive: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerAuthCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON lines are asserted field by field.
const lines = (): any[] => stdout.map((l) => JSON.parse(l));

const pending = () => json(400, { error: "authorization_pending" });
const approved = () => json(200, CREDENTIAL);

describe("tarout login --device", () => {
	it("prints the URL, the code and the warning, and never the secret device code", async () => {
		tokenResponses = [approved];
		await run(["login", "--device"]);

		expect(exitCodes).toEqual([]);
		const text = out();
		expect(text).toContain("https://tarout.sa/device");
		expect(text).toContain("ABCD-EFGH");
		expect(text).toContain("Only approve a code you started yourself.");
		// The prefilled link is offered too; the browser opener itself is
		// suppressed in unit tests (see setup-browser-safety.ts).
		expect(text).toContain("https://tarout.sa/device?code=ABCD-EFGH");
		expect(text).not.toContain("dc_secret_do_not_print");
		expect(err()).not.toContain("dc_secret_do_not_print");
		expect(requests[0]).toEqual({
			url: "https://tarout.sa/api/cli/device/code",
			body: { clientName: expect.stringMatching(/^Tarout CLI/) },
		});
	});

	it("keeps polling while pending, then stores the credential exactly like the loopback login", async () => {
		// Loopback browser login first, for the reference write.
		m.startCliBrowserAuth.mockResolvedValue({
			port: 4567,
			authUrl: "https://tarout.sa/cli-authorize?callback=x",
			waitForCallback: async () => CREDENTIAL,
			close: vi.fn(),
		});
		await run(["login"], { json: true });
		expect(exitCodes).toEqual([]);
		expect(m.setProjectCredential).toHaveBeenCalledTimes(1);
		const [loopbackCredential, loopbackDir] =
			m.setProjectCredential.mock.calls[0] ?? [];
		const loopbackEnvelope = lines().at(-1);

		stdout = [];
		m.setProjectCredential.mockClear();
		tokenResponses = [pending, pending, approved];
		await run(["login", "--device"], { json: true });

		expect(exitCodes).toEqual([]);
		expect(requests.filter((r) => r.url.endsWith("/device/token"))).toEqual(
			Array(3).fill({
				url: "https://tarout.sa/api/cli/device/token",
				body: { device_code: "dc_secret_do_not_print" },
			}),
		);
		expect(m.setProjectCredential).toHaveBeenCalledTimes(1);
		const [deviceCredential, deviceDir] =
			m.setProjectCredential.mock.calls[0] ?? [];
		expect(deviceDir).toBe(loopbackDir);
		expect(loopbackCredential).toMatchObject({ ...RESOLVED, source: "login" });
		expect(deviceCredential).toEqual({
			...loopbackCredential,
			source: "login --device",
		});
		// Same final envelope as the loopback login.
		expect(lines().at(-1)).toEqual(loopbackEnvelope);
		expect(m.setProfile).not.toHaveBeenCalled();
	});

	it("honors --global like the loopback login", async () => {
		tokenResponses = [approved];
		await run(["login", "--device", "--global"], { json: true });

		expect(exitCodes).toEqual([]);
		expect(m.resolveCredentialPlacement).toHaveBeenCalledWith("global");
		expect(m.setProfile).toHaveBeenCalledWith("default", RESOLVED);
		expect(m.setCurrentProfile).toHaveBeenCalledWith("default");
		expect(m.setProjectCredential).not.toHaveBeenCalled();
		expect(lines().at(-1)).toMatchObject({
			success: true,
			data: { scope: "global", user: { email: "owner@example.com" } },
		});
	});

	it("--json prints one device_code event first, then the final envelope", async () => {
		tokenResponses = [pending, approved];
		await run(["login", "--device"], { json: true });

		expect(exitCodes).toEqual([]);
		const [event, ...rest] = lines();
		expect(event).toEqual({
			type: "event",
			event: "device_code",
			user_code: "ABCD-EFGH",
			verification_uri: "https://tarout.sa/device",
			verification_uri_complete: "https://tarout.sa/device?code=ABCD-EFGH",
			expires_in: 600,
		});
		expect(rest).toHaveLength(1);
		expect(rest[0]).toMatchObject({
			success: true,
			data: {
				scope: "project",
				credentialPath: "/tmp/project/.tarout/auth.json",
				organization: { id: "org-1", name: "Acme" },
			},
		});
		expect(out()).not.toContain("dc_secret_do_not_print");
	});

	it("stops on access_denied with the auth error code and saves nothing", async () => {
		tokenResponses = [pending, () => json(400, { error: "access_denied" })];
		await run(["login", "--device"], { json: true });

		expect(exitCodes).toEqual([3]);
		const envelope = lines().at(-1);
		expect(envelope.success).toBe(false);
		expect(envelope.error.code).toBe("AUTH_ERROR");
		expect(envelope.error.message).toContain("denied");
		expect(envelope.error.details).toMatchObject({
			reason: "access_denied",
			nextCommand: "tarout login --device",
		});
		expect(m.setProjectCredential).not.toHaveBeenCalled();
		expect(m.setProfile).not.toHaveBeenCalled();
	});

	it("stops on expired_token and suggests running it again", async () => {
		tokenResponses = [() => json(400, { error: "expired_token" })];
		await run(["login", "--device"]);

		expect(exitCodes).toEqual([3]);
		expect(err()).toContain("expired");
		expect(err()).toContain("Run `tarout login --device` again");
		expect(m.setProjectCredential).not.toHaveBeenCalled();
	});

	it("tells an older server's user to use --token (404)", async () => {
		codeResponse = () => json(404, { message: "Not found" });
		await run(["login", "--device"]);

		expect(exitCodes).toEqual([3]);
		expect(err()).toContain("does not support `tarout login --device`");
		expect(err()).toContain("tarout login --token <key>");
		expect(requests).toHaveLength(1);
		expect(m.setProjectCredential).not.toHaveBeenCalled();
	});

	it("Ctrl+C stops polling cleanly: exit 3, nothing saved, listener removed", async () => {
		const listenersBefore = process.listenerCount("SIGINT");
		// A real 5-second interval: only Ctrl+C can end this wait early.
		codeResponse = () => json(200, { ...CODE_BODY, interval: 5 });

		const done = run(["login", "--device"], { json: true });
		await vi.waitFor(() =>
			expect(process.listenerCount("SIGINT")).toBe(listenersBefore + 1),
		);
		process.emit("SIGINT");
		await done;

		expect(exitCodes).toEqual([3]);
		// It never got as far as polling.
		expect(requests.filter((r) => r.url.endsWith("/device/token"))).toEqual(
			[],
		);
		const envelope = lines().at(-1);
		expect(envelope.error.details.reason).toBe("interrupted");
		expect(envelope.error.message).toContain("cancelled");
		expect(m.setProjectCredential).not.toHaveBeenCalled();
		expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
	});

	it("rejects --device together with --token (exit 2) before any request", async () => {
		await run(["login", "--device", "--token", "tk_123"]);
		expect(exitCodes).toEqual([2]);
		expect(err()).toContain("either --token or --device");
		expect(requests).toEqual([]);
	});

	it("skips the flow when this project is already signed in", async () => {
		m.getProjectCredential.mockReturnValue({
			projectDir: "/tmp/project",
			path: "/tmp/project/.tarout/auth.json",
			credential: { userEmail: "owner@example.com", organizationName: "Acme" },
		} as never);
		await run(["login", "--device"], { json: true });

		expect(exitCodes).toEqual([]);
		expect(requests).toEqual([]);
		expect(lines().at(-1)).toMatchObject({
			data: { alreadyLoggedIn: true, userEmail: "owner@example.com" },
		});
	});
});
