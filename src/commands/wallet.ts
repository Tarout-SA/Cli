import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	log,
	outputData,
	table,
} from "../lib/output.js";
import { input } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

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
				log(colors.bold(`Wallet Ledger — last ${options.days} days`));
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
		.description("Top up wallet balance")
		.option("-a, --amount <halalas>", "Amount in halalas (100 halalas = 1 SAR)")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let amountHalalas: number | undefined;

				if (options.amount) {
					amountHalalas = Number.parseInt(options.amount);
				} else {
					const amountStr = await input(
						"Amount in SAR (e.g., 50 for 50 SAR, leave blank for default):",
						undefined,
						{ field: "wallet_topup_amount_sar", flag: "--amount" },
					);
					if (amountStr) {
						amountHalalas = Math.round(Number.parseFloat(amountStr) * 100);
					}
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

				box("Wallet Top-Up", [
					`Order ID: ${colors.cyan(result.orderId || "")}`,
					`Amount: ${result.amount ? `${(result.amount / 100).toFixed(2)} SAR` : "Default"}`,
					`Payment URL: ${colors.cyan(result.paymentUrl || result.url || "")}`,
				]);

				log("Complete payment in your browser to credit the wallet.");
				log(
					`Confirm after payment: ${colors.dim(`tarout wallet confirm ${result.orderId || "<orderId>"}`)}`,
				);
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
