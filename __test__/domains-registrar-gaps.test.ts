import { describe, expect, it } from "vitest";
import {
	apexModeRefusal,
	appDomainDeleteRefusal,
	buildSaudiDocumentUpload,
	describeRenewalQuote,
	parseDomainOrderId,
	resolveApexMode,
	SAUDI_DOCUMENT_CONTENT_TYPES,
	saudiFlowRefusal,
} from "../src/commands/domains.js";
import { CliError, InvalidArgumentError } from "../src/lib/errors.js";

/**
 * The argument contracts behind the domain-registrar commands that had no CLI
 * path: `domains apex-mode`, `domains cancel-payment`,
 * `domains saudi upload-doc`, `domains renew-quote` / `renew --dry-run`, and
 * `domains app delete`. Everything here is pure - no client, no network.
 */

// ── domains apex-mode --redirect | --serve ──

describe("resolveApexMode", () => {
	it("maps each flag to the mode setApexMode expects", () => {
		expect(resolveApexMode({ redirect: true })).toBe("redirect");
		expect(resolveApexMode({ serve: true })).toBe("serve");
	});

	it("refuses both flags at once instead of silently picking one", () => {
		expect(() => resolveApexMode({ redirect: true, serve: true })).toThrow(
			InvalidArgumentError,
		);
		expect(() => resolveApexMode({ redirect: true, serve: true })).toThrow(
			/only one/i,
		);
	});

	it("refuses neither flag: the procedure has no default and switches live traffic", () => {
		expect(() => resolveApexMode({})).toThrow(InvalidArgumentError);
		expect(() => resolveApexMode({})).toThrow(/--redirect or --serve/);
		expect(() => resolveApexMode({ redirect: false, serve: false })).toThrow(
			/no default/i,
		);
	});
});

describe("apexModeRefusal", () => {
	const opts = { identifier: "d-1", host: "example.sa", mode: "serve" } as const;

	it("explains that only apex-gateway root domains have a mode", () => {
		const refusal = apexModeRefusal(
			{
				data: { code: "PRECONDITION_FAILED" },
				message:
					"Only root domains connected through the Tarout apex gateway have a redirect/serve mode.",
			},
			opts,
		);
		expect(refusal).toBeInstanceOf(CliError);
		expect(refusal?.message).toMatch(/not routed through the Tarout apex gateway/);
		expect(refusal?.message).toContain("tarout domains info d-1");
	});

	it("names the link-and-deploy steps serve mode needs", () => {
		const refusal = apexModeRefusal(
			{
				data: { code: "PRECONDITION_FAILED" },
				message:
					"Link example.sa to a deployed application first - serve mode proxies the bare domain straight to it.",
			},
			opts,
		);
		expect(refusal?.message).toContain("tarout domains link <app> example.sa");
		expect(refusal?.message).toMatch(/Nothing changed/);
	});

	it("explains an application whose server has no address yet", () => {
		const refusal = apexModeRefusal(
			{
				data: { code: "PRECONDITION_FAILED" },
				message:
					"The application's server has no reachable address yet. Try again after its next deploy.",
			},
			opts,
		);
		expect(refusal?.message).toMatch(/no reachable server address/);
	});

	it("reports a failed gateway route write as transient and unchanged", () => {
		const refusal = apexModeRefusal(
			{
				data: { code: "PRECONDITION_FAILED" },
				message: "Could not publish the gateway origin route. Nothing changed; try again.",
			},
			opts,
		);
		expect(refusal?.message).toMatch(/still in its previous mode/);
	});

	it("leaves anything that is not a precondition refusal alone", () => {
		expect(
			apexModeRefusal({ data: { code: "FORBIDDEN" }, message: "nope" }, opts),
		).toBeNull();
		expect(
			apexModeRefusal(
				{ data: { code: "PRECONDITION_FAILED" }, message: "something else" },
				opts,
			),
		).toBeNull();
	});
});

// ── domains cancel-payment --order-id dom_... ──

describe("parseDomainOrderId", () => {
	it("accepts a domain order id and trims it", () => {
		expect(parseDomainOrderId("dom_abc123")).toBe("dom_abc123");
		expect(parseDomainOrderId("  dom_abc123  ")).toBe("dom_abc123");
	});

	it("requires the flag at all", () => {
		expect(() => parseDomainOrderId(undefined)).toThrow(InvalidArgumentError);
		expect(() => parseDomainOrderId("   ")).toThrow(/--order-id <dom_\.\.\.>/);
	});

	it("rejects an order id that is not a domain order", () => {
		expect(() => parseDomainOrderId("sub_abc123")).toThrow(
			InvalidArgumentError,
		);
		expect(() => parseDomainOrderId("sub_abc123")).toThrow(
			/tarout billing confirm/,
		);
		expect(() => parseDomainOrderId("abc123")).toThrow(/start with/);
	});

	it("rejects a bare prefix with no transaction id", () => {
		expect(() => parseDomainOrderId("dom_")).toThrow(InvalidArgumentError);
	});
});

// ── domains saudi upload-doc ──

describe("buildSaudiDocumentUpload", () => {
	const base = { domainName: "acme.sa", fileName: "cr.pdf", fileSize: 2048 };

	it("builds the exact createSaudiDomainDocumentUpload input", () => {
		expect(buildSaudiDocumentUpload(base)).toEqual({
			domainName: "acme.sa",
			fileName: "cr.pdf",
			contentType: "application/pdf",
			fileSize: 2048,
		});
	});

	it("infers every accepted content type from the file extension", () => {
		for (const [fileName, contentType] of [
			["cr.pdf", "application/pdf"],
			["id.JPG", "image/jpeg"],
			["id.jpeg", "image/jpeg"],
			["id.png", "image/png"],
		] as const) {
			expect(
				buildSaudiDocumentUpload({ ...base, fileName }).contentType,
			).toBe(contentType);
		}
	});

	it("normalises the domain and honours an explicit content type", () => {
		expect(
			buildSaudiDocumentUpload({
				...base,
				domainName: "  ACME.SA ",
				fileName: "scan",
				contentType: "IMAGE/PNG",
			}),
		).toEqual({
			domainName: "acme.sa",
			fileName: "scan",
			contentType: "image/png",
			fileSize: 2048,
		});
	});

	it("rejects an unsupported content type and names the accepted ones", () => {
		const call = () =>
			buildSaudiDocumentUpload({ ...base, contentType: "image/heic" });
		expect(call).toThrow(InvalidArgumentError);
		for (const accepted of SAUDI_DOCUMENT_CONTENT_TYPES) {
			expect(call).toThrow(accepted);
		}
	});

	it("rejects a file whose type cannot be told from its name", () => {
		expect(() =>
			buildSaudiDocumentUpload({ ...base, fileName: "scan.tiff" }),
		).toThrow(/--content-type/);
		expect(() =>
			buildSaudiDocumentUpload({ ...base, fileName: "scan" }),
		).toThrow(InvalidArgumentError);
	});

	it("rejects a zero, negative, fractional or missing size", () => {
		expect(() => buildSaudiDocumentUpload({ ...base, fileSize: 0 })).toThrow(
			/empty/,
		);
		expect(() => buildSaudiDocumentUpload({ ...base, fileSize: -1 })).toThrow(
			InvalidArgumentError,
		);
		expect(() =>
			buildSaudiDocumentUpload({ ...base, fileSize: 10.5 }),
		).toThrow(/whole number of bytes/);
		expect(() =>
			buildSaudiDocumentUpload({ ...base, fileSize: undefined }),
		).toThrow(InvalidArgumentError);
		expect(() =>
			buildSaudiDocumentUpload({ ...base, fileSize: Number.NaN }),
		).toThrow(InvalidArgumentError);
	});

	it("only files documents for .sa names", () => {
		expect(() =>
			buildSaudiDocumentUpload({ ...base, domainName: "acme.com" }),
		).toThrow(/not a Saudi domain/);
		expect(() =>
			buildSaudiDocumentUpload({ ...base, domainName: "not a domain" }),
		).toThrow(InvalidArgumentError);
	});

	it("rejects a file name the registry would refuse", () => {
		expect(() =>
			buildSaudiDocumentUpload({ ...base, fileName: `${"a".repeat(256)}.pdf` }),
		).toThrow(/255 characters/);
		expect(() =>
			buildSaudiDocumentUpload({ ...base, fileName: "   " }),
		).toThrow(/--file-name/);
	});
});

describe("saudiFlowRefusal", () => {
	it("says the .sa path is switched off rather than relaying the raw refusal", () => {
		const refusal = saudiFlowRefusal(
			{
				data: { code: "PRECONDITION_FAILED" },
				message: "Saudi domain registration is not available",
			},
			"acme.sa",
		);
		expect(refusal).toBeInstanceOf(CliError);
		expect(refusal?.message).toMatch(/switched off/);
		expect(refusal?.message).toMatch(/nothing was created for acme\.sa/);
		expect(refusal?.message).toMatch(/Other TLDs are unaffected/);
	});

	it("passes through errors that are not the gate", () => {
		expect(
			saudiFlowRefusal({
				data: { code: "BAD_REQUEST" },
				message: "Saudi domain document size is invalid",
			}),
		).toBeNull();
		expect(
			saudiFlowRefusal({
				data: { code: "PRECONDITION_FAILED" },
				message: "Domain is locked",
			}),
		).toBeNull();
	});
});

// ── domains app delete ──

describe("appDomainDeleteRefusal", () => {
	it("sends an external domain's route to the command that removes both", () => {
		const refusal = appDomainDeleteRefusal(
			{
				data: { code: "PRECONDITION_FAILED" },
				message:
					"shop.acme.com is a connected external domain. Remove it from the Domains page so its certificate and routing are released too.",
			},
			{ host: "shop.acme.com" },
		);
		expect(refusal).toBeInstanceOf(CliError);
		expect(refusal?.message).toContain("tarout domains delete shop.acme.com");
		expect(refusal?.message).toContain("tarout domains unlink shop.acme.com");
		expect(refusal?.message).not.toMatch(/Domains page/);
	});

	it("leaves other refusals to the generic handler", () => {
		expect(
			appDomainDeleteRefusal(
				{ data: { code: "PRECONDITION_FAILED" }, message: "still deploying" },
				{ host: "shop.acme.com" },
			),
		).toBeNull();
		expect(
			appDomainDeleteRefusal(new Error("boom"), { host: "shop.acme.com" }),
		).toBeNull();
	});
});

// ── domains renew-quote / renew --dry-run ──

describe("describeRenewalQuote", () => {
	const cycle = {
		currentExpiry: "2027-03-01T00:00:00.000Z",
		newExpiry: "2028-03-01T00:00:00.000Z",
	};

	it("renewable: quotes the exact VAT-inclusive checkout amount", () => {
		const view = describeRenewalQuote({
			state: "renewable",
			years: 1,
			currency: "SAR",
			netAmountHalalas: 4000,
			taxHalalas: 600,
			amountHalalas: 4600,
			...cycle,
		});
		expect(view.renewable).toBe(true);
		expect(view.scalar).toBe("4600");
		expect(view.lines).toEqual([
			["Term", "1 year"],
			["Price", "46.00 SAR (VAT included)"],
			["Of which VAT", "6.00 SAR"],
			["Expires now", "2027-03-01"],
			["After renewal", "2028-03-01"],
		]);
	});

	it("renewable: omits the VAT line while Tarout is not VAT-registered", () => {
		const view = describeRenewalQuote({
			state: "renewable",
			years: 2,
			taxHalalas: 0,
			amountHalalas: 9000,
			...cycle,
		});
		expect(view.lines.map(([label]) => label)).not.toContain("Of which VAT");
		expect(view.lines[0]).toEqual(["Term", "2 years"]);
	});

	it("checkout_open: surfaces the open order and refuses to start a second", () => {
		const view = describeRenewalQuote({
			state: "checkout_open",
			orderId: "dom_tx1",
			amountHalalas: 4600,
			paymentUrl: "https://tarout.sa/pay",
			publicPaymentUrl: "https://tarout.sa/c/dom_tx1",
			...cycle,
		});
		expect(view.renewable).toBe(false);
		expect(view.scalar).toBe("dom_tx1");
		expect(view.nextCommand).toBe(
			"tarout domains confirm-payment --order-id dom_tx1",
		);
		expect(view.lines).toContainEqual(["Amount", "46.00 SAR"]);
		expect(view.lines).toContainEqual([
			"Shareable link",
			"https://tarout.sa/c/dom_tx1",
		]);
		expect(view.note).toMatch(/only one live renewal per expiry cycle/);
	});

	it("paid: reports the cycle as done", () => {
		const view = describeRenewalQuote({ state: "paid", ...cycle });
		expect(view).toMatchObject({
			state: "paid",
			scalar: "paid",
			renewable: false,
		});
		expect(view.headline).toMatch(/Already renewed/);
		expect(view.lines).toContainEqual(["Now expires", "2028-03-01"]);
	});

	it("processing: says no second payment is needed", () => {
		const view = describeRenewalQuote({ state: "processing", ...cycle });
		expect(view.scalar).toBe("processing");
		expect(view.renewable).toBe(false);
		expect(view.note).toMatch(/No second payment/);
	});

	it("refund_pending: says the cycle is blocked until the refund settles", () => {
		const view = describeRenewalQuote({ state: "refund_pending", ...cycle });
		expect(view.scalar).toBe("refund_pending");
		expect(view.renewable).toBe(false);
		expect(view.note).toMatch(/refund settles/);
	});

	it("unavailable: keeps the reason and has no new expiry", () => {
		const view = describeRenewalQuote({
			state: "unavailable",
			reason: "too_early",
			message: "This domain cannot be renewed yet.",
			currentExpiry: "2027-03-01T00:00:00.000Z",
		});
		expect(view.scalar).toBe("too_early");
		expect(view.renewable).toBe(false);
		expect(view.lines).toEqual([
			["Reason", "too_early"],
			["Detail", "This domain cannot be renewed yet."],
			["Expires", "2027-03-01"],
		]);
	});

	it("unavailable: tolerates a domain with no expiry at all", () => {
		const view = describeRenewalQuote({
			state: "unavailable",
			reason: "no_expiry",
			message: "No expiry date is known for this domain.",
			currentExpiry: null,
		});
		expect(view.lines).toContainEqual(["Expires", "unknown"]);
	});

	it("an unknown state is reported as such, not as renewable", () => {
		const view = describeRenewalQuote({ state: "teleported" });
		expect(view.renewable).toBe(false);
		expect(view.scalar).toBe("teleported");
		expect(view.headline).toMatch(/Unrecognised renewal state "teleported"/);
		expect(view.note).toMatch(/tarout upgrade/);
	});

	it("a missing or empty answer never reads as renewable", () => {
		for (const quote of [undefined, null, {}, { state: "" }]) {
			const view = describeRenewalQuote(quote);
			expect(view.renewable).toBe(false);
			expect(view.scalar).toBe("unknown");
		}
	});
});
