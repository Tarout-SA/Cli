import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	table,
} from "../lib/output.js";
import { startSpinner, succeedSpinner } from "../utils/spinner.js";

/** Halalas (integer) to a "12.34 SAR" string. */
export function formatSar(halalas: number): string {
	return `${(halalas / 100).toFixed(2)} SAR`;
}

const KIND_LABELS: Record<string, string> = {
	subscription_checkout: "Plan payment",
	subscription_renewal: "Plan renewal",
	wallet_topup: "Wallet top-up",
	domain: "Domain",
	manual: "Granted by Tarout",
};

const STATUS_LABELS: Record<string, string> = {
	PENDING: "pending",
	REVIEW: "in review",
	AVAILABLE: "available",
	REVERSED: "reversed",
	REJECTED: "rejected",
	CAPPED: "monthly cap",
};

function formatDate(value: string | Date | null | undefined): string {
	if (!value) return "-";
	return new Date(value).toISOString().slice(0, 10);
}

export function registerReferralCommands(program: Command) {
	const referral = program
		.command("referral")
		.description(
			"Your referral code, link and compute-credit earnings (bring clients, earn credit on their payments)",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				startSpinner("Fetching referral summary...");
				const [code, summary] = await Promise.all([
					client.referral.getMyCode.query(),
					client.referral.getPartnerSummary.query(),
				]);
				succeedSpinner();

				if (isJsonMode()) {
					outputData({ ...code, ...summary });
					return;
				}
				// Quiet mode: just the link, for piping into a message or a README.
				quietOutput(code.url);

				const p = summary.program;
				const duration =
					p.durationMonths === null ? "for life" : `for ${p.durationMonths} months`;
				log("");
				log(
					colors.bold("Tarout referrals") +
						(summary.isPartner ? `  ${colors.success("partner")}` : ""),
				);
				log("");
				log(`  Code:  ${colors.cyan(code.code)}`);
				log(`  Link:  ${colors.cyan(code.url)}`);
				if (summary.codeDisabled) {
					log(`  ${colors.error("Your referral code is disabled. Contact support.")}`);
				}
				log("");
				log(`  Clicks            ${summary.clicks}`);
				log(`  Sign-ups          ${summary.signups}`);
				log(`  Paying customers  ${summary.payingCustomers}`);
				log("");
				log(`  Credit pending    ${formatSar(summary.pendingHalalas + summary.reviewHalalas)}`);
				log(`  Credit available  ${colors.success(formatSar(summary.availableHalalas))}`);
				if (summary.reversedHalalas > 0) {
					log(`  Reversed          ${formatSar(summary.reversedHalalas)}`);
				}
				log("");
				if (p.enabled) {
					log(
						colors.dim(
							`  You earn ${p.creditBps / 100}% of each payment by a customer you refer, ${duration}, as compute credit (spendable after ${p.holdDays} days). They get ${p.welcomeBonusDays} bonus plan days.`,
						),
					);
				} else {
					log(colors.dim("  The referral program is paused; existing credit still releases."));
				}
				log(colors.dim("  Credit has no cash value. Terms: https://tarout.sa/referral-terms"));
				log("");
				log(`History: ${colors.dim("tarout referral history")}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	referral
		.command("history")
		.description("Credit earned per customer payment")
		.option("-n, --limit <n>", "Max rows", "50")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				startSpinner("Fetching referral credit history...");
				const rows = await client.referral.listCredits.query({
					limit: Math.min(Math.max(Number.parseInt(options.limit) || 50, 1), 200),
				});
				succeedSpinner();

				if (isJsonMode()) {
					outputData(rows);
					return;
				}
				if (!rows || rows.length === 0) {
					log("");
					log("  No referral credit yet. Share your link: tarout referral");
					log("");
					return;
				}
				log("");
				table(
					["DATE", "CUSTOMER", "PAYMENT", "AMOUNT", "%", "CREDIT", "STATUS", "SPENDABLE"],
					rows.map((r: any) => [
						formatDate(r.createdAt),
						r.customerName ?? "-",
						KIND_LABELS[r.kind] ?? r.kind,
						r.kind === "manual" ? "-" : formatSar(r.paymentAmountHalalas),
						r.kind === "manual" ? "-" : `${r.percentBps / 100}%`,
						r.reversedHalalas > 0
							? `${formatSar(r.amountHalalas - r.reversedHalalas)} (−${formatSar(r.reversedHalalas)})`
							: formatSar(r.amountHalalas),
						STATUS_LABELS[r.status] ?? r.status,
						r.status === "AVAILABLE"
							? formatDate(r.availableAt)
							: r.status === "PENDING"
								? formatDate(r.holdUntil)
								: "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}
