/**
 * How AI Gateway charges read on the CLI. Every billed AI call answers
 * `billed_halalas` (1 SAR = 100 halalas, fractions allowed); a failed call is
 * free and answers an error instead.
 */
import { colors, isJsonMode, isQuietMode } from "./output.js";

/**
 * One dim summary line on stderr ("3 inputs embedded, billed 0.01 SAR"), so
 * stdout stays the result itself and can be piped. Silent under --json and
 * --quiet.
 */
export function printSummary(message: string): void {
	if (isJsonMode() || isQuietMode()) return;
	process.stderr.write(`${colors.dim(message)}\n`);
}

/**
 * SAR with enough decimals that a fraction of a halala does not read as 0.00
 * (an embedding call can cost a ten-thousandth of a halala).
 */
export function formatBilledSar(halalas: number): string {
	const sar = halalas / 100;
	if (sar === 0 || sar >= 0.01) return `${sar.toFixed(2)} SAR`;
	const decimals = Math.min(8, Math.max(4, Math.ceil(-Math.log10(sar)) + 1));
	return `${sar.toFixed(decimals)} SAR`;
}

/** `billed_halalas` of a response, or null when the response carries none. */
export function billedHalalasOf(result: unknown): number | null {
	if (!result || typeof result !== "object") return null;
	const value = (result as { billed_halalas?: unknown }).billed_halalas;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** ", billed 0.0123 SAR", or "" when the response reports no charge. */
export function billedSuffix(result: unknown): string {
	const halalas = billedHalalasOf(result);
	return halalas === null ? "" : `, billed ${formatBilledSar(halalas)}`;
}
