import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout domains` read field names the platform does not send. The
 * domainRegistrar router strips every provider field on the way out
 * (omitProviderFieldsForResponse in cloud/src/server/api/routers/
 * domain-registrar.ts): `cloudflareZoneStatus` becomes `dnsZoneStatus`,
 * `cloudflareCustomHostnameId` becomes `usesTaroutRouting`, and
 * `cloudflareNameservers` is gone. Availability answers with `purchasable`,
 * never `available`. These specs drive each command against those real
 * shapes and pin what the CLI sends and prints.
 */

const h = vi.hoisted(() => ({
	client: {} as any,
	input: vi.fn(),
	confirm: vi.fn(),
}));

vi.mock("../src/lib/api.js", () => ({ getApiClient: () => h.client }));

vi.mock("../src/lib/config.js", () => ({
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1", projectName: undefined }),
	getApiUrl: () => "https://api.test",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn(),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

vi.mock("../src/utils/prompts.js", () => ({
	input: h.input,
	confirm: h.confirm,
}));

import { Command } from "commander";
import { registerDomainsCommands } from "../src/commands/domains";
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

let stdout: string[];
let stderr: string[];
let exitCodes: number[];

beforeEach(() => {
	stdout = [];
	stderr = [];
	exitCodes = [];
	h.input.mockReset();
	h.confirm.mockReset();
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
		stderr.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	// handleError ends in process.exit; record the code and unwind instead.
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		exitCodes.push(code ?? 0);
		throw new Error(`__EXIT_${code ?? 0}`);
	}) as never);
});

afterEach(() => {
	setGlobalOptions(RESET);
	vi.restoreAllMocks();
	h.client = {} as any;
});

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	const program = new Command();
	program.exitOverride();
	registerDomainsCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

function helpFor(path: string[]): string {
	const program = new Command();
	registerDomainsCommands(program);
	let cmd: Command | undefined = program;
	for (const name of path) {
		cmd = cmd?.commands.find((c) => c.name() === name);
	}
	if (!cmd) throw new Error(`no command ${path.join(" ")}`);
	return cmd.helpInformation();
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");
const all = () => `${out()}\n${err()}`;

/** A CNAME-contract external subdomain as domainRegistrar.getAll returns it. */
const EXTERNAL_SUB = {
	domainId: "rd_sub_0123456789",
	organizationId: "org_1",
	domainName: "shop.acme.com",
	source: "external",
	status: "pending",
	autoRenew: true,
	expiryDate: null,
	sslStatus: "pending_validation",
	hasManagedDns: false,
	dnsZoneStatus: "pending",
	nameservers: [],
	registrar: "managed",
	usesTaroutRouting: true,
	ownershipTxtName: null,
	ownershipTxtValue: null,
	cnameTarget: "edge.tarout.sa",
	isApex: false,
	apexIps: [],
	domain: [],
};

/** A gateway-contract external apex (no provider object, A records). */
const EXTERNAL_APEX = {
	...EXTERNAL_SUB,
	domainId: "rd_apex_0123456789",
	domainName: "acme.com",
	cnameTarget: null,
	isApex: true,
	apexIps: ["35.252.59.242"],
};

const PURCHASED = {
	domainId: "rd_buy_0123456789",
	organizationId: "org_1",
	domainName: "tarout-demo.sa",
	source: "purchased",
	status: "active",
	autoRenew: false,
	whoisPrivacy: true,
	locked: true,
	expiryDate: "2027-09-01T00:00:00.000Z",
	registrationDate: "2026-09-01T00:00:00.000Z",
	sslStatus: "active",
	hasManagedDns: true,
	dnsZoneStatus: "active",
	nameservers: [],
	registrar: "managed",
	usesTaroutRouting: false,
	cnameTarget: null,
	isApex: true,
	apexIps: [],
	domain: [],
};

function registrarWith(rows: unknown[], rest: Record<string, unknown> = {}) {
	return {
		domainRegistrar: {
			getAll: { query: vi.fn(async () => rows) },
			...rest,
		},
	};
}

const CONTACT_FLAGS = [
	"--first-name",
	"Sara",
	"--last-name",
	"Ali",
	"--email",
	"sara@example.com",
	"--phone",
	"+966500000000",
	"--address1",
	"King Fahd Rd",
	"--city",
	"Riyadh",
	"--state",
	"Riyadh",
	"--zip",
	"12211",
	"--country",
	"sa",
];

function availability(overrides: Record<string, unknown> = {}) {
	return {
		domainName: "acme-new.com",
		purchasable: true,
		premium: false,
		purchasePrice: 45,
		purchaseType: "registration",
		renewalPrice: 45,
		tld: "com",
		registrar: "managed",
		currency: "SAR",
		registrationFlow: "standard",
		...overrides,
	};
}

describe("domains register", () => {
	it("reads `purchasable` (the field searchDomain returns) and creates the payment", async () => {
		const pay = vi.fn(async () => ({
			domainId: "rd_new",
			paymentUrl: "https://pay.test/abc",
			amount: 45,
			canConnectToApps: true,
		}));
		h.client = registrarWith([], {
			searchDomain: { query: vi.fn(async () => availability()) },
			createRegistrationPayment: { mutate: pay },
		});

		await run(["domains", "register", "acme-new.com", ...CONTACT_FLAGS], {
			yes: true,
		});

		expect(exitCodes).toEqual([]);
		expect(all()).not.toContain("not available");
		expect(out()).toMatch(/acme-new\.com is available/);
		expect(out()).toMatch(/Price:\s+45 SAR/);
		expect(out()).toContain("https://pay.test/abc");
		expect(pay).toHaveBeenCalledWith(
			expect.objectContaining({
				domainName: "acme-new.com",
				years: 1,
				privacyEnabled: true,
				autoRenew: true,
				contact: expect.objectContaining({ country: "SA", city: "Riyadh" }),
			}),
		);
	});

	it("refuses a taken domain with the platform's reason and never charges", async () => {
		const pay = vi.fn();
		h.client = registrarWith([], {
			searchDomain: {
				query: vi.fn(async () =>
					availability({ purchasable: false, reason: "Domain is already registered" }),
				),
			},
			createRegistrationPayment: { mutate: pay },
		});

		await run(["domains", "register", "acme-new.com", ...CONTACT_FLAGS], {
			yes: true,
		});

		expect(exitCodes).not.toEqual([]);
		expect(all()).toContain("acme-new.com is not available for registration");
		expect(all()).toContain("Domain is already registered");
		expect(pay).not.toHaveBeenCalled();
	});

	it("defaults to the registry's minimum term when the TLD sells in multi-year blocks", async () => {
		const pay = vi.fn(async () => ({
			domainId: "rd_ai",
			paymentUrl: "https://pay.test/ai",
			amount: 400,
		}));
		h.client = registrarWith([], {
			searchDomain: {
				query: vi.fn(async () =>
					availability({ domainName: "acme.ai", tld: "ai", minYears: 2, purchasePrice: 400 }),
				),
			},
			createRegistrationPayment: { mutate: pay },
		});

		await run(["domains", "register", "acme.ai", ...CONTACT_FLAGS], { yes: true });

		expect(exitCodes).toEqual([]);
		expect(pay).toHaveBeenCalledWith(expect.objectContaining({ years: 2 }));
	});

	it("rejects an explicit --years below the registry minimum before any payment", async () => {
		const pay = vi.fn();
		h.client = registrarWith([], {
			searchDomain: {
				query: vi.fn(async () =>
					availability({ domainName: "acme.ai", tld: "ai", minYears: 2 }),
				),
			},
			createRegistrationPayment: { mutate: pay },
		});

		await run(
			["domains", "register", "acme.ai", "--years", "1", ...CONTACT_FLAGS],
			{ yes: true },
		);

		expect(exitCodes).not.toEqual([]);
		expect(all()).toContain("at least 2 years");
		expect(pay).not.toHaveBeenCalled();
	});

	it("sends .sa registrations to the dashboard (registry application + document) before collecting a contact", async () => {
		const pay = vi.fn();
		h.client = registrarWith([], {
			searchDomain: {
				query: vi.fn(async () =>
					availability({ domainName: "acme.sa", tld: "sa", registrationFlow: "saudi" }),
				),
			},
			createRegistrationPayment: { mutate: pay },
		});

		await run(["domains", "register", "acme.sa"], { yes: true });

		expect(exitCodes).not.toEqual([]);
		expect(all()).toMatch(/dashboard/i);
		expect(h.input).not.toHaveBeenCalled();
		expect(pay).not.toHaveBeenCalled();
	});

	it("help no longer names a registrar the platform does not use", () => {
		const help = helpFor(["domains", "register"]);
		expect(help).not.toMatch(/Name\.com/i);
	});
});

describe("domains search / search-multiple", () => {
	const rows = [
		availability({ domainName: "acme.io", tld: "io", purchasePrice: 180 }),
		availability({ domainName: "acme.com", purchasable: false, purchasePrice: 45 }),
		availability({ domainName: "acme.ai", tld: "ai", minYears: 2, purchasePrice: 400 }),
	];

	it("search reads purchasable + purchasePrice", async () => {
		h.client = registrarWith([], {
			searchByKeyword: { query: vi.fn(async () => rows) },
		});

		await run(["domains", "search", "acme"]);

		const text = out();
		expect(text).toMatch(/acme\.io\s+yes\s+180 SAR\/yr/);
		expect(text).toMatch(/acme\.com\s+no/);
		expect(text).toMatch(/acme\.ai\s+yes\s+400 SAR\/2yr/);
	});

	it("search-multiple reads purchasable + purchasePrice", async () => {
		const query = vi.fn(async () => rows.slice(0, 2));
		h.client = registrarWith([], { searchMultiple: { query } });

		await run(["domains", "search-multiple", "acme.io,acme.com"]);

		expect(query).toHaveBeenCalledWith({ domainNames: ["acme.io", "acme.com"] });
		expect(out()).toMatch(/acme\.io\s+yes\s+180 SAR\/yr/);
		expect(out()).toMatch(/acme\.com\s+no/);
	});
});

describe("domains list", () => {
	it("fills the DNS column from dnsZoneStatus (cloudflareZoneStatus is stripped)", async () => {
		h.client = registrarWith([EXTERNAL_SUB, PURCHASED]);

		await run(["domains", "list"]);

		const text = out();
		expect(text).not.toContain("CF ZONE");
		expect(text).toMatch(/shop\.acme\.com\s+external\s+pending\s+pending/);
		expect(text).toMatch(/tarout-demo\.sa\s+purchased\s+active\s+active\s+2027-09-01\s+off/);
	});
});

describe("domains verify", () => {
	it("prints the CNAME, the ownership TXT and the platform's reasons for a pending CNAME domain", async () => {
		const verify = vi.fn(async () => ({
			verified: false,
			customHostnameStatus: "pending",
			sslStatus: "pending_validation",
			dcvTxtName: null,
			dcvTxtValue: null,
			ownershipVerification: {
				name: "_tarout-verify.shop.acme.com",
				value: "tarout-verify=abc123",
			},
			cfOwnershipVerification: null,
			verificationErrors: ["custom hostname does not CNAME to this zone."],
			caaBlock: null,
			domain: { ...EXTERNAL_SUB },
		}));
		h.client = registrarWith([EXTERNAL_SUB], {
			verifyExternalDomain: { mutate: verify },
		});

		await run(["domains", "verify", "shop.acme.com"]);

		expect(verify).toHaveBeenCalledWith({ domainId: EXTERNAL_SUB.domainId });
		const text = all();
		expect(text).not.toMatch(/nameserver/i);
		expect(text).toContain("custom hostname does not CNAME to this zone.");
		expect(text).toMatch(/Type:\s+CNAME/);
		expect(text).toMatch(/Name:\s+shop\.acme\.com/);
		expect(text).toMatch(/Value:\s+edge\.tarout\.sa/);
		expect(text).toMatch(/Type:\s+TXT/);
		expect(text).toMatch(/Name:\s+_tarout-verify\.shop\.acme\.com/);
		expect(text).toMatch(/Value:\s+tarout-verify=abc123/);
		expect(text).toMatch(/SSL status:\s+pending validation/);
	});

	it("prints the gateway A records for a pending apex (no CNAME target, no provider object)", async () => {
		h.client = registrarWith([EXTERNAL_APEX], {
			verifyExternalDomain: {
				mutate: vi.fn(async () => ({
					verified: false,
					status: "pending",
					sslStatus: "pending_validation",
					dcvTxtName: null,
					dcvTxtValue: null,
					ownershipVerification: null,
					cfOwnershipVerification: null,
					caaBlock: null,
					verificationErrors: [
						"The root A record has not propagated yet - it must point at 35.252.59.242.",
					],
				})),
			},
		});

		await run(["domains", "verify", "acme.com"]);

		const text = all();
		expect(text).not.toMatch(/nameserver/i);
		expect(text).toContain("The root A record has not propagated yet");
		expect(text).toMatch(/Type:\s+A/);
		expect(text).toMatch(/Name:\s+@/);
		expect(text).toMatch(/Value:\s+35\.252\.59\.242/);
	});

	it("prints the CAA record the certificate authority needs when issuance is blocked", async () => {
		h.client = registrarWith([EXTERNAL_SUB], {
			verifyExternalDomain: {
				mutate: vi.fn(async () => ({
					verified: false,
					sslStatus: "pending_validation",
					ownershipVerification: null,
					cfOwnershipVerification: null,
					verificationErrors: ["CAA records block issuance (ssl.com)"],
					caaBlock: {
						authority: "ssl.com",
						recordName: "shop",
						recordValue: '0 issue "ssl.com"',
					},
				})),
			},
		});

		await run(["domains", "verify", "shop.acme.com"]);

		expect(all()).toMatch(/Type:\s+CAA/);
		expect(all()).toContain('0 issue "ssl.com"');
	});

	it("reports success without nameserver wording when verified", async () => {
		h.client = registrarWith([EXTERNAL_SUB], {
			verifyExternalDomain: {
				mutate: vi.fn(async () => ({
					verified: true,
					customHostnameStatus: "active",
					sslStatus: "active",
					verificationErrors: [],
					ownershipVerification: null,
					cfOwnershipVerification: null,
					caaBlock: null,
				})),
			},
		});

		await run(["domains", "verify", "shop.acme.com"]);

		expect(exitCodes).toEqual([]);
		expect(all()).toContain("Domain shop.acme.com is verified!");
		expect(all()).not.toMatch(/nameserver/i);
	});
});

describe("domains info", () => {
	it("reads whoisPrivacy and expiryDate (the registered_domain columns)", async () => {
		const getById = vi.fn(async () => ({
			...PURCHASED,
			linkedHosts: [
				{
					domainId: "dom_1",
					host: "www.tarout-demo.sa",
					applicationId: "app_1",
					isVerified: true,
					sslStatus: "active",
					routeStatus: "active",
					application: { applicationId: "app_1", appName: "web-x1", name: "web" },
				},
			],
		}));
		h.client = registrarWith([PURCHASED], { getById: { query: getById } });

		await run(["domains", "info", "tarout-demo.sa"]);

		expect(getById).toHaveBeenCalledWith({ domainId: PURCHASED.domainId });
		const text = out();
		expect(text).toMatch(/Privacy:\s+enabled/);
		expect(text).toMatch(/Auto-renew:\s+no/);
		expect(text).toMatch(/Expires:\s+2027-09-01/);
		expect(text).toMatch(/www\.tarout-demo\.sa\s+->\s+web/);
	});

	it("does not print registrar-only rows for an external domain", async () => {
		h.client = registrarWith([EXTERNAL_SUB], {
			getById: { query: vi.fn(async () => ({ ...EXTERNAL_SUB, linkedHosts: [] })) },
		});

		await run(["domains", "info", "shop.acme.com"]);

		const text = out();
		expect(text).toMatch(/Source:\s+external/);
		expect(text).toMatch(/DNS:\s+pending/);
		expect(text).not.toMatch(/Privacy:/);
		expect(text).not.toMatch(/Expires:/);
	});
});

describe("domains ssl", () => {
	it("reads status, message and activatedAt from getSSLStatus", async () => {
		h.client = registrarWith([PURCHASED], {
			getSSLStatus: {
				query: vi.fn(async () => ({
					status: "active",
					message: "SSL certificate is active and serving traffic securely.",
					activatedAt: "2026-09-02T10:00:00.000Z",
					usesTaroutRouting: false,
				})),
			},
		});

		await run(["domains", "ssl", "tarout-demo.sa"]);

		const text = out();
		expect(text).toMatch(/Status:\s+active/);
		expect(text).toContain("SSL certificate is active and serving traffic securely.");
		expect(text).toMatch(/Activated:\s+2026-09-02/);
		expect(text).not.toContain("invalid/missing");
	});

	it("shows pending as pending, not invalid", async () => {
		h.client = registrarWith([EXTERNAL_SUB], {
			getSSLStatus: {
				query: vi.fn(async () => ({
					status: "pending",
					message: "SSL is being provisioned automatically by Tarout.",
					activatedAt: null,
					usesTaroutRouting: true,
				})),
			},
		});

		await run(["domains", "ssl", "shop.acme.com"]);

		expect(out()).toMatch(/Status:\s+pending/);
		expect(out()).not.toContain("invalid/missing");
	});
});

describe("domains transfer-in", () => {
	it("never sends --auth-code (the platform drops it) and says so", async () => {
		const mutate = vi.fn(async () => ({ success: true, ticketId: "tkt_1" }));
		h.client = registrarWith([], { requestTransferIn: { mutate } });

		await run([
			"domains",
			"transfer-in",
			"acme.com",
			"--auth-code",
			"EPP-SECRET",
			"--current-registrar",
			"GoDaddy",
		]);

		expect(exitCodes).toEqual([]);
		expect(mutate).toHaveBeenCalledWith({
			domainName: "acme.com",
			currentRegistrar: "GoDaddy",
			note: undefined,
		});
		expect(JSON.stringify(mutate.mock.calls)).not.toContain("EPP-SECRET");
		expect(all()).toMatch(/auth code was not sent/i);
		expect(all()).toContain("tkt_1");
	});

	it("help says the auth code is not sent", () => {
		expect(helpFor(["domains", "transfer-in"])).toMatch(/not sent/i);
	});
});

describe("domains registrar-status", () => {
	it("reads configured + available (there is no `ready` field)", async () => {
		h.client = registrarWith([], {
			registrarReadiness: {
				query: vi.fn(async () => ({
					configured: true,
					available: true,
					probeDomain: "example.com",
					configurationMissing: false,
					message: "Managed registrar is ready.",
				})),
			},
		});

		await run(["domains", "registrar-status"]);

		expect(out()).toMatch(/Registrar ready:\s+yes/);
		expect(out()).toContain("Managed registrar is ready.");
	});
});
