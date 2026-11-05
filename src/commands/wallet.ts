import { type Command, Option } from "commander";
import { getApiClient } from "../lib/api.js";
import { paymentBrowserOpener } from "../lib/browser.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	handleError,
	InvalidArgumentError,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input } from "../utils/prompts.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
} from "../utils/spinner.js";

export function registerWalletCommands(program: Command) {
	const wallet = program
		.command("wallet")
		.description("Manage AI Gateway wallet balance");

	// Show balance
	wallet
		.command("balance")
		.description("Show current wallet balance")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching balance...");

				const data = await client.wallet.getBalance.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				// Quiet mode: emit the raw halala balance for scripting/piping.
				quietOutput(String(data.balanceHalalas));

				const halalaBalance = Number(data.balanceHalalas);
				const sarBalance = (halalaBalance / 100).toFixed(2);

				log("");
				log(colors.bold("Wallet Balance"));
				log("");
				log(`  ${colors.cyan(`${sarBalance} SAR`)} (${halalaBalance} halalas)`);
				log("");
				log(
					`Top up: ${colors.dim("tarout wallet topup")}   Ledger: ${colors.dim("tarout wallet ledger")}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Show ledger
	wallet
		.command("ledger")
		.description("Show transaction history")
		.option("-d, --days <days>", "Number of days to show", "30")
		.option(
			"-t, --type <type>",
			"Filter by type: topup, ai_gateway_usage, cloud_server_usage, refund, adjustment",
		)
		.option("-n, --limit <n>", "Max transactions", "50")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching ledger...");

				const data = await client.wallet.getLedger.query({
					days: Number.parseInt(options.days) || 30,
					type: options.type,
					limit: Number.parseInt(options.limit) || 50,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				const { entries, breakdown } = data;

				log("");
				log(colors.bold(`Wallet Ledger (last ${options.days} days)`));
				log("");

				if (!entries || entries.length === 0) {
					log("  No transactions found.");
					log("");
					return;
				}

				table(
					["DATE", "TYPE", "AMOUNT", "BALANCE", "DESCRIPTION"],
					entries.map((e: any) => [
						formatDate(e.createdAt),
						formatType(e.type),
						formatAmount(e.amountHalalas),
						formatAmount(e.balanceAfterHalalas),
						truncate(e.description || e.refType || "-", 30),
					]),
				);

				log("");
				log(colors.bold("Spending breakdown:"));
				log(
					`  AI Gateway: ${colors.cyan(formatSar(breakdown.aiGatewayHalalas))}   Cloud Servers: ${colors.cyan(formatSar(breakdown.cloudServerHalalas))}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Top up wallet
	wallet
		.command("topup")
		.description(`Top up wallet balance (minimum ${MIN_TOPUP_SAR} SAR)`)
		.option(
			"-a, --amount <sar>",
			`Amount in SAR, e.g. 50 (minimum ${MIN_TOPUP_SAR} SAR)`,
		)
		// --amount used to take halalas. Scripts that still pass halalas
		// can use this hidden flag.
		.addOption(new Option("--halalas <n>", "Amount in halalas").hideHelp())
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let amountHalalas: number | undefined;

				if (options.amount !== undefined) {
					amountHalalas = sarToHalalas(options.amount);
				} else if (options.halalas !== undefined) {
					const halalas = Number(options.halalas);
					if (!Number.isInteger(halalas) || halalas <= 0) {
						throw new InvalidArgumentError(
							`Invalid amount "${options.halalas}" halalas. Use a whole number, or --amount <sar>.`,
						);
					}
					amountHalalas = halalas;
				} else {
					const amountStr = await input(
						`Amount in SAR (minimum ${MIN_TOPUP_SAR}, leave blank for ${MIN_TOPUP_SAR} SAR):`,
						undefined,
						{ field: "wallet_topup_amount_sar", flag: "--amount" },
					);
					if (amountStr?.trim()) {
						amountHalalas = sarToHalalas(amountStr);
					}
				}

				// The platform silently raises anything below the minimum to it,
				// so refuse here instead of charging an amount nobody typed.
				if (
					amountHalalas !== undefined &&
					amountHalalas < MIN_TOPUP_SAR * 100
				) {
					throw new InvalidArgumentError(
						`The minimum top-up is ${MIN_TOPUP_SAR} SAR (you asked for ${(amountHalalas / 100).toFixed(2)} SAR).`,
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Creating checkout session...");

				const result = await client.wallet.createTopupCheckout.mutate(
					amountHalalas ? { amountHalalas } : {},
				);

				succeedSpinner("Checkout created!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				// Quiet mode: emit the order ID (confirm with `wallet confirm <id>`).
				quietOutput(result.orderId || "");

				// Prefer the platform's unauthenticated checkout page: this URL is
				// printed for a human to open, and a dashboard URL dead-ends an
				// unsigned-in browser at the login screen. Falls back for older
				// platforms that predate the public page.
				const paymentUrl =
					result.publicPaymentUrl || result.paymentUrl || result.url || "";

				// The response carries `amountHalalas` (what the checkout charges).
				const chargedHalalas = Number(result.amountHalalas ?? amountHalalas);
				box("Wallet Top-Up", [
					`Order ID: ${colors.cyan(result.orderId || "")}`,
					`Amount: ${Number.isFinite(chargedHalalas) && chargedHalalas > 0 ? formatSar(chargedHalalas) : "-"}`,
					`Payment URL: ${colors.cyan(paymentUrl)}`,
				]);

				// Auto-open the hosted checkout (the URL above is the copy/paste
				// fallback). Opener is undefined with --no-display / opt-out.
				if (paymentUrl) {
					const openPayment = paymentBrowserOpener();
					if (openPayment) await openPayment(paymentUrl);
				}

				log("Complete payment in your browser to credit the wallet.");
				log(
					`Confirm after payment: ${colors.dim(`tarout wallet confirm ${result.orderId || "<orderId>"}`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Accept the Compute Wallet agreement
	wallet
		.command("agree")
		.description(
			"Accept the Compute Wallet agreement (needed before creating servers or topping up; owner only)",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					log("");
					log(colors.bold("Compute Wallet agreement"));
					log("");
					log(
						"The Compute Wallet agreement must be accepted before you can create cloud servers or top up the wallet.",
					);
					log(`Read the full terms at ${colors.cyan(WALLET_TERMS_URL)}`);
					log("");
					const accepted = await confirm(
						"Do you accept the Compute Wallet agreement for this organization?",
						false,
						{
							field: "confirm_wallet_agreement",
							flag: "--yes",
							context: { termsUrl: WALLET_TERMS_URL },
						},
					);
					if (!accepted) {
						log("Not accepted.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Accepting agreement...");

				// Owner only: the platform answers FORBIDDEN for anyone else, and
				// handleError prints that.
				const result = await client.wallet.acceptAgreement.mutate();

				succeedSpinner("Agreement accepted!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(String(result?.agreementAcceptedAt ?? ""));

				log("");
				log(
					colors.success(
						`Compute Wallet agreement accepted${result?.agreementAcceptedAt ? ` on ${formatDate(result.agreementAcceptedAt)}` : ""}.`,
					),
				);
				log(`  Balance: ${formatSar(result?.balanceHalalas ?? 0)}`);
				if (result?.isReady) {
					log("  The wallet is ready for cloud servers.");
				} else {
					log(
						`  Top up to start using it: ${colors.dim(`tarout wallet topup --amount ${MIN_TOPUP_SAR}`)}`,
					);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Confirm top-up
	wallet
		.command("confirm")
		.argument("<order-id>", "Order ID from checkout")
		.description("Confirm a completed wallet top-up payment")
		.option("--transaction-id <id>", "Transaction ID (optional)")
		.action(async (orderId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Confirming top-up...");

				const result = await client.wallet.confirmTopup.mutate({
					orderId,
					transactionId: options.transactionId,
				});

				succeedSpinner("Top-up confirmed!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");
				log(colors.success("Wallet top-up confirmed successfully."));
				log("");
				log(
					`Run ${colors.dim("tarout wallet balance")} to see updated balance.`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Full wallet readiness: balance + agreement + runway
	wallet
		.command("status")
		.description(
			"Show whether the Compute Wallet is ready to run servers: the balance, whether the agreement is accepted, and the runway — how many hours the currently running cloud servers can keep going at the present burn rate, plus any server already inside its grace window or stopped for an empty wallet. Owner only.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching wallet status...");

				const data = await client.wallet.getStatus.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(data);
					return;
				}

				// Quiet mode: emit the raw halala balance, same scalar as `balance`.
				quietOutput(String(data?.balanceHalalas ?? "0"));

				const runway = data?.runway;

				log("");
				log(colors.bold("Compute Wallet Status"));
				log("");
				log(`  Balance:   ${colors.cyan(formatSar(data?.balanceHalalas ?? 0))}`);
				log(
					`  Agreement: ${
						data?.agreementAcceptedAt
							? colors.success(`accepted ${formatDate(data.agreementAcceptedAt)}`)
							: colors.warn("not accepted — run `tarout wallet agree`")
					}`,
				);
				log(
					`  Ready:     ${data?.isReady ? colors.success("yes") : colors.warn("no")}`,
				);
				if (runway) {
					log(`  Level:     ${formatRunwayLevel(runway.level)}`);
					log(`  Burn:      ${formatSar(runway.burnPerHourHalalas ?? 0)}/hour`);
					log(
						`  Runway:    ${
							typeof runway.hoursOfRunway === "number"
								? `${runway.hoursOfRunway} hour(s)`
								: colors.dim("not burning anything right now")
						}`,
					);
					if (typeof runway.minPrepaidHours === "number") {
						log(
							`  ${colors.dim(`A new cloud server needs ${runway.minPrepaidHours} hour(s) of balance prepaid.`)}`,
						);
					}
					const grace: any[] = Array.isArray(runway.graceServers)
						? runway.graceServers
						: [];
					if (grace.length) {
						log("");
						log(
							colors.warn(
								`${grace.length} server(s) are inside the ${runway.graceHours ?? 0}-hour grace window and stop when it ends:`,
							),
						);
						table(
							["SERVER", "STOPS AT"],
							grace.map((s: any) => [
								s.name || s.id || "-",
								s.stopsAt ? formatDate(s.stopsAt) : "-",
							]),
						);
					}
					const stopped: any[] = Array.isArray(runway.walletStoppedServers)
						? runway.walletStoppedServers
						: [];
					if (stopped.length) {
						log("");
						log(
							colors.error(
								`${stopped.length} server(s) were already stopped for an empty wallet:`,
							),
						);
						table(
							["SERVER", "STOPPED AT"],
							stopped.map((s: any) => [
								s.name || s.id || "-",
								s.stoppedAt ? formatDate(s.stoppedAt) : "-",
							]),
						);
					}
				}
				log("");
				log(`Top up: ${colors.dim("tarout wallet topup --amount 50")}`);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// Abandon an unpaid top-up order
	wallet
		.command("cancel")
		.argument("<order-id>", 'Top-up order ID from checkout ("top_…")')
		.option(
			"--reason <text>",
			"Why it was abandoned, recorded on the failure event (max 200 characters)",
		)
		.description(
			`Abandon an UNPAID wallet top-up order so it stops sitting open. ${WALLET_CANCEL_NOT_A_REFUND} Owner only.`,
		)
		.addHelpText("after", `\n${WALLET_CANCEL_HELP_WARNING}`)
		.action(async (orderId: string, options: { reason?: string }) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				assertWalletTopupOrderId(orderId);

				if (!shouldSkipConfirmation()) {
					log("");
					log(colors.warn(WALLET_CANCEL_NOT_A_REFUND));
					log("");
					const confirmed = await confirm(
						`Abandon unpaid top-up order ${orderId}?`,
						false,
						{
							field: "confirm_wallet_cancel",
							flag: "--yes",
							context: { orderId, refunds: false },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Abandoning top-up order...");

				const result = await client.wallet.cancelTopup.mutate({
					orderId,
					...(options.reason ? { reason: options.reason } : {}),
				});

				succeedSpinner("Top-up order abandoned.");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(orderId);

				log("");
				log(
					colors.success(
						`Top-up order ${orderId} is marked failed and will not credit the wallet.`,
					),
				);
				log(colors.dim(WALLET_CANCEL_NOT_A_REFUND));
				log(
					`Check the balance: ${colors.dim("tarout wallet balance")}   Ledger: ${colors.dim("tarout wallet ledger")}`,
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});
}

/**
 * The one sentence every `wallet cancel` surface has to carry. The procedure
 * writes a failure event and nothing else: it does not call the payment
 * provider and it does not move money, so reading it as "cancel my charge"
 * would be wrong in the one direction that costs a customer real money.
 */
export const WALLET_CANCEL_NOT_A_REFUND =
	"This is NOT a refund: it only abandons an order that was never paid. It does not contact the payment provider, does not reverse a completed payment, and does not remove credit already added to the wallet.";

/** Expanded warning for `--help`, including what to do instead. */
export const WALLET_CANCEL_HELP_WARNING = `${WALLET_CANCEL_NOT_A_REFUND}\nIf the payment already went through, the balance is credited and this command will not take it back — the platform has no self-serve refund path, so open a support ticket (\`tarout tickets create\`) instead.`;

/**
 * Refuse an order id the top-up procedure would silently ignore.
 * `markWalletTopupFailed` returns early for anything that is not a `top_…`
 * order, and the mutation still answers `{ success: true }` — so a subscription
 * order id typed here would read as a successful cancellation while nothing
 * happened at all.
 */
export function assertWalletTopupOrderId(orderId: string): void {
	const id = String(orderId ?? "").trim();
	if (id.startsWith("top_")) return;
	if (id.startsWith("sub_")) {
		throw new InvalidArgumentError(
			`"${id}" is a subscription checkout, not a wallet top-up. Abandon it with \`tarout billing cancel-checkout ${id}\` instead.`,
		);
	}
	throw new InvalidArgumentError(
		`"${id}" is not a wallet top-up order ID. Top-up orders look like "top_…" and are printed by \`tarout wallet topup\`; the platform silently ignores anything else, so this would report success without cancelling anything.`,
	);
}

/** Colour a wallet runway level without inventing new vocabulary for it. */
export function formatRunwayLevel(level: string | null | undefined): string {
	switch (level) {
		case "ok":
			return colors.success("ok");
		case "low":
			return colors.warn("low");
		case "empty":
			return colors.error("empty");
		default:
			return String(level ?? "-");
	}
}

/** Smallest top-up the platform accepts (500 halalas). */
const MIN_TOPUP_SAR = 5;
const WALLET_TERMS_URL = "https://tarout.sa/dashboard/wallet";

/** Parses a SAR amount ("50", "12.5") into whole halalas. */
export function sarToHalalas(value: string): number {
	const text = String(value).trim();
	const sar = Number(text);
	if (text === "" || !Number.isFinite(sar) || sar <= 0) {
		throw new InvalidArgumentError(
			`Invalid amount "${value}". Give the amount in SAR, e.g. --amount 50.`,
		);
	}
	return Math.round(sar * 100);
}

function formatAmount(halalas: string | number): string {
	const n = Number(halalas);
	if (n < 0) return colors.error(`-${Math.abs(n / 100).toFixed(2)} SAR`);
	return colors.success(`+${(n / 100).toFixed(2)} SAR`);
}

function formatSar(halalas: string | number): string {
	return `${(Number(halalas) / 100).toFixed(2)} SAR`;
}

function formatType(type: string): string {
	const map: Record<string, string> = {
		topup: colors.success("topup"),
		ai_gateway_usage: colors.info("ai usage"),
		cloud_server_usage: colors.warn("server"),
		refund: colors.success("refund"),
		adjustment: colors.dim("adjust"),
	};
	return map[type] || type;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

function truncate(str: string, max: number): string {
	if (str.length <= max) return str;
	return `${str.slice(0, max - 3)}...`;
}

function _failSpinnerSilent() {
	failSpinner();
}
