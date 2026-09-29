/**
 * @fileoverview Device authorization for `tarout login --device`.
 *
 * The loopback browser flow needs a browser on the machine running the CLI.
 * Over SSH, in a container, or on any other host without one, the device flow
 * works instead: the CLI asks Tarout for a one-time code, a human opens the
 * verification URL in any browser, signs in and approves the code, and the CLI
 * polls until the platform hands back the same credential body
 * `/api/cli/exchange` returns.
 *
 *   POST /api/cli/device/code  { clientName? }  -> device_code, user_code, ...
 *   POST /api/cli/device/token { device_code }  -> 400 { error } | 200 credential
 *
 * No `projectScope` is sent: the loopback flow sends none either, because the
 * credential is account-scoped and the project travels per request.
 *
 * Kept free of terminal output so the polling rules (interval, `slow_down`,
 * deadline, Ctrl+C) are unit-testable with an injected fetch, clock and sleep.
 * @module lib/device-auth
 */

import { hostname } from "node:os";
import { ExitCode } from "../utils/exit-codes.js";
import { normalizeApiUrl } from "./api-url.js";
import { type AuthCallbackData, parseAuthCallbackData } from "./auth-server.js";
import { CliError } from "./errors.js";
import { isNetworkFailure, platformFetch } from "./password-gate.js";

/** A device code as the CLI uses it. `deviceCode` is the secret half: never print it. */
export interface DeviceCode {
	deviceCode: string;
	/** What the human types into the verification page, e.g. `ABCD-EFGH`. */
	userCode: string;
	verificationUri: string;
	/** The verification URL with the code already filled in. */
	verificationUriComplete: string;
	/** Seconds until the code expires. */
	expiresIn: number;
	/** Seconds to wait between polls. */
	interval: number;
}

export type DeviceAuthorizationResult =
	| { outcome: "authorized"; authData: AuthCallbackData }
	| { outcome: "denied" }
	| { outcome: "expired" }
	| { outcome: "interrupted" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** RFC 8628 defaults: poll every 5 seconds, and add 5 on every `slow_down`. */
export const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
export const SLOW_DOWN_INCREMENT_SECONDS = 5;
/** Consecutive transport failures or 5xx answers tolerated while polling. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_NAME_MAX_LENGTH = 64;

/** Command the device-flow errors point at when a retry is the fix. */
export const DEVICE_LOGIN_COMMAND = "tarout login --device";

/**
 * Label shown on the approval page so the human can tell which terminal asked.
 * Capped because the server's length rule is not visible from here.
 */
export function deviceClientName(): string {
	let host = "";
	try {
		host = hostname();
	} catch {
		// A missing hostname only makes the label less specific.
	}
	const name = host ? `Tarout CLI on ${host}` : "Tarout CLI";
	return name.slice(0, CLIENT_NAME_MAX_LENGTH);
}

/**
 * Raised when the server predates the device flow (404 on its endpoints). An
 * API key is the headless path that works everywhere, so point at it.
 */
export function deviceLoginUnsupportedError(apiUrl: string): CliError {
	const keysUrl = `${normalizeApiUrl(apiUrl)}/dashboard/agent/keys`;
	return new CliError(
		`This Tarout server does not support \`tarout login --device\` yet. Sign in with an API key instead: \`tarout login --token <key>\` (create one at ${keysUrl}).`,
		ExitCode.AUTH_ERROR,
		undefined,
		{
			reason: "device_flow_unsupported",
			nextCommand: "tarout login --token <key>",
			keysUrl,
		},
	);
}

/** A poll the server could not answer right now (5xx). Retried, up to a cap. */
class DevicePollUnavailableError extends Error {
	constructor(status: number) {
		super(
			`Tarout's device login is not answering right now (HTTP ${status}). Try again shortly.`,
		);
		this.name = "DevicePollUnavailableError";
	}
}

function isTransientPollFailure(error: unknown): boolean {
	return (
		error instanceof DevicePollUnavailableError ||
		isNetworkFailure(error) ||
		(error instanceof Error && error.name === "AbortError")
	);
}

function httpUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		// This string is handed to the OS browser opener, so only web URLs pass.
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: undefined;
	} catch {
		return undefined;
	}
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Validate the `/api/cli/device/code` body. */
export function parseDeviceCodeResponse(value: unknown): DeviceCode {
	const record =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const deviceCode = nonEmptyString(record.device_code);
	const userCode = nonEmptyString(record.user_code);
	const verificationUri = httpUrl(record.verification_uri);
	const expiresIn = positiveNumber(record.expires_in);
	// `verification_uri_complete` is optional in RFC 8628; `interval` defaults.
	const completeRaw = record.verification_uri_complete;
	const verificationUriComplete =
		completeRaw === undefined ? verificationUri : httpUrl(completeRaw);
	const intervalRaw = record.interval;
	const interval =
		intervalRaw === undefined
			? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS
			: positiveNumber(intervalRaw);

	if (
		!deviceCode ||
		!userCode ||
		!verificationUri ||
		!verificationUriComplete ||
		!expiresIn ||
		!interval
	) {
		throw new Error(
			"Tarout returned an invalid response to the device login request.",
		);
	}
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete,
		expiresIn,
		interval,
	};
}

async function postJson(
	fetchImpl: FetchLike,
	url: string,
	body: unknown,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	timeout.unref?.();
	try {
		return await fetchImpl(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			redirect: "error",
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
	}
}

function serverMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const message = (body as { message?: unknown }).message;
	return typeof message === "string" && message.length > 0 ? message : undefined;
}

/**
 * Ask Tarout for a device code.
 *
 * @throws {CliError} `device_flow_unsupported` (exit 3) when the server has no
 *   device endpoints (404).
 */
export async function requestDeviceCode(
	apiUrl: string,
	options: { clientName?: string; fetch?: FetchLike } = {},
): Promise<DeviceCode> {
	const endpoint = `${normalizeApiUrl(apiUrl)}/api/cli/device/code`;
	const response = await postJson(
		options.fetch ?? platformFetch,
		endpoint,
		options.clientName ? { clientName: options.clientName } : {},
	);
	if (response.status === 404) throw deviceLoginUnsupportedError(apiUrl);
	if (!response.ok) {
		const message = serverMessage(await readJson(response));
		throw new CliError(
			message
				? `Tarout could not start a device login: ${message}`
				: `Tarout could not start a device login (HTTP ${response.status}).`,
		);
	}
	return parseDeviceCodeResponse(await readJson(response));
}

type DeviceTokenPoll =
	| { status: "authorized"; authData: AuthCallbackData }
	| { status: "pending" }
	| { status: "slow_down" }
	| { status: "denied" }
	| { status: "expired" };

/** One call to `/api/cli/device/token`. */
export async function pollDeviceToken(
	apiUrl: string,
	deviceCode: string,
	options: { fetch?: FetchLike } = {},
): Promise<DeviceTokenPoll> {
	const endpoint = `${normalizeApiUrl(apiUrl)}/api/cli/device/token`;
	const response = await postJson(options.fetch ?? platformFetch, endpoint, {
		device_code: deviceCode,
	});
	if (response.ok) {
		return {
			status: "authorized",
			authData: parseAuthCallbackData(await readJson(response)),
		};
	}
	if (response.status === 404) throw deviceLoginUnsupportedError(apiUrl);
	// Rate limited: back off exactly as a `slow_down` asks.
	if (response.status === 429) return { status: "slow_down" };
	if (response.status >= 500) {
		throw new DevicePollUnavailableError(response.status);
	}

	const body = await readJson(response);
	const code =
		body && typeof body === "object"
			? (body as { error?: unknown }).error
			: undefined;
	switch (code) {
		case "authorization_pending":
			return { status: "pending" };
		case "slow_down":
			return { status: "slow_down" };
		case "access_denied":
			return { status: "denied" };
		case "expired_token":
			return { status: "expired" };
	}
	throw new CliError(
		typeof code === "string" && code.length > 0
			? `Tarout rejected the device login (${code}). Run \`${DEVICE_LOGIN_COMMAND}\` to start again.`
			: `Tarout rejected the device login (HTTP ${response.status}). Run \`${DEVICE_LOGIN_COMMAND}\` to start again.`,
		ExitCode.AUTH_ERROR,
		undefined,
		{
			reason: typeof code === "string" ? code : "unknown",
			nextCommand: DEVICE_LOGIN_COMMAND,
		},
	);
}

export interface WaitForDeviceAuthorizationOptions {
	/** Test seam, and the hook a caller uses to make Ctrl+C wake the loop. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	/** Checked before every sleep and every poll. */
	isInterrupted?: () => boolean;
	fetch?: FetchLike;
	/** Called with the new interval, in seconds, after each `slow_down`. */
	onSlowDown?: (intervalSeconds: number) => void;
}

/**
 * Poll until the code is approved, denied or expired, or the caller is
 * interrupted. Waits `interval` seconds before every poll (RFC 8628), adds 5
 * seconds for good on each `slow_down`, and gives up at `expires_in` whatever
 * the server says. A poll already in flight when Ctrl+C lands is allowed to
 * finish: if it brings back a credential, the key exists server side and is
 * better stored than orphaned.
 */
export async function waitForDeviceAuthorization(
	apiUrl: string,
	code: DeviceCode,
	options: WaitForDeviceAuthorizationOptions = {},
): Promise<DeviceAuthorizationResult> {
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const interrupted = () => options.isInterrupted?.() === true;
	const deadline = now() + code.expiresIn * 1000;
	let intervalSeconds = code.interval;
	let failures = 0;

	for (;;) {
		if (interrupted()) return { outcome: "interrupted" };
		const remaining = deadline - now();
		if (remaining <= 0) return { outcome: "expired" };
		await sleep(Math.min(intervalSeconds * 1000, remaining));
		if (interrupted()) return { outcome: "interrupted" };

		let poll: DeviceTokenPoll;
		try {
			poll = await pollDeviceToken(apiUrl, code.deviceCode, {
				fetch: options.fetch,
			});
		} catch (error) {
			failures += 1;
			if (
				isTransientPollFailure(error) &&
				failures < MAX_CONSECUTIVE_POLL_FAILURES
			) {
				continue;
			}
			throw error;
		}
		failures = 0;

		switch (poll.status) {
			case "authorized":
				return { outcome: "authorized", authData: poll.authData };
			case "denied":
				return { outcome: "denied" };
			case "expired":
				return { outcome: "expired" };
			case "slow_down":
				intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
				options.onSlowDown?.(intervalSeconds);
				break;
			case "pending":
				break;
		}
	}
}
