import { type Command, Option } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	findSimilar,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
import {
	box,
	colors,
	getStatusBadge,
	isJsonMode,
	isQuietMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { ExitCode } from "../utils/exit-codes.js";
import { confirm, input, select } from "../utils/prompts.js";
import {
	failSpinner,
	startSpinner,
	stopSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

/**
 * The provider name shown to customers. The platform reports Global GPU
 * servers as "global"; older platform versions sent the internal supplier id,
 * which must not be printed either.
 */
function displayProvider(providerId: unknown): string {
	if (typeof providerId !== "string" || !providerId) return "";
	return providerId === "runpod" ? "global" : providerId;
}

export function registerServersCommands(program: Command) {
	const servers = program
		.command("servers")
		.description("Manage cloud servers (VMs)");

	// List servers
	servers
		.command("list")
		.alias("ls")
		.description("List all cloud servers")
		.option("-t, --type <type>", "Filter by type: cpu, gpu")
		.option(
			"-s, --status <status>",
			"Filter by status: running, stopped, provisioning",
		)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching servers...");

				const serverList = await client.virtualMachine.list.query({
					serverType: options.type,
					status: options.status,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(serverList);
					return;
				}

				const servers = serverList?.servers || serverList || [];

				if (isQuietMode()) {
					if (Array.isArray(servers)) {
						for (const s of servers as any[]) {
							const id = s.id || s.serverId;
							if (id) quietOutput(String(id));
						}
					}
					return;
				}

				if (!Array.isArray(servers) || servers.length === 0) {
					log("");
					log("No servers found.");
					log("");
					log(`Create one with: ${colors.dim("tarout servers create")}`);
					return;
				}

				log("");
				table(
					["ID", "NAME", "TYPE", "SIZE", "STATUS", "IP", "CREATED"],
					servers.map((s: any) => [
						colors.cyan((s.id || s.serverId || "").slice(0, 8)),
						s.name || colors.dim("-"),
						s.serverType || colors.dim("-"),
						s.serverSize || s.size || colors.dim("-"),
						getStatusBadge(s.status || "unknown"),
						s.publicIp || s.ipAddress || s.ip || colors.dim("-"),
						formatDate(s.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${servers.length} server${servers.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Create server
	servers
		.command("create")
		.argument("[name]", "Server name")
		.description("Create a new cloud server (VM)")
		.option(
			"-t, --type <type>",
			"Server type: cpu or gpu (only the types your account can create are offered)",
		)
		.option(
			"-s, --size <size>",
			"Server size id, e.g. cpu-xs, cpu-s, cpu-m (see `tarout servers sizes`)",
		)
		.option("-o, --os <os>", `OS: ${SERVER_OS_TYPES.join(", ")}`)
		.option("--software <software>", "Pre-install software: coolify or dokploy")
		.option("--provider <provider>", "Cloud provider: gcp or global (Global GPU)")
		.option(
			"-k, --key <key...>",
			"Saved SSH key name(s) or id(s) to install (default: your default keys)",
		)
		.option(
			"--generate-key",
			"Generate a new key pair and print its private key once, instead of using saved keys",
		)
		.option("--no-ssh", "Create the server with SSH access disabled")
		.action(async (name, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				// Reject bad flag values before any request, so nothing is
				// half-created and the message names the valid choices.
				const sshEnabled = options.ssh !== false;
				if (!sshEnabled && (options.key?.length || options.generateKey)) {
					throw new InvalidArgumentError(
						"--no-ssh cannot be combined with --key or --generate-key.",
					);
				}
				if (options.type && !SERVER_TYPES.includes(options.type)) {
					throw new InvalidArgumentError(
						`Invalid server type "${options.type}". Must be one of: ${SERVER_TYPES.join(", ")}.`,
					);
				}
				if (options.os && !SERVER_OS_TYPES.includes(options.os)) {
					throw new InvalidArgumentError(
						`Invalid OS "${options.os}". Must be one of: ${SERVER_OS_TYPES.join(", ")}.`,
					);
				}
				let software: string | undefined;
				if (options.software !== undefined) {
					software = String(options.software).trim().toLowerCase();
					if (!PRE_INSTALLED_SOFTWARE.includes(software)) {
						throw new InvalidArgumentError(
							`Invalid software "${options.software}". Must be one of: ${PRE_INSTALLED_SOFTWARE.join(", ")}.`,
						);
					}
				}

				const client = getApiClient();

				// Resolve SSH access BEFORE anything is created: an unknown --key
				// must fail without leaving a half-made server behind.
				let keyChoice: SshKeyChoice | null = null;
				if (sshEnabled) {
					const savedKeys = options.generateKey
						? []
						: ((await client.sshKey.list.query()) as SavedSshKey[]);
					keyChoice = pickServerSshKeys(savedKeys, {
						keys: options.key,
						generateKey: Boolean(options.generateKey),
					});
				}
				const sshSummary = keyChoice
					? describeSshKeyChoice(keyChoice)
					: "disabled";

				// Interactive mode
				let serverName = name;
				let serverType: string | undefined = options.type;
				let serverSize: string | undefined = options.size;
				let osType: string | undefined = options.os;

				if (!serverName) {
					serverName = await input("Server name:", undefined, {
						field: "server_name",
						flag: "<name>",
					});
				}

				// One catalog call drives both choices. The platform lists only
				// the sizes this account can create (GPU sizes are hidden until
				// GPU rentals open), so the type prompt is derived from it
				// instead of always offering GPU.
				const _spinner = startSpinner("Fetching available sizes...");
				const sizes = await client.virtualMachine.getServerTypes.query({
					type: "all",
					providerId: options.provider,
				});
				succeedSpinner();

				const sizeList: any[] = asArray(
					sizes?.types || sizes?.serverTypes || sizes,
				);
				const sizeId = (s: any): string => String(s.id || s.name || s.size);
				const availableTypes = SERVER_TYPES.filter((t) =>
					sizeList.some((s) => s.serverType === t),
				);

				if (!serverType && serverSize) {
					serverType = sizeList.find((s) => sizeId(s) === serverSize)?.serverType;
				}

				if (!serverType) {
					if (availableTypes.length === 1) {
						serverType = availableTypes[0];
					} else if (availableTypes.length > 1) {
						serverType = await select(
							"Server type:",
							availableTypes.map((t) => ({
								name:
									t === "gpu"
										? "GPU (for AI/ML workloads)"
										: "CPU (general purpose)",
								value: t,
							})),
							{ field: "server_type", flag: "--type" },
						);
					} else {
						throw new CliError(
							"No server sizes are available to your account right now.",
						);
					}
				} else if (sizeList.length > 0 && !availableTypes.includes(serverType)) {
					throw new InvalidArgumentError(
						`${serverType.toUpperCase()} servers are not available to your account. Available: ${availableTypes.join(", ") || "none"}.`,
					);
				}

				const typeSizes = sizeList.filter((s) => s.serverType === serverType);

				if (!serverSize) {
					if (typeSizes.length === 0) {
						throw new CliError(
							`No ${serverType} server sizes are available to your account right now.`,
						);
					}
					serverSize = await select(
						"Server size:",
						typeSizes.map((s) => ({
							name: describeServerSize(s),
							value: sizeId(s),
						})),
						{ field: "server_size", flag: "--size" },
					);
				} else if (sizeList.length > 0) {
					const match = sizeList.find((s) => sizeId(s) === serverSize);
					if (!match || match.serverType !== serverType) {
						throw new InvalidArgumentError(
							`Unknown ${serverType} server size "${serverSize}". Available: ${typeSizes.map(sizeId).join(", ") || "none"}. See \`tarout servers sizes\`.`,
						);
					}
				}

				if (!osType) {
					osType = await select(
						"Operating system:",
						[
							{ name: "Ubuntu 22.04 LTS", value: "ubuntu-22" },
							{ name: "Ubuntu 24.04 LTS", value: "ubuntu-24" },
							{ name: "Debian 12", value: "debian-12" },
						],
						{ field: "os_type", flag: "--os" },
					);
				}

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Name: ${colors.bold(serverName)}`);
					log(`Type: ${serverType}`);
					log(`Size: ${serverSize}`);
					log(`OS: ${osType}`);
					if (software) log(`Software: ${software}`);
					log(`SSH: ${sshSummary}`);
					log("");

					const confirmed = await confirm("Create this server?", false, {
						field: "confirm_create_server",
						flag: "--yes",
						context: { name: serverName, type: serverType, size: serverSize },
					});

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _createSpinner = startSpinner("Creating server...");

				const result = await client.virtualMachine.create.mutate({
					name: serverName,
					serverType,
					serverSize,
					osType,
					billingPeriod: "hourly",
					enableSsh: sshEnabled,
					...(software ? { preInstalledSoftware: software } : {}),
					...(options.provider ? { providerId: options.provider } : {}),
					...(keyChoice && keyChoice.keyIds.length > 0
						? { selectedKeyIds: keyChoice.keyIds }
						: {}),
				});

				succeedSpinner("Server creation started!");

				// Server returns { server, privateKey, privateKeyFormatted, sshCommand }.
				// The real id lives on result.server.id and the private key is shown
				// ONCE: it is never stored server-side.
				const created = result as any;
				const serverId = created.server?.id || created.server?.serverId;

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(serverId || serverName);

				box("Server Created", [
					`ID: ${colors.cyan(serverId || "")}`,
					`Name: ${serverName}`,
					`Type: ${serverType} / ${serverSize}`,
					`OS: ${osType}`,
					...(software ? [`Software: ${software}`] : []),
					`SSH: ${sshSummary}`,
					`Status: ${colors.info("provisioning")}`,
				]);

				const sshCommand = created.sshCommand;
				if (sshCommand) {
					log("");
					log(`SSH: ${colors.cyan(sshCommand)}`);
				}

				const privateKey = created.privateKeyFormatted || created.privateKey;
				if (privateKey) {
					log("");
					log(
						colors.warn(
							"Save this private key now. It will NOT be shown again:",
						),
					);
					log("");
					log(privateKey);
				}

				log("");
				log(
					`Check status: ${colors.dim(`tarout servers info ${(serverId || "").slice(0, 8)}`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Show server info
	servers
		.command("info")
		.argument("<server>", "Server ID or name")
		.description("Show server details")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching server...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					const suggestions = findSimilar(
						serverIdentifier,
						servers.map((s: any) => s.name || ""),
					);
					throw new NotFoundError("Server", serverIdentifier, suggestions);
				}

				const details = await client.virtualMachine.get.query({
					id: server.id || server.serverId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(details);
					return;
				}

				quietOutput(String(details.id || details.serverId));

				log("");
				log(colors.bold(details.name || serverIdentifier));
				log(colors.dim(details.id || details.serverId));
				log("");
				log(`  Status: ${getStatusBadge(details.status || "unknown")}`);
				log(`  Type: ${details.serverType || colors.dim("-")}`);
				log(`  Size: ${details.serverSize || details.size || colors.dim("-")}`);
				log(`  OS: ${details.osType || colors.dim("-")}`);
				log(
					`  Provider: ${displayProvider(details.providerId || details.provider) || colors.dim("-")}`,
				);
				log("");
				log(colors.bold("Network"));
				// The platform never returns a private IP (it is redacted from
				// every response), so only the public address is shown.
				log(
					`  Public IP: ${colors.cyan(details.publicIp || details.ipAddress || colors.dim("Not assigned"))}`,
				);
				log("");
				if (details.createdAt) {
					log(`  Created: ${formatDate(details.createdAt)}`);
				}
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Start server
	servers
		.command("start")
		.argument("<server>", "Server ID or name")
		.description("Start a stopped server")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding server...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const _actionSpinner = startSpinner(
					`Starting ${server.name || serverIdentifier}...`,
				);

				await client.virtualMachine.start.mutate({
					id: server.id || server.serverId,
				});

				succeedSpinner("Server starting!");

				if (isJsonMode()) {
					outputData({ started: true, id: server.id || server.serverId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Stop server
	servers
		.command("stop")
		.argument("<server>", "Server ID or name")
		.description("Stop a running server")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding server...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Stop server "${server.name || serverIdentifier}"?`,
						false,
						{
							field: "confirm_stop_server",
							flag: "--yes",
							context: { server: server.name || serverIdentifier },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _actionSpinner = startSpinner(
					`Stopping ${server.name || serverIdentifier}...`,
				);

				await client.virtualMachine.stop.mutate({
					id: server.id || server.serverId,
				});

				succeedSpinner("Server stopping!");

				if (isJsonMode()) {
					outputData({ stopped: true, id: server.id || server.serverId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Restart server
	servers
		.command("restart")
		.argument("<server>", "Server ID or name")
		.description("Restart a server")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding server...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const _actionSpinner = startSpinner(
					`Restarting ${server.name || serverIdentifier}...`,
				);

				await client.virtualMachine.restart.mutate({
					id: server.id || server.serverId,
				});

				succeedSpinner("Server restarting!");

				if (isJsonMode()) {
					outputData({ restarted: true, id: server.id || server.serverId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Delete server
	servers
		.command("delete")
		.alias("rm")
		.argument("<server>", "Server ID or name")
		.description(
			"Permanently delete a server: terminate it, then remove its record",
		)
		.option("--keep-volumes", "Keep the server's volumes (they keep billing)")
		.option(
			"--keep-snapshots",
			"Keep the server's snapshots (they keep billing)",
		)
		.option("--keep-ips", "Keep the server's reserved IPs (they keep billing)")
		.action(async (serverIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const keep = keepChoiceFromOptions(options);

				startSpinner("Finding server...");
				// Resolve by id first: `list` hides terminated servers, so deleting
				// the record of an already-terminated server used to fail with
				// "not found". Names still resolve through `list`.
				const server = await resolveServerIncludingTerminated(
					client,
					serverIdentifier,
				).catch((err: unknown) => {
					failSpinner();
					throw err;
				});
				succeedSpinner();

				const serverId = String(server.id || server.serverId);
				const label = server.name || serverIdentifier;
				const alreadyTerminated = server.status === "terminated";
				const terminating = server.status === "terminating";

				if (!shouldSkipConfirmation()) {
					let confirmed: boolean;
					if (alreadyTerminated || terminating) {
						// Nothing left to choose: the machine is gone (or going),
						// so only the record is at stake.
						const state = alreadyTerminated ? "terminated" : "terminating";
						log("");
						log(`Server: ${colors.bold(label)} (${state})`);
						log(`ID: ${colors.dim(serverId)}`);
						log("");
						confirmed = await confirm(
							`Delete the record of ${state} server "${label}"?`,
							false,
							{
								field: "confirm_delete_server",
								flag: "--yes",
								context: { server: label, status: state },
							},
						);
					} else {
						confirmed = await confirmTermination(
							client,
							serverId,
							label,
							keep,
							"delete",
						);
					}
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				// The platform only removes a server record once the machine itself
				// is confirmed gone. "delete" promises the whole thing, so terminate
				// first and wait for the provider delete instead of failing with
				// "must be terminated first" (seen 2026-09-23).
				if (!alreadyTerminated) {
					if (!terminating) {
						startSpinner("Terminating server...");
						await client.virtualMachine.terminate.mutate(
							terminateInput(serverId, keep),
						);
						succeedSpinner("Termination started");
					}
					startSpinner("Waiting for the machine to be deleted...");
					const deadline = Date.now() + 10 * 60 * 1000;
					for (;;) {
						const current: any = await client.virtualMachine.get
							.query({ id: serverId })
							.catch(() => null);
						const status = current?.status;
						if (status === "terminated") break;
						if (status === "failed") {
							failSpinner();
							throw new Error(
								"Termination could not be confirmed. Run `tarout servers delete` again, or contact support if it keeps failing.",
							);
						}
						if (Date.now() > deadline) {
							failSpinner();
							throw new Error(
								"The server is still terminating after 10 minutes. It will finish in the background; run `tarout servers delete` again to remove the record.",
							);
						}
						await new Promise((resolve) => setTimeout(resolve, 5000));
					}
					succeedSpinner("Machine deleted");
				}

				startSpinner("Deleting server record...");
				try {
					await client.virtualMachine.delete.mutate({ id: serverId });
				} catch (err) {
					failSpinner();
					throw (
						keptStorageRefusal(err, {
							terminatedNow: !alreadyTerminated,
							identifier: serverIdentifier,
						}) ?? err
					);
				}
				succeedSpinner("Server deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, id: serverId });
				} else {
					quietOutput(serverId);
					logKeptStorageHint(keep);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// View server console output
	servers
		.command("console")
		.argument("<server>", "Server ID or name")
		.description("View server console output")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching console output...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const output = await client.virtualMachine.getConsoleOutput.query({
					id: server.id || server.serverId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(output);
					return;
				}

				log("");
				log(
					`Console output for ${colors.cyan(server.name || serverIdentifier)}:`,
				);
				log(colors.dim("─".repeat(50)));
				log("");
				log(
					output?.output || output?.consoleOutput || colors.dim("(no output)"),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// View server metrics
	servers
		.command("metrics")
		.argument("<server>", "Server ID or name")
		.description("View server performance metrics")
		.option(
			"-r, --range <range>",
			`Time range: ${METRIC_RANGES.join(", ")}`,
			"1h",
		)
		.action(async (serverIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!METRIC_RANGES.includes(options.range)) {
					throw new InvalidArgumentError(
						`Invalid range "${options.range}". Must be one of: ${METRIC_RANGES.join(", ")}.`,
					);
				}

				const client = getApiClient();

				const _spinner = startSpinner("Fetching metrics...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const metrics = await client.virtualMachine.getMetrics.query({
					id: server.id || server.serverId,
					timeRange: options.range,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(metrics);
					return;
				}

				log("");
				log(
					`Metrics for ${colors.cyan(server.name || serverIdentifier)} (${options.range})`,
				);
				log("");

				// getMetrics returns one { timestamp, value } series per metric:
				// cpu/memory in percent, disk and network in bytes per second.
				let anyData = false;
				const rows = METRIC_SERIES.map(({ key, label, unit }) => {
					const summary = summarizeMetricSeries(metrics?.[key]);
					if (!summary) {
						// Cloud servers run no agent that can report memory.
						const empty = key === "memoryUsage" ? "not collected" : "no data yet";
						return [label, colors.dim(empty), "-", "-"];
					}
					anyData = true;
					const format = unit === "percent" ? formatPercent : formatRate;
					return [
						label,
						format(summary.latest),
						format(summary.avg),
						format(summary.max),
					];
				});
				table(["METRIC", "LATEST", "AVG", "MAX"], rows);
				log("");
				if (!anyData) {
					log(
						colors.dim(
							"No data yet. Metrics appear a few minutes after the server starts running.",
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Snapshots subgroup
	const snapshots = servers
		.command("snapshots")
		.description("Manage server snapshots");

	snapshots
		.command("list")
		.alias("ls")
		.argument("<server>", "Server ID or name")
		.description("List snapshots for a server")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching snapshots...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const snapshotList = await client.virtualMachine.listSnapshots.query({
					serverId: server.id || server.serverId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(snapshotList);
					return;
				}

				const items = snapshotList?.snapshots || snapshotList || [];

				if (!Array.isArray(items) || items.length === 0) {
					log("");
					log(
						`No snapshots for ${colors.cyan(server.name || serverIdentifier)}.`,
					);
					return;
				}

				log("");
				table(
					["ID", "NAME", "STATUS", "SIZE", "CREATED"],
					items.map((s: any) => [
						// Full id: `snapshots delete` needs it, a prefix is refused.
						colors.cyan(String(s.id || s.snapshotId || "")),
						s.name || colors.dim("-"),
						s.status || colors.dim("-"),
						formatBytes(s.diskSizeGb ? s.diskSizeGb * 1024 * 1024 * 1024 : 0),
						formatDate(s.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${items.length} snapshot${items.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	snapshots
		.command("create")
		.argument("<server>", "Server ID or name")
		.argument("[snapshot-name]", "Snapshot name")
		.description("Create a snapshot of a server")
		.action(async (serverIdentifier, snapshotName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding server...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				let name = snapshotName;
				if (!name) {
					// Snapshot names are capped at 50 characters, so the default is
					// built to fit instead of `<server>-snapshot-<ms>`, which a long
					// server name pushed over the limit.
					const fallback = defaultSnapshotName(
						server.name || serverIdentifier,
					);
					name = await input(
						`Snapshot name (default: ${fallback}):`,
						undefined,
						{ field: "snapshot_name", flag: "<snapshot-name>" },
					);
					if (!name) {
						name = fallback;
					}
				}

				const _createSpinner = startSpinner("Creating snapshot...");

				const result = await client.virtualMachine.createSnapshot.mutate({
					serverId: server.id || server.serverId,
					name,
				});

				succeedSpinner("Snapshot creation started!");

				if (isJsonMode()) {
					outputData(result);
				} else {
					quietOutput(
						String((result as any)?.snapshotId || (result as any)?.id || name),
					);
					box("Snapshot Created", [
						`Name: ${colors.cyan(name)}`,
						`Server: ${server.name || serverIdentifier}`,
					]);
				}
			} catch (err) {
				handleError(err);
			}
		});

	snapshots
		.command("delete")
		.alias("rm")
		.argument("<snapshot-id>", "Snapshot ID to delete")
		.description("Delete a snapshot")
		.action(async (snapshotId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete snapshot "${snapshotId}"?`,
						false,
						{
							field: "confirm_delete_snapshot",
							flag: "--yes",
							context: { snapshotId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting snapshot...");

				await client.virtualMachine.deleteSnapshot.mutate({ snapshotId });

				succeedSpinner("Snapshot deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, snapshotId });
				} else {
					quietOutput(snapshotId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Firewall rules subgroup
	const firewall = servers
		.command("firewall")
		.description("Manage server firewall rules");

	firewall
		.command("list")
		.alias("ls")
		.argument("<server>", "Server ID or name")
		.description("List firewall rules for a server")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching firewall rules...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const rules = await client.virtualMachine.listFirewallRules.query({
					serverId: server.id || server.serverId,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(rules);
					return;
				}

				const items = rules?.rules || rules || [];

				if (!Array.isArray(items) || items.length === 0) {
					log("");
					log(
						`No firewall rules for ${colors.cyan(server.name || serverIdentifier)}.`,
					);
					return;
				}

				log("");
				table(
					// virtualMachineFirewallRule rows carry `direction` (schema default
					// "ingress"), so show it: an egress rule listed without it looks
					// identical to an inbound one, and its SOURCE column is really the
					// destination range.
					["ID", "NAME", "DIRECTION", "PROTOCOL", "PORTS", "SOURCE"],
					items.map((r: any) => [
						colors.cyan(r.id || r.ruleId || ""),
						r.name || colors.dim("-"),
						r.direction || "ingress",
						r.protocol || colors.dim("-"),
						r.portRange || colors.dim("-"),
						r.sourceRanges || "0.0.0.0/0",
					]),
				);
			} catch (err) {
				handleError(err);
			}
		});

	firewall
		.command("add")
		.argument("<server>", "Server ID or name")
		.description("Add a firewall rule")
		.option(
			"-n, --name <name>",
			"Rule name, unique per server (default: allow-<protocol>-<port>)",
		)
		.option("-p, --protocol <proto>", "Protocol: tcp, udp, icmp", "tcp")
		.option("--port <range>", "Port or range (e.g., 80, 443, 8000-9000)")
		.option("--source <cidr>", "Source CIDR range", "0.0.0.0/0")
		.option(
			"--direction <direction>",
			"Rule direction: ingress (inbound) or egress (outbound)",
			"ingress",
		)
		.action(async (serverIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				// The platform enum is exactly ["ingress","egress"] (lowercase). Send
				// anything else and the tRPC input parse fails with a raw zod error, so
				// normalize + reject here where we can give a usable message.
				const direction = String(options.direction || "ingress").toLowerCase();
				if (direction !== "ingress" && direction !== "egress") {
					throw new InvalidArgumentError(
						`Invalid direction "${options.direction}". Must be "ingress" or "egress".`,
					);
				}

				const client = getApiClient();

				const _spinner = startSpinner("Finding server...");
				const serverList = await client.virtualMachine.list.query({});
				const servers = serverList?.servers || serverList || [];
				const server = findServer(servers, serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				let portRange = options.port;
				if (!portRange) {
					portRange = await input(
						"Port or range (e.g., 80, 443, 8000-9000):",
						undefined,
						{ field: "port_range", flag: "--port" },
					);
				}

				// Rule names are unique per server, so a fixed default ("allow-port")
				// collided on the second rule. Derive one from what the rule opens.
				const ruleName =
					options.name ||
					defaultFirewallRuleName(options.protocol, portRange, direction);

				const _addSpinner = startSpinner("Adding firewall rule...");

				const result = await client.virtualMachine.createFirewallRule.mutate({
					serverId: server.id || server.serverId,
					name: ruleName,
					protocol: options.protocol,
					portRange,
					sourceRanges: options.source,
					direction,
				});

				succeedSpinner("Firewall rule added!");

				if (isJsonMode()) {
					outputData(result);
				} else {
					box("Firewall Rule Added", [
						`Name: ${ruleName}`,
						`Direction: ${direction}`,
						`Protocol: ${options.protocol.toUpperCase()}`,
						`Port: ${portRange}`,
						// For an egress rule the platform applies this CIDR as the GCP
						// destinationRanges, not sourceRanges, so label it accordingly.
						`${direction === "egress" ? "Destination" : "Source"}: ${options.source}`,
					]);
				}
			} catch (err) {
				handleError(err);
			}
		});

	firewall
		.command("delete")
		.alias("rm")
		.argument("<rule-id>", "Firewall rule ID")
		.description("Delete a firewall rule")
		.action(async (ruleId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete firewall rule "${ruleId}"?`,
						false,
						{
							field: "confirm_delete_firewall_rule",
							flag: "--yes",
							context: { ruleId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting firewall rule...");

				await client.virtualMachine.deleteFirewallRule.mutate({ ruleId });

				succeedSpinner("Firewall rule deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, ruleId });
				} else {
					quietOutput(ruleId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// List available server sizes/types
	servers
		.command("sizes")
		.description("List available server sizes and types")
		.option("-t, --type <type>", "Filter by type: cpu, gpu, all", "all")
		.option("--provider <provider>", "Filter by provider: gcp or global")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching server types...");

				const types = await client.virtualMachine.getServerTypes.query({
					type: options.type === "all" ? undefined : options.type,
					providerId: options.provider,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(types);
					return;
				}

				const items = types?.types || types?.serverTypes || types || [];

				if (!Array.isArray(items) || items.length === 0) {
					log("No server types available.");
					return;
				}

				log("");
				table(
					["SIZE", "VCPU", "RAM", "DISK", "TYPE", "PRICE/HR"],
					items.map((s: any) => [
						colors.cyan(s.name || s.id || ""),
						String(s.vcpu || s.cpu || "-"),
						s.ramGb ? `${s.ramGb} GB` : "-",
						s.diskGb ? `${s.diskGb} GB` : "-",
						s.serverType || "-",
						s.priceHalalas
							? `${(s.priceHalalas / 100).toFixed(3)} SAR`
							: colors.dim("custom"),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Resize server
	servers
		.command("resize")
		.argument("<server>", "Server ID or name")
		.argument("<size>", "New server size/type")
		.description("Resize a cloud server to a different plan")
		.action(async (serverIdentifier, size) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				succeedSpinner();

				const _resizeSpinner = startSpinner("Resizing server...");

				await client.virtualMachine.resize.mutate({
					id: server.id || server.serverId,
					newServerSize: size,
				} as any);

				succeedSpinner("Server resize initiated!");

				if (isJsonMode()) {
					outputData({
						resizing: true,
						serverId: server.id || server.serverId,
						size,
					});
				} else {
					log("");
					log(
						`${colors.success("Resize initiated.")} Run ${colors.dim(`tarout servers info ${serverIdentifier}`)} to track progress.`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Rescue mode
	servers
		.command("rescue")
		.argument("<server>", "Server ID or name")
		.description("Enable or disable rescue mode for a server")
		.option("--disable", "Disable rescue mode (default: enable)")
		.action(async (serverIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				succeedSpinner();

				const enable = !options.disable;
				const _rescueSpinner = startSpinner(
					`${enable ? "Enabling" : "Disabling"} rescue mode...`,
				);

				// Server requires an explicit `enable` boolean (rescueMode input is
				// { id, enable }); there is no server-side toggle.
				await client.virtualMachine.rescueMode.mutate({
					id: server.id || server.serverId,
					enable,
				} as any);

				succeedSpinner(`Rescue mode ${enable ? "enabled" : "disabled"}!`);

				if (isJsonMode()) {
					outputData({
						rescue: enable,
						serverId: server.id || server.serverId,
					});
				} else {
					log("");
					log(
						colors.warn(
							`Rescue mode has been ${enable ? "enabled" : "disabled"} for this server.`,
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Sync server status
	servers
		.command("sync")
		.argument("<server>", "Server ID or name")
		.description("Sync server status from provider")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const _syncSpinner = startSpinner("Syncing status...");

				await client.virtualMachine.syncStatus.mutate({
					id: server.id || server.serverId,
				} as any);

				succeedSpinner("Status synced!");

				if (isJsonMode()) {
					outputData({ synced: true, serverId: server.id || server.serverId });
				} else {
					log("");
					log(
						`${colors.success("Status synced.")} Run ${colors.dim(`tarout servers info ${serverIdentifier}`)} to view.`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Volumes subgroup
	const volumes = servers
		.command("volumes")
		.description("Manage cloud server volumes");

	volumes
		.command("list")
		.argument("<server>", "Server ID or name")
		.description("List volumes attached to a server")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching volumes...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const vols = await client.virtualMachine.listVolumes.query({
					serverId: server.id || server.serverId,
				} as any);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(vols);
					return;
				}

				const list = Array.isArray(vols) ? vols : [];

				if (!list.length) {
					log("");
					log("No volumes found.");
					return;
				}

				log("");
				// Rows are { id, name, diskSizeGb, diskType, deviceName, status,
				// zone, createdAt }; "attached" is a status, not a timestamp.
				table(
					["ID", "NAME", "SIZE", "TYPE", "STATUS", "DEVICE", "CREATED"],
					list.map((v: any) => [
						// Full id: attach/detach/delete need it.
						colors.cyan(String(v.id || v.volumeId || "")),
						v.name || "-",
						v.diskSizeGb ? `${v.diskSizeGb} GB` : "-",
						v.diskType || "-",
						formatVolumeStatus(v.status),
						v.deviceName || colors.dim("-"),
						formatDate(v.createdAt),
					]),
				);
				log("");
				if (list.some((v: any) => v.status === "available")) {
					log(
						colors.dim(
							"Available volumes are not attached. Attach one with: tarout servers volumes attach <volume-id>",
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	volumes
		.command("create")
		.argument("<server>", "Server ID or name")
		.description(
			"Create a new volume for a server (use --attach to attach it right away)",
		)
		.option("-n, --name <name>", "Volume name")
		.option("-s, --size <gb>", "Size in GB (10 to 64000)", "20")
		.option("--type <type>", "Disk type: balanced, ssd, standard", "balanced")
		.option("--attach", "Attach the volume to the server after creating it")
		.action(async (serverIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const sizeGb = Number(options.size);
				if (!Number.isInteger(sizeGb) || sizeGb < 10 || sizeGb > 64000) {
					throw new InvalidArgumentError(
						`Invalid size "${options.size}". Must be a whole number of GB from 10 to 64000.`,
					);
				}
				const diskType = String(options.type).toLowerCase();
				if (!VOLUME_DISK_TYPES.includes(diskType)) {
					throw new InvalidArgumentError(
						`Invalid disk type "${options.type}". Must be one of: ${VOLUME_DISK_TYPES.join(", ")}.`,
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				let name = options.name;
				if (!name) {
					name = await input("Volume name:", undefined, {
						field: "volume_name",
						flag: "--name",
					});
				}

				const _createSpinner = startSpinner("Creating volume...");

				const vol: any = await client.virtualMachine.createVolume.mutate({
					serverId: server.id || server.serverId,
					name,
					sizeGb,
					diskType,
				});

				succeedSpinner("Volume created!");

				// createVolume leaves the volume "available" (detached). Attaching
				// is a separate call, so only claim "attached" after making it.
				const volumeId = String(vol?.id || vol?.volumeId || "");
				let attached = false;
				if (options.attach && volumeId) {
					startSpinner("Attaching volume...");
					try {
						await client.virtualMachine.attachVolume.mutate({ volumeId });
					} catch (err) {
						failSpinner();
						const reason = err instanceof Error ? err.message : String(err);
						throw new CliError(
							`Volume "${name}" (${volumeId}) was created but could not be attached: ${reason}\nRetry with: tarout servers volumes attach ${volumeId}`,
						);
					}
					succeedSpinner("Volume attached!");
					attached = true;
				}

				if (isJsonMode()) {
					outputData({ ...vol, attached });
				} else {
					quietOutput(volumeId || name);
					log("");
					if (attached) {
						log(colors.success(`Volume "${name}" created and attached.`));
					} else {
						log(
							colors.success(
								`Volume "${name}" created. It is not attached yet.`,
							),
						);
						log(
							`Attach it with: ${colors.dim(`tarout servers volumes attach ${volumeId || "<volume-id>"}`)}`,
						);
					}
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	volumes
		.command("delete")
		.argument("<volume-id>", "Volume ID to delete")
		.description("Delete a volume")
		.action(async (volumeId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete volume "${volumeId}"? This is irreversible.`,
						false,
						{
							field: "confirm_delete_volume",
							flag: "--yes",
							context: { volumeId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Deleting volume...");

				await client.virtualMachine.deleteVolume.mutate({
					volumeId,
				} as any);

				succeedSpinner("Volume deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, volumeId });
				} else {
					quietOutput(volumeId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	volumes
		.command("attach")
		.argument("<volume-id>", "Volume ID")
		.argument(
			"[server]",
			"Server the volume belongs to (optional: a volume only attaches to the server it was created for)",
		)
		.description("Attach a volume to the server it was created for")
		.action(async (volumeId, serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// attachVolume input is { volumeId } only: the platform attaches
				// the volume to its own server and takes no server argument. When
				// a server is named, check the volume really is that server's, so
				// the command never reports attaching it somewhere it did not go.
				let serverId: string | undefined;
				if (serverIdentifier) {
					startSpinner("Finding server...");
					const serverList = await client.virtualMachine.list.query();
					const server = findServer(asServerList(serverList), serverIdentifier);
					if (!server) {
						failSpinner();
						throw new NotFoundError("Server", serverIdentifier);
					}
					serverId = String(server.id || server.serverId);
					const vols = asArray(
						await client.virtualMachine.listVolumes.query({ serverId }),
					);
					if (!vols.some((v: any) => (v.id || v.volumeId) === volumeId)) {
						failSpinner();
						throw new InvalidArgumentError(
							`Volume "${volumeId}" does not belong to server "${server.name || serverIdentifier}". A volume can only be attached to the server it was created for.`,
						);
					}
					succeedSpinner();
				}

				startSpinner("Attaching volume...");

				await client.virtualMachine.attachVolume.mutate({ volumeId });

				succeedSpinner("Volume attached!");

				if (isJsonMode()) {
					outputData({
						attached: true,
						volumeId,
						...(serverId ? { serverId } : {}),
					});
				} else {
					quietOutput(volumeId);
				}
			} catch (err) {
				handleError(err);
			}
		});

	volumes
		.command("detach")
		.argument("<volume-id>", "Volume ID to detach")
		.description("Detach a volume from its server")
		.action(async (volumeId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Detaching volume...");

				await client.virtualMachine.detachVolume.mutate({
					volumeId,
				} as any);

				succeedSpinner("Volume detached!");

				if (isJsonMode()) {
					outputData({ detached: true, volumeId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Reserved IPs subgroup
	const ips = servers
		.command("ips")
		.description("Manage reserved IP addresses");

	ips
		.command("list")
		.description("List reserved IP addresses")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching reserved IPs...");

				const ipList = await client.virtualMachine.listReservedIps.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(ipList);
					return;
				}

				const items = Array.isArray(ipList) ? ipList : [];

				if (!items.length) {
					log("");
					log("No reserved IPs found.");
					log(`Reserve one with: ${colors.dim("tarout servers ips reserve")}`);
					return;
				}

				log("");
				// Rows are { id, name, ipAddress, region, status, assignedServerId,
				// assignedServer?: { name }, createdAt }.
				table(
					["ID", "NAME", "IP", "REGION", "STATUS", "ASSIGNED TO", "CREATED"],
					items.map((ip: any) => [
						// Full id: release/assign/unassign need it.
						colors.cyan(String(ip.id || ip.ipId || "")),
						ip.name || "-",
						ip.ipAddress ? colors.cyan(ip.ipAddress) : colors.dim("pending"),
						ip.region || "-",
						ip.status || "-",
						ip.assignedServer?.name ||
							ip.assignedServerId ||
							colors.dim("unassigned"),
						formatDate(ip.createdAt),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	ips
		.command("reserve")
		.description("Reserve a new IP address")
		.option(
			"-r, --region <region>",
			"Region for the IP (me-central2, Dammam, is the only region)",
			DEFAULT_IP_REGION,
		)
		.option("-n, --name <name>", "Name for the reserved IP")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Server requires both { name, region }. The region defaults to
				// the only one there is. The default name carries a unique suffix:
				// the provider address is named after it, so a fixed default made
				// every second reservation fail.
				const region = String(options.region || DEFAULT_IP_REGION);
				const name = options.name || defaultReservedIpName(region);

				const _spinner = startSpinner("Reserving IP...");

				const result = await client.virtualMachine.reserveIp.mutate({
					name,
					region,
				});

				succeedSpinner("IP reserved!");

				if (isJsonMode()) {
					outputData(result);
				} else {
					const r = result as any;
					const reservedIpId = r?.id || r?.ipId;
					if (reservedIpId) quietOutput(String(reservedIpId));
					log("");
					box("IP Reserved", [
						`IP: ${colors.cyan(r?.ipAddress || "pending")}`,
						`ID: ${reservedIpId || ""}`,
						`Name: ${r?.name || name}`,
						`Region: ${r?.region || region}`,
						`Status: ${r?.status || "-"}`,
					]);
					log(
						`Assign to server: ${colors.dim(`tarout servers ips assign ${reservedIpId || "<id>"} <server>`)}`,
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	ips
		.command("release")
		.argument("<ip-id>", "Reserved IP ID to release")
		.description("Release a reserved IP address")
		.action(async (ipId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(`Release IP "${ipId}"?`, false, {
						field: "confirm_release_ip",
						flag: "--yes",
						context: { ipId },
					});
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const client = getApiClient();
				const _spinner = startSpinner("Releasing IP...");

				await client.virtualMachine.releaseIp.mutate({ ipId } as any);

				succeedSpinner("IP released!");

				if (isJsonMode()) {
					outputData({ released: true, ipId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	ips
		.command("assign")
		.argument("<ip-id>", "Reserved IP ID")
		.argument("<server>", "Server ID or name")
		.description("Assign a reserved IP to a server")
		.action(async (ipId, serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const _assignSpinner = startSpinner("Assigning IP...");

				await client.virtualMachine.assignIp.mutate({
					ipId,
					serverId: server.id || server.serverId,
				} as any);

				succeedSpinner("IP assigned!");

				if (isJsonMode()) {
					outputData({
						assigned: true,
						ipId,
						serverId: server.id || server.serverId,
					});
				}
			} catch (err) {
				handleError(err);
			}
		});

	ips
		.command("unassign")
		.argument("<ip-id>", "Reserved IP ID to unassign")
		.description("Unassign a reserved IP from its server")
		.action(async (ipId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Unassigning IP...");

				await client.virtualMachine.unassignIp.mutate({ ipId } as any);

				succeedSpinner("IP unassigned!");

				if (isJsonMode()) {
					outputData({ unassigned: true, ipId });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Alerts subgroup
	// `servers alerts` edits the THRESHOLD RULES (virtualMachine.*AlertConfig);
	// `servers incidents` works the alerts those rules have already fired
	// (machineAlert.*). The two are easy to confuse, so each group's help names
	// the other and neither description stands on the bare word "alert".
	const alerts = servers
		.command("alerts")
		.description(
			"Configure the monitoring thresholds that decide when a server raises an alert (CPU, disk and network rules). This group edits the rules, not the alerts they produce: to see, acknowledge, resolve or mute an alert that is firing right now, use `tarout servers incidents`.",
		)
		.addHelpText(
			"after",
			"\nThreshold rules live here. Alerts that have already fired live under `tarout servers incidents`.",
		);

	alerts
		.command("list")
		.argument("<server>", "Server ID or name")
		.description("List alert configurations for a server")
		.action(async (serverIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching alerts...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				const alertList = await client.virtualMachine.listAlertConfigs.query({
					serverId: server.id || server.serverId,
				} as any);

				succeedSpinner();

				if (isJsonMode()) {
					outputData(alertList);
					return;
				}

				const items = Array.isArray(alertList) ? alertList : [];

				if (!items.length) {
					log("");
					log("No alert configurations found.");
					return;
				}

				log("");
				// thresholdValue is percent for cpu/memory and bytes per second for
				// disk/network, so format it per metric instead of printing raw.
				table(
					["METRIC", "CONDITION", "THRESHOLD", "FOR", "ENABLED"],
					items.map((a: any) => {
						const metric = String(a.metricType || a.metric || "-");
						const value = Number(a.thresholdValue ?? a.threshold);
						return [
							metric,
							COMPARISON_SYMBOLS[a.comparisonOp] || a.comparisonOp || "-",
							Number.isFinite(value)
								? formatAlertThreshold(metric, value)
								: "-",
							a.durationMinutes ? `${a.durationMinutes} min` : "-",
							a.enabled ? colors.success("yes") : colors.dim("no"),
						];
					}),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	alerts
		.command("set")
		.argument("<server>", "Server ID or name")
		.description("Create or update an alert configuration")
		.option(
			"-m, --metric <metric>",
			`Metric: ${ALERT_METRICS.join(", ")}`,
		)
		.option(
			"-t, --threshold <n>",
			"Threshold: percent (0-100) for cpu and memory, MB/s for disk_read, disk_write, network_in and network_out",
			"80",
		)
		.option(
			"--comparison <op>",
			"Trigger when the value is gt, lt, gte or lte the threshold",
			"gt",
		)
		.option(
			"--duration <minutes>",
			"Minutes the condition must hold before the alert fires (1-60)",
			"5",
		)
		.option("--disable", "Disable the alert")
		.action(async (serverIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				if (options.metric === "memory") {
					throw new InvalidArgumentError(
						"Memory usage is not collected on cloud servers, so a memory alert can never fire. Check memory over SSH with `free -m`.",
					);
				}
				if (options.metric && !ALERT_METRICS.includes(options.metric)) {
					throw new InvalidArgumentError(
						`Invalid metric "${options.metric}". Must be one of: ${ALERT_METRICS.join(", ")}.`,
					);
				}
				const comparisonOp = String(options.comparison).toLowerCase();
				if (!(comparisonOp in COMPARISON_SYMBOLS)) {
					throw new InvalidArgumentError(
						`Invalid comparison "${options.comparison}". Must be one of: ${Object.keys(COMPARISON_SYMBOLS).join(", ")}.`,
					);
				}
				const durationMinutes = Number(options.duration);
				if (
					!Number.isInteger(durationMinutes) ||
					durationMinutes < 1 ||
					durationMinutes > 60
				) {
					throw new InvalidArgumentError(
						`Invalid duration "${options.duration}". Must be a whole number of minutes from 1 to 60.`,
					);
				}
				const threshold = Number(options.threshold);
				if (
					String(options.threshold).trim() === "" ||
					!Number.isFinite(threshold) ||
					threshold < 0
				) {
					throw new InvalidArgumentError(
						`Invalid threshold "${options.threshold}". Must be a number of 0 or more.`,
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(asServerList(serverList), serverIdentifier);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}
				succeedSpinner();

				// Metric must be one of the server's metricType enum values
				// (cpu | disk_read | disk_write | network_in | network_out). Memory
				// is not collected on cloud servers, so the platform refuses it.
				let metric: string = options.metric;
				if (!metric) {
					metric = await select(
						"Alert metric:",
						[
							{ name: "CPU usage (%)", value: "cpu" },
							{ name: "Disk read (MB/s)", value: "disk_read" },
							{ name: "Disk write (MB/s)", value: "disk_write" },
							{ name: "Network in (MB/s)", value: "network_in" },
							{ name: "Network out (MB/s)", value: "network_out" },
						],
						{ field: "alert_metric", flag: "--metric" },
					);
				}

				if (PERCENT_METRICS.has(metric) && threshold > 100) {
					throw new InvalidArgumentError(
						`Invalid threshold "${options.threshold}" for ${metric}: it is a percentage from 0 to 100.`,
					);
				}

				// cpu/memory are stored in percent, disk/network in BYTES per
				// second. The flag takes MB/s for those, so convert here.
				const thresholdValue = alertThresholdToApi(metric, threshold);
				const enabled = !options.disable;

				const _setSpinner = startSpinner("Saving alert...");

				await client.virtualMachine.upsertAlertConfig.mutate({
					serverId: server.id || server.serverId,
					metricType: metric,
					thresholdValue,
					comparisonOp,
					durationMinutes,
					enabled,
				});

				succeedSpinner("Alert saved!");

				const unit = PERCENT_METRICS.has(metric) ? "percent" : "MB/s";
				if (isJsonMode()) {
					outputData({
						saved: true,
						metric,
						threshold,
						thresholdUnit: unit,
						thresholdValue,
						comparisonOp,
						durationMinutes,
						enabled,
					});
				} else {
					log("");
					log(
						colors.success(
							`Alert saved: ${metric} ${COMPARISON_SYMBOLS[comparisonOp]} ${formatAlertThreshold(metric, thresholdValue)} for ${durationMinutes} min${enabled ? "" : " (disabled)"}.`,
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	alerts
		.command("delete")
		.argument("<server>", "Server ID or name")
		.argument("<metric>", "Metric alert to delete")
		.description("Delete an alert configuration")
		.action(async (serverIdentifier, metric) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");

				const serverList = await client.virtualMachine.list.query();
				const server = findServer(
					Array.isArray(serverList)
						? serverList
						: (serverList as any)?.servers || [],
					serverIdentifier,
				);

				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", serverIdentifier);
				}

				// deleteAlertConfig takes { alertId }; there is no delete-by-metric
				// path. Resolve the alert's id from the server's configs first.
				const alertConfigs = await client.virtualMachine.listAlertConfigs.query({
					serverId: server.id || server.serverId,
				} as any);
				const alertItems = Array.isArray(alertConfigs) ? alertConfigs : [];
				const alert = alertItems.find(
					(a: any) => (a.metricType || a.metric) === metric,
				);
				if (!alert?.id) {
					failSpinner();
					throw new CliError(
						`No alert configured for metric "${metric}" on this server.`,
					);
				}

				const _deleteSpinner = startSpinner("Deleting alert...");

				await client.virtualMachine.deleteAlertConfig.mutate({
					alertId: alert.id,
				} as any);

				succeedSpinner("Alert deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, metric, alertId: alert.id });
				} else {
					quietOutput(String(alert.id));
				}
			} catch (err) {
				handleError(err);
			}
		});

	// ── Firing alerts (machineAlert.*) ───────────────────────────────────────

	const incidents = servers
		.command("incidents")
		.description(
			"Work the alerts your servers have already raised: list them, acknowledge one you are investigating, resolve one you have fixed, or mute one while you work on it. These are fired alerts, raised by Tarout's own monitoring - you never create one. To change the CPU, disk or network thresholds that decide when an alert fires, use `tarout servers alerts`.",
		)
		.addHelpText(
			"after",
			"\nAn incident is attached to either a rented cloud server or a dedicated runtime host, and is listed for the whole organization rather than one server. Threshold rules live under `tarout servers alerts`; this group never changes them.",
		);

	incidents
		.command("list")
		.alias("ls")
		.description(
			"List the alerts raised for this organization's servers, unresolved states first and the most recently seen first within a state. Covers both rented cloud servers and dedicated runtime hosts, so an empty list means nothing is firing anywhere.",
		)
		.option(
			"-s, --status <status>",
			`Only alerts in this state: ${INCIDENT_STATUSES.join(", ")}`,
		)
		.option(
			"--severity <severity>",
			`Only alerts at this severity: ${INCIDENT_SEVERITIES.join(", ")}`,
		)
		.option(
			"--server <server>",
			"Only alerts raised for this cloud server (ID or name)",
		)
		.option(
			"--limit <n>",
			`How many alerts to return, ${INCIDENT_LIMIT_MIN}-${INCIDENT_LIMIT_MAX} (default ${INCIDENT_LIMIT_DEFAULT}); a larger number is clamped to ${INCIDENT_LIMIT_MAX} instead of failing`,
		)
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				// Validated before the first request: a bad --severity must fail
				// without having asked the platform anything.
				const filters = incidentListInput({
					status: options.status,
					severity: options.severity,
					limit: options.limit,
				});
				const _spinner = startSpinner("Fetching server alerts...");
				if (options.server) {
					const server = await resolveServerIncludingTerminated(
						client,
						options.server,
					);
					filters.serverId = server.id || server.serverId;
				}
				const alerts = await client.machineAlert.list.query(filters);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(alerts);
					return;
				}
				const rows = incidentRows(alerts);
				if (isQuietMode()) {
					for (const row of rows) quietOutput(row.id);
					return;
				}
				if (rows.length === 0) {
					log("");
					log("No server alerts match. Nothing is firing.");
					log("");
					log(
						colors.dim(
							"Thresholds are configured with: tarout servers alerts list <server>",
						),
					);
					log("");
					return;
				}
				log("");
				table(
					["ID", "SEVERITY", "STATUS", "TARGET", "TITLE", "LAST SEEN"],
					rows.map((row) => [
						colors.cyan(row.id),
						formatIncidentSeverity(row.severity),
						formatIncidentStatus(row.status),
						row.target,
						row.title,
						formatTimestamp(row.lastSeenAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${rows.length} alert${rows.length === 1 ? "" : "s"}. Acknowledge one with: tarout servers incidents ack <id>`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	incidents
		.command("summary")
		.description(
			"Count this organization's server alerts by severity and state - the one-call health check to run before anything else. Open alerts are broken down per severity; acknowledged and muted are reported as totals.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Summarizing server alerts...");
				const summary = await client.machineAlert.summary.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(summary);
					return;
				}
				const s = (summary ?? {}) as {
					open?: Record<string, number>;
					acknowledged?: number;
					muted?: number;
				};
				const open = openIncidentTotal(summary);
				quietOutput(String(open));
				log("");
				log(colors.bold("Server alerts"));
				log(`  Open:         ${open === 0 ? colors.success("0") : String(open)}`);
				for (const severity of INCIDENT_SEVERITIES) {
					const count = Number(s.open?.[severity] ?? 0);
					if (count > 0) {
						log(`    ${formatIncidentSeverity(severity)}: ${count}`);
					}
				}
				log(`  Acknowledged: ${Number(s.acknowledged ?? 0)}`);
				log(`  Muted:        ${Number(s.muted ?? 0)}`);
				log("");
				if (open > 0) {
					log(
						colors.dim("See them with: tarout servers incidents list --status open"),
					);
					log("");
				}
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	incidents
		.command("ack")
		.alias("acknowledge")
		.argument("<id>", "Alert ID, as printed by `tarout servers incidents list`")
		.description(
			"Acknowledge a firing alert: record that a human has seen it and is dealing with it, without claiming it is fixed. The alert stays on the list in the acknowledged state until someone resolves it, so acknowledging silences nothing.",
		)
		.action(async (id: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Acknowledging the alert...");
				const alert = await client.machineAlert.acknowledge.mutate({ id });
				succeedSpinner("Alert acknowledged.");
				if (isJsonMode()) {
					outputData(alert);
					return;
				}
				quietOutput(String((alert as any)?.id ?? id));
				logIncidentDetail(alert);
				log(
					colors.dim(
						`Resolve it once it is fixed with: tarout servers incidents resolve ${id}`,
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	incidents
		.command("resolve")
		.argument("<id>", "Alert ID, as printed by `tarout servers incidents list`")
		.description(
			"Mark a firing alert resolved because the underlying problem is fixed. This only closes the alert record: if the condition is still true, Tarout's monitoring raises it again on its next check, which is the signal that the fix did not hold.",
		)
		.action(async (id: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Resolving the alert...");
				const alert = await client.machineAlert.resolve.mutate({ id });
				succeedSpinner("Alert resolved.");
				if (isJsonMode()) {
					outputData(alert);
					return;
				}
				quietOutput(String((alert as any)?.id ?? id));
				logIncidentDetail(alert);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	incidents
		.command("mute")
		.argument("<id>", "Alert ID, as printed by `tarout servers incidents list`")
		.description(
			"Mute a firing alert for a set number of minutes so a known-noisy condition stops being reported while you work on it. Only an organization owner may mute, and a mute hides a real problem: the alert returns the moment the window expires.",
		)
		.option(
			"--minutes <minutes>",
			`How long to mute for, ${MUTE_MINUTES_MIN}-${MUTE_MINUTES_MAX} minutes (${MUTE_MINUTES_MAX / 60 / 24} days)`,
			String(MUTE_MINUTES_DEFAULT),
		)
		.action(async (id: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const minutes = muteMinutes(options.minutes);
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Mute alert "${id}" for ${describeMuteWindow(minutes)}? It stops being reported until the window expires, even if the problem gets worse.`,
						false,
						{
							field: "confirm_mute_incident",
							flag: "--yes",
							context: { id, minutes },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Muting the alert...");
				const alert = await client.machineAlert.mute.mutate({ id, minutes });
				succeedSpinner(`Alert muted for ${describeMuteWindow(minutes)}.`);
				if (isJsonMode()) {
					outputData(alert);
					return;
				}
				quietOutput(String((alert as any)?.id ?? id));
				logIncidentDetail(alert);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Installed software (serverSoftware.*) ────────────────────────────────

	const software = servers
		.command("software")
		.description(
			"Install and manage the self-hosted app platform that runs on a cloud server. Tarout rents you the VM; this installs a curated platform (Coolify or Dokploy) onto it over SSH, so you can deploy your own apps, databases and services on a machine you own outright.",
		)
		.addHelpText(
			"after",
			`\nInstallable: ${INSTALLABLE_SOFTWARE.join(", ")}. The target must be a running cloud server in Saudi Arabia - a Global GPU server cannot take an install - and only one software operation may run per server at a time. Every operation is asynchronous: the command returns as soon as the job is queued, then \`tarout servers software status\` reports ${SOFTWARE_RUN_STATES.join(" | ")} and \`tarout servers software logs\` shows the installer's own output. Pass --wait to block until the run finishes. A successful install also opens the platform's default ports in the server firewall.`,
		);

	software
		.command("list")
		.alias("ls")
		.description(
			"List every software platform tracked on a cloud server, whatever state it is in - installed, mid-install, failed or removed. A server with nothing installed returns an empty list rather than an error.",
		)
		.argument("<server>", "Server ID or name")
		.action(async (serverIdentifier: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching installed software...");
				const server = await resolveServerIncludingTerminated(
					client,
					serverIdentifier,
				);
				const installed = await client.serverSoftware.list.query({
					serverId: server.id || server.serverId,
				});
				succeedSpinner();
				if (isJsonMode()) {
					outputData(installed);
					return;
				}
				const rows = asArray(installed);
				if (isQuietMode()) {
					for (const row of rows) quietOutput(String(row.addonId ?? ""));
					return;
				}
				if (rows.length === 0) {
					log("");
					log(`No software is tracked on "${server.name || serverIdentifier}".`);
					log("");
					log(
						colors.dim(
							`Install one with: tarout servers software install ${server.name || serverIdentifier} ${INSTALLABLE_SOFTWARE[0]}`,
						),
					);
					log("");
					return;
				}
				log("");
				table(
					["SOFTWARE", "STATUS", "VERSION", "PORTS", "VIA", "UPDATED"],
					rows.map((row: any) => [
						softwareLabel(row.addonId),
						formatSoftwareStatus(row.status),
						row.installedVersion || row.pinnedRef || colors.dim("-"),
						asArray(row.ports).join(", ") || colors.dim("-"),
						row.installedVia || colors.dim("-"),
						formatTimestamp(row.updatedAt),
					]),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	software
		.command("install")
		.argument("<server>", "Server ID or name")
		.argument("<software>", `Software to install: ${INSTALLABLE_SOFTWARE.join(", ")}`)
		.description(
			"Install a curated app platform onto a running cloud server over SSH. The server must be running, must have enough RAM and disk for the platform, and must not already have another software operation in flight; the install itself then runs in the background and opens the platform's default ports on success.",
		)
		.option(
			"--wait",
			"Block until the install finishes instead of returning as soon as it is queued",
		)
		.action(async (serverIdentifier: string, softwareName: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const addon = resolveSoftwareAddonId(softwareName, { forInstall: true });
				const client = getApiClient();
				const _spinner = startSpinner(`Queueing the ${addon.name} install...`);
				const server = await resolveServerIncludingTerminated(
					client,
					serverIdentifier,
				);
				const serverId = server.id || server.serverId;
				let row = await client.serverSoftware.install.mutate(
					serverSoftwareInput(serverId, addon.id),
				);
				if (options.wait) {
					row = await waitForSoftwareRun(client, serverId, addon.id, "install");
				}
				succeedSpinner(
					options.wait
						? `${addon.name} install finished (${String((row as any)?.status ?? "unknown")}).`
						: `${addon.name} install queued.`,
				);
				if (isJsonMode()) {
					outputData(row);
					return;
				}
				quietOutput(String((row as any)?.status ?? "installing"));
				logSoftwareDetail(addon.name, server.name || serverIdentifier, row);
				logSoftwarePollHint(server.name || serverIdentifier, addon.id, options.wait);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	software
		.command("update")
		.argument("<server>", "Server ID or name")
		.argument("<software>", "Software already installed on the server")
		.description(
			"Re-run an installed platform's install script in place to pick up its latest release. The script is idempotent, so this is the supported upgrade path; the software must already be tracked on the server, and a retired platform may be updated even though it can no longer be freshly installed.",
		)
		.option(
			"--wait",
			"Block until the update finishes instead of returning as soon as it is queued",
		)
		.action(async (serverIdentifier: string, softwareName: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const addon = resolveSoftwareAddonId(softwareName);
				const client = getApiClient();
				const _spinner = startSpinner(`Queueing the ${addon.name} update...`);
				const server = await resolveServerIncludingTerminated(
					client,
					serverIdentifier,
				);
				const serverId = server.id || server.serverId;
				let row = await client.serverSoftware.update.mutate(
					serverSoftwareInput(serverId, addon.id),
				);
				if (options.wait) {
					row = await waitForSoftwareRun(client, serverId, addon.id, "update");
				}
				succeedSpinner(
					options.wait
						? `${addon.name} update finished (${String((row as any)?.status ?? "unknown")}).`
						: `${addon.name} update queued.`,
				);
				if (isJsonMode()) {
					outputData(row);
					return;
				}
				quietOutput(String((row as any)?.status ?? "installing"));
				logSoftwareDetail(addon.name, server.name || serverIdentifier, row);
				logSoftwarePollHint(server.name || serverIdentifier, addon.id, options.wait);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	software
		.command("uninstall")
		.argument("<server>", "Server ID or name")
		.argument("<software>", "Software already installed on the server")
		.description(
			"Remove an installed platform from a cloud server using its curated teardown script, and retract the firewall rule the install opened. Everything the platform was running on that server - its apps, its databases and their data - goes with it, and the server itself is left untouched and still billing.",
		)
		.option(
			"--wait",
			"Block until the removal finishes instead of returning as soon as it is queued",
		)
		.action(async (serverIdentifier: string, softwareName: string, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const addon = resolveSoftwareAddonId(softwareName);
				const client = getApiClient();
				const _findSpinner = startSpinner("Finding server...");
				const server = await resolveServerIncludingTerminated(
					client,
					serverIdentifier,
				);
				const serverId = server.id || server.serverId;
				const label = server.name || serverIdentifier;
				succeedSpinner();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Uninstall ${addon.name} from server "${label}"? This permanently deletes everything it was running there, including any databases and their data.`,
						false,
						{
							field: "confirm_uninstall_server_software",
							flag: "--yes",
							context: { server: label, software: addon.id },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const _spinner = startSpinner(`Queueing the ${addon.name} removal...`);
				let row = await client.serverSoftware.uninstall.mutate(
					serverSoftwareInput(serverId, addon.id),
				);
				if (options.wait) {
					row = await waitForSoftwareRun(client, serverId, addon.id, "uninstall");
				}
				succeedSpinner(
					options.wait
						? `${addon.name} removal finished (${String((row as any)?.status ?? "unknown")}).`
						: `${addon.name} removal queued.`,
				);
				if (isJsonMode()) {
					outputData(row);
					return;
				}
				quietOutput(String((row as any)?.status ?? "installing"));
				logSoftwareDetail(addon.name, label, row);
				logSoftwarePollHint(label, addon.id, options.wait);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	software
		.command("status")
		.argument("<server>", "Server ID or name")
		.argument("<software>", "Software tracked on the server")
		.description(
			`Show where one platform stands on a cloud server: ${SOFTWARE_RUN_STATES.join(" | ")}, the version it reported, and the ports it listens on. This is the poll target after an install, update or removal; a platform the server has never been asked to install is reported as not tracked.`,
		)
		.action(async (serverIdentifier: string, softwareName: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const addon = resolveSoftwareAddonId(softwareName);
				const client = getApiClient();
				const _spinner = startSpinner(`Checking ${addon.name}...`);
				const server = await resolveServerIncludingTerminated(
					client,
					serverIdentifier,
				);
				const row = await client.serverSoftware.status.query(
					serverSoftwareInput(server.id || server.serverId, addon.id),
				);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(row);
					return;
				}
				quietOutput(String((row as any)?.status ?? "unknown"));
				logSoftwareDetail(addon.name, server.name || serverIdentifier, row);
				logSoftwarePollHint(server.name || serverIdentifier, addon.id, true);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	software
		.command("logs")
		.argument("<server>", "Server ID or name")
		.argument("<software>", "Software tracked on the server")
		.description(
			"Print the installer's captured output for one platform on a cloud server. This is what a failed install left behind - the script's own stdout and stderr, capped at the most recent output - and it is the first thing to read when a status comes back failed.",
		)
		.action(async (serverIdentifier: string, softwareName: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const addon = resolveSoftwareAddonId(softwareName);
				const client = getApiClient();
				const _spinner = startSpinner(`Fetching ${addon.name} logs...`);
				const server = await resolveServerIncludingTerminated(
					client,
					serverIdentifier,
				);
				const row = await client.serverSoftware.logs.query(
					serverSoftwareInput(server.id || server.serverId, addon.id),
				);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(row);
					return;
				}
				const r = (row ?? {}) as { status?: string; logs?: string | null };
				quietOutput(String(r.status ?? "unknown"));
				log("");
				log(
					`${colors.bold(addon.name)} on ${server.name || serverIdentifier}: ${formatSoftwareStatus(r.status)}`,
				);
				log("");
				if (!r.logs) {
					log(colors.dim("No output captured yet."));
					log("");
					return;
				}
				log(r.logs);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	// ── Missing VM procedures ─────────────────────────────────────────────────

	servers
		.command("terminate")
		.argument("<server>", "Server ID or name")
		.description("Permanently terminate a cloud server (irreversible)")
		.option("--keep-volumes", "Keep the server's volumes (they keep billing)")
		.option(
			"--keep-snapshots",
			"Keep the server's snapshots (they keep billing)",
		)
		.option("--keep-ips", "Keep the server's reserved IPs (they keep billing)")
		.action(async (identifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const keep = keepChoiceFromOptions(options);
				const _spinner = startSpinner("Finding server...");
				const list = await client.virtualMachine.list.query({});
				const server = findServer(asServerList(list), identifier);
				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", identifier);
				}
				succeedSpinner();
				const serverId = String(server.id || server.serverId);
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirmTermination(
						client,
						serverId,
						server.name || identifier,
						keep,
						"terminate",
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const _termSpinner = startSpinner("Terminating server...");
				// Volumes, snapshots and reserved IPs are deleted with the server
				// unless kept. Send all three so the request says exactly what
				// the user chose.
				await client.virtualMachine.terminate.mutate(
					terminateInput(serverId, keep),
				);
				succeedSpinner("Server terminated!");
				if (isJsonMode()) {
					outputData({
						terminated: true,
						id: serverId,
						kept: {
							volumes: keep.keepVolumes,
							snapshots: keep.keepSnapshots,
							reservedIps: keep.keepIps,
						},
					});
				} else {
					quietOutput(serverId);
					logKeptStorageHint(keep);
				}
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("resize-volume")
		.argument("<server>", "Server ID or name")
		.argument("<volume-id>", "Volume ID")
		.argument("<size-gb>", "New size in GB", Number.parseInt)
		.description("Resize a server volume")
		.action(async (identifier, volumeId, sizeGb) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");
				const list = await client.virtualMachine.list.query({});
				const server = findServer(
					Array.isArray(list) ? list : (list as any)?.items || [],
					identifier,
				);
				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", identifier);
				}
				const _resSpinner = startSpinner("Resizing volume...");
				// resizeVolume input is { volumeId, newSizeGb }, with no serverId.
				const result = await client.virtualMachine.resizeVolume.mutate({
					volumeId,
					newSizeGb: sizeGb,
				} as any);
				succeedSpinner("Volume resized!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("ssh-session")
		.argument("<server>", "Server ID or name")
		.description("Create an SSH session token for a server")
		.action(async (identifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding server...");
				const list = await client.virtualMachine.list.query({});
				const server = findServer(
					Array.isArray(list) ? list : (list as any)?.items || [],
					identifier,
				);
				if (!server) {
					failSpinner();
					throw new NotFoundError("Server", identifier);
				}
				const _sshSpinner = startSpinner("Creating SSH session...");
				const result = await client.virtualMachine.createSshSession.mutate({
					serverId: server.id || server.serverId,
				} as any);
				succeedSpinner("SSH session created!");
				if (isJsonMode()) outputData(result);
				else {
					// createSshSession returns { token, ipAddress }.
					const r = result as any;
					log("");
					log(colors.bold("SSH Session"));
					log(`  IP Address: ${colors.cyan(r.ipAddress || "-")}`);
					if (r.token) log(`  Token: ${colors.dim(r.token)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("cancel-vm-subscription")
		.argument("[server]", "Server ID or name")
		.description(
			"No longer applies: cloud servers are billed hourly and have no subscription",
		)
		.action(() => {
			// Monthly and yearly servers are gone; every server is billed hourly
			// from the Compute Wallet, and the platform endpoint always fails.
			// Keep the command so old scripts get a clear answer, not a crash.
			handleError(
				new CliError(
					"Cloud servers are billed hourly from your Compute Wallet and have no subscription to cancel. To stop paying for a server, terminate it with `tarout servers terminate <server>`.",
				),
			);
		});

	servers
		.command("os-images")
		.description("List the operating systems new servers can use")
		// There is no provider choice for OS images. The flag used to be
		// documented (wrongly, as "hetzner, runpod"); it is still accepted and
		// ignored so old scripts keep working.
		.addOption(new Option("--provider <provider>").hideHelp())
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching OS images...");
				// getOSImages takes no input: every server runs on the same
				// images, so there is no provider to pick.
				const images = await client.virtualMachine.getOSImages.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(images);
					return;
				}
				const list = asArray(
					Array.isArray(images) ? images : (images as any)?.images,
				);
				if (isQuietMode()) {
					for (const i of list) if (i?.id) quietOutput(String(i.id));
					return;
				}
				if (!list.length) {
					log("\nNo OS images found.\n");
					return;
				}
				log("");
				table(
					["ID", "NAME", "DESCRIPTION"],
					list.map((i: any) => [
						colors.cyan(String(i.id || "-")),
						i.name || "-",
						i.description || "-",
					]),
				);
				log("");
				log(colors.dim("Use the ID with: tarout servers create --os <id>"));
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Global GPU images and availability. The old `runpod-*` names stay as
	// hidden aliases so scripts written against them keep working; the
	// upstream GPU supplier is never named to customers.
	const listGpuImages = async () => {
		try {
			if (!isLoggedIn()) throw new AuthError();
			const client = getApiClient();
			const _spinner = startSpinner("Fetching Global GPU images...");
			const images = await client.virtualMachine.getGpuDockerImages.query();
			succeedSpinner();
			if (isJsonMode()) {
				outputData(images);
				return;
			}
			const list = Array.isArray(images)
				? images
				: (images as any)?.images || [];
			if (!list.length) {
				log("\nNo Global GPU images found.\n");
				return;
			}
			log("");
			table(
				["ID", "NAME", "DESCRIPTION"],
				list.map((i: any) => [i.id || "-", i.name || "-", i.description || ""]),
			);
			log("");
		} catch (err) {
			handleError(err);
		}
	};

	const checkGpuAvailability = async () => {
		try {
			if (!isLoggedIn()) throw new AuthError();
			const client = getApiClient();
			const _spinner = startSpinner("Checking Global GPU availability...");
			const result = await client.virtualMachine.isGlobalGpuAvailable.query();
			succeedSpinner();
			if (isJsonMode()) {
				outputData(result);
				return;
			}
			const available = (result as any)?.available ?? result;
			log(
				`\nGlobal GPU: ${available ? colors.success("available") : colors.error("unavailable")}\n`,
			);
		} catch (err) {
			handleError(err);
		}
	};

	servers
		.command("gpu-images")
		.description("List available Global GPU server images")
		.action(listGpuImages);
	servers.command("runpod-images", { hidden: true }).action(listGpuImages);

	servers
		.command("gpu-available")
		.description("Check whether Global GPU servers can be rented")
		.action(checkGpuAvailability);
	servers.command("runpod-available", { hidden: true }).action(checkGpuAvailability);

	servers
		.command("gpu-catalog")
		.description(
			"List the GPU cards rentable in the Global region, with the exact size ID and hourly price to pass to `tarout servers create`. One offer per card family and GPU count; an offer marked unavailable has no supplier with capacity right now, so creating it would fail.",
		)
		.option("--family <family>", "Only this GPU family (for example a100, h100, l4)")
		.option("--available", "Only offers that can be launched right now")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching the Global GPU catalog...");
				const catalog = await client.virtualMachine.getGlobalGpuCatalog.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(catalog);
					return;
				}
				const rows = gpuCatalogRows(catalog, {
					family: options.family,
					availableOnly: Boolean(options.available),
				});
				if (isQuietMode()) {
					for (const row of rows) quietOutput(row.sizeId);
					return;
				}
				if (rows.length === 0) {
					log("");
					log(
						options.family || options.available
							? "No GPU offers match."
							: "No GPU offers are listed. GPU rentals are not open on this account.",
					);
					log("");
					return;
				}
				log("");
				table(
					["FAMILY", "GPUS", "SIZE", "PROVIDER", "VCPU", "RAM", "DISK", "SAR/HR", "AVAILABLE"],
					rows.map((row) => [
						row.family,
						String(row.count),
						colors.cyan(row.sizeId),
						row.provider,
						String(row.vcpus),
						`${row.memoryGb} GB`,
						`${row.diskSizeGb} GB`,
						row.hourlySar,
						row.available ? colors.success("yes") : colors.error("no"),
					]),
				);
				log("");
				const providers = asArray((catalog as any)?.providers)
					.map(displayProvider)
					.join(", ");
				if (providers) log(colors.dim(`Providers configured: ${providers}`));
				log(
					colors.dim(
						"Rent one with: tarout servers create <name> --type gpu --provider <PROVIDER> --size <SIZE>",
					),
				);
				log("");
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	servers
		.command("check-quota")
		.description("Check how many servers the organization can still create")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking quota...");
				const quota = await client.virtualMachine.checkQuota.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(quota);
					return;
				}
				// { canCreate, current: { total, cpu, gpu }, limit: { total, cpu, gpu }, message? }
				const q = (quota ?? {}) as any;
				const used = (key: string) =>
					`${q.current?.[key] ?? "-"} / ${q.limit?.[key] ?? "-"}`;
				quietOutput(q.canCreate ? "yes" : "no");
				log("");
				log(colors.bold("Server quota"));
				log(`  All servers:  ${used("total")}`);
				log(`  CPU servers:  ${used("cpu")}`);
				log(`  GPU servers:  ${used("gpu")}`);
				log(
					`  Can create:   ${q.canCreate ? colors.success("yes") : colors.error("no")}`,
				);
				if (!q.canCreate && q.message) log(`  ${colors.warn(String(q.message))}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("kept-storage")
		.alias("kept")
		.description(
			"List volumes, snapshots and reserved IPs kept after their server was terminated (they keep billing)",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching kept storage...");
				const retained = await client.virtualMachine.listRetainedStorage.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(retained);
					return;
				}
				const rows = retainedStorageRows(retained);
				if (isQuietMode()) {
					for (const row of rows) quietOutput(row.id);
					return;
				}
				if (rows.length === 0) {
					log("");
					log("No kept storage. Nothing is billing without a server.");
					log("");
					return;
				}
				log("");
				table(
					["KIND", "ID", "NAME", "SIZE / IP", "FROM SERVER"],
					rows.map((row) => [
						row.kind,
						colors.cyan(row.id),
						row.name,
						row.detail,
						row.server,
					]),
				);
				log("");
				log(
					colors.warn(
						"These keep billing until you delete them. Remove them with:",
					),
				);
				log(`  ${colors.dim("tarout servers volumes delete <id>")}`);
				log(`  ${colors.dim("tarout servers snapshots delete <id>")}`);
				log(`  ${colors.dim("tarout servers ips release <id>")}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── Coolify / Dedicated server management (server.*) ─────────────────────

	const pool = servers
		.command("pool")
		.description("Manage Coolify server pools (shared/dedicated)");

	pool
		.command("list")
		.alias("ls")
		.description("List all managed Coolify servers")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching server pool...");
				const list = await client.server.list.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(list);
					return;
				}
				// server.list returns { dedicatedServers: [...], sharedPool: {...} }.
				const items = Array.isArray(list)
					? list
					: (list as any)?.dedicatedServers || [];
				if (!items.length) {
					log("\nNo managed servers found.\n");
					return;
				}
				log("");
				table(
					["ID", "TYPE", "STATUS", "APPS"],
					items.map((s: any) => [
						colors.cyan((s.id || s.coolifyServerId || "").slice(0, 8)),
						s.serverType || s.type || "-",
						s.status || "-",
						String(s.applicationCount ?? "-"),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("get")
		.argument("<id>", "Server ID")
		.description("Get details of a managed server")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching server...");
				const s = await client.server.getById.query({ serverId: id } as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(s);
					return;
				}
				const sv = s as any;
				quietOutput(String(sv.id || sv.coolifyServerId || id));
				log("");
				log(colors.bold(sv.name || `Server ${id}`));
				log(`  Type:   ${sv.serverType || "-"}`);
				log(`  Status: ${sv.status || "-"}`);
				log(
					`  Apps:   ${sv.applicationCount ?? "-"} / ${sv.maxApplications ?? "-"}`,
				);
				log(`  IP:     ${sv.ipAddress || "-"}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("health")
		.argument("<id>", "Server ID")
		.description("Check health of a managed server")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking health...");
				const health = await client.server.getHealth.query({
					serverId: id,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(health);
					return;
				}
				const h = health as any;
				log("");
				log(colors.bold("Server Health"));
				log(
					`  Status:  ${h.healthy ? colors.success("healthy") : colors.error("unhealthy")}`,
				);
				log(`  CPU:     ${h.cpu ?? "-"}%`);
				log(`  Memory:  ${h.memory ?? "-"}%`);
				log(`  Disk:    ${h.disk ?? "-"}%`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("sizes")
		.description("List available dedicated server sizes")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching sizes...");
				const sizes = await client.server.getAvailableSizes.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(sizes);
					return;
				}
				const list = Array.isArray(sizes) ? sizes : (sizes as any)?.sizes || [];
				if (!list.length) {
					log("\nNo sizes available.\n");
					return;
				}
				log("");
				// getAvailableSizes returns
				// { size, machineType, maxApplications, maxDatabases, diskSizeGb }.
				table(
					["SIZE", "MACHINE TYPE", "MAX APPS", "MAX DBS", "DISK"],
					list.map((s: any) => [
						colors.cyan(s.size || "-"),
						s.machineType || "-",
						String(s.maxApplications ?? "-"),
						String(s.maxDatabases ?? "-"),
						s.diskSizeGb ? `${s.diskSizeGb} GB` : "-",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("provision")
		.description("Provision a new dedicated Coolify server")
		.option("--size <size>", "Server size: SMALL, MEDIUM, or LARGE")
		.option("--region <region>", "Region")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				let sizeInput = options.size;
				if (!sizeInput) {
					sizeInput = await select(
						"Server size:",
						[
							{ name: "Small", value: "SMALL" },
							{ name: "Medium", value: "MEDIUM" },
							{ name: "Large", value: "LARGE" },
						],
						{ field: "server_size", flag: "--size" },
					);
				}
				// provisionDedicated input is { size: enum SMALL/MEDIUM/LARGE, region? }.
				const size = normalizeDedicatedSize(sizeInput);
				const region =
					options.region ||
					(await input("Region:", undefined, {
						field: "region",
						flag: "--region",
					}));
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Provision a dedicated server (${size} in ${region})?`,
						false,
						{
							field: "confirm_provision_dedicated",
							flag: "--yes",
							context: { size, region },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Provisioning dedicated server...");
				const result = await client.server.provisionDedicated.mutate({
					size,
					region,
				} as any);
				succeedSpinner("Dedicated server provisioning started!");
				if (isJsonMode()) outputData(result);
				else {
					box("Server Provisioning", [
						`Size: ${colors.cyan(size)}`,
						`Region: ${region}`,
						`Status: ${colors.warn("provisioning...")}`,
					]);
				}
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("retry-provisioning")
		.alias("retry-provision")
		.description(
			"Re-queue the dedicated host for the active project after its provisioning failed, sizing it from the project's dedicated plan. Also recovers the case where no host row exists at all - a project that pays for a dedicated plan but has nothing provisioning, which otherwise leaves every app create failing with no dedicated host. Refused if the plan is not a dedicated one in good standing, or if a host is already provisioning or active.",
		)
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Re-queueing the dedicated host...");
				const result =
					await client.server.retryDedicatedProvisioning.mutate();
				succeedSpinner("Dedicated host provisioning re-queued.");
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				quietOutput(String((result as any)?.status ?? "queued"));
				box("Dedicated Host", [
					`Status: ${colors.warn(String((result as any)?.status ?? "queued"))}`,
					"Provisioning takes a few minutes.",
					`Watch it with: ${colors.dim("tarout servers pool list")}`,
				]);
			} catch (err) {
				stopSpinner();
				handleError(err);
			}
		});

	pool
		.command("decommission")
		.argument("<id>", "Server ID to decommission")
		.description("Decommission a dedicated server")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Decommission server "${id}"? Apps will be migrated first.`,
						false,
						{
							field: "confirm_decommission_server",
							flag: "--yes",
							context: { id },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Decommissioning server...");
				await client.server.decommission.mutate({ serverId: id } as any);
				succeedSpinner("Server decommissioning started!");
				if (isJsonMode()) outputData({ decommissioning: true, id });
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("upgrade")
		.argument("<id>", "Server ID")
		.option("--size <size>", "New size: SMALL, MEDIUM, or LARGE")
		.description("Upgrade a dedicated server to a larger size")
		.action(async (id, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const sizeInput =
					options.size ||
					(await input("New size (SMALL/MEDIUM/LARGE):", undefined, {
						field: "new_size",
						flag: "--size",
					}));
				// upgradeServer input is { serverId, newSize: enum SMALL/MEDIUM/LARGE }.
				const newSize = normalizeDedicatedSize(sizeInput);
				const client = getApiClient();
				const _spinner = startSpinner("Starting upgrade...");
				const result = await client.server.upgradeServer.mutate({
					serverId: id,
					newSize,
				} as any);
				succeedSpinner("Server upgrade initiated!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("blue-green-upgrade")
		.argument("<id>", "Server ID")
		.option("--size <size>", "Target size: SMALL, MEDIUM, or LARGE")
		.description("Start a blue/green server upgrade (zero-downtime)")
		.action(async (id, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const sizeInput =
					options.size ||
					(await input("Target size (SMALL/MEDIUM/LARGE):", undefined, {
						field: "target_size",
						flag: "--size",
					}));
				// upgradeBlueGreen input is { serverId, newSize: enum }.
				const newSize = normalizeDedicatedSize(sizeInput);
				const client = getApiClient();
				const _spinner = startSpinner("Starting blue/green upgrade...");
				const result = await client.server.upgradeBlueGreen.mutate({
					serverId: id,
					newSize,
				} as any);
				succeedSpinner("Blue/green upgrade started!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("blue-green-status")
		.argument("<id>", "Server ID")
		.description("Get blue/green upgrade status")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching upgrade status...");
				const status = await client.server.getBlueGreenStatus.query({
					blueServerId: id,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(status);
					return;
				}
				const s = status as any;
				log("");
				log(colors.bold("Blue/Green Upgrade Status"));
				log(`  Phase:   ${s.phase || "-"}`);
				log(`  Green:   ${s.greenStatus || "-"}`);
				log(`  Traffic: ${s.trafficSplit || "-"}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("complete-cutover")
		.argument("<id>", "Server ID")
		.description(
			"Complete the blue/green cutover (switch 100% traffic to new server)",
		)
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Complete cutover for server "${id}"?`,
						false,
						{
							field: "confirm_complete_cutover",
							flag: "--yes",
							context: { id },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Completing cutover...");
				await client.server.completeCutover.mutate({ blueServerId: id } as any);
				succeedSpinner("Cutover complete!");
				if (isJsonMode()) outputData({ cutoverComplete: true });
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("rollback-cutover")
		.argument("<id>", "Server ID")
		.description("Rollback a blue/green cutover")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Rolling back cutover...");
				await client.server.rollbackCutover.mutate({ blueServerId: id } as any);
				succeedSpinner("Cutover rolled back!");
				if (isJsonMode()) outputData({ rolledBack: true });
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("cancel-blue-green")
		.argument("<id>", "Server ID")
		.description("Cancel an in-progress blue/green upgrade")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Cancelling blue/green upgrade...");
				await client.server.cancelBlueGreenUpgrade.mutate({
					blueServerId: id,
				} as any);
				succeedSpinner("Blue/green upgrade cancelled!");
				if (isJsonMode()) outputData({ cancelled: true });
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("migrate-to-dedicated")
		.argument("<id>", "Dedicated server ID to move shared apps onto")
		.description("Migrate apps from shared pool to your dedicated server")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						"Migrate all shared apps to your dedicated server?",
						false,
						{
							field: "confirm_migrate_to_dedicated",
							flag: "--yes",
							context: { id },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Starting migration...");
				// migrateSharedAppsToDedicated input is
				// { dedicatedServerId, applicationIds? }.
				const result = await client.server.migrateSharedAppsToDedicated.mutate({
					dedicatedServerId: id,
				} as any);
				succeedSpinner("Migration started!");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("complete-migration")
		.argument("<id>", "Dedicated server ID")
		.description("Complete the shared-to-dedicated migration")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Completing migration...");
				// completeSharedToDedicated input is { dedicatedServerId }.
				await client.server.completeSharedToDedicated.mutate({
					dedicatedServerId: id,
				} as any);
				succeedSpinner("Migration complete!");
				if (isJsonMode()) outputData({ migrationComplete: true });
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("rollback-migration")
		.argument("<id>", "Dedicated server ID")
		.description("Rollback a shared-to-dedicated migration")
		.action(async (id) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Rolling back migration...");
				// rollbackSharedToDedicated input is { dedicatedServerId }.
				await client.server.rollbackSharedToDedicated.mutate({
					dedicatedServerId: id,
				} as any);
				succeedSpinner("Migration rolled back!");
				if (isJsonMode()) outputData({ rolledBack: true });
			} catch (err) {
				handleError(err);
			}
		});

	pool
		.command("request-enterprise")
		.description("Request an enterprise server configuration")
		.option("-m, --message <message>", "Additional requirements or message")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const message =
					options.message ||
					(await input("Requirements / message (optional):", undefined, {
						field: "enterprise_message",
						flag: "--message",
					}));
				const client = getApiClient();
				const _spinner = startSpinner("Submitting enterprise request...");
				await client.server.requestEnterprise.mutate({ message } as any);
				succeedSpinner("Enterprise request submitted!");
				if (isJsonMode()) outputData({ submitted: true });
				else {
					log("");
					log(
						colors.success(
							"Enterprise request submitted. The Tarout team will reach out shortly.",
						),
					);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});
}

function findServer(servers: any[], identifier: string) {
	const lower = identifier.toLowerCase();
	return servers.find(
		(s: any) =>
			(s.id || s.serverId) === identifier ||
			(s.id || s.serverId || "").startsWith(identifier) ||
			(s.name || "").toLowerCase() === lower,
	);
}

function formatDate(date: Date | string | null | undefined): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(
		units.length - 1,
		Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))),
	);
	return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function formatRate(bytesPerSecond: number): string {
	return `${formatBytes(bytesPerSecond)}/s`;
}

function formatPercent(value: number): string {
	const text = `${value.toFixed(1)}%`;
	if (value >= 90) return colors.error(text);
	if (value >= 70) return colors.warn(text);
	return colors.success(text);
}

function formatVolumeStatus(status: string | undefined): string {
	if (!status) return colors.dim("-");
	if (status === "attached") return colors.success(status);
	if (status === "failed") return colors.error(status);
	return status;
}

// ── Cloud server constants (mirror the platform's input enums) ──────────────

const SERVER_TYPES: readonly string[] = ["cpu", "gpu"];
export const SERVER_OS_TYPES: readonly string[] = [
	"ubuntu-22",
	"ubuntu-24",
	"debian-12",
];
/**
 * The curated software catalog, mirroring SOFTWARE_ADDONS on the platform. The
 * `id` is what the API is sent and what is persisted, so it is reproduced
 * verbatim - including `taroutCore`'s camel case. A `hidden` entry is retired:
 * an existing install can still be listed, inspected, updated and removed, but
 * the platform refuses to install it on another server.
 *
 * `aliases` are lowercase spellings a user or an agent is likely to type,
 * including the legacy ids the platform's own normalizer still accepts.
 */
interface SoftwareAddonEntry {
	id: string;
	name: string;
	hidden?: boolean;
	aliases?: readonly string[];
}

const SOFTWARE_ADDONS: readonly SoftwareAddonEntry[] = [
	{ id: "coolify", name: "Coolify", aliases: ["tarout-app-platform"] },
	{ id: "dokploy", name: "Dokploy" },
	{
		id: "openship",
		name: "Tarout Core",
		hidden: true,
		aliases: ["tarout core", "tarout-core"],
	},
	{
		id: "taroutCore",
		name: "Tarout Managed",
		hidden: true,
		aliases: ["taroutcore", "tarout managed", "tarout-managed"],
	},
];

/** The software a NEW install may name; retired entries are excluded. */
export const INSTALLABLE_SOFTWARE: readonly string[] = SOFTWARE_ADDONS.filter(
	(addon) => !addon.hidden,
).map((addon) => addon.id);

/** `installed_software.status`, the whole lifecycle an install moves through. */
export const SOFTWARE_RUN_STATES: readonly string[] = [
	"installing",
	"installed",
	"failed",
	"removed",
];

/** How often and how long `--wait` polls `serverSoftware.status`. */
const SOFTWARE_RUN_POLL_MS = 5000;
const SOFTWARE_RUN_TIMEOUT_MS = 20 * 60 * 1000;

// `servers create --software` pre-installs at boot through a different field
// (`preInstalledSoftware`), but it reads the same catalog, so both paths offer
// exactly the same choices.
const PRE_INSTALLED_SOFTWARE: readonly string[] = INSTALLABLE_SOFTWARE;
const METRIC_RANGES: readonly string[] = ["1h", "6h", "24h", "7d", "30d"];
const VOLUME_DISK_TYPES: readonly string[] = ["balanced", "ssd", "standard"];
/** The only region cloud servers and reserved IPs run in (Dammam). */
const DEFAULT_IP_REGION = "me-central2";
/** Platform cap on snapshot, firewall rule and reserved IP names. */
const RESOURCE_NAME_MAX = 50;

const METRIC_SERIES: ReadonlyArray<{
	key: string;
	label: string;
	unit: "percent" | "rate";
}> = [
	{ key: "cpuUtilization", label: "CPU", unit: "percent" },
	{ key: "memoryUsage", label: "Memory", unit: "percent" },
	{ key: "diskReadBytes", label: "Disk read", unit: "rate" },
	{ key: "diskWriteBytes", label: "Disk write", unit: "rate" },
	{ key: "networkReceivedBytes", label: "Network in", unit: "rate" },
	{ key: "networkSentBytes", label: "Network out", unit: "rate" },
];

const ALERT_METRICS: readonly string[] = [
	"cpu",
	"disk_read",
	"disk_write",
	"network_in",
	"network_out",
];
/** Alert metrics whose threshold is a percentage; the rest are bytes/s. */
const PERCENT_METRICS: ReadonlySet<string> = new Set(["cpu", "memory"]);
const COMPARISON_SYMBOLS: Record<string, string> = {
	gt: ">",
	lt: "<",
	gte: ">=",
	lte: "<=",
};
const BYTES_PER_MB = 1024 * 1024;

function asArray(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function asServerList(value: unknown): any[] {
	if (Array.isArray(value)) return value;
	const wrapped = value as { servers?: unknown; items?: unknown } | null;
	return asArray(wrapped?.servers ?? wrapped?.items);
}

function describeServerSize(s: any): string {
	const id = String(s.id || s.name || s.size);
	const label = s.displayName ? ` (${s.displayName})` : "";
	const description = s.description ? `: ${s.description}` : "";
	const price =
		typeof s.pricePerHourSAR === "number"
			? ` ${s.pricePerHourSAR.toFixed(3)} SAR/hr`
			: s.priceHalalas
				? ` ${(s.priceHalalas / 100).toFixed(2)} SAR/hr`
				: "";
	return `${id}${label}${description}${price}`;
}

/**
 * Latest, average and peak of one `getMetrics` series (an array of
 * `{ timestamp, value }`). Returns null for an empty series so the caller can
 * say "no data yet" instead of printing zeros.
 */
export function summarizeMetricSeries(
	points: unknown,
): { latest: number; avg: number; max: number } | null {
	const valid = asArray(points)
		.map((p: any) => ({
			t: new Date(p?.timestamp).getTime(),
			v: p?.value == null ? Number.NaN : Number(p.value),
		}))
		.filter((p) => Number.isFinite(p.v));
	if (valid.length === 0) return null;
	const time = (t: number) => (Number.isFinite(t) ? t : 0);
	valid.sort((a, b) => time(a.t) - time(b.t));
	let sum = 0;
	let max = Number.NEGATIVE_INFINITY;
	for (const p of valid) {
		sum += p.v;
		if (p.v > max) max = p.v;
	}
	return {
		latest: valid[valid.length - 1].v,
		avg: sum / valid.length,
		max,
	};
}

function toResourceSlug(value: string): string {
	return String(value)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Default snapshot name: always at most 50 characters and only [a-z0-9-].
 * The old `<server>-snapshot-<ms>` went past the limit for long server names.
 */
export function defaultSnapshotName(
	serverName: string,
	now: number = Date.now(),
): string {
	const suffix = `-snapshot-${now.toString(36)}`;
	const base = toResourceSlug(serverName)
		.slice(0, RESOURCE_NAME_MAX - suffix.length)
		.replace(/-+$/, "");
	return `${base || "server"}${suffix}`;
}

/**
 * Default firewall rule name. Names are unique per server, so a fixed
 * "allow-port" failed on the second rule; this names what the rule opens.
 */
export function defaultFirewallRuleName(
	protocol: string,
	portRange: string | undefined,
	direction = "ingress",
): string {
	const proto = String(protocol || "tcp").toLowerCase();
	const parts = ["allow"];
	if (direction === "egress") parts.push("egress");
	parts.push(proto);
	if (proto !== "icmp" && portRange) parts.push(String(portRange));
	const name = toResourceSlug(parts.join("-"))
		.slice(0, RESOURCE_NAME_MAX)
		.replace(/-+$/, "");
	return name || "allow";
}

/**
 * Default reserved IP name. The provider address is named after it, so a
 * fixed default collided on every second reservation.
 */
export function defaultReservedIpName(
	region: string,
	now: number = Date.now(),
): string {
	const name = `ip-${toResourceSlug(region) || "ip"}-${now.toString(36)}`;
	return name.slice(0, RESOURCE_NAME_MAX).replace(/-+$/, "");
}

/**
 * Alert thresholds: cpu/memory are sent as a percentage; disk and network
 * are stored in bytes per second, and the CLI flag takes MB/s for them.
 */
export function alertThresholdToApi(metric: string, value: number): number {
	return PERCENT_METRICS.has(metric)
		? value
		: Math.round(value * BYTES_PER_MB);
}

/** Formats a stored alert threshold in the unit its metric uses. */
export function formatAlertThreshold(metric: string, apiValue: number): string {
	if (PERCENT_METRICS.has(metric)) return `${Number(apiValue.toFixed(2))}%`;
	const mb = apiValue / BYTES_PER_MB;
	if (apiValue > 0 && mb < 0.01) return formatRate(apiValue);
	return `${Number(mb.toFixed(2))} MB/s`;
}

// ── Firing alerts: `servers incidents` (machineAlert.*) ─────────────────────
//
// Distinct from the threshold rules above in every way that matters: these rows
// are created by the platform's monitoring, are listed for the whole
// organization rather than one server, and cover dedicated runtime hosts as
// well as rented VMs. Nothing here edits a threshold.

/** `machine_alert_status` on the platform. */
export const INCIDENT_STATUSES: readonly string[] = [
	"open",
	"acknowledged",
	"resolved",
	"muted",
];
/** `machine_alert_severity`, least to most urgent. */
export const INCIDENT_SEVERITIES: readonly string[] = [
	"info",
	"warning",
	"error",
	"critical",
];
const INCIDENT_LIMIT_MIN = 1;
const INCIDENT_LIMIT_MAX = 100;
const INCIDENT_LIMIT_DEFAULT = 50;

/** The platform's mute window, 15 minutes to 30 days. */
const MUTE_MINUTES_MIN = 15;
const MUTE_MINUTES_MAX = 60 * 24 * 30;
const MUTE_MINUTES_DEFAULT = 60;

export interface IncidentListInput {
	status?: string;
	severity?: string;
	serverId?: string;
	limit: number;
}

/**
 * `--limit` for the incident list. The platform's Zod schema rejects anything
 * outside 1-100 with a raw BAD_REQUEST, which reads as a server fault for what
 * is really "you asked for more than we page". A number past the cap means
 * "give me as many as you can", so clamp it; only a non-number is an error.
 */
export function clampIncidentLimit(value: string | number | undefined): number {
	if (value === undefined || value === null || value === "") {
		return INCIDENT_LIMIT_DEFAULT;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new InvalidArgumentError(
			`Invalid --limit "${value}". Must be a whole number between ${INCIDENT_LIMIT_MIN} and ${INCIDENT_LIMIT_MAX}.`,
		);
	}
	return Math.min(
		INCIDENT_LIMIT_MAX,
		Math.max(INCIDENT_LIMIT_MIN, Math.trunc(parsed)),
	);
}

/**
 * `machineAlert.list` input. Every filter is optional on the platform, and an
 * omitted key must stay omitted rather than being sent as undefined, so a
 * filter the user did not ask for can never narrow the result.
 */
export function incidentListInput(options: {
	status?: string;
	severity?: string;
	serverId?: string;
	limit?: string | number;
}): IncidentListInput {
	const status = options.status
		? String(options.status).trim().toLowerCase()
		: undefined;
	if (status && !INCIDENT_STATUSES.includes(status)) {
		throw new InvalidArgumentError(
			`Invalid alert status "${options.status}". Must be one of: ${INCIDENT_STATUSES.join(", ")}.`,
		);
	}
	const severity = options.severity
		? String(options.severity).trim().toLowerCase()
		: undefined;
	if (severity && !INCIDENT_SEVERITIES.includes(severity)) {
		throw new InvalidArgumentError(
			`Invalid alert severity "${options.severity}". Must be one of: ${INCIDENT_SEVERITIES.join(", ")}.`,
		);
	}
	return {
		...(status ? { status } : {}),
		...(severity ? { severity } : {}),
		...(options.serverId ? { serverId: options.serverId } : {}),
		limit: clampIncidentLimit(options.limit),
	};
}

/** How long to mute for. Out of range is refused, never silently adjusted. */
export function muteMinutes(value: string | number | undefined): number {
	const parsed = Number(value);
	if (value === undefined || value === "" || !Number.isFinite(parsed)) {
		throw new InvalidArgumentError(
			`Invalid --minutes "${value}". Must be a whole number of minutes between ${MUTE_MINUTES_MIN} and ${MUTE_MINUTES_MAX}.`,
		);
	}
	if (!Number.isInteger(parsed)) {
		throw new InvalidArgumentError(
			`Invalid --minutes "${value}". Alerts are muted for a whole number of minutes.`,
		);
	}
	if (parsed < MUTE_MINUTES_MIN || parsed > MUTE_MINUTES_MAX) {
		throw new InvalidArgumentError(
			`Cannot mute for ${parsed} minutes. The platform allows ${MUTE_MINUTES_MIN} minutes to ${MUTE_MINUTES_MAX} (${MUTE_MINUTES_MAX / 60 / 24} days).`,
		);
	}
	return parsed;
}

export function describeMuteWindow(minutes: number): string {
	if (minutes < 60) return `${minutes} minutes`;
	if (minutes % (60 * 24) === 0) {
		const days = minutes / (60 * 24);
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	return `${minutes} minutes`;
}

export interface IncidentRow {
	id: string;
	severity: string;
	status: string;
	title: string;
	/** The machine the alert is about, or "platform" for an org-wide one. */
	target: string;
	count: number;
	lastSeenAt: string | null;
}

/**
 * One table row per alert. `machineAlert.list` runs its rows through
 * `toCustomerMachineAlert`, which keeps the VM under `server` but renames the
 * dedicated-host relation to `managedRuntime` (and its `gcpInstanceName` to
 * `instanceName`), so both have to be read to name the machine.
 */
export function incidentRows(alerts: unknown): IncidentRow[] {
	return asArray(alerts).map((alert: any) => {
		const vm = alert?.server as
			| { name?: string; instanceName?: string }
			| null
			| undefined;
		const host = alert?.managedRuntime as
			| { name?: string; instanceName?: string }
			| null
			| undefined;
		const count = Number(alert?.count);
		return {
			id: String(alert?.id ?? ""),
			severity: String(alert?.severity ?? "-"),
			status: String(alert?.status ?? "-"),
			title: String(alert?.title ?? "-"),
			target: String(
				vm?.name ||
					vm?.instanceName ||
					host?.name ||
					host?.instanceName ||
					"platform",
			),
			count: Number.isFinite(count) && count > 0 ? count : 1,
			lastSeenAt: alert?.lastSeenAt ? String(alert.lastSeenAt) : null,
		};
	});
}

/**
 * Total open alerts across every severity. `machineAlert.summary` reports open
 * ones grouped by severity and omits a severity with no rows, so there is no
 * total to read - it has to be summed.
 */
export function openIncidentTotal(summary: unknown): number {
	const open = (summary as { open?: Record<string, unknown> } | null)?.open;
	if (!open || typeof open !== "object") return 0;
	return Object.values(open).reduce((total: number, value) => {
		const count = Number(value);
		return total + (Number.isFinite(count) ? count : 0);
	}, 0);
}

function formatIncidentSeverity(severity: string): string {
	if (severity === "critical") return colors.error(severity);
	if (severity === "error") return colors.error(severity);
	if (severity === "warning") return colors.warn(severity);
	return colors.dim(severity);
}

function formatIncidentStatus(status: string): string {
	if (status === "resolved") return colors.success(status);
	if (status === "open") return colors.error(status);
	if (status === "muted") return colors.dim(status);
	return colors.warn(status);
}

/** Prints one alert after a state change, from the row the mutation returns. */
function logIncidentDetail(alert: unknown): void {
	const row = incidentRows([alert])[0];
	const a = (alert ?? {}) as {
		message?: string;
		source?: string;
		mutedUntil?: string | null;
		firstSeenAt?: string | null;
	};
	if (!row) return;
	log("");
	log(colors.bold(row.title));
	log(`  ID:        ${colors.cyan(row.id)}`);
	log(`  Severity:  ${formatIncidentSeverity(row.severity)}`);
	log(`  Status:    ${formatIncidentStatus(row.status)}`);
	log(`  Machine:   ${row.target}`);
	if (a.source) log(`  Raised by: ${a.source}`);
	log(`  Seen:      ${row.count}x, last ${formatTimestamp(row.lastSeenAt)}`);
	if (a.mutedUntil) log(`  Muted to:  ${formatTimestamp(a.mutedUntil)}`);
	if (a.message) log(`  ${colors.dim(String(a.message))}`);
	log("");
}

// ── Installed software: `servers software` (serverSoftware.*) ───────────────

export interface SoftwareAddonChoice {
	id: string;
	name: string;
	hidden: boolean;
}

/**
 * Resolves what the user typed to a catalog id. The platform matches `addonId`
 * exactly and one id is camel case (`taroutCore`), so a lowercased spelling has
 * to be mapped here rather than passed straight through. `forInstall` refuses a
 * retired entry up front, with the same rule the platform applies: a hidden
 * addon may still be updated or removed, just not newly installed.
 */
export function resolveSoftwareAddonId(
	name: string,
	options: { forInstall?: boolean } = {},
): SoftwareAddonChoice {
	const wanted = String(name ?? "")
		.trim()
		.toLowerCase();
	const addon = SOFTWARE_ADDONS.find(
		(candidate) =>
			candidate.id.toLowerCase() === wanted ||
			candidate.name.toLowerCase() === wanted ||
			(candidate.aliases ?? []).includes(wanted),
	);
	if (!addon) {
		const similar = findSimilar(
			wanted,
			SOFTWARE_ADDONS.map((candidate) => candidate.id),
		);
		throw new InvalidArgumentError(
			`Unknown software "${name}". Installable: ${INSTALLABLE_SOFTWARE.join(", ")}.${
				similar.length ? ` Did you mean ${similar.join(" or ")}?` : ""
			}`,
		);
	}
	if (addon.hidden && options.forInstall) {
		throw new InvalidArgumentError(
			`${addon.name} is retired and can no longer be installed on a server. Installable: ${INSTALLABLE_SOFTWARE.join(", ")}. A server that already runs ${addon.name} can still be inspected, updated and uninstalled.`,
		);
	}
	return { id: addon.id, name: addon.name, hidden: Boolean(addon.hidden) };
}

/** `serverSoftware.{install,update,uninstall,status,logs}` input. */
export function serverSoftwareInput(serverId: string, addonId: string) {
	return { serverId, addonId };
}

/** The display name for a persisted `addonId`, which may be a retired one. */
function softwareLabel(addonId: unknown): string {
	const id = String(addonId ?? "");
	const addon = SOFTWARE_ADDONS.find((candidate) => candidate.id === id);
	if (!addon) return id || colors.dim("-");
	return addon.hidden ? `${addon.name} ${colors.dim("(retired)")}` : addon.name;
}

/**
 * Whether a software run has finished. `installing` is the only non-terminal
 * state, and an unknown or missing status is treated as still running so
 * `--wait` keeps polling rather than reporting a result it does not have.
 */
export function softwareRunSettled(status: unknown): boolean {
	const value = typeof status === "string" ? status : "";
	return value === "installed" || value === "failed" || value === "removed";
}

function formatSoftwareStatus(status: unknown): string {
	const value = String(status ?? "unknown");
	if (value === "installed") return colors.success(value);
	if (value === "failed") return colors.error(value);
	if (value === "installing") return colors.warn(value);
	if (value === "removed") return colors.dim(value);
	return value;
}

function logSoftwareDetail(
	softwareName: string,
	serverLabel: string,
	row: unknown,
): void {
	const r = (row ?? {}) as {
		status?: string;
		installedVersion?: string | null;
		pinnedRef?: string | null;
		installedVia?: string | null;
		ports?: unknown;
		updatedAt?: string | null;
	};
	log("");
	log(`${colors.bold(softwareName)} on ${serverLabel}`);
	log(`  Status:  ${formatSoftwareStatus(r.status)}`);
	if (r.installedVersion || r.pinnedRef) {
		log(`  Version: ${r.installedVersion || r.pinnedRef}`);
	}
	const ports = asArray(r.ports);
	if (ports.length > 0) log(`  Ports:   ${ports.join(", ")}`);
	if (r.installedVia) log(`  Via:     ${r.installedVia}`);
	if (r.updatedAt) log(`  Updated: ${formatTimestamp(r.updatedAt)}`);
	log("");
}

function logSoftwarePollHint(
	serverLabel: string,
	addonId: string,
	settled: boolean,
): void {
	if (settled) {
		log(
			colors.dim(
				`Read the installer output with: tarout servers software logs ${serverLabel} ${addonId}`,
			),
		);
		log("");
		return;
	}
	log(colors.dim("The run continues in the background. Follow it with:"));
	log(
		colors.dim(`  tarout servers software status ${serverLabel} ${addonId}`),
	);
	log(colors.dim(`  tarout servers software logs ${serverLabel} ${addonId}`));
	log("");
}

/**
 * Polls `serverSoftware.status` until the run leaves `installing`. The install
 * runner is a background SSH job, so there is nothing to stream; this is the
 * only way a script can block on the outcome.
 */
async function waitForSoftwareRun(
	client: any,
	serverId: string,
	addonId: string,
	action: "install" | "update" | "uninstall",
): Promise<unknown> {
	const deadline = Date.now() + SOFTWARE_RUN_TIMEOUT_MS;
	let row: unknown = null;
	while (Date.now() < deadline) {
		const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
		updateSpinner(`Running the ${action} on the server... (${left}s left)`);
		await new Promise((resolve) => setTimeout(resolve, SOFTWARE_RUN_POLL_MS));
		row = await client.serverSoftware.status.query(
			serverSoftwareInput(serverId, addonId),
		);
		if (softwareRunSettled((row as { status?: unknown } | null)?.status)) {
			return row;
		}
	}
	throw new CliError(
		`The ${action} is still running after ${SOFTWARE_RUN_TIMEOUT_MS / 60000} minutes. It has not failed - it is still going on the server.`,
		ExitCode.GENERAL_ERROR,
		[
			`Check it with: tarout servers software status <server> ${addonId}`,
			`Read its output with: tarout servers software logs <server> ${addonId}`,
		],
		{ reason: "software_run_timeout", addonId, action },
	);
}

// ── Global GPU catalog (virtualMachine.getGlobalGpuCatalog) ────────────────

export interface GpuCatalogRow {
	family: string;
	count: number;
	sizeId: string;
	provider: string;
	vcpus: number;
	memoryGb: number;
	diskSizeGb: number;
	gpuMemoryGb: number;
	hourlySar: string;
	region: string;
	available: boolean;
}

/**
 * Flattens the catalog into one row per offer (a GPU family at one GPU count).
 * Prices arrive in halalas; `--family` matches the family key or either of its
 * display names so `a100`, `A100` and "NVIDIA A100" all work.
 */
export function gpuCatalogRows(
	catalog: unknown,
	filters: { family?: string; availableOnly?: boolean } = {},
): GpuCatalogRow[] {
	const wanted = filters.family
		? String(filters.family).trim().toLowerCase()
		: undefined;
	const rows: GpuCatalogRow[] = [];
	for (const family of asArray((catalog as any)?.families)) {
		const names = [family?.key, family?.shortName, family?.displayName]
			.filter((value) => typeof value === "string")
			.map((value: string) => value.toLowerCase());
		if (wanted && !names.includes(wanted)) continue;
		for (const offer of asArray(family?.offers)) {
			if (filters.availableOnly && !offer?.available) continue;
			rows.push({
				family: String(family?.shortName || family?.key || "-"),
				count: Number(offer?.count ?? 1),
				sizeId: String(offer?.sizeId ?? "-"),
				provider: displayProvider(offer?.providerId) || "-",
				vcpus: Number(offer?.vcpus ?? 0),
				memoryGb: Number(offer?.memoryGb ?? 0),
				diskSizeGb: Number(offer?.diskSizeGb ?? 0),
				gpuMemoryGb: Number(offer?.gpuMemoryGb ?? 0),
				hourlySar: formatHalalasPerHour(offer?.hourlyHalalas),
				region: String(offer?.regionDisplayName || "-"),
				available: Boolean(offer?.available),
			});
		}
	}
	return rows;
}

/** Halalas to the SAR figure the rest of the CLI prints (1 SAR = 100 halalas). */
export function formatHalalasPerHour(halalas: unknown): string {
	const value = Number(halalas);
	if (!Number.isFinite(value)) return "-";
	return (value / 100).toFixed(3);
}

/** Date AND time: an alert or an install run is useless dated to the day. */
function formatTimestamp(value: Date | string | null | undefined): string {
	if (!value) return colors.dim("-");
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return colors.dim("-");
	return date.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// ── Termination: what goes with the server and what is kept ────────────────

export interface KeepChoice {
	keepVolumes: boolean;
	keepSnapshots: boolean;
	keepIps: boolean;
}

function keepChoiceFromOptions(options: {
	keepVolumes?: boolean;
	keepSnapshots?: boolean;
	keepIps?: boolean;
}): KeepChoice {
	return {
		keepVolumes: Boolean(options.keepVolumes),
		keepSnapshots: Boolean(options.keepSnapshots),
		keepIps: Boolean(options.keepIps),
	};
}

/** `virtualMachine.terminate` input; each kind is deleted unless kept. */
export function terminateInput(id: string, keep: KeepChoice) {
	return {
		id,
		deleteVolumes: !keep.keepVolumes,
		deleteSnapshots: !keep.keepSnapshots,
		releaseIps: !keep.keepIps,
	};
}

export interface TerminationPreview {
	volumes?: Array<{
		id: string;
		name: string;
		diskSizeGb?: number;
		diskType?: string;
	}>;
	snapshots?: Array<{ id: string; name: string; diskSizeGb?: number }>;
	reservedIps?: Array<{ id: string; name: string; ipAddress?: string | null }>;
}

export interface TerminationPlan {
	deleted: string[];
	kept: string[];
	deletedSummary: string[];
	keptSummary: string[];
	/** Kept volumes/snapshots block deleting the server record. */
	keepsRecord: boolean;
}

function countNoun(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinList(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? "";
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function planTermination(
	preview: TerminationPreview | null | undefined,
	keep: KeepChoice,
): TerminationPlan {
	const volumes = asArray(preview?.volumes).map(
		(v) =>
			`volume "${v.name}"${v.diskSizeGb ? ` (${v.diskSizeGb} GB${v.diskType ? `, ${v.diskType}` : ""})` : ""}`,
	);
	const snapshots = asArray(preview?.snapshots).map(
		(s) => `snapshot "${s.name}"${s.diskSizeGb ? ` (${s.diskSizeGb} GB)` : ""}`,
	);
	const ips = asArray(preview?.reservedIps).map(
		(ip) => `reserved IP ${ip.ipAddress ? `${ip.ipAddress} ` : ""}("${ip.name}")`,
	);
	const groups = [
		{ items: volumes, kept: keep.keepVolumes, noun: "volume" },
		{ items: snapshots, kept: keep.keepSnapshots, noun: "snapshot" },
		{ items: ips, kept: keep.keepIps, noun: "reserved IP" },
	];
	const summary = (kept: boolean) =>
		groups
			.filter((g) => g.kept === kept && g.items.length > 0)
			.map((g) => countNoun(g.items.length, g.noun));
	return {
		deleted: groups.filter((g) => !g.kept).flatMap((g) => g.items),
		kept: groups.filter((g) => g.kept).flatMap((g) => g.items),
		deletedSummary: summary(false),
		keptSummary: summary(true),
		keepsRecord:
			(keep.keepVolumes && volumes.length > 0) ||
			(keep.keepSnapshots && snapshots.length > 0),
	};
}

export function terminationQuestion(
	action: "terminate" | "delete",
	label: string,
	plan: TerminationPlan,
): string {
	const verb = action === "delete" ? "Delete" : "Terminate";
	const deletes = joinList(["the server", "its boot disk", ...plan.deletedSummary]);
	let question = `${verb} server "${label}"? This permanently deletes ${deletes}.`;
	if (plan.keptSummary.length > 0) {
		question += ` Kept, and still billed until you delete it: ${joinList(plan.keptSummary)}.`;
	}
	return question;
}

/**
 * Shows exactly what terminating deletes and keeps, then asks. The preview is
 * what makes the answer informed, so a failed preview stops here instead of
 * asking the user to approve a deletion blind.
 */
async function confirmTermination(
	client: any,
	serverId: string,
	label: string,
	keep: KeepChoice,
	action: "terminate" | "delete",
): Promise<boolean> {
	startSpinner("Checking the server's volumes, snapshots and IPs...");
	let preview: TerminationPreview;
	try {
		preview = await client.virtualMachine.getTerminationPreview.query({
			id: serverId,
		});
	} catch (err) {
		failSpinner();
		throw err;
	}
	succeedSpinner();

	const plan = planTermination(preview, keep);
	log("");
	log(`Server: ${colors.bold(label)}`);
	log(`ID: ${colors.dim(serverId)}`);
	log("");
	log(colors.error("Deleted permanently:"));
	log("  - the server and its boot disk, with all data on them");
	for (const item of plan.deleted) log(`  - ${item}`);
	if (plan.kept.length > 0) {
		log("");
		log(colors.warn("Kept (keeps billing until you delete it):"));
		for (const item of plan.kept) log(`  - ${item}`);
	}
	if (plan.deleted.length > 0) {
		log("");
		log(
			colors.dim(
				"To keep any of these, re-run with --keep-volumes, --keep-snapshots or --keep-ips.",
			),
		);
	}
	if (action === "delete" && plan.keepsRecord) {
		log(
			colors.dim(
				"The server record stays until the kept volumes and snapshots are deleted.",
			),
		);
	}
	log("");

	return confirm(terminationQuestion(action, label, plan), false, {
		field:
			action === "delete" ? "confirm_delete_server" : "confirm_terminate_server",
		flag: "--yes",
		context: { server: label, deletes: plan.deleted, keeps: plan.kept },
	});
}

function logKeptStorageHint(keep: KeepChoice): void {
	if (!keep.keepVolumes && !keep.keepSnapshots && !keep.keepIps) return;
	log("");
	log(
		colors.warn(
			"Kept storage keeps billing until you delete it. See it with: tarout servers kept-storage",
		),
	);
	log("");
}

function trpcCode(err: unknown): string | undefined {
	const e = err as { code?: unknown; data?: { code?: unknown } } | null;
	const code = e?.data?.code ?? e?.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * Finds a server by id (including terminated ones, which `list` hides), then
 * by name or id prefix among live servers, then among terminated ones.
 */
async function resolveServerIncludingTerminated(
	client: any,
	identifier: string,
): Promise<any> {
	try {
		const server = await client.virtualMachine.get.query({ id: identifier });
		if (server) return server;
	} catch (err) {
		if (trpcCode(err) !== "NOT_FOUND") throw err;
	}
	const live = asServerList(await client.virtualMachine.list.query({}));
	const liveMatch = findServer(live, identifier);
	if (liveMatch) return liveMatch;
	const terminated = asServerList(
		await client.virtualMachine.list.query({ status: "terminated" }),
	);
	const terminatedMatch = findServer(terminated, identifier);
	if (terminatedMatch) return terminatedMatch;
	throw new NotFoundError(
		"Server",
		identifier,
		findSimilar(
			identifier,
			[...live, ...terminated].map((s: any) => s.name || ""),
		),
	);
}

/**
 * The platform refuses to delete a server record while volumes or snapshots
 * kept at termination still point at it. Turn that refusal into a message
 * that names the commands to run, instead of the dashboard's "Servers page".
 */
export function keptStorageRefusal(
	err: unknown,
	opts: { terminatedNow: boolean; identifier: string },
): CliError | null {
	const message = String((err as { message?: unknown } | null)?.message ?? "");
	if (trpcCode(err) !== "PRECONDITION_FAILED" || !/kept/i.test(message)) {
		return null;
	}
	const prefix = opts.terminatedNow
		? "The server was terminated, but its record was not deleted. "
		: "";
	return new CliError(
		`${prefix}${message}\nList them with \`tarout servers kept-storage\`, delete them with \`tarout servers volumes delete <id>\` and \`tarout servers snapshots delete <id>\`, then run \`tarout servers delete ${opts.identifier}\` again.`,
		ExitCode.INVALID_ARGUMENTS,
		undefined,
		{ reason: "kept_storage", nextCommand: "tarout servers kept-storage" },
	);
}

export interface RetainedStorageRow {
	kind: "volume" | "snapshot" | "reserved IP";
	id: string;
	name: string;
	detail: string;
	server: string;
}

/** Flattens `listRetainedStorage` into one row per billed item. */
export function retainedStorageRows(retained: unknown): RetainedStorageRow[] {
	const r = (retained ?? {}) as {
		volumes?: unknown;
		snapshots?: unknown;
		reservedIps?: unknown;
	};
	const serverLabel = (server: any) => server?.name || server?.id || "-";
	return [
		...asArray(r.volumes).map((v) => ({
			kind: "volume" as const,
			id: String(v.id),
			name: v.name || "-",
			detail: v.diskSizeGb
				? `${v.diskSizeGb} GB${v.diskType ? ` ${v.diskType}` : ""}`
				: "-",
			server: serverLabel(v.server),
		})),
		...asArray(r.snapshots).map((s) => ({
			kind: "snapshot" as const,
			id: String(s.id),
			name: s.name || "-",
			detail: s.diskSizeGb ? `${s.diskSizeGb} GB` : "-",
			server: serverLabel(s.server),
		})),
		...asArray(r.reservedIps).map((ip) => ({
			kind: "reserved IP" as const,
			id: String(ip.id),
			name: ip.name || "-",
			detail: ip.ipAddress || "-",
			server: "-",
		})),
	];
}

/**
 * Dedicated Coolify server sizes are a strict enum on the server
 * (SMALL | MEDIUM | LARGE). Normalize free-text CLI input to that enum so an
 * invalid value fails with a clear message instead of a raw Zod BAD_REQUEST.
 */
function normalizeDedicatedSize(value: string): "SMALL" | "MEDIUM" | "LARGE" {
	const normalized = String(value).trim().toUpperCase();
	if (
		normalized === "SMALL" ||
		normalized === "MEDIUM" ||
		normalized === "LARGE"
	) {
		return normalized;
	}
	throw new CliError(
		`Invalid dedicated server size "${value}". Must be one of: SMALL, MEDIUM, LARGE.`,
	);
}

export interface SavedSshKey {
	id: string;
	name: string;
	isDefault?: boolean;
}

export interface SshKeyChoice {
	keyIds: string[];
	names: string[];
	source: "explicit" | "default" | "generated";
}

/**
 * Which saved keys a new server gets. `tarout keys default` promises "the
 * default for new servers", but create sent no key ids, so the platform
 * generated a fresh pair and the user's own key could not log in (production
 * 2026-09-23). Explicit --key wins, then the default keys, and only with
 * neither (or --generate-key) does the platform generate a pair.
 */
export function pickServerSshKeys(
	saved: SavedSshKey[],
	options: { keys?: string[]; generateKey?: boolean },
): SshKeyChoice {
	if (options.generateKey) return { keyIds: [], names: [], source: "generated" };
	if (options.keys?.length) {
		const picked = options.keys.map((ref) => {
			const match =
				saved.find((key) => key.id === ref) ??
				saved.find((key) => key.name === ref);
			if (!match) {
				throw new NotFoundError(
					"SSH key",
					ref,
					findSimilar(
						ref,
						saved.map((key) => key.name),
					),
				);
			}
			return match;
		});
		return {
			keyIds: [...new Set(picked.map((key) => key.id))],
			names: picked.map((key) => key.name),
			source: "explicit",
		};
	}
	const defaults = saved.filter((key) => key.isDefault);
	if (defaults.length > 0) {
		return {
			keyIds: defaults.map((key) => key.id),
			names: defaults.map((key) => key.name),
			source: "default",
		};
	}
	return { keyIds: [], names: [], source: "generated" };
}

function describeSshKeyChoice(choice: SshKeyChoice): string {
	if (choice.source === "generated") {
		return "new key pair (private key shown once)";
	}
	const label = choice.names.join(", ");
	return choice.source === "default" ? `${label} (default key)` : label;
}
