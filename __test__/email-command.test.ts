import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import {
	ALL_PAGES_ROW_CAP,
	EMAIL_LOG_STATUSES,
	EMAIL_WEBHOOK_EVENTS,
	EMAIL_NOT_LAUNCHED_CODE,
	SUPPRESSION_LIST_CAP,
	buildWebhookUpdate,
	collectLogPages,
	describeLogStatus,
	emailLaunchRefusal,
	formatLogStatus,
	formatRecipients,
	mergeWebhookEvents,
	parseApiKeyScope,
	parseEmailAddress,
	parseLogStatus,
	parseRowLimit,
	parseSecondsOption,
	parseSendingDomain,
	parseSuppressionReason,
	parseWebhookEvents,
	parseWebhookUrl,
	registerEmailCommands,
	resolveEmailRecord,
} from "../src/commands/email";
import { type CliError, InvalidArgumentError, NotFoundError } from "../src/lib/errors";
import { setGlobalOptions } from "../src/lib/output";

/**
 * `tarout email` contracts. Everything here is a pure helper exported from
 * commands/email.ts: no network, no tRPC client, no process exits.
 */

/** A tRPC client error as the CLI actually receives it. */
function trpcError(code: string, message: string): Error & {
	data: { code: string };
} {
	return Object.assign(new Error(message), { data: { code } });
}

const LAUNCH_MESSAGE =
	"Tarout Email is coming soon - the transactional email API is not open yet.";

afterEach(() => {
	setGlobalOptions({ noColor: false, json: false, quiet: false });
});

describe("the launch gate", () => {
	it("maps the server's PRECONDITION_FAILED refusal to a not-launched report", () => {
		const refusal = emailLaunchRefusal(
			trpcError("PRECONDITION_FAILED", LAUNCH_MESSAGE),
		);
		expect(refusal).not.toBeNull();
		expect(refusal?.details.reason).toBe("not_launched");
		expect(refusal?.details.launched).toBe(false);
		expect(refusal?.details.serverMessage).toBe(LAUNCH_MESSAGE);
		// The human/agent message must say it plainly, not echo a tRPC code.
		expect(refusal?.message).toContain("has not launched yet");
		expect(refusal?.message).not.toContain("PRECONDITION_FAILED");
		expect(refusal?.details.hint).toContain("Do not retry");
	});

	it("reads the code off the nested tRPC shapes too", () => {
		expect(
			emailLaunchRefusal({
				message: LAUNCH_MESSAGE,
				shape: { data: { code: "PRECONDITION_FAILED" } },
			}),
		).not.toBeNull();
		expect(
			emailLaunchRefusal({
				message: LAUNCH_MESSAGE,
				code: "PRECONDITION_FAILED",
			}),
		).not.toBeNull();
	});

	it("leaves the router's other PRECONDITION_FAILED answers alone", () => {
		// These are actionable and must keep their own message.
		for (const message of [
			"Select a project before using the email service.",
			"The Tarout Email service is not available for this project.",
			"No shared sending domain is configured - verify a custom domain and pass an explicit `from`.",
		]) {
			expect(emailLaunchRefusal(trpcError("PRECONDITION_FAILED", message))).toBeNull();
		}
	});

	it("ignores other error codes, CLI errors and non-errors", () => {
		expect(emailLaunchRefusal(trpcError("FORBIDDEN", LAUNCH_MESSAGE))).toBeNull();
		expect(emailLaunchRefusal(new InvalidArgumentError("bad flag"))).toBeNull();
		expect(emailLaunchRefusal(undefined)).toBeNull();
		expect(emailLaunchRefusal("coming soon")).toBeNull();
	});

	it("keeps a stable code for the --json envelope", () => {
		expect(EMAIL_NOT_LAUNCHED_CODE).toBe("EMAIL_NOT_LAUNCHED");
	});
});

describe("webhook events", () => {
	it("refuses an unknown event and names the eight real ones", () => {
		expect(() => parseWebhookEvents(["email.exploded"])).toThrow(
			InvalidArgumentError,
		);
		expect(() => parseWebhookEvents(["bouncd"])).toThrow(
			/Unknown webhook event "bouncd"/,
		);
		expect(() => parseWebhookEvents(["nope"])).toThrow(/email.delivery_delayed/);
	});

	it("accepts repeats, comma groups, bare tails and hyphens, in canonical order", () => {
		expect(
			parseWebhookEvents(["clicked", "email.sent,delivery-delayed", "SENT"]),
		).toEqual(["email.sent", "email.delivery_delayed", "email.clicked"]);
	});

	it("treats no --event as an empty subscription", () => {
		expect(parseWebhookEvents(undefined)).toEqual([]);
		expect(parseWebhookEvents([])).toEqual([]);
	});

	it("read-modify-writes for --add-event instead of replacing", () => {
		expect(
			mergeWebhookEvents(["email.bounced"], ["email.complained"]),
		).toEqual(["email.bounced", "email.complained"]);
		// Already subscribed: no duplicate, no loss.
		expect(mergeWebhookEvents(["email.bounced"], ["bounced"])).toEqual([
			"email.bounced",
		]);
		expect(mergeWebhookEvents(undefined, ["sent"])).toEqual(["email.sent"]);
	});
});

describe("buildWebhookUpdate", () => {
	const current = ["email.bounced"];

	it("refuses an update that changes nothing", () => {
		expect(() => buildWebhookUpdate("wh_1", current, {})).toThrow(
			/Nothing to change/,
		);
	});

	it("refuses contradictory and overlapping flags", () => {
		expect(() =>
			buildWebhookUpdate("wh_1", current, { enable: true, disable: true }),
		).toThrow(InvalidArgumentError);
		expect(() =>
			buildWebhookUpdate("wh_1", current, {
				event: ["sent"],
				addEvent: ["clicked"],
			}),
		).toThrow(/replaces the whole event list/);
	});

	it("replaces with --event and merges with --add-event", () => {
		expect(
			buildWebhookUpdate("wh_1", current, { event: ["sent"] }),
		).toEqual({ webhookId: "wh_1", events: ["email.sent"] });
		expect(
			buildWebhookUpdate("wh_1", current, { addEvent: ["sent"] }),
		).toEqual({
			webhookId: "wh_1",
			events: ["email.sent", "email.bounced"],
		});
	});

	it("carries url and status through", () => {
		expect(
			buildWebhookUpdate("wh_1", current, {
				url: "https://example.com/hook",
				disable: true,
			}),
		).toEqual({
			webhookId: "wh_1",
			url: "https://example.com/hook",
			status: "disabled",
		});
		expect(
			buildWebhookUpdate("wh_1", current, { enable: true }).status,
		).toBe("active");
	});
});

describe("webhook urls", () => {
	it("requires a public https endpoint", () => {
		expect(parseWebhookUrl(" https://example.com/hook ")).toBe(
			"https://example.com/hook",
		);
		expect(() => parseWebhookUrl("http://example.com/hook")).toThrow(/https/);
		expect(() => parseWebhookUrl("not a url")).toThrow(InvalidArgumentError);
		expect(() => parseWebhookUrl("https://localhost:3000/hook")).toThrow(
			/loopback/,
		);
	});
});

describe("log statuses", () => {
	it("refuses an unknown status and lists the ten real ones", () => {
		expect(() => parseLogStatus("delivererd")).toThrow(InvalidArgumentError);
		expect(() => parseLogStatus("pending")).toThrow(
			/Unknown message status "pending"/,
		);
		expect(() => parseLogStatus("nope")).toThrow(/delivery_delayed/);
	});

	it("accepts every status the server knows, and no filter at all", () => {
		for (const status of EMAIL_LOG_STATUSES) {
			expect(parseLogStatus(status)).toBe(status);
		}
		expect(parseLogStatus("DELIVERY-DELAYED")).toBe("delivery_delayed");
		expect(parseLogStatus(undefined)).toBeUndefined();
	});

	it("explains and badges every status", () => {
		setGlobalOptions({ noColor: true });
		for (const status of EMAIL_LOG_STATUSES) {
			expect(describeLogStatus(status)).not.toBe("unknown status");
			expect(formatLogStatus(status)).toContain(
				status === "delivery_delayed" ? "delayed" : status,
			);
		}
		expect(describeLogStatus("made_up")).toBe("unknown status");
		expect(formatLogStatus("made_up")).toBe("made_up");
	});
});

describe("sending domains", () => {
	it("rejects an apex domain before spending a round trip", () => {
		expect(() => parseSendingDomain("example.com")).toThrow(
			InvalidArgumentError,
		);
		expect(() => parseSendingDomain("Example.COM.")).toThrow(
			/apex domain/,
		);
		// And it suggests the shape that would work.
		expect(() => parseSendingDomain("example.com")).toThrow(
			/mail\.example\.com/,
		);
	});

	it("normalizes a valid subdomain the way the server does", () => {
		expect(parseSendingDomain("  MAIL.Example.com.  ")).toBe(
			"mail.example.com",
		);
	});

	it("rejects an address, an empty value and a malformed name", () => {
		expect(() => parseSendingDomain("noreply@mail.example.com")).toThrow(
			/looks like an email address/,
		);
		expect(() => parseSendingDomain("   ")).toThrow(InvalidArgumentError);
		expect(() => parseSendingDomain("mail..example.com")).toThrow(
			/not a valid domain name/,
		);
	});
});

describe("email addresses", () => {
	it("accepts one address and refuses the rest", () => {
		expect(parseEmailAddress(" you@example.com ", "recipient address")).toBe(
			"you@example.com",
		);
		expect(() => parseEmailAddress("you@example", "recipient address")).toThrow(
			InvalidArgumentError,
		);
		expect(() =>
			parseEmailAddress("a@b.com, c@d.com", "recipient address"),
		).toThrow(/recipient address/);
	});
});

describe("scopes, reasons and limits", () => {
	it("defaults and validates the API key scope", () => {
		expect(parseApiKeyScope(undefined)).toBe("full_access");
		expect(parseApiKeyScope("sending-access")).toBe("sending_access");
		expect(parseApiKeyScope("sending")).toBe("sending_access");
		expect(() => parseApiKeyScope("admin")).toThrow(InvalidArgumentError);
	});

	it("defaults and validates the suppression reason", () => {
		expect(parseSuppressionReason(undefined)).toBe("manual");
		expect(parseSuppressionReason("Bounce")).toBe("bounce");
		expect(() => parseSuppressionReason("spam")).toThrow(
			/manual, bounce, complaint/,
		);
	});

	it("keeps the row limit inside the server's 1-100 window", () => {
		expect(parseRowLimit(undefined)).toBe(50);
		expect(parseRowLimit("25")).toBe(25);
		expect(() => parseRowLimit("0")).toThrow(InvalidArgumentError);
		expect(() => parseRowLimit("101")).toThrow(/between 1 and 100/);
		expect(() => parseRowLimit("ten")).toThrow(InvalidArgumentError);
	});

	it("validates a seconds option against its own window", () => {
		expect(
			parseSecondsOption(undefined, {
				flag: "--timeout",
				min: 30,
				max: 3600,
				fallback: 300,
			}),
		).toBe(300);
		expect(() =>
			parseSecondsOption("5", {
				flag: "--timeout",
				min: 30,
				max: 3600,
				fallback: 300,
			}),
		).toThrow(/--timeout must be a whole number of seconds between 30 and 3600/);
	});
});

describe("identifier resolution", () => {
	interface Row {
		domainId: string;
		name: string;
	}
	const rows: Row[] = [
		{ domainId: "dom_abc12345", name: "mail.one.com" },
		{ domainId: "dom_abc98765", name: "mail.two.com" },
		{ domainId: "dom_zzz00000", name: "MAIL.THREE.com" },
	];
	const read = (row: Row) => ({ id: row.domainId, label: row.name });
	const resolve = (identifier: string) =>
		resolveEmailRecord(rows, identifier, read, "Sending domain");

	it("takes an exact id, then an exact name case-insensitively", () => {
		expect(resolve("dom_abc12345").name).toBe("mail.one.com");
		expect(resolve("mail.THREE.com").domainId).toBe("dom_zzz00000");
	});

	it("takes a unique id prefix", () => {
		expect(resolve("dom_z").domainId).toBe("dom_zzz00000");
	});

	it("refuses an ambiguous id prefix and names every candidate", () => {
		expect(() => resolve("dom_abc")).toThrow(InvalidArgumentError);
		expect(() => resolve("dom_abc")).toThrow(/matches 2 records/);
		expect(() => resolve("dom_abc")).toThrow(/dom_abc12345 \(mail.one.com\)/);
		expect(() => resolve("dom_abc")).toThrow(/Pass the full id instead/);
	});

	it("reports a miss as not found, with the candidates to choose from", () => {
		expect(() => resolve("mail.nope.com")).toThrow(NotFoundError);
		try {
			resolve("mail.nope.com");
			expect.unreachable();
		} catch (err) {
			expect((err as NotFoundError).message).toContain(
				'Sending domain "mail.nope.com" not found',
			);
			expect((err as CliError).suggestions).toContain("mail.one.com");
		}
	});

	it("refuses an empty identifier", () => {
		expect(() => resolve("   ")).toThrow(/Pass the sending domain to act on/);
	});
});

describe("log pagination", () => {
	const page = (ids: string[], nextCursor: string | null) => ({
		items: ids.map((logId) => ({ logId })),
		nextCursor,
	});

	it("reads one page by default and reports that more is available", async () => {
		const seen: Array<string | undefined> = [];
		const result = await collectLogPages<{ logId: string }>(async (cursor) => {
			seen.push(cursor);
			return page(["a", "b"], "cursor_1");
		});
		expect(seen).toEqual([undefined]);
		expect(result.items.map((row) => row.logId)).toEqual(["a", "b"]);
		expect(result.hasMore).toBe(true);
		expect(result.pages).toBe(1);
	});

	it("stops following when nextCursor comes back null", async () => {
		const pages = [page(["a"], "c1"), page(["b"], "c2"), page(["c"], null)];
		const seen: Array<string | undefined> = [];
		let index = 0;
		const result = await collectLogPages<{ logId: string }>(
			async (cursor) => {
				seen.push(cursor);
				return pages[index++] ?? page([], null);
			},
			{ all: true },
		);
		expect(seen).toEqual([undefined, "c1", "c2"]);
		expect(result.items.map((row) => row.logId)).toEqual(["a", "b", "c"]);
		expect(result.pages).toBe(3);
		expect(result.hasMore).toBe(false);
		expect(result.capped).toBe(false);
	});

	it("stops on an empty page even if the server keeps handing back a cursor", async () => {
		let calls = 0;
		const result = await collectLogPages<{ logId: string }>(
			async () => {
				calls += 1;
				return calls === 1 ? page(["a"], "c1") : page([], "c2");
			},
			{ all: true },
		);
		expect(calls).toBe(2);
		expect(result.items).toHaveLength(1);
	});

	it("stops --all at the row ceiling and says so", async () => {
		const result = await collectLogPages<{ logId: string }>(
			async () => page(["a", "b"], "c1"),
			{ all: true, maxRows: 4 },
		);
		expect(result.items).toHaveLength(4);
		expect(result.capped).toBe(true);
		expect(result.hasMore).toBe(true);
	});

	it("survives a page with no items array at all", async () => {
		const result = await collectLogPages<{ logId: string }>(async () => ({}));
		expect(result.items).toEqual([]);
		expect(result.hasMore).toBe(false);
	});
});

describe("recipient formatting", () => {
	it("reads the JSON recipient column in every shape it takes", () => {
		expect(formatRecipients(["one@example.com"])).toBe("one@example.com");
		expect(formatRecipients(["one@example.com", "two@example.com"])).toBe(
			"one@example.com +1 more",
		);
		expect(formatRecipients("one@example.com")).toBe("one@example.com");
		expect(formatRecipients([])).toBe("-");
		expect(formatRecipients(null)).toBe("-");
		expect(formatRecipients(undefined)).toBe("-");
	});
});

describe("documented platform limits", () => {
	it("pins the numbers the help text promises", () => {
		expect(EMAIL_WEBHOOK_EVENTS).toHaveLength(8);
		expect(EMAIL_LOG_STATUSES).toHaveLength(10);
		expect(SUPPRESSION_LIST_CAP).toBe(500);
		expect(ALL_PAGES_ROW_CAP).toBeGreaterThan(100);
	});
});

describe("the command tree", () => {
	/** Registration only — no action runs, so nothing talks to the API. */
	function tree() {
		const program = new Command();
		registerEmailCommands(program);
		const email = program.commands.find((cmd) => cmd.name() === "email");
		if (!email) throw new Error("email command was not registered");
		return email;
	}

	it("registers every group and leaf the audit asked for", () => {
		const email = tree();
		const names = email.commands.map((cmd) => cmd.name());
		expect(names).toEqual([
			"status",
			"usage",
			"domains",
			"keys",
			"webhooks",
			"logs",
			"suppressions",
			"send-test",
		]);

		const leaves = (group: string) =>
			email.commands
				.find((cmd) => cmd.name() === group)
				?.commands.map((cmd) => cmd.name());
		expect(leaves("domains")).toEqual([
			"list",
			"add",
			"verify",
			"rearm",
			"rm",
		]);
		expect(leaves("keys")).toEqual(["list", "create", "revoke"]);
		expect(leaves("webhooks")).toEqual([
			"list",
			"create",
			"update",
			"rotate-secret",
			"rm",
			"deliveries",
		]);
		// `logs` is both a leaf (listLogs) and a parent (getLog).
		expect(leaves("logs")).toEqual(["view"]);
		expect(leaves("suppressions")).toEqual(["list", "add", "rm"]);
	});

	it("never names a send command `send`, so nobody scripts the test send as one", () => {
		const email = tree();
		const sendTest = email.commands.find((cmd) => cmd.name() === "send-test");
		expect(sendTest).toBeDefined();
		expect(email.commands.map((cmd) => cmd.name())).not.toContain("send");
		expect(sendTest?.aliases()).not.toContain("send");
		expect(sendTest?.description()).toContain("NOT a general send API");
	});

	it("keeps the list aliases operators expect", () => {
		const email = tree();
		const group = (name: string) =>
			email.commands.find((cmd) => cmd.name() === name);
		for (const name of ["domains", "keys", "webhooks", "suppressions"]) {
			expect(group(name)?.commands[0]?.aliases()).toContain("ls");
		}
		expect(group("domains")?.commands.at(-1)?.aliases()).toContain("delete");
	});

	it("says that --event replaces the whole event list", () => {
		const email = tree();
		const update = email.commands
			.find((cmd) => cmd.name() === "webhooks")
			?.commands.find((cmd) => cmd.name() === "update");
		const eventFlag = update?.options.find(
			(option) => option.long === "--event",
		);
		expect(eventFlag?.description).toContain("REPLACES");
		const addFlag = update?.options.find(
			(option) => option.long === "--add-event",
		);
		expect(addFlag?.description).toContain("read-modify-write");
	});

	it("routes `email logs view <id>` to the subcommand, not the log list", () => {
		// `logs` carries its own action (listLogs) AND a `view` subcommand
		// (getLog). Parse as far as help generation to prove which one argv
		// reaches; help short-circuits before any action body runs, so nothing
		// here touches the API.
		const program = new Command();
		registerEmailCommands(program);
		let help = "";
		const writeOut = (str: string) => {
			help += str;
		};
		program.exitOverride().configureOutput({ writeOut });
		for (const command of program.commands) {
			command.exitOverride().configureOutput({ writeOut });
			for (const leaf of command.commands) {
				leaf.exitOverride().configureOutput({ writeOut });
			}
		}
		expect(() =>
			program.parse(["email", "logs", "view", "--help"], { from: "user" }),
		).toThrow();
		expect(help).toContain("<log-id>");
		expect(help).not.toContain("--all");
	});

	it("exposes --all on the log list and no raw --cursor anywhere", () => {
		const email = tree();
		const logs = email.commands.find((cmd) => cmd.name() === "logs");
		const flags = logs?.options.map((option) => option.long);
		expect(flags).toContain("--all");
		const everyFlag = email.commands.flatMap((group) => [
			...group.options.map((option) => option.long),
			...group.commands.flatMap((leaf) =>
				leaf.options.map((option) => option.long),
			),
		]);
		expect(everyFlag).not.toContain("--cursor");
		// --yes is global; a local copy would shadow it.
		expect(everyFlag).not.toContain("--yes");
	});
});
