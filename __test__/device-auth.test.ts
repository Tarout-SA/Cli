import { describe, expect, it, vi } from "vitest";

/**
 * The device flow behind `tarout login --device`: request a one-time code, then
 * poll `/api/cli/device/token` every `interval` seconds until a human approves
 * or denies it, the code expires, or the user presses Ctrl+C. The loop takes an
 * injected fetch, clock and sleep, so every rule here runs without a network or
 * real waiting.
 */

import { CliError } from "../src/lib/errors";
import {
	type DeviceCode,
	MAX_CONSECUTIVE_POLL_FAILURES,
	deviceClientName,
	parseDeviceCodeResponse,
	pollDeviceToken,
	requestDeviceCode,
	waitForDeviceAuthorization,
} from "../src/lib/device-auth";
import { ExitCode } from "../src/utils/exit-codes";

const API = "https://tarout.sa";

const CODE_BODY = {
	device_code: "dc_secret_123",
	user_code: "ABCD-EFGH",
	verification_uri: "https://tarout.sa/device",
	verification_uri_complete: "https://tarout.sa/device?code=ABCD-EFGH",
	expires_in: 900,
	interval: 5,
};

const CODE: DeviceCode = {
	deviceCode: "dc_secret_123",
	userCode: "ABCD-EFGH",
	verificationUri: "https://tarout.sa/device",
	verificationUriComplete: "https://tarout.sa/device?code=ABCD-EFGH",
	expiresIn: 900,
	interval: 5,
};

const CREDENTIAL = {
	token: "cli_tok_abc",
	userId: "user-1",
	userEmail: "owner@example.com",
	userName: "Owner",
	organizationId: "org-1",
	organizationName: "Acme",
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const pending = () => json(400, { error: "authorization_pending" });

/** A fetch that answers each call with the next queued response. */
function queuedFetch(...responses: Array<Response | Error>) {
	const calls: Array<{ url: string; body: unknown }> = [];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra request");
		if (next instanceof Error) throw next;
		return next;
	});
	return { fetch, calls };
}

/** A fake clock whose sleep advances it and records every wait. */
function fakeClock() {
	let t = 1_000_000;
	const sleeps: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
		sleeps,
	};
}

describe("requestDeviceCode", () => {
	it("posts the client name to /api/cli/device/code and parses the code", async () => {
		const { fetch, calls } = queuedFetch(json(200, CODE_BODY));
		const code = await requestDeviceCode(`${API}/`, {
			clientName: "Tarout CLI on box",
			fetch,
		});
		expect(calls).toEqual([
			{
				url: "https://tarout.sa/api/cli/device/code",
				body: { clientName: "Tarout CLI on box" },
			},
		]);
		expect(code).toEqual(CODE);
	});

	it("points at `tarout login --token` when the server has no device endpoints (404)", async () => {
		const { fetch } = queuedFetch(json(404, { message: "Not found" }));
		const error = await requestDeviceCode(API, { fetch }).catch((e) => e);
		expect(error).toBeInstanceOf(CliError);
		expect(error.code).toBe(ExitCode.AUTH_ERROR);
		expect(error.message).toContain("does not support `tarout login --device`");
		expect(error.message).toContain("tarout login --token <key>");
		expect(error.message).toContain("https://tarout.sa/dashboard/agent/keys");
		expect(error.details).toMatchObject({
			reason: "device_flow_unsupported",
			nextCommand: "tarout login --token <key>",
		});
	});

	it("surfaces the server's message on other failures", async () => {
		const { fetch } = queuedFetch(
			json(429, { message: "Too many CLI authorization attempts." }),
		);
		await expect(requestDeviceCode(API, { fetch })).rejects.toThrow(
			"Too many CLI authorization attempts.",
		);
	});

	it("keeps the client name short enough for the approval page", () => {
		const name = deviceClientName();
		expect(name.startsWith("Tarout CLI")).toBe(true);
		expect(name.length).toBeLessThanOrEqual(64);
	});
});

describe("parseDeviceCodeResponse", () => {
	it("defaults interval to 5 and verification_uri_complete to verification_uri", () => {
		const {
			interval: _interval,
			verification_uri_complete: _complete,
			...rest
		} = CODE_BODY;
		expect(parseDeviceCodeResponse(rest)).toMatchObject({
			interval: 5,
			verificationUriComplete: "https://tarout.sa/device",
		});
	});

	it("refuses a URL the browser opener must never receive", () => {
		for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
			expect(() =>
				parseDeviceCodeResponse({ ...CODE_BODY, verification_uri_complete: bad }),
			).toThrow("invalid response to the device login request");
		}
	});

	it("refuses a response missing the code or expiry", () => {
		for (const key of ["device_code", "user_code", "expires_in"] as const) {
			const body: Record<string, unknown> = { ...CODE_BODY };
			delete body[key];
			expect(() => parseDeviceCodeResponse(body)).toThrow(
				"invalid response to the device login request",
			);
		}
	});
});

describe("pollDeviceToken", () => {
	it("sends only the device code and validates the credential body", async () => {
		const { fetch, calls } = queuedFetch(json(200, CREDENTIAL));
		const poll = await pollDeviceToken(API, "dc_secret_123", { fetch });
		expect(calls).toEqual([
			{
				url: "https://tarout.sa/api/cli/device/token",
				body: { device_code: "dc_secret_123" },
			},
		]);
		expect(poll).toEqual({ status: "authorized", authData: CREDENTIAL });
	});

	it("rejects a 200 that is not the /api/cli/exchange body", async () => {
		const { fetch } = queuedFetch(json(200, { token: "x" }));
		await expect(pollDeviceToken(API, "dc", { fetch })).rejects.toThrow(
			"invalid response",
		);
	});
});

describe("waitForDeviceAuthorization", () => {
	it("waits `interval` before every poll and returns the credential after pending", async () => {
		const clock = fakeClock();
		const { fetch, calls } = queuedFetch(
			pending(),
			pending(),
			json(200, CREDENTIAL),
		);
		const result = await waitForDeviceAuthorization(API, CODE, {
			fetch,
			...clock,
		});
		expect(result).toEqual({ outcome: "authorized", authData: CREDENTIAL });
		expect(calls).toHaveLength(3);
		expect(clock.sleeps).toEqual([5000, 5000, 5000]);
	});

	it("adds 5 seconds on every slow_down, and keeps it", async () => {
		const clock = fakeClock();
		const onSlowDown = vi.fn();
		const { fetch } = queuedFetch(
			json(400, { error: "slow_down" }),
			pending(),
			json(400, { error: "slow_down" }),
			json(200, CREDENTIAL),
		);
		const result = await waitForDeviceAuthorization(API, CODE, {
			fetch,
			onSlowDown,
			...clock,
		});
		expect(result.outcome).toBe("authorized");
		expect(clock.sleeps).toEqual([5000, 10_000, 10_000, 15_000]);
		expect(onSlowDown.mock.calls).toEqual([[10], [15]]);
	});

	it("treats a 429 like slow_down", async () => {
		const clock = fakeClock();
		const { fetch } = queuedFetch(json(429, {}), json(200, CREDENTIAL));
		await waitForDeviceAuthorization(API, CODE, { fetch, ...clock });
		expect(clock.sleeps).toEqual([5000, 10_000]);
	});

	it("stops on access_denied", async () => {
		const clock = fakeClock();
		const { fetch } = queuedFetch(
			pending(),
			json(400, { error: "access_denied" }),
		);
		const result = await waitForDeviceAuthorization(API, CODE, {
			fetch,
			...clock,
		});
		expect(result).toEqual({ outcome: "denied" });
	});

	it("stops on expired_token", async () => {
		const clock = fakeClock();
		const { fetch } = queuedFetch(json(400, { error: "expired_token" }));
		const result = await waitForDeviceAuthorization(API, CODE, {
			fetch,
			...clock,
		});
		expect(result).toEqual({ outcome: "expired" });
	});

	it("gives up at expires_in even if the server keeps saying pending", async () => {
		const clock = fakeClock();
		const { fetch } = queuedFetch(pending(), pending(), pending());
		const result = await waitForDeviceAuthorization(
			API,
			{ ...CODE, expiresIn: 12 },
			{ fetch, ...clock },
		);
		expect(result).toEqual({ outcome: "expired" });
		// 5s + 5s, then only the 2s left before the deadline; never past it.
		expect(clock.sleeps).toEqual([5000, 5000, 2000]);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("returns interrupted without another poll once Ctrl+C flips the flag", async () => {
		const clock = fakeClock();
		let interrupted = false;
		const { fetch } = queuedFetch(pending());
		const result = await waitForDeviceAuthorization(API, CODE, {
			fetch,
			now: clock.now,
			sleep: async (ms) => {
				await clock.sleep(ms);
				// The second sleep is the one Ctrl+C wakes.
				if (clock.sleeps.length === 2) interrupted = true;
			},
			isInterrupted: () => interrupted,
		});
		expect(result).toEqual({ outcome: "interrupted" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("rides out transient network failures and 5xx answers", async () => {
		const clock = fakeClock();
		const { fetch } = queuedFetch(
			new TypeError("fetch failed"),
			json(503, {}),
			json(200, CREDENTIAL),
		);
		const result = await waitForDeviceAuthorization(API, CODE, {
			fetch,
			...clock,
		});
		expect(result.outcome).toBe("authorized");
	});

	it("gives up after too many failures in a row", async () => {
		const clock = fakeClock();
		const failures = Array.from(
			{ length: MAX_CONSECUTIVE_POLL_FAILURES },
			() => json(502, {}),
		);
		const { fetch } = queuedFetch(...failures);
		await expect(
			waitForDeviceAuthorization(API, CODE, { fetch, ...clock }),
		).rejects.toThrow("HTTP 502");
		expect(fetch).toHaveBeenCalledTimes(MAX_CONSECUTIVE_POLL_FAILURES);
	});

	it("points at `tarout login --token` when the token endpoint is missing (404)", async () => {
		const clock = fakeClock();
		const { fetch } = queuedFetch(json(404, {}));
		await expect(
			waitForDeviceAuthorization(API, CODE, { fetch, ...clock }),
		).rejects.toThrow("tarout login --token <key>");
	});

	it("fails with a rerun hint on an unknown 400 error", async () => {
		const clock = fakeClock();
		const { fetch } = queuedFetch(json(400, { error: "invalid_grant" }));
		const error = await waitForDeviceAuthorization(API, CODE, {
			fetch,
			...clock,
		}).catch((e) => e);
		expect(error).toBeInstanceOf(CliError);
		expect(error.code).toBe(ExitCode.AUTH_ERROR);
		expect(error.message).toContain("invalid_grant");
		expect(error.message).toContain("tarout login --device");
	});
});
