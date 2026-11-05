import { describe, expect, it } from "vitest";
import {
	clampIncidentLimit,
	describeMuteWindow,
	formatHalalasPerHour,
	gpuCatalogRows,
	incidentListInput,
	incidentRows,
	INCIDENT_SEVERITIES,
	INCIDENT_STATUSES,
	INSTALLABLE_SOFTWARE,
	muteMinutes,
	openIncidentTotal,
	resolveSoftwareAddonId,
	serverSoftwareInput,
	SOFTWARE_RUN_STATES,
	softwareRunSettled,
} from "../src/commands/servers.js";
import { InvalidArgumentError } from "../src/lib/errors.js";

// `servers incidents` (machineAlert.*) is the fired-alert surface. It is a
// different router from `servers alerts` (virtualMachine.*AlertConfig), which
// edits thresholds - these tests pin the input contracts of the former so the
// two can never be wired to each other's procedures by accident.

describe("incidentListInput", () => {
	it("sends only the filters the user asked for, with the platform default limit", () => {
		expect(incidentListInput({})).toEqual({ limit: 50 });
	});

	it("normalizes status and severity to the platform's enum spelling", () => {
		expect(
			incidentListInput({ status: " OPEN ", severity: "Critical" }),
		).toEqual({ status: "open", severity: "critical", limit: 50 });
	});

	it("passes a resolved serverId through untouched", () => {
		expect(incidentListInput({ serverId: "vm_123", limit: 10 })).toEqual({
			serverId: "vm_123",
			limit: 10,
		});
	});

	it("rejects a status the platform's enum does not have", () => {
		expect(() => incidentListInput({ status: "firing" })).toThrow(
			InvalidArgumentError,
		);
		expect(() => incidentListInput({ status: "firing" })).toThrow(
			/open, acknowledged, resolved, muted/,
		);
	});

	it("rejects a severity the platform's enum does not have", () => {
		expect(() => incidentListInput({ severity: "fatal" })).toThrow(
			InvalidArgumentError,
		);
		expect(() => incidentListInput({ severity: "fatal" })).toThrow(
			/info, warning, error, critical/,
		);
	});

	it("mirrors the platform enums exactly", () => {
		expect(INCIDENT_STATUSES).toEqual([
			"open",
			"acknowledged",
			"resolved",
			"muted",
		]);
		expect(INCIDENT_SEVERITIES).toEqual([
			"info",
			"warning",
			"error",
			"critical",
		]);
	});
});

describe("clampIncidentLimit", () => {
	it("defaults to the platform's own default", () => {
		expect(clampIncidentLimit(undefined)).toBe(50);
		expect(clampIncidentLimit("")).toBe(50);
	});

	it("clamps into the platform's 1-100 window instead of failing a Zod check", () => {
		expect(clampIncidentLimit(500)).toBe(100);
		expect(clampIncidentLimit("1000")).toBe(100);
		expect(clampIncidentLimit(0)).toBe(1);
		expect(clampIncidentLimit(-7)).toBe(1);
	});

	it("truncates a fractional limit and accepts a numeric string", () => {
		expect(clampIncidentLimit("25")).toBe(25);
		expect(clampIncidentLimit(7.9)).toBe(7);
	});

	it("rejects a limit that is not a number at all", () => {
		expect(() => clampIncidentLimit("many")).toThrow(InvalidArgumentError);
	});
});

describe("muteMinutes", () => {
	it("accepts the platform's whole window", () => {
		expect(muteMinutes(15)).toBe(15);
		expect(muteMinutes("60")).toBe(60);
		expect(muteMinutes(60 * 24 * 30)).toBe(43200);
	});

	it("refuses a window outside 15 minutes to 30 days rather than clamping it", () => {
		// Clamping would silence a real problem for a length nobody chose.
		expect(() => muteMinutes(14)).toThrow(InvalidArgumentError);
		expect(() => muteMinutes(43201)).toThrow(InvalidArgumentError);
		expect(() => muteMinutes(43201)).toThrow(/15 minutes to 43200/);
	});

	it("refuses a fractional or non-numeric window", () => {
		expect(() => muteMinutes(30.5)).toThrow(InvalidArgumentError);
		expect(() => muteMinutes("a while")).toThrow(InvalidArgumentError);
		expect(() => muteMinutes(undefined)).toThrow(InvalidArgumentError);
	});
});

describe("describeMuteWindow", () => {
	it("says the window back in the largest whole unit", () => {
		expect(describeMuteWindow(30)).toBe("30 minutes");
		expect(describeMuteWindow(60)).toBe("1 hour");
		expect(describeMuteWindow(180)).toBe("3 hours");
		expect(describeMuteWindow(1440)).toBe("1 day");
		expect(describeMuteWindow(43200)).toBe("30 days");
		expect(describeMuteWindow(90)).toBe("90 minutes");
	});
});

describe("incidentRows", () => {
	it("names the rented VM the alert is about", () => {
		expect(
			incidentRows([
				{
					id: "al_1",
					severity: "critical",
					status: "open",
					title: "Disk almost full",
					count: 4,
					lastSeenAt: "2026-11-05T09:00:00.000Z",
					server: { id: "vm_1", name: "web", instanceName: "gcp-web" },
				},
			]),
		).toEqual([
			{
				id: "al_1",
				severity: "critical",
				status: "open",
				title: "Disk almost full",
				target: "web",
				count: 4,
				lastSeenAt: "2026-11-05T09:00:00.000Z",
			},
		]);
	});

	it("reads the dedicated host out of managedRuntime, the shaper's renamed relation", () => {
		// toCustomerMachineAlert strips `coolifyServer` and re-exposes it as
		// `managedRuntime`, with gcpInstanceName renamed to instanceName.
		const rows = incidentRows([
			{
				id: "al_2",
				severity: "warning",
				status: "acknowledged",
				title: "Host unreachable",
				managedRuntime: { id: "cs_1", instanceName: "dedicated-7" },
			},
		]);
		expect(rows[0]?.target).toBe("dedicated-7");
		expect(rows[0]?.count).toBe(1);
		expect(rows[0]?.lastSeenAt).toBeNull();
	});

	it("falls back to platform for an alert attached to no machine", () => {
		expect(incidentRows([{ id: "al_3" }])[0]).toEqual({
			id: "al_3",
			severity: "-",
			status: "-",
			title: "-",
			target: "platform",
			count: 1,
			lastSeenAt: null,
		});
	});

	it("tolerates a missing or non-array payload", () => {
		expect(incidentRows(undefined)).toEqual([]);
		expect(incidentRows({ alerts: [] })).toEqual([]);
	});
});

describe("openIncidentTotal", () => {
	it("sums the per-severity groups the summary reports", () => {
		expect(
			openIncidentTotal({
				open: { critical: 2, warning: 3 },
				acknowledged: 9,
				muted: 1,
			}),
		).toBe(5);
	});

	it("is zero when nothing is open", () => {
		expect(openIncidentTotal({ open: {}, acknowledged: 0, muted: 0 })).toBe(0);
		expect(openIncidentTotal(undefined)).toBe(0);
		expect(openIncidentTotal({ open: { warning: "x" } })).toBe(0);
	});
});

describe("resolveSoftwareAddonId", () => {
	it("offers exactly the platform's non-retired catalog", () => {
		expect(INSTALLABLE_SOFTWARE).toEqual(["coolify", "dokploy"]);
	});

	it("resolves a catalog id or display name, in any case", () => {
		expect(resolveSoftwareAddonId("coolify")).toEqual({
			id: "coolify",
			name: "Coolify",
			hidden: false,
		});
		expect(resolveSoftwareAddonId(" DOKPLOY ").id).toBe("dokploy");
		expect(resolveSoftwareAddonId("Coolify").id).toBe("coolify");
	});

	it("maps the legacy addon id the platform's own normalizer still accepts", () => {
		expect(resolveSoftwareAddonId("tarout-app-platform").id).toBe("coolify");
	});

	it("restores the camel-cased id the platform matches exactly", () => {
		// `taroutCore` is the persisted id; a lowercased spelling would never
		// match the composite unique the status/logs procedures key on.
		expect(resolveSoftwareAddonId("taroutcore").id).toBe("taroutCore");
		expect(resolveSoftwareAddonId("tarout-managed").id).toBe("taroutCore");
	});

	it("lets a retired platform be inspected, updated and removed", () => {
		expect(resolveSoftwareAddonId("openship")).toEqual({
			id: "openship",
			name: "Tarout Core",
			hidden: true,
		});
	});

	it("refuses a retired platform for a fresh install, as the platform does", () => {
		expect(() =>
			resolveSoftwareAddonId("openship", { forInstall: true }),
		).toThrow(InvalidArgumentError);
		expect(() =>
			resolveSoftwareAddonId("taroutCore", { forInstall: true }),
		).toThrow(/retired/);
	});

	it("rejects an unknown software name and suggests the near miss", () => {
		expect(() => resolveSoftwareAddonId("k3s")).toThrow(InvalidArgumentError);
		expect(() => resolveSoftwareAddonId("coolfy")).toThrow(/Did you mean/);
		expect(() => resolveSoftwareAddonId("coolfy")).toThrow(/coolify/);
		expect(() => resolveSoftwareAddonId("")).toThrow(InvalidArgumentError);
	});
});

describe("serverSoftwareInput", () => {
	it("sends the exact serverSoftware input contract", () => {
		expect(serverSoftwareInput("vm_1", "coolify")).toEqual({
			serverId: "vm_1",
			addonId: "coolify",
		});
	});
});

describe("softwareRunSettled", () => {
	it("mirrors the installed_software lifecycle", () => {
		expect(SOFTWARE_RUN_STATES).toEqual([
			"installing",
			"installed",
			"failed",
			"removed",
		]);
	});

	it("treats only the terminal states as finished", () => {
		expect(softwareRunSettled("installed")).toBe(true);
		expect(softwareRunSettled("failed")).toBe(true);
		expect(softwareRunSettled("removed")).toBe(true);
		expect(softwareRunSettled("installing")).toBe(false);
	});

	it("keeps polling on a status it does not recognize", () => {
		// Reporting a result we do not have is worse than polling once more.
		expect(softwareRunSettled(undefined)).toBe(false);
		expect(softwareRunSettled(null)).toBe(false);
		expect(softwareRunSettled("queued")).toBe(false);
	});
});

const catalog = {
	providers: ["gcp", "runpod"],
	families: [
		{
			key: "l4",
			shortName: "L4",
			displayName: "NVIDIA L4",
			offers: [
				{
					family: "l4",
					count: 1,
					sizeId: "gpu-l4-1",
					providerId: "gcp",
					available: true,
					hourlyHalalas: 1234,
					vcpus: 8,
					memoryGb: 32,
					diskSizeGb: 200,
					gpuMemoryGb: 24,
					regionDisplayName: "me-central2",
				},
				{
					family: "l4",
					count: 4,
					sizeId: "gpu-l4-4",
					providerId: "runpod",
					available: false,
					hourlyHalalas: 5000,
					vcpus: 32,
					memoryGb: 128,
					diskSizeGb: 500,
					gpuMemoryGb: 96,
					regionDisplayName: "Global",
				},
			],
		},
		{
			key: "h100",
			shortName: "H100",
			displayName: "NVIDIA H100",
			offers: [
				{
					family: "h100",
					count: 1,
					sizeId: "gpu-h100-1",
					providerId: "runpod",
					available: true,
					hourlyHalalas: 90000,
					vcpus: 16,
					memoryGb: 192,
					diskSizeGb: 1000,
					gpuMemoryGb: 80,
					regionDisplayName: "Global",
				},
			],
		},
	],
};

describe("gpuCatalogRows", () => {
	it("flattens one row per family and GPU count", () => {
		const rows = gpuCatalogRows(catalog);
		expect(rows.map((row) => row.sizeId)).toEqual([
			"gpu-l4-1",
			"gpu-l4-4",
			"gpu-h100-1",
		]);
		expect(rows[0]).toEqual({
			family: "L4",
			count: 1,
			sizeId: "gpu-l4-1",
			provider: "gcp",
			vcpus: 8,
			memoryGb: 32,
			diskSizeGb: 200,
			gpuMemoryGb: 24,
			hourlySar: "12.340",
			region: "me-central2",
			available: true,
		});
	});

	it("never prints the upstream supplier's name", () => {
		// Tarout rents the hardware; customers see "global", not "runpod".
		expect(gpuCatalogRows(catalog).map((row) => row.provider)).toEqual([
			"gcp",
			"global",
			"global",
		]);
	});

	it("filters by family key, short name or display name", () => {
		expect(gpuCatalogRows(catalog, { family: "h100" })).toHaveLength(1);
		expect(gpuCatalogRows(catalog, { family: "H100" })).toHaveLength(1);
		expect(gpuCatalogRows(catalog, { family: "NVIDIA L4" })).toHaveLength(2);
		expect(gpuCatalogRows(catalog, { family: "a100" })).toEqual([]);
	});

	it("drops offers no supplier can take right now on request", () => {
		expect(
			gpuCatalogRows(catalog, { availableOnly: true }).map((row) => row.sizeId),
		).toEqual(["gpu-l4-1", "gpu-h100-1"]);
	});

	it("returns nothing for the empty catalog a GPU-gated account gets", () => {
		expect(gpuCatalogRows({ providers: [], families: [] })).toEqual([]);
		expect(gpuCatalogRows(undefined)).toEqual([]);
	});
});

describe("formatHalalasPerHour", () => {
	it("converts halalas to the SAR figure the rest of the CLI prints", () => {
		expect(formatHalalasPerHour(1234)).toBe("12.340");
		expect(formatHalalasPerHour(0)).toBe("0.000");
		expect(formatHalalasPerHour(undefined)).toBe("-");
		expect(formatHalalasPerHour("nope")).toBe("-");
	});
});
