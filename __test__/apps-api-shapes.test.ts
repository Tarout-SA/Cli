import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `tarout apps`, `tarout deploy:*` and `tarout env push` read fields the
 * platform does not send, called a query as a mutation, and sent inputs the
 * platform refuses. These specs drive each command against the REAL
 * `application.*` / `deployment.*` / `envVariable.*` response shapes
 * (cloud/src/server/api/routers/application.ts, deployment.ts,
 * env-variable.ts) and pin both what the CLI sends and what it prints.
 */

const h = vi.hoisted(() => ({
	client: {} as any,
	input: vi.fn(),
	confirm: vi.fn(),
	select: vi.fn(),
	spinnerText: [] as string[],
}));

vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => h.client,
	resetApiClient: () => {},
}));

vi.mock("../src/lib/config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/config.js")>()),
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ organizationId: "org_1", projectName: undefined }),
	getApiUrl: () => "https://api.test",
	getToken: () => "tok_test",
	getAuthScope: () => ({ scope: "none" }),
}));

vi.mock("../src/lib/auth-profile.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/auth-profile.js")>()),
	requireProfile: async () => ({ organizationId: "org_1" }),
}));

vi.mock("../src/utils/spinner.js", () => ({
	startSpinner: vi.fn(() => null),
	succeedSpinner: vi.fn((text?: string) => {
		if (text) h.spinnerText.push(text);
	}),
	failSpinner: vi.fn(),
	stopSpinner: vi.fn(),
	updateSpinner: vi.fn(),
}));

vi.mock("../src/utils/prompts.js", () => ({
	input: h.input,
	confirm: h.confirm,
	select: h.select,
	password: vi.fn(),
	promptOrEmit: vi.fn(),
}));

import { Command } from "commander";
import { registerAppsCommands } from "../src/commands/apps";
import { registerDeployCommands } from "../src/commands/deploy";
import { registerEnvCommands } from "../src/commands/env";
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
	h.spinnerText = [];
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

function buildProgram(): Command {
	const program = new Command();
	program.exitOverride();
	registerAppsCommands(program);
	registerDeployCommands(program);
	registerEnvCommands(program);
	return program;
}

async function run(
	argv: string[],
	opts: Partial<typeof RESET> = {},
): Promise<void> {
	setGlobalOptions({ ...RESET, noColor: true, ...opts });
	try {
		await buildProgram().parseAsync(["node", "tarout", ...argv]);
	} catch (err) {
		if (!/__EXIT_/.test(String(err))) throw err;
	}
}

function helpFor(path: string[]): string {
	let cmd: Command | undefined = buildProgram();
	for (const name of path) {
		cmd = cmd?.commands.find((c) => c.name() === name);
	}
	if (!cmd) throw new Error(`no command ${path.join(" ")}`);
	return cmd.helpInformation();
}

const out = () => stdout.join("\n");
const err = () => stderr.join("\n");

// application.allByOrganization row, exactly as the router maps it.
const APP = {
	applicationId: "Vq3kPz81xYbT0nLm4sRwE",
	name: "web",
	appName: "web-abc123",
	description: null,
	applicationStatus: "done",
	plan: "SHARED",
	region: "me-central2",
	createdAt: "2026-09-01T00:00:00.000Z",
	domain: null,
	liveUrl: "web-abc123.tarout.app",
	lastDeployment: { status: "done", at: "2026-09-20T10:00:00.000Z" },
};

function clientWith(application: Record<string, unknown> = {}, rest = {}) {
	return {
		application: {
			allByOrganization: { query: async () => [APP] },
			...application,
		},
		...rest,
	};
}

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("apps info", () => {
	it("prints the Git source from the top-level fields application.one returns", async () => {
		// The router strips the github/gitlab/bitbucket/gitea relations
		// (redactApplicationForResponse), so the repository lives on the row.
		h.client = clientWith({
			one: {
				query: async () => ({
					applicationId: APP.applicationId,
					name: "web",
					applicationStatus: "done",
					sourceType: "github",
					owner: "acme",
					repository: "web",
					branch: "main",
					buildType: "nixpacks",
					domain: [],
					appSubdomain: "https://web-abc123.tarout.app",
					createdAt: APP.createdAt,
				}),
			},
		});

		await run(["apps", "info", "web"]);

		const text = out();
		expect(text).toMatch(/Type: github/);
		expect(text).toMatch(/Repository: acme\/web/);
		expect(text).toMatch(/Branch: main/);
		expect(text).not.toContain("undefined");
	});

	it("prints a custom Git URL, a Docker image and an uploaded archive", async () => {
		const base = {
			applicationId: APP.applicationId,
			name: "web",
			applicationStatus: "idle",
			domain: [],
			createdAt: APP.createdAt,
		};
		h.client = clientWith({
			one: {
				query: async () => ({
					...base,
					sourceType: "git",
					customGitUrl: "https://git.example.com/acme/web.git",
					customGitBranch: "prod",
				}),
			},
		});
		await run(["apps", "info", "web"]);
		expect(out()).toMatch(/URL: https:\/\/git\.example\.com\/acme\/web\.git/);
		expect(out()).toMatch(/Branch: prod/);

		stdout = [];
		h.client = clientWith({
			one: {
				query: async () => ({
					...base,
					sourceType: "dockerhub",
					dockerHubImage: `nginx@${DIGEST}`,
				}),
			},
		});
		await run(["apps", "info", "web"]);
		expect(out()).toContain(`Image: nginx@${DIGEST}`);

		stdout = [];
		h.client = clientWith({
			one: {
				query: async () => ({
					...base,
					sourceType: "drop",
					dropSourceFilename: "source.zip",
					dropSourceUploadedAt: "2026-09-20T10:00:00.000Z",
				}),
			},
		});
		await run(["apps", "info", "web"]);
		expect(out()).toMatch(/Upload: source\.zip/);
	});
});

describe("apps sync", () => {
	it("calls syncApplicationStatus as a query and prints the status", async () => {
		const query = vi.fn(async () => ({
			applicationStatus: "running",
			changed: false,
		}));
		h.client = clientWith({ syncApplicationStatus: { query } });

		await run(["apps", "sync", "web"]);

		expect(query).toHaveBeenCalledWith({ applicationId: APP.applicationId });
		expect(out()).toMatch(/Status:.*running/);
		expect(exitCodes).toEqual([]);
	});
});

describe("apps ssl-status", () => {
	it("prints appSubdomainStatus / customSubdomainStatus", async () => {
		h.client = clientWith({
			checkSubdomainSSL: {
				query: async () => ({
					appSubdomainStatus: "active",
					customSubdomainStatus: null,
				}),
			},
		});

		await run(["apps", "ssl-status", "web"]);

		const text = out();
		expect(text).toMatch(/Platform subdomain:\s+active/);
		expect(text).not.toContain("invalid/missing");
	});

	it("reports a pending certificate as pending, not valid", async () => {
		h.client = clientWith({
			checkSubdomainSSL: {
				query: async () => ({
					appSubdomainStatus: "pending",
					customSubdomainStatus: "pending",
				}),
			},
		});

		await run(["apps", "ssl-status", "web"]);

		expect(out()).toMatch(/Platform subdomain:\s+pending/);
		expect(out()).toMatch(/Custom subdomain:\s+pending/);
	});
});

describe("apps analytics", () => {
	it("prints the deployment stats application.getAnalytics returns and sends only the app id", async () => {
		const query = vi.fn(async () => ({
			deployments: {
				total: 12,
				successful: 9,
				failed: 3,
				successRate: 75,
				recentCount: 4,
			},
			lastDeployment: {
				status: "done",
				createdAt: "2026-09-20T10:00:00.000Z",
				title: "Deploy abc",
			},
			domains: { count: 1, primary: "acme.sa" },
			status: "done",
			createdAt: APP.createdAt,
		}));
		h.client = clientWith({ getAnalytics: { query } });

		await run(["apps", "analytics", "web"]);

		expect(query).toHaveBeenCalledWith({ applicationId: APP.applicationId });
		const text = out();
		expect(text).toMatch(/Deployments:\s+12 total, 9 succeeded, 3 failed \(75% success\)/);
		expect(text).toMatch(/Last 7 days:\s+4 deployments/);
		expect(text).toMatch(/Last deploy:.*done/);
		expect(text).toMatch(/Domains:\s+1 \(primary: acme\.sa\)/);
	});
});

const MONITOR_METRICS = {
	available: true,
	provider: "tarout-monitor",
	period: "24h",
	window: { from: "2026-09-24T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" },
	reason: null,
	totals: {
		events: 1500,
		requests: 1200,
		pageViews: 300,
		errors: 7,
		slowRequests: 5,
		runtimeLogs: 0,
		metrics: 0,
	},
	latency: { avgMs: 42, p95Ms: 180, maxMs: 900 },
	statusBreakdown: { s2xx: 1100, s3xx: 50, s4xx: 43, s5xx: 7, other: 0 },
	security: {
		monitored: true,
		events: 2,
		blockedRequests: 1,
		warnings: 0,
		errors: 0,
		latestAt: null,
	},
	topPaths: [{ path: "/", count: 800 }],
	timeline: [],
	latestAt: "2026-09-24T23:59:00.000Z",
};

describe("apps metrics", () => {
	it("prints the request telemetry application.getMetrics returns and forwards --period", async () => {
		const query = vi.fn(async () => MONITOR_METRICS);
		h.client = clientWith({ getMetrics: { query } });

		await run(["apps", "metrics", "web", "--period", "24h"]);

		expect(query).toHaveBeenCalledWith({
			applicationId: APP.applicationId,
			period: "24h",
		});
		const text = out();
		expect(text).toMatch(/Requests:\s+1,200/);
		expect(text).toMatch(/Errors:\s+7/);
		expect(text).toMatch(/Latency:\s+avg 42ms, p95 180ms, max 900ms/);
		expect(text).toMatch(/Status codes:\s+2xx 1,100 {2}3xx 50 {2}4xx 43 {2}5xx 7/);
	});

	it("does not advertise CPU/memory in its help", () => {
		expect(helpFor(["apps", "metrics"])).not.toMatch(/CPU|memory/i);
	});

	it("explains an empty window instead of printing only a header", async () => {
		h.client = clientWith({
			getMetrics: {
				query: async () => ({
					...MONITOR_METRICS,
					available: false,
					reason: "no_data",
				}),
			},
		});

		await run(["apps", "metrics", "web"]);

		expect(out()).toContain("No telemetry recorded");
	});
});

describe("apps visitors", () => {
	it("prints the application.getVisitorStats fields", async () => {
		h.client = clientWith({
			getVisitorStats: {
				query: async () => ({
					available: true,
					provider: "tarout-monitor",
					period: "24h",
					window: MONITOR_METRICS.window,
					reason: null,
					totalPageViews: 300,
					totalRequests: 1200,
					totalErrors: 7,
					uniqueVisitors: null,
					topPaths: [{ path: "/pricing", count: 120 }],
					timeline: [],
					latestAt: null,
				}),
			},
		});

		await run(["apps", "visitors", "web"]);

		const text = out();
		expect(text).toMatch(/Page views:\s+300/);
		expect(text).toMatch(/Requests:\s+1,200/);
		expect(text).toMatch(/Errors:\s+7/);
		expect(text).toMatch(/\/pricing\s+120/);
	});
});

describe("apps observability", () => {
	it("prints traffic, uptime and deployment sections", async () => {
		const query = vi.fn(async () => ({
			traffic: {
				trafficAnalyticsConfigured: true,
				hasData: true,
				totalRequests: 5000,
				uniqueVisitors: 420,
				totalBandwidthBytes: 10 * 1024 * 1024,
				cacheHitRate: 63.5,
				statusBreakdown: { s2xx: 4800, s3xx: 100, s4xx: 90, s5xx: 10 },
				topCountries: [{ code: "SA", requests: 4000 }],
				timeline: [],
			},
			uptime: {
				hasMonitor: true,
				currentStatus: "up",
				uptimePercent: 99.9,
				avgResponseTimeMs: 120,
				lastCheckAt: "2026-09-25T00:00:00.000Z",
				responseTimeline: [],
			},
			deployments: {
				stats: {
					total: 3,
					successful: 2,
					failed: 1,
					successRate: 67,
					avgDurationMs: 95_000,
				},
				timeline: [],
				totalAllTime: 40,
				lastSuccess: { createdAt: "2026-09-24T00:00:00.000Z" },
				lastFailure: {
					createdAt: "2026-09-23T00:00:00.000Z",
					errorMessage: "Build failed",
				},
			},
		}));
		h.client = clientWith({ getObservabilityData: { query } });

		await run(["apps", "observability", "web", "--period", "7d"]);

		expect(query).toHaveBeenCalledWith({
			applicationId: APP.applicationId,
			period: "7d",
		});
		const text = out();
		expect(text).toMatch(/Requests:\s+5,000/);
		expect(text).toMatch(/Unique visitors:\s+420/);
		expect(text).toMatch(/Bandwidth:\s+10\.0 MB/);
		expect(text).toMatch(/Uptime:\s+99\.9% \(up\)/);
		expect(text).toMatch(/Deploys:\s+3 \(2 succeeded, 1 failed\)/);
		expect(text).toMatch(/Last failure:.*Build failed/);
	});

	it("refuses a period the platform does not accept", async () => {
		const query = vi.fn();
		h.client = clientWith({ getObservabilityData: { query } });

		await run(["apps", "observability", "web", "--period", "2h"]);

		expect(query).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
	});
});

describe("apps create-options", () => {
	it("prints the tier availability application.getCreateOptions returns", async () => {
		h.client = clientWith({
			getCreateOptions: {
				query: async () => ({
					subscriptionPlanKey: "shared_pro",
					isPaid: true,
					tiers: [
						{ tier: "FREE", total: 1, used: 1, available: 0 },
						{ tier: "SHARED", total: 10, used: 3, available: 7 },
						{ tier: "DEDICATED", total: 0, used: 0, available: 0 },
					],
					dedicatedHostReady: null,
					defaultTier: "SHARED",
				}),
			},
		});

		await run(["apps", "create-options"]);

		const text = out();
		expect(text).toMatch(/Plan:\s+shared_pro/);
		expect(text).toMatch(/SHARED\s+3\s+10\s+7/);
		expect(text).toMatch(/Default tier:\s+SHARED/);
	});
});

describe("apps deploy-status", () => {
	it("prints the real getDeploymentStatus fields", async () => {
		h.client = clientWith({
			getDeploymentStatus: {
				query: async () => ({
					status: "done",
					publicUrl: "https://web-abc123.tarout.app",
					createdAt: APP.createdAt,
					deployed: true,
				}),
			},
		});

		await run(["apps", "deploy-status", "web"]);

		const text = out();
		expect(text).toMatch(/Status:.*done/);
		expect(text).toMatch(/URL:\s+https:\/\/web-abc123\.tarout\.app/);
		expect(text).not.toContain("undefined");
	});
});

describe("apps live-status", () => {
	it("does not name the infrastructure provider in its help", () => {
		expect(helpFor(["apps", "live-status"])).not.toMatch(/coolify/i);
	});
});

describe("apps complete-upload", () => {
	it("says the source was saved and points at deploy, since nothing is queued", async () => {
		const mutate = vi.fn(async () => ({
			objectName: "drops/org_1/app/abc.zip",
			sizeBytes: 2048,
			sha256: "f".repeat(64),
			filename: "source.zip",
		}));
		h.client = clientWith({ completeDropUpload: { mutate } });

		await run([
			"apps",
			"complete-upload",
			"web",
			"--object-name",
			"drops/org_1/app/abc.zip",
			"--file-name",
			"source.zip",
			"--file-size",
			"2048",
		]);

		const all = [...h.spinnerText, out()].join("\n");
		expect(all).not.toMatch(/deployment triggered/i);
		expect(all).toMatch(/tarout deploy web/);
	});
});

describe("apps create", () => {
	it("points the next step at the real source commands, not the read-only info", async () => {
		h.client = clientWith({
			create: {
				mutate: async () => ({
					applicationId: APP.applicationId,
					name: "web",
					appName: "web-abc123",
				}),
			},
		});

		await run(["apps", "create", "web", "--description", "x"]);

		const text = out();
		expect(text).toContain("tarout apps git github");
		expect(text).not.toMatch(/Connect a source: .*apps info/);
	});
});

describe("apps git docker-hub", () => {
	it("refuses a mutable tag before calling the platform", async () => {
		const mutate = vi.fn();
		h.client = clientWith({ saveDockerHubProvider: { mutate } });

		await run(["apps", "git", "docker-hub", "web", "--image", "nginx:latest"]);

		expect(mutate).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
		expect(err()).toMatch(/sha256/);
	});

	it("refuses private-image flags the platform rejects", async () => {
		const mutate = vi.fn();
		h.client = clientWith({ saveDockerHubProvider: { mutate } });

		await run([
			"apps",
			"git",
			"docker-hub",
			"web",
			"--image",
			`myorg/app@${DIGEST}`,
			"--private",
			"--username",
			"me",
			"--token",
			"t",
		]);

		expect(mutate).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
		expect(err()).toMatch(/[Pp]rivate/);
	});

	it("sends a digest-pinned public image without private fields", async () => {
		const mutate = vi.fn(async () => true);
		h.client = clientWith({ saveDockerHubProvider: { mutate } });

		await run([
			"apps",
			"git",
			"docker-hub",
			"web",
			"--image",
			`nginx@${DIGEST}`,
			"--port",
			"80",
		]);

		expect(mutate).toHaveBeenCalledWith({
			applicationId: APP.applicationId,
			dockerHubImage: `nginx@${DIGEST}`,
			containerPort: 80,
		});
		expect(exitCodes).toEqual([]);
	});

	it("help asks for a digest, not a tag", () => {
		const help = helpFor(["apps", "git", "docker-hub"]);
		expect(help).toMatch(/@sha256:/);
		expect(help).not.toMatch(/nginx:latest|--private|--username|--token/);
	});
});

describe("apps git url", () => {
	it("refuses an SSH remote before calling the platform", async () => {
		const mutate = vi.fn();
		h.client = clientWith({ saveGitProvider: { mutate } });

		await run(["apps", "git", "url", "web", "--url", "git@github.com:acme/web.git"]);

		expect(mutate).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
		expect(err()).toMatch(/HTTPS/);
	});

	it("refuses credentials embedded in the URL", async () => {
		const mutate = vi.fn();
		h.client = clientWith({ saveGitProvider: { mutate } });

		await run([
			"apps",
			"git",
			"url",
			"web",
			"--url",
			"https://user:secret@git.example.com/acme/web.git",
		]);

		expect(mutate).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
	});

	it("refuses --ssh-key, which the platform never uses", async () => {
		const mutate = vi.fn();
		h.client = clientWith({ saveGitProvider: { mutate } });

		await run([
			"apps",
			"git",
			"url",
			"web",
			"--url",
			"https://git.example.com/acme/web.git",
			"--ssh-key",
			"key_1",
		]);

		expect(mutate).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
	});

	it("sends an HTTPS URL without customGitSSHKeyId", async () => {
		const mutate = vi.fn(async () => true);
		h.client = clientWith({ saveGitProvider: { mutate } });

		await run([
			"apps",
			"git",
			"url",
			"web",
			"--url",
			"https://git.example.com/acme/web.git",
		]);

		expect(mutate).toHaveBeenCalledWith({
			applicationId: APP.applicationId,
			customGitUrl: "https://git.example.com/acme/web.git",
			customGitBranch: "main",
			customGitBuildPath: "/",
			watchPaths: [],
			enableSubmodules: false,
		});
	});

	it("help does not offer SSH", () => {
		expect(helpFor(["apps", "git", "url"])).not.toMatch(/ssh/i);
	});
});

// deployment.all rows (publicDeployment) are newest first.
const DEP_FAILED = {
	deploymentId: "Kx81mQzT0bR5nPa2LcWd7",
	status: "error",
	title: "Deploy 2",
	createdAt: "2026-09-24T10:00:00.000Z",
};
const DEP_OK = {
	deploymentId: "Kx81zzzz0bR5nPa2LcWd8",
	status: "done",
	title: "Deploy 1",
	createdAt: "2026-09-23T10:00:00.000Z",
};

describe("deploy:list", () => {
	it("prints full deployment ids, which deploy:logs needs for its exact lookup", async () => {
		h.client = clientWith(
			{},
			{ deployment: { all: { query: async () => [DEP_FAILED, DEP_OK] } } },
		);

		await run(["deploy:list", "web"]);

		expect(out()).toContain(DEP_FAILED.deploymentId);
		expect(out()).toContain(DEP_OK.deploymentId);
	});
});

describe("deploy:status", () => {
	it("prints the getDeploymentStatus fields without undefined or Invalid Date", async () => {
		h.client = clientWith({
			one: {
				query: async () => ({
					applicationId: APP.applicationId,
					name: "web",
					applicationStatus: "done",
					appSubdomain: "https://web-abc123.tarout.app",
					domain: [],
				}),
			},
			getDeploymentStatus: {
				query: async () => ({
					status: "done",
					publicUrl: "https://web-abc123.tarout.app",
					createdAt: APP.createdAt,
					deployed: true,
				}),
			},
		});

		await run(["deploy:status", "web"]);

		const text = out();
		expect(text).not.toContain("undefined");
		expect(text).not.toContain("Invalid Date");
		expect(text).toMatch(/Deployed:\s+yes/);
	});
});

describe("deploy:retry", () => {
	it("resolves a unique deployment id prefix to the full id", async () => {
		const retry = vi.fn(async () => ({ deploymentId: "new_dep_1" }));
		h.client = clientWith(
			{},
			{
				deployment: {
					all: { query: async () => [DEP_FAILED, DEP_OK] },
					retry: { mutate: retry },
				},
			},
		);

		await run(["deploy:retry", "web", "--deployment", "Kx81mQzT"]);

		expect(retry).toHaveBeenCalledWith({
			applicationId: APP.applicationId,
			deploymentId: DEP_FAILED.deploymentId,
		});
	});

	it("refuses an ambiguous prefix", async () => {
		const retry = vi.fn();
		h.client = clientWith(
			{},
			{
				deployment: {
					all: { query: async () => [DEP_FAILED, DEP_OK] },
					retry: { mutate: retry },
				},
			},
		);

		await run(["deploy:retry", "web", "--deployment", "Kx81"]);

		expect(retry).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
	});
});

describe("deploy:rollback", () => {
	it("prints the full new deployment id in the logs hint", async () => {
		const rollback = vi.fn(async () => ({
			deploymentId: "Rb9newDeployment0000X",
		}));
		h.client = clientWith(
			{},
			{
				deployment: {
					all: { query: async () => [DEP_OK] },
					rollback: { mutate: rollback },
				},
			},
		);

		await run(["deploy:rollback", "web", "--to", DEP_OK.deploymentId], {
			yes: true,
		});

		expect(out()).toContain("tarout deploy:logs Rb9newDeployment0000X");
	});
});

describe("env push", () => {
	function envFile(content: string): string {
		const dir = mkdtempSync(join(tmpdir(), "tarout-env-push-"));
		const file = join(dir, ".env");
		writeFileSync(file, content);
		return file;
	}

	it("refuses --replace without --restart before calling the platform", async () => {
		const mutate = vi.fn();
		h.client = clientWith({}, { envVariable: { import: { mutate } } });

		await run(["env", "push", "web", "--input", envFile("A=1\n"), "--replace"]);

		expect(mutate).not.toHaveBeenCalled();
		expect(exitCodes).toEqual([2]);
		expect(err()).toMatch(/--restart/);
	});

	it("sends merge:false restart:true for --replace --restart", async () => {
		const mutate = vi.fn(async () => ({ imported: 1, skipped: 0 }));
		h.client = clientWith({}, { envVariable: { import: { mutate } } });

		await run([
			"env",
			"push",
			"web",
			"--input",
			envFile("A=1\n"),
			"--replace",
			"--restart",
		]);

		expect(mutate).toHaveBeenCalledWith(
			expect.objectContaining({ merge: false, restart: true }),
		);
	});

	it("describes skipped entries as invalid, not as already existing", async () => {
		const mutate = vi.fn(async () => ({ imported: 1, skipped: 2 }));
		h.client = clientWith({}, { envVariable: { import: { mutate } } });

		await run(["env", "push", "web", "--input", envFile("A=1\n")]);

		expect(out()).not.toMatch(/already exist/);
		expect(out()).toMatch(/Skipped 2 invalid/);
	});
});
