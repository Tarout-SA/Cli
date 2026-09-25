import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout servers` read field names the platform does not send, so output
 * showed "-", blanks or "[object Object]". These specs drive each command
 * against the real `virtualMachine.*` response shapes and pin both what the
 * CLI sends and what it prints.
 */

const h = vi.hoisted(() => ({
	client: {} as any,
	input: vi.fn(),
	confirm: vi.fn(),
	select: vi.fn(),
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
	select: h.select,
}));

import { Command } from "commander";
import {
	alertThresholdToApi,
	defaultFirewallRuleName,
	defaultReservedIpName,
	defaultSnapshotName,
	formatAlertThreshold,
	registerServersCommands,
	summarizeMetricSeries,
} from "../src/commands/servers";
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
	h.select.mockReset();
	vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		stdout.push(a.map(String).join(" ").replace(ANSI, ""));
	});
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
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
	registerServersCommands(program);
	try {
		await program.parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

function helpFor(path: string[]): string {
	const program = new Command();
	registerServersCommands(program);
	let cmd: Command | undefined = program;
	for (const name of path) {
		cmd = cmd?.commands.find((c) => c.name() === name);
	}
	if (!cmd) throw new Error(`no command ${path.join(" ")}`);
	return cmd.helpInformation();
}

function trpcError(code: string, message: string): Error {
	return Object.assign(new Error(message), { data: { code } });
}

const SERVER = {
	id: "cmsrv000000000000000000001",
	name: "web",
	status: "running",
	serverType: "cpu",
	serverSize: "cpu-s",
};

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

describe("servers metrics", () => {
	const at = (m: number) => new Date(Date.UTC(2026, 8, 25, 10, m));

	it("summarizes each { timestamp, value } series with the right unit", async () => {
		const query = vi.fn(async () => ({
			cpuUtilization: [
				{ timestamp: at(0), value: 10 },
				{ timestamp: at(2), value: 42.5 },
				{ timestamp: at(1), value: 30 },
			],
			memoryUsage: [{ timestamp: at(0).toISOString(), value: 61.2 }],
			diskReadBytes: [{ timestamp: at(0), value: 2048 }],
			diskWriteBytes: [],
			networkReceivedBytes: [
				{ timestamp: at(0), value: 1024 },
				{ timestamp: at(1), value: 3 * 1024 * 1024 },
			],
			networkSentBytes: [{ timestamp: at(0), value: 512 }],
		}));
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				getMetrics: { query },
			},
		};

		await run(["servers", "metrics", "web", "--range", "6h"]);

		expect(query).toHaveBeenCalledWith({ id: SERVER.id, timeRange: "6h" });
		const text = out();
		// Latest is the newest point by timestamp, not the last in the array.
		expect(text).toMatch(/CPU\s+42\.5%\s+27\.5%\s+42\.5%/);
		expect(text).toMatch(/Memory\s+61\.2%/);
		expect(text).toMatch(/Disk read\s+2\.0 KB\/s/);
		expect(text).toMatch(/Disk write\s+no data yet/);
		expect(text).toMatch(/Network in\s+3\.0 MB\/s/);
		expect(text).toMatch(/Network out\s+512\.0 B\/s/);
		expect(text).not.toContain("[object Object]");
		expect(text).not.toContain("No data yet. Metrics appear");
	});

	it('says "no data yet" when every series is empty', async () => {
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				getMetrics: {
					query: async () => ({
						cpuUtilization: [],
						memoryUsage: [],
						diskReadBytes: [],
						diskWriteBytes: [],
						networkReceivedBytes: [],
						networkSentBytes: [],
					}),
				},
			},
		};

		await run(["servers", "metrics", "web"]);

		expect(out().match(/no data yet/g)).toHaveLength(5);
		expect(out()).toMatch(/Memory\s+not collected/);
		expect(out()).toContain("No data yet. Metrics appear");
	});

	it("rejects an unknown range before calling the API", async () => {
		const query = vi.fn();
		h.client = { virtualMachine: { list: { query }, getMetrics: { query } } };

		await run(["servers", "metrics", "web", "--range", "2h"]);

		expect(exitCodes[0]).toBe(2);
		expect(query).not.toHaveBeenCalled();
	});

	it("summarizeMetricSeries ignores null values and returns null when empty", () => {
		expect(summarizeMetricSeries([])).toBeNull();
		expect(summarizeMetricSeries(undefined)).toBeNull();
		expect(
			summarizeMetricSeries([
				{ timestamp: at(0), value: null },
				{ timestamp: at(1), value: 4 },
			]),
		).toEqual({ latest: 4, avg: 4, max: 4 });
	});
});

describe("servers volumes", () => {
	const VOLUME = {
		id: "cmvol000000000000000000001",
		serverId: SERVER.id,
		name: "data",
		externalVolumeId: "tarout-vol-data",
		diskSizeGb: 100,
		diskType: "balanced",
		deviceName: "tarout-data",
		status: "attached",
		zone: "me-central2-a",
		createdAt: new Date("2026-09-20T10:00:00Z"),
	};

	it("list reads diskSizeGb, diskType, deviceName and status, with the full id", async () => {
		const listVolumes = vi.fn(async () => [
			VOLUME,
			{ ...VOLUME, id: "cmvol000000000000000000002", name: "scratch", status: "available", deviceName: null, diskType: "ssd", diskSizeGb: 20 },
		]);
		h.client = {
			virtualMachine: { list: { query: async () => [SERVER] }, listVolumes: { query: listVolumes } },
		};

		await run(["servers", "volumes", "list", "web"]);

		expect(listVolumes).toHaveBeenCalledWith({ serverId: SERVER.id });
		const text = out();
		expect(text).toContain("cmvol000000000000000000001");
		expect(text).toMatch(/data\s+100 GB\s+balanced\s+attached\s+tarout-data/);
		expect(text).toMatch(/scratch\s+20 GB\s+ssd\s+available/);
		expect(text).toContain("tarout servers volumes attach <volume-id>");
	});

	it("create sends diskType and says the new volume is not attached", async () => {
		const createVolume = vi.fn(async (_input: unknown) => ({ ...VOLUME, status: "available" }));
		const attachVolume = vi.fn();
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				createVolume: { mutate: createVolume },
				attachVolume: { mutate: attachVolume },
			},
		};

		await run(["servers", "volumes", "create", "web", "--name", "data", "--size", "100", "--type", "ssd"]);

		expect(createVolume.mock.calls[0]?.[0]).toEqual({
			serverId: SERVER.id,
			name: "data",
			sizeGb: 100,
			diskType: "ssd",
		});
		expect(attachVolume).not.toHaveBeenCalled();
		expect(out()).toContain('Volume "data" created. It is not attached yet.');
		expect(out()).toContain(`tarout servers volumes attach ${VOLUME.id}`);
		expect(out()).not.toContain("created and attached");
	});

	it("create --attach attaches with the volume id only", async () => {
		const attachVolume = vi.fn(async (_input: unknown) => ({ ...VOLUME }));
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				createVolume: { mutate: async () => ({ ...VOLUME, status: "available" }) },
				attachVolume: { mutate: attachVolume },
			},
		};

		await run(["servers", "volumes", "create", "web", "--name", "data", "--attach"]);

		expect(attachVolume.mock.calls[0]?.[0]).toEqual({ volumeId: VOLUME.id });
		expect(out()).toContain('Volume "data" created and attached.');
	});

	it("create rejects a size below the 10 GB minimum", async () => {
		const createVolume = vi.fn();
		h.client = { virtualMachine: { list: { query: async () => [SERVER] }, createVolume: { mutate: createVolume } } };

		await run(["servers", "volumes", "create", "web", "--name", "x", "--size", "5"]);

		expect(exitCodes[0]).toBe(2);
		expect(createVolume).not.toHaveBeenCalled();
	});

	it("attach needs no server: it attaches to the volume's own server", async () => {
		const attachVolume = vi.fn(async (_input: unknown) => ({}));
		const list = vi.fn();
		h.client = { virtualMachine: { list: { query: list }, attachVolume: { mutate: attachVolume } } };

		await run(["servers", "volumes", "attach", VOLUME.id]);

		expect(list).not.toHaveBeenCalled();
		expect(attachVolume.mock.calls[0]?.[0]).toEqual({ volumeId: VOLUME.id });
	});

	it("attach refuses a server the volume does not belong to", async () => {
		const attachVolume = vi.fn();
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				listVolumes: { query: async () => [] },
				attachVolume: { mutate: attachVolume },
			},
		};

		await run(["servers", "volumes", "attach", VOLUME.id, "web"]);

		expect(exitCodes[0]).toBe(2);
		expect(attachVolume).not.toHaveBeenCalled();
		expect(err()).toContain("can only be attached to the server it was created for");
	});
});

describe("servers ips", () => {
	const IP = {
		id: "cmip0000000000000000000001",
		organizationId: "org_1",
		name: "edge",
		externalAddressId: "tarout-ip-edge",
		ipAddress: "34.166.10.20",
		region: "me-central2",
		status: "assigned",
		assignedServerId: SERVER.id,
		createdAt: new Date("2026-09-20T10:00:00Z"),
		assignedServer: { name: "web" },
	};

	it("list reads ipAddress, name, status and the assigned server's name", async () => {
		h.client = {
			virtualMachine: {
				listReservedIps: {
					query: async () => [
						IP,
						{ ...IP, id: "cmip0000000000000000000002", name: "spare", ipAddress: "34.166.10.21", status: "available", assignedServerId: null, assignedServer: null },
					],
				},
			},
		};

		await run(["servers", "ips", "list"]);

		const text = out();
		expect(text).toContain("cmip0000000000000000000001");
		expect(text).toMatch(/edge\s+34\.166\.10\.20\s+me-central2\s+assigned\s+web/);
		expect(text).toMatch(/spare\s+34\.166\.10\.21\s+me-central2\s+available\s+unassigned/);
	});

	it("reserve defaults to me-central2 with a unique name and prints ipAddress", async () => {
		const reserveIp = vi.fn(async (input: { name: string; region: string }) => ({
			...IP,
			name: input.name,
			status: "available",
			assignedServerId: null,
		}));
		h.client = { virtualMachine: { reserveIp: { mutate: reserveIp } } };

		await run(["servers", "ips", "reserve"]);

		expect(h.input).not.toHaveBeenCalled();
		const sent = reserveIp.mock.calls[0]?.[0] as { name: string; region: string };
		expect(sent.region).toBe("me-central2");
		expect(sent.name).toMatch(/^ip-me-central2-[a-z0-9]+$/);
		expect(out()).toContain("IP: 34.166.10.20");
		expect(out()).toContain(`ID: ${IP.id}`);
	});

	it("defaultReservedIpName changes over time so reservations do not collide", () => {
		expect(defaultReservedIpName("me-central2", 1)).not.toBe(
			defaultReservedIpName("me-central2", 2),
		);
	});
});

describe("servers check-quota and os-images", () => {
	it("check-quota reads { canCreate, current, limit }", async () => {
		h.client = {
			virtualMachine: {
				checkQuota: {
					query: async () => ({
						canCreate: true,
						current: { total: 1, cpu: 1, gpu: 0 },
						limit: { total: 3, cpu: 3, gpu: 0 },
					}),
				},
			},
		};

		await run(["servers", "check-quota"]);

		const text = out();
		expect(text).toContain("All servers:  1 / 3");
		expect(text).toContain("CPU servers:  1 / 3");
		expect(text).toContain("GPU servers:  0 / 0");
		expect(text).toContain("Can create:   yes");
		expect(text).not.toContain("- / -");
	});

	it("check-quota shows the reason when no more servers can be created", async () => {
		h.client = {
			virtualMachine: {
				checkQuota: {
					query: async () => ({
						canCreate: false,
						current: { total: 3, cpu: 3, gpu: 0 },
						limit: { total: 3, cpu: 3, gpu: 0 },
						message: "Server limit reached",
					}),
				},
			},
		};

		await run(["servers", "check-quota"]);

		expect(out()).toContain("Can create:   no");
		expect(out()).toContain("Server limit reached");
	});

	it("os-images prints id, name and description, and sends no input", async () => {
		const query = vi.fn(async (..._args: unknown[]) => [
			{ id: "ubuntu-22", name: "Ubuntu 22.04 LTS", description: "Stable long-term support release", hasCuda: false, isWindows: false },
			{ id: "debian-12", name: "Debian 12 (Bookworm)", description: "Stable and lightweight", hasCuda: false, isWindows: false },
		]);
		h.client = { virtualMachine: { getOSImages: { query } } };

		await run(["servers", "os-images"]);

		expect(query.mock.calls[0]).toEqual([]);
		expect(out()).toMatch(/ubuntu-22\s+Ubuntu 22\.04 LTS\s+Stable long-term support release/);
		expect(out()).toMatch(/debian-12\s+Debian 12 \(Bookworm\)\s+Stable and lightweight/);
	});

	it("os-images help no longer mentions a provider", () => {
		const help = helpFor(["servers", "os-images"]);
		expect(help).not.toContain("hetzner");
		expect(help).not.toContain("--provider");
	});
});

describe("servers create", () => {
	const SIZES = [
		{ id: "cpu-xs", size: "xs", serverType: "cpu", displayName: "Extra Small", description: "0.25 vCPU, 1 GB RAM", pricePerHourSAR: 0.102, priceHalalas: 10 },
		{ id: "cpu-s", size: "s", serverType: "cpu", displayName: "Small", description: "1 vCPU, 2 GB RAM", pricePerHourSAR: 0.41, priceHalalas: 41 },
	];

	function mockCreate() {
		const create = vi.fn(async (_input: unknown) => ({
			server: { id: SERVER.id },
			sshCommand: "ssh root@34.166.10.20",
		}));
		const sshList = vi.fn(async () => [{ id: "k1", name: "laptop", isDefault: true }]);
		const getServerTypes = vi.fn(async (_input: unknown) => SIZES);
		h.client = {
			sshKey: { list: { query: sshList } },
			virtualMachine: { getServerTypes: { query: getServerTypes }, create: { mutate: create } },
		};
		return { create, sshList, getServerTypes };
	}

	it("offers only the platform's 3 OS ids and never GPU when getServerTypes has none", async () => {
		const { create } = mockCreate();
		h.select.mockImplementation(async (message: string, choices: Array<{ value: string }>) => {
			if (message.startsWith("Server size")) return "cpu-s";
			if (message.startsWith("Operating system")) return "ubuntu-24";
			return choices[0]?.value;
		});

		await run(["servers", "create", "web"], { yes: true });

		const prompts = h.select.mock.calls.map((c) => String(c[0]));
		expect(prompts.some((p) => p.startsWith("Server type"))).toBe(false);
		const osChoices = h.select.mock.calls.find((c) => String(c[0]).startsWith("Operating system"))?.[1] as Array<{ value: string }>;
		expect(osChoices.map((c) => c.value)).toEqual(["ubuntu-22", "ubuntu-24", "debian-12"]);
		const sizeChoices = h.select.mock.calls.find((c) => String(c[0]).startsWith("Server size"))?.[1] as Array<{ value: string }>;
		expect(sizeChoices.map((c) => c.value)).toEqual(["cpu-xs", "cpu-s"]);

		expect(create.mock.calls[0]?.[0]).toEqual({
			name: "web",
			serverType: "cpu",
			serverSize: "cpu-s",
			osType: "ubuntu-24",
			billingPeriod: "hourly",
			enableSsh: true,
			selectedKeyIds: ["k1"],
		});
	});

	it("offers a GPU choice only when getServerTypes returns GPU sizes", async () => {
		mockCreate();
		h.client.virtualMachine.getServerTypes.query = async () => [
			...SIZES,
			{ id: "gpu-l4", serverType: "gpu", description: "1x L4" },
		];
		h.select.mockImplementation(async (message: string, choices: Array<{ value: string }>) => {
			if (message.startsWith("Server type")) return "cpu";
			return choices[0]?.value;
		});

		await run(["servers", "create", "web"], { yes: true });

		const typeChoices = h.select.mock.calls.find((c) => String(c[0]).startsWith("Server type"))?.[1] as Array<{ value: string }>;
		expect(typeChoices.map((c) => c.value)).toEqual(["cpu", "gpu"]);
	});

	it("--software and --no-ssh reach the create input, and saved keys are not read", async () => {
		const { create, sshList } = mockCreate();

		await run(
			["servers", "create", "web", "--size", "cpu-xs", "--os", "debian-12", "--software", "coolify", "--no-ssh"],
			{ yes: true },
		);

		expect(sshList).not.toHaveBeenCalled();
		expect(create.mock.calls[0]?.[0]).toEqual({
			name: "web",
			serverType: "cpu",
			serverSize: "cpu-xs",
			osType: "debian-12",
			billingPeriod: "hourly",
			enableSsh: false,
			preInstalledSoftware: "coolify",
		});
		expect(out()).toContain("SSH: disabled");
	});

	it("rejects an OS the platform does not support before anything is created", async () => {
		const { create } = mockCreate();

		await run(["servers", "create", "web", "--size", "cpu-xs", "--os", "rocky-linux-9"], { yes: true });

		expect(exitCodes[0]).toBe(2);
		expect(create).not.toHaveBeenCalled();
		expect(err()).toContain("ubuntu-22, ubuntu-24, debian-12");
	});

	it("rejects --type gpu when the account has no GPU sizes", async () => {
		const { create } = mockCreate();

		await run(["servers", "create", "web", "--type", "gpu", "--os", "ubuntu-22"], { yes: true });

		expect(exitCodes[0]).toBe(2);
		expect(create).not.toHaveBeenCalled();
		expect(err()).toContain("GPU servers are not available");
	});

	it("rejects an unknown --size with the real size ids", async () => {
		const { create } = mockCreate();

		await run(["servers", "create", "web", "--size", "n2-standard-2", "--os", "ubuntu-22"], { yes: true });

		expect(exitCodes[0]).toBe(2);
		expect(create).not.toHaveBeenCalled();
		expect(err()).toContain("cpu-xs, cpu-s");
	});

	it("help shows real size ids and the new flags", () => {
		const help = helpFor(["servers", "create"]);
		expect(help).toContain("cpu-xs");
		expect(help).not.toContain("n2-standard-2");
		expect(help).toContain("--software <software>");
		expect(help).toContain("--no-ssh");
	});
});

describe("servers info", () => {
	it("has no Private IP line (the platform never returns one)", async () => {
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				get: { query: async () => ({ ...SERVER, ipAddress: "34.166.10.20", osType: "ubuntu-24", providerId: "gcp" }) },
			},
		};

		await run(["servers", "info", "web"]);

		expect(out()).toContain("Public IP: 34.166.10.20");
		expect(out()).not.toContain("Private IP");
	});
});

const PREVIEW = {
	volumes: [{ id: "v1", name: "data", diskSizeGb: 100, diskType: "balanced" }],
	snapshots: [{ id: "s1", name: "nightly", diskSizeGb: 30 }],
	reservedIps: [{ id: "ip1", name: "edge", ipAddress: "34.166.10.20" }],
};

describe("servers terminate", () => {
	function mockTerminate() {
		const terminate = vi.fn(async (_input: unknown) => ({ ...SERVER, status: "terminating" }));
		const preview = vi.fn(async (_input: unknown) => PREVIEW);
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				getTerminationPreview: { query: preview },
				terminate: { mutate: terminate },
			},
		};
		return { terminate, preview };
	}

	it("confirms with what is deleted and kept, then sends the keep choices", async () => {
		const { terminate, preview } = mockTerminate();
		h.confirm.mockResolvedValue(true);

		await run(["servers", "terminate", "web", "--keep-snapshots"]);

		expect(preview).toHaveBeenCalledWith({ id: SERVER.id });
		const question = String(h.confirm.mock.calls[0]?.[0]);
		expect(question).toContain('Terminate server "web"?');
		expect(question).toContain("1 volume and 1 reserved IP");
		expect(question).toContain("Kept, and still billed until you delete it: 1 snapshot");
		const context = (h.confirm.mock.calls[0]?.[2] as { context: { deletes: string[]; keeps: string[] } }).context;
		expect(context.deletes).toEqual(['volume "data" (100 GB, balanced)', 'reserved IP 34.166.10.20 ("edge")']);
		expect(context.keeps).toEqual(['snapshot "nightly" (30 GB)']);
		expect(out()).toContain("Kept (keeps billing until you delete it):");

		expect(terminate.mock.calls[0]?.[0]).toEqual({
			id: SERVER.id,
			deleteVolumes: true,
			deleteSnapshots: false,
			releaseIps: true,
		});
		expect(out()).toContain("tarout servers kept-storage");
	});

	it("does not terminate when the user declines", async () => {
		const { terminate } = mockTerminate();
		h.confirm.mockResolvedValue(false);

		await run(["servers", "terminate", "web"]);

		expect(terminate).not.toHaveBeenCalled();
		expect(out()).toContain("Cancelled.");
	});

	it("with --yes deletes everything by default and skips the preview", async () => {
		const { terminate, preview } = mockTerminate();

		await run(["servers", "terminate", "web"], { yes: true });

		expect(preview).not.toHaveBeenCalled();
		expect(terminate.mock.calls[0]?.[0]).toEqual({
			id: SERVER.id,
			deleteVolumes: true,
			deleteSnapshots: true,
			releaseIps: true,
		});
	});

	it("stops without terminating when the preview cannot be loaded", async () => {
		const { terminate } = mockTerminate();
		h.client.virtualMachine.getTerminationPreview.query = async () => {
			throw trpcError("INTERNAL_SERVER_ERROR", "Failed to load the server's storage");
		};

		await run(["servers", "terminate", "web"]);

		expect(exitCodes[0]).toBe(1);
		expect(h.confirm).not.toHaveBeenCalled();
		expect(terminate).not.toHaveBeenCalled();
	});
});

describe("servers delete", () => {
	it("deletes an already-terminated server by id without listing or terminating", async () => {
		const list = vi.fn();
		const terminate = vi.fn();
		const del = vi.fn(async (_input: unknown) => ({ success: true }));
		h.client = {
			virtualMachine: {
				get: { query: async () => ({ ...SERVER, status: "terminated" }) },
				list: { query: list },
				terminate: { mutate: terminate },
				delete: { mutate: del },
			},
		};
		h.confirm.mockResolvedValue(true);

		await run(["servers", "delete", SERVER.id]);

		expect(list).not.toHaveBeenCalled();
		expect(terminate).not.toHaveBeenCalled();
		expect(String(h.confirm.mock.calls[0]?.[0])).toContain('Delete the record of terminated server "web"?');
		expect(del.mock.calls[0]?.[0]).toEqual({ id: SERVER.id });
		expect(exitCodes).toEqual([]);
	});

	it("finds a terminated server by name when get says NOT_FOUND", async () => {
		const list = vi.fn(async (input: { status?: string }) =>
			input?.status === "terminated" ? [{ ...SERVER, status: "terminated" }] : [],
		);
		const del = vi.fn(async (_input: unknown) => ({ success: true }));
		h.client = {
			virtualMachine: {
				get: { query: async () => { throw trpcError("NOT_FOUND", "Server not found"); } },
				list: { query: list },
				delete: { mutate: del },
			},
		};

		await run(["servers", "delete", "web"], { yes: true });

		expect(list.mock.calls.map((c) => c[0])).toEqual([{}, { status: "terminated" }]);
		expect(del.mock.calls[0]?.[0]).toEqual({ id: SERVER.id });
	});

	it("does not treat a FORBIDDEN lookup as not found", async () => {
		const list = vi.fn();
		h.client = {
			virtualMachine: {
				get: { query: async () => { throw trpcError("FORBIDDEN", "You don't have permission to access cloud servers"); } },
				list: { query: list },
			},
		};

		await run(["servers", "delete", SERVER.id], { yes: true });

		expect(exitCodes[0]).toBe(5);
		expect(list).not.toHaveBeenCalled();
	});

	it("terminates a running server with the keep flags, waits, then deletes the record", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce({ ...SERVER })
			.mockResolvedValueOnce({ ...SERVER, status: "terminated" });
		const terminate = vi.fn(async (_input: unknown) => ({}));
		const del = vi.fn(async (_input: unknown) => ({ success: true }));
		h.client = {
			virtualMachine: {
				get: { query: get },
				terminate: { mutate: terminate },
				delete: { mutate: del },
			},
		};

		await run(["servers", "delete", SERVER.id, "--keep-ips"], { yes: true });

		expect(terminate.mock.calls[0]?.[0]).toEqual({
			id: SERVER.id,
			deleteVolumes: true,
			deleteSnapshots: true,
			releaseIps: false,
		});
		expect(del.mock.calls[0]?.[0]).toEqual({ id: SERVER.id });
		expect(exitCodes).toEqual([]);
	});

	it("shows the termination preview in the delete confirmation", async () => {
		const terminate = vi.fn();
		h.client = {
			virtualMachine: {
				get: { query: async () => ({ ...SERVER }) },
				getTerminationPreview: { query: async () => PREVIEW },
				terminate: { mutate: terminate },
			},
		};
		h.confirm.mockResolvedValue(false);

		await run(["servers", "delete", SERVER.id, "--keep-volumes"]);

		const question = String(h.confirm.mock.calls[0]?.[0]);
		expect(question).toContain('Delete server "web"?');
		expect(question).toContain("1 snapshot and 1 reserved IP");
		expect(question).toContain("still billed until you delete it: 1 volume");
		expect(out()).toContain("The server record stays until the kept volumes and snapshots are deleted.");
		expect(terminate).not.toHaveBeenCalled();
	});

	it("explains a refusal caused by kept volumes or snapshots", async () => {
		h.client = {
			virtualMachine: {
				get: { query: async () => ({ ...SERVER, status: "terminated" }) },
				delete: {
					mutate: async () => {
						throw trpcError(
							"PRECONDITION_FAILED",
							"This server still has 1 volume you kept when terminating it. Delete them from the Servers page first, then delete this record.",
						);
					},
				},
			},
		};

		await run(["servers", "delete", SERVER.id], { yes: true });

		expect(exitCodes[0]).toBe(2);
		expect(err()).toContain("This server still has 1 volume you kept when terminating it.");
		expect(err()).toContain("tarout servers kept-storage");
		expect(err()).toContain(`tarout servers delete ${SERVER.id}`);
	});

	it("json: the kept-storage refusal names the next command", async () => {
		h.client = {
			virtualMachine: {
				get: { query: async () => ({ ...SERVER, status: "terminated" }) },
				delete: {
					mutate: async () => {
						throw trpcError("PRECONDITION_FAILED", "This server still has 2 snapshots you kept when terminating it.");
					},
				},
			},
		};

		await run(["servers", "delete", SERVER.id], { json: true, yes: true });

		const envelope = JSON.parse(stdout.find((l) => l.includes('"success"')) ?? "{}");
		expect(envelope.success).toBe(false);
		expect(JSON.stringify(envelope)).toContain("tarout servers kept-storage");
		expect(exitCodes[0]).toBe(2);
	});
});

describe("servers kept-storage", () => {
	const RETAINED = {
		volumes: [
			{ id: "cmvol1", name: "data", diskSizeGb: 100, diskType: "balanced", status: "available", createdAt: new Date(), server: { id: SERVER.id, name: "old-web" } },
		],
		snapshots: [
			{ id: "cmsnap1", name: "nightly", diskSizeGb: 30, status: "ready", createdAt: new Date(), server: { id: SERVER.id, name: "old-web" } },
		],
		reservedIps: [
			{ id: "cmip1", name: "edge", ipAddress: "34.166.10.20", region: "me-central2", status: "available", createdAt: new Date() },
		],
	};

	it("prints one table of everything that keeps billing", async () => {
		h.client = { virtualMachine: { listRetainedStorage: { query: async () => RETAINED } } };

		await run(["servers", "kept-storage"]);

		const text = out();
		expect(text).toMatch(/volume\s+cmvol1\s+data\s+100 GB balanced\s+old-web/);
		expect(text).toMatch(/snapshot\s+cmsnap1\s+nightly\s+30 GB\s+old-web/);
		expect(text).toMatch(/reserved IP\s+cmip1\s+edge\s+34\.166\.10\.20/);
		expect(text).toContain("keep billing until you delete them");
		expect(text).toContain("tarout servers volumes delete <id>");
		expect(text).toContain("tarout servers snapshots delete <id>");
		expect(text).toContain("tarout servers ips release <id>");
	});

	it("the kept alias works and --quiet prints only ids", async () => {
		h.client = { virtualMachine: { listRetainedStorage: { query: async () => RETAINED } } };

		await run(["servers", "kept"], { quiet: true });

		expect(stdout).toEqual(["cmvol1", "cmsnap1", "cmip1"]);
	});

	it("--json prints the raw object", async () => {
		h.client = { virtualMachine: { listRetainedStorage: { query: async () => RETAINED } } };

		await run(["servers", "kept-storage"], { json: true });

		const envelope = JSON.parse(stdout.join("\n"));
		expect(Object.keys(envelope.data)).toEqual(["volumes", "snapshots", "reservedIps"]);
		expect(envelope.data.reservedIps[0].ipAddress).toBe("34.166.10.20");
	});

	it("says so when nothing is kept", async () => {
		h.client = {
			virtualMachine: { listRetainedStorage: { query: async () => ({ volumes: [], snapshots: [], reservedIps: [] }) } },
		};

		await run(["servers", "kept-storage"]);

		expect(out()).toContain("No kept storage.");
	});
});

describe("servers snapshots and firewall default names", () => {
	it("defaultSnapshotName stays within 50 characters of [a-zA-Z0-9-]", () => {
		const names = [
			defaultSnapshotName("a".repeat(80)),
			defaultSnapshotName("My Very Long Production Server Name_with spaces & symbols!"),
			defaultSnapshotName("---"),
			defaultSnapshotName("web"),
		];
		for (const name of names) {
			expect(name.length).toBeLessThanOrEqual(50);
			expect(name).toMatch(/^[a-zA-Z0-9-]+$/);
			expect(name).not.toMatch(/^-|-$|--/);
		}
		expect(defaultSnapshotName("web", 0)).toBe("web-snapshot-0");
	});

	it("snapshots create uses the fitted default when no name is given", async () => {
		const createSnapshot = vi.fn(async (_input: unknown) => ({ id: "snap_1" }));
		const longServer = { ...SERVER, name: "x".repeat(50) };
		h.client = {
			virtualMachine: { list: { query: async () => [longServer] }, createSnapshot: { mutate: createSnapshot } },
		};
		h.input.mockResolvedValue("");

		await run(["servers", "snapshots", "create", SERVER.id]);

		const sent = createSnapshot.mock.calls[0]?.[0] as { name: string };
		expect(sent.name.length).toBeLessThanOrEqual(50);
		expect(sent.name).toMatch(/^x+-snapshot-[a-z0-9]+$/);
	});

	it("defaultFirewallRuleName names the protocol and port", () => {
		expect(defaultFirewallRuleName("tcp", "443")).toBe("allow-tcp-443");
		expect(defaultFirewallRuleName("UDP", "8000-9000")).toBe("allow-udp-8000-9000");
		expect(defaultFirewallRuleName("icmp", "")).toBe("allow-icmp");
		expect(defaultFirewallRuleName("tcp", "443", "egress")).toBe("allow-egress-tcp-443");
		expect(defaultFirewallRuleName("tcp", "1".repeat(80)).length).toBeLessThanOrEqual(50);
	});

	it("firewall add gives two rules different default names", async () => {
		const createFirewallRule = vi.fn(async (_input: unknown) => ({ id: "rule" }));
		h.client = {
			virtualMachine: { list: { query: async () => [SERVER] }, createFirewallRule: { mutate: createFirewallRule } },
		};

		await run(["servers", "firewall", "add", "web", "--port", "80"]);
		await run(["servers", "firewall", "add", "web", "--port", "443"]);

		const names = createFirewallRule.mock.calls.map((c) => (c[0] as { name: string }).name);
		expect(names).toEqual(["allow-tcp-80", "allow-tcp-443"]);
		expect(out()).toContain("Name: allow-tcp-443");
	});

	it("firewall list prints the full rule id that firewall delete needs", async () => {
		// It printed 8 characters, and `firewall delete` takes the full id, so a
		// rule could only be deleted after a --json lookup (seen on prod).
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				listFirewallRules: {
					query: async () => [
						{ id: "cmugeozke000101t5g8t83n93", name: "SSH", direction: "ingress", protocol: "tcp", portRange: "22", sourceRanges: "0.0.0.0/0" },
					],
				},
			},
		};

		await run(["servers", "firewall", "list", "web"]);

		expect(out()).toContain("cmugeozke000101t5g8t83n93");
	});

	it("firewall add still honours an explicit --name", async () => {
		const createFirewallRule = vi.fn(async (_input: unknown) => ({ id: "rule" }));
		h.client = {
			virtualMachine: { list: { query: async () => [SERVER] }, createFirewallRule: { mutate: createFirewallRule } },
		};

		await run(["servers", "firewall", "add", "web", "--port", "22", "--name", "ssh"]);

		expect((createFirewallRule.mock.calls[0]?.[0] as { name: string }).name).toBe("ssh");
	});
});

describe("servers alerts", () => {
	function mockUpsert() {
		const upsert = vi.fn(async (_input: unknown) => ({ id: "alert_1" }));
		h.client = {
			virtualMachine: { list: { query: async () => [SERVER] }, upsertAlertConfig: { mutate: upsert } },
		};
		return upsert;
	}

	it("converts an MB/s threshold to bytes per second for network and disk metrics", async () => {
		const upsert = mockUpsert();

		await run([
			"servers", "alerts", "set", "web",
			"--metric", "network_in", "--threshold", "10",
			"--comparison", "gte", "--duration", "10",
		]);

		expect(upsert.mock.calls[0]?.[0]).toEqual({
			serverId: SERVER.id,
			metricType: "network_in",
			thresholdValue: 10 * 1024 * 1024,
			comparisonOp: "gte",
			durationMinutes: 10,
			enabled: true,
		});
		expect(out()).toContain("Alert saved: network_in >= 10 MB/s for 10 min.");
		expect(out()).not.toContain("%");
	});

	it("keeps cpu and memory thresholds in percent, with gt and 5 minutes by default", async () => {
		const upsert = mockUpsert();

		await run(["servers", "alerts", "set", "web", "--metric", "cpu", "--threshold", "90"]);

		expect(upsert.mock.calls[0]?.[0]).toEqual({
			serverId: SERVER.id,
			metricType: "cpu",
			thresholdValue: 90,
			comparisonOp: "gt",
			durationMinutes: 5,
			enabled: true,
		});
		expect(out()).toContain("Alert saved: cpu > 90% for 5 min.");
	});

	it("accepts an explicit 0 threshold instead of replacing it with 80", async () => {
		const upsert = mockUpsert();

		await run(["servers", "alerts", "set", "web", "--metric", "disk_write", "--threshold", "0", "--comparison", "lte"]);

		expect((upsert.mock.calls[0]?.[0] as { thresholdValue: number }).thresholdValue).toBe(0);
	});

	it("rejects a percent above 100, a bad comparison and a bad duration", async () => {
		const upsert = mockUpsert();

		await run(["servers", "alerts", "set", "web", "--metric", "cpu", "--threshold", "150"]);
		await run(["servers", "alerts", "set", "web", "--metric", "cpu", "--comparison", "eq"]);
		await run(["servers", "alerts", "set", "web", "--metric", "cpu", "--duration", "61"]);

		expect(exitCodes).toEqual([2, 2, 2]);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("refuses a memory alert: memory is not collected on cloud servers", async () => {
		// Cloud servers have no agent that can report memory, so the platform
		// refuses memory alerts; say why instead of offering them (2026-09-25).
		const upsert = mockUpsert();

		await run(["servers", "alerts", "set", "web", "--metric", "memory", "--threshold", "80"]);

		expect(exitCodes).toEqual([2]);
		expect(upsert).not.toHaveBeenCalled();
		expect(err() + out()).toContain("free -m");
	});

	it("list shows thresholds in their own unit", async () => {
		h.client = {
			virtualMachine: {
				list: { query: async () => [SERVER] },
				listAlertConfigs: {
					query: async () => [
						{ id: "a1", serverId: SERVER.id, metricType: "cpu", thresholdValue: 90, comparisonOp: "gt", durationMinutes: 5, enabled: true },
						{ id: "a2", serverId: SERVER.id, metricType: "network_out", thresholdValue: 5 * 1024 * 1024, comparisonOp: "gte", durationMinutes: 10, enabled: false },
					],
				},
			},
		};

		await run(["servers", "alerts", "list", "web"]);

		const text = out();
		expect(text).toMatch(/cpu\s+>\s+90%\s+5 min\s+yes/);
		expect(text).toMatch(/network_out\s+>=\s+5 MB\/s\s+10 min\s+no/);
		expect(text).not.toContain("5242880");
	});

	it("threshold helpers round-trip MB/s", () => {
		expect(alertThresholdToApi("disk_read", 1.5)).toBe(1572864);
		expect(formatAlertThreshold("disk_read", 1572864)).toBe("1.5 MB/s");
		expect(alertThresholdToApi("memory", 75)).toBe(75);
		expect(formatAlertThreshold("memory", 75)).toBe("75%");
	});
});

describe("servers cancel-vm-subscription", () => {
	it("explains hourly billing and exits non-zero without calling the API", async () => {
		const cancel = vi.fn();
		const list = vi.fn();
		h.client = { virtualMachine: { cancelSubscription: { mutate: cancel }, list: { query: list } } };

		await run(["servers", "cancel-vm-subscription", "web"]);

		expect(exitCodes[0]).toBe(1);
		expect(cancel).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
		expect(err()).toContain("billed hourly");
		expect(err()).toContain("no subscription to cancel");
		expect(err()).toContain("tarout servers terminate");
	});
});
