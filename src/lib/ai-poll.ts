/**
 * Polling for the AI Gateway's asynchronous jobs (video generation, file
 * indexing, batches). `pollTiming` is an object so tests can replace the
 * sleep instead of waiting.
 */
import { InvalidArgumentError } from "./errors.js";

export const pollTiming = {
	sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
	now: (): number => Date.now(),
};

/**
 * Read until `done` holds or `timeoutMs` passes. Answers the last value read
 * and whether it timed out; the first read happens at once.
 */
export async function pollUntil<T>(
	read: () => Promise<T>,
	done: (value: T) => boolean,
	options: { intervalMs: number; timeoutMs: number; onTick?: (value: T) => void },
): Promise<{ value: T; timedOut: boolean }> {
	const deadline = pollTiming.now() + options.timeoutMs;
	for (;;) {
		const value = await read();
		options.onTick?.(value);
		if (done(value)) return { value, timedOut: false };
		if (pollTiming.now() + options.intervalMs > deadline) return { value, timedOut: true };
		await pollTiming.sleep(options.intervalMs);
	}
}

/** A `--timeout` in whole seconds (1 to `maxSeconds`), in milliseconds. */
export function parseTimeoutSeconds(value: unknown, maxSeconds = 86_400): number {
	const text = String(value ?? "").trim();
	const seconds = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!(seconds >= 1 && seconds <= maxSeconds)) {
		throw new InvalidArgumentError(
			`Invalid --timeout "${value}". Pass a whole number of seconds from 1 to ${maxSeconds}.`,
		);
	}
	return seconds * 1000;
}

/** A positive whole number flag, else INVALID_ARGUMENTS naming the flag. */
export function parsePositiveInt(value: unknown, flag: string, max?: number): number {
	const text = String(value ?? "").trim();
	const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
	if (!(parsed >= 1) || (max !== undefined && parsed > max)) {
		throw new InvalidArgumentError(
			`Invalid ${flag} "${value}". Pass a whole number${max !== undefined ? ` from 1 to ${max}` : " of at least 1"}.`,
		);
	}
	return parsed;
}
