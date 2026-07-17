import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	findSimilar,
	handleError,
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
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

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
						s.publicIp || s.ip || colors.dim("-"),
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
		.option("-t, --type <type>", "Server type: cpu or gpu")
		.option("-s, --size <size>", "Server size (e.g., n2-standard-2)")
		.option("-o, --os <os>", "OS type: ubuntu-22, ubuntu-24, debian-12")
		.option("--provider <provider>", "Cloud provider: gcp, runpod")
		.action(async (name, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Interactive mode
				let serverName = name;
				let serverType = options.type;
				let serverSize = options.size;
				let osType = options.os;

				if (!serverName) {
					serverName = await input("Server name:", undefined, {
						field: "server_name",
						flag: "<name>",
					});
				}

				if (!serverType) {
					serverType = await select(
						"Server type:",
						[
							{ name: "CPU (general purpose)", value: "cpu" },
							{ name: "GPU (for AI/ML workloads)", value: "gpu" },
						],
						{ field: "server_type", flag: "--type" },
					);
				}

				// Fetch available sizes
				const _spinner = startSpinner("Fetching available sizes...");
				const sizes = await client.virtualMachine.getServerTypes.query({
					type: serverType,
					providerId: options.provider,
				});
				succeedSpinner();

				const sizeList = sizes?.types || sizes?.serverTypes || sizes || [];

				if (!serverSize && Array.isArray(sizeList) && sizeList.length > 0) {
					const sizeChoices = sizeList.slice(0, 10).map((s: any) => ({
						name: `${s.name || s.id} - ${s.description || ""} ${s.priceHalalas ? `(${(s.priceHalalas / 100).toFixed(2)} SAR/hr)` : ""}`,
						value: s.name || s.id || s.size,
					}));
					serverSize = await select("Server size:", sizeChoices, {
						field: "server_size",
						flag: "--size",
					});
				} else if (!serverSize) {
					serverSize = await input(
						"Server size (e.g., n2-standard-2 for GCP, GPU-small for RunPod):",
						undefined,
						{ field: "server_size", flag: "--size" },
					);
				}

				if (!osType) {
					osType = await select(
						"Operating system:",
						[
							{ name: "Ubuntu 22.04 LTS", value: "ubuntu-22" },
							{ name: "Ubuntu 24.04 LTS", value: "ubuntu-24" },
							{ name: "Debian 12", value: "debian-12" },
							{ name: "Rocky Linux 9", value: "rocky-linux-9" },
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
					providerId: options.provider,
				});

				succeedSpinner("Server creation started!");

				// Server returns { server, privateKey, privateKeyFormatted, sshCommand }.
				// The real id lives on result.server.id and the private key is shown
				// ONCE — it is never stored server-side.
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
							"Save this private key now — it will NOT be shown again:",
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
					`  Provider: ${details.providerId || details.provider || colors.dim("-")}`,
				);
				log("");
				log(colors.bold("Network"));
				log(
					`  Public IP: ${colors.cyan(details.publicIp || colors.dim("Not assigned"))}`,
				);
				log(`  Private IP: ${details.privateIp || colors.dim("-")}`);
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
		.description("Permanently delete a server")
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

				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Server: ${colors.bold(server.name || serverIdentifier)}`);
					log(`ID: ${colors.dim(server.id || server.serverId)}`);
					log("");
					log(
						colors.error(
							"Warning: This will permanently delete the server and all data on it.",
						),
					);
					log("");

					const confirmed = await confirm(
						`Are you sure you want to delete server "${server.name || serverIdentifier}"?`,
						false,
						{
							field: "confirm_delete_server",
							flag: "--yes",
							context: { server: server.name || serverIdentifier },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting server...");

				await client.virtualMachine.delete.mutate({
					id: server.id || server.serverId,
				});

				succeedSpinner("Server deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, id: server.id || server.serverId });
				} else {
					quietOutput(server.id || server.serverId);
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
		.option("-r, --range <range>", "Time range: 1h, 6h, 24h, 7d, 30d", "1h")
		.action(async (serverIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

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

				const latest = metrics?.current || metrics?.latest || {};
				if (latest.cpu !== undefined) {
					log(`  CPU: ${formatPercent(latest.cpu)}`);
				}
				if (latest.memory !== undefined) {
					log(`  Memory: ${formatPercent(latest.memory)}`);
				}
				if (latest.disk !== undefined) {
					log(`  Disk: ${formatPercent(latest.disk)}`);
				}
				if (latest.networkIn !== undefined || latest.networkOut !== undefined) {
					log(
						`  Network: ↓ ${formatBytes(latest.networkIn || 0)} / ↑ ${formatBytes(latest.networkOut || 0)}`,
					);
				}
				log("");
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
						colors.cyan((s.id || s.snapshotId || "").slice(0, 8)),
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
					name = await input(
						`Snapshot name (default: ${server.name}-snapshot-${Date.now()}):`,
						undefined,
						{ field: "snapshot_name", flag: "<snapshot-name>" },
					);
					if (!name) {
						name = `${server.name || serverIdentifier}-snapshot-${Date.now()}`;
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
					["ID", "NAME", "PROTOCOL", "PORTS", "SOURCE"],
					items.map((r: any) => [
						colors.cyan((r.id || r.ruleId || "").slice(0, 8)),
						r.name || colors.dim("-"),
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
		.option("-n, --name <name>", "Rule name", "allow-port")
		.option("-p, --protocol <proto>", "Protocol: tcp, udp, icmp", "tcp")
		.option("--port <range>", "Port or range (e.g., 80, 443, 8000-9000)")
		.option("--source <cidr>", "Source CIDR range", "0.0.0.0/0")
		.action(async (serverIdentifier, options) => {
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

				let portRange = options.port;
				if (!portRange) {
					portRange = await input(
						"Port or range (e.g., 80, 443, 8000-9000):",
						undefined,
						{ field: "port_range", flag: "--port" },
					);
				}

				const _addSpinner = startSpinner("Adding firewall rule...");

				const result = await client.virtualMachine.createFirewallRule.mutate({
					serverId: server.id || server.serverId,
					name: options.name,
					protocol: options.protocol,
					portRange,
					sourceRanges: options.source,
				});

				succeedSpinner("Firewall rule added!");

				if (isJsonMode()) {
					outputData(result);
				} else {
					box("Firewall Rule Added", [
						`Protocol: ${options.protocol.toUpperCase()}`,
						`Port: ${portRange}`,
						`Source: ${options.source}`,
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
		.option("--provider <provider>", "Filter by provider: gcp, runpod")
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
				table(
					["ID", "NAME", "SIZE", "STATUS", "ATTACHED"],
					list.map((v: any) => [
						colors.cyan((v.id || v.volumeId || "").slice(0, 8)),
						v.name || "-",
						v.sizeGb ? `${v.sizeGb} GB` : "-",
						v.status || "-",
						v.attachedAt ? colors.success("yes") : colors.dim("no"),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	volumes
		.command("create")
		.argument("<server>", "Server ID or name")
		.description("Create and attach a new volume to a server")
		.option("-n, --name <name>", "Volume name")
		.option("-s, --size <gb>", "Size in GB", "20")
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

				let name = options.name;
				if (!name) {
					name = await input("Volume name:", undefined, {
						field: "volume_name",
						flag: "--name",
					});
				}

				const _createSpinner = startSpinner("Creating volume...");

				const vol = await client.virtualMachine.createVolume.mutate({
					serverId: server.id || server.serverId,
					name,
					sizeGb: Number.parseInt(options.size) || 20,
				} as any);

				succeedSpinner("Volume created!");

				if (isJsonMode()) {
					outputData(vol);
				} else {
					quietOutput(
						String((vol as any)?.id || (vol as any)?.volumeId || name),
					);
					log("");
					log(colors.success(`Volume "${name}" created and attached.`));
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
		.argument("<server>", "Server ID or name")
		.description("Attach a volume to a server")
		.action(async (volumeId, serverIdentifier) => {
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

				const _attachSpinner = startSpinner("Attaching volume...");

				// attachVolume input is { volumeId } only — the volume already
				// carries its target server association server-side.
				await client.virtualMachine.attachVolume.mutate({
					volumeId,
				} as any);

				succeedSpinner("Volume attached!");

				if (isJsonMode()) {
					outputData({
						attached: true,
						volumeId,
						serverId: server.id || server.serverId,
					});
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
				table(
					["ID", "IP", "REGION", "ASSIGNED TO", "CREATED"],
					items.map((ip: any) => [
						colors.cyan((ip.id || ip.ipId || "").slice(0, 8)),
						colors.cyan(ip.ip || ip.address || "-"),
						ip.region || "-",
						ip.assignedServerId
							? colors.dim(ip.assignedServerId.slice(0, 8))
							: colors.dim("unassigned"),
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
		.option("-r, --region <region>", "Region for the IP")
		.option("-n, --name <name>", "Name for the reserved IP")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				// Server requires both { name, region }. Prompt for region when
				// missing; derive a deterministic name from the region when no
				// --name is given (pass --name to reserve several IPs per region).
				let region = options.region;
				if (!region) {
					region = await input("Region for the IP:", undefined, {
						field: "region",
						flag: "--region",
					});
				}

				const name =
					options.name || `ip-${String(region).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

				const _spinner = startSpinner("Reserving IP...");

				const result = await client.virtualMachine.reserveIp.mutate({
					name,
					region,
				} as any);

				succeedSpinner("IP reserved!");

				if (isJsonMode()) {
					outputData(result);
				} else {
					const r = result as any;
					const reservedIpId = r.id || r.ipId || r.ip || r.address;
					if (reservedIpId) quietOutput(String(reservedIpId));
					log("");
					box("IP Reserved", [
						`IP: ${colors.cyan(r.ip || r.address || "")}`,
						`ID: ${r.id || r.ipId || ""}`,
						`Region: ${r.region || "-"}`,
					]);
					log(
						`Assign to server: ${colors.dim(`tarout servers ips assign ${r.id || r.ipId || "<id>"} <server>`)}`,
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
	const alerts = servers
		.command("alerts")
		.description("Manage server alert configurations");

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
				table(
					["METRIC", "CONDITION", "THRESHOLD", "ENABLED"],
					items.map((a: any) => [
						a.metricType || a.metric || "-",
						a.comparisonOp || a.condition || "-",
						String(a.thresholdValue ?? a.threshold ?? "-"),
						a.enabled ? colors.success("yes") : colors.dim("no"),
					]),
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
			"Metric: cpu, memory, disk_read, disk_write, network_in, network_out",
		)
		.option("-t, --threshold <n>", "Alert threshold value", "80")
		.option("--disable", "Disable the alert")
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

				// Metric must be one of the server's metricType enum values
				// (cpu | memory | disk_read | disk_write | network_in | network_out).
				let metric = options.metric;
				if (!metric) {
					metric = await select(
						"Alert metric:",
						[
							{ name: "CPU Usage", value: "cpu" },
							{ name: "Memory Usage", value: "memory" },
							{ name: "Disk Read", value: "disk_read" },
							{ name: "Disk Write", value: "disk_write" },
							{ name: "Network In", value: "network_in" },
							{ name: "Network Out", value: "network_out" },
						],
						{ field: "alert_metric", flag: "--metric" },
					);
				}

				const _setSpinner = startSpinner("Saving alert...");

				await client.virtualMachine.upsertAlertConfig.mutate({
					serverId: server.id || server.serverId,
					metricType: metric,
					thresholdValue: Number.parseInt(options.threshold) || 80,
					enabled: !options.disable,
				} as any);

				succeedSpinner("Alert saved!");

				if (isJsonMode()) {
					outputData({ saved: true, metric, threshold: options.threshold });
				} else {
					log("");
					log(
						colors.success(
							`Alert for ${metric} at ${options.threshold}% saved.`,
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

				// deleteAlertConfig takes { alertId } — there is no delete-by-metric
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

	// ── Missing VM procedures ─────────────────────────────────────────────────

	servers
		.command("terminate")
		.argument("<server>", "Server ID or name")
		.description("Permanently terminate a cloud server (irreversible)")
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
				if (!shouldSkipConfirmation()) {
					log(
						`\n${colors.error("WARNING: This will permanently destroy the server and all data.")}`,
					);
					const confirmed = await confirm(
						`Terminate server "${server.name || identifier}"?`,
						false,
						{
							field: "confirm_terminate_server",
							flag: "--yes",
							context: { server: server.name || identifier },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const _termSpinner = startSpinner("Terminating server...");
				await client.virtualMachine.terminate.mutate({
					id: server.id || server.serverId,
				} as any);
				succeedSpinner("Server terminated!");
				if (isJsonMode()) outputData({ terminated: true });
				else quietOutput(String(server.id || server.serverId));
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
				// resizeVolume input is { volumeId, newSizeGb } — no serverId.
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
					log("");
					log(colors.bold("SSH Session"));
					log(`  Host: ${colors.cyan((result as any).host || "-")}`);
					log(`  Port: ${(result as any).port || 22}`);
					log(`  User: ${(result as any).user || "root"}`);
					if ((result as any).token)
						log(`  Token: ${colors.dim((result as any).token)}`);
					log("");
				}
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("cancel-vm-subscription")
		.argument("<server>", "Server ID or name")
		.description("Cancel the subscription for a cloud server")
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
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Cancel subscription for server "${server.name || identifier}"?`,
						false,
						{
							field: "confirm_cancel_vm_subscription",
							flag: "--yes",
							context: { server: server.name || identifier },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const _cancelSpinner = startSpinner("Cancelling subscription...");
				await client.virtualMachine.cancelSubscription.mutate({
					id: server.id || server.serverId,
				} as any);
				succeedSpinner("Subscription cancelled!");
				if (isJsonMode()) outputData({ cancelled: true });
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("os-images")
		.description("List available OS images for new servers")
		.option("--provider <provider>", "Provider: hetzner, runpod")
		.action(async (options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching OS images...");
				const images = await client.virtualMachine.getOSImages.query({
					provider: options.provider,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(images);
					return;
				}
				const list = Array.isArray(images)
					? images
					: (images as any)?.images || [];
				if (!list.length) {
					log("\nNo OS images found.\n");
					return;
				}
				log("");
				table(
					["ID", "NAME", "OS", "ARCH"],
					list.map((i: any) => [
						colors.cyan(String(i.id || i.imageId || "-")),
						i.name || i.description || "-",
						i.os || i.distribution || "-",
						i.architecture || "x64",
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("runpod-images")
		.description("List available RunPod Docker images")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching RunPod images...");
				const images =
					await client.virtualMachine.getRunPodDockerImages.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(images);
					return;
				}
				const list = Array.isArray(images)
					? images
					: (images as any)?.images || [];
				if (!list.length) {
					log("\nNo RunPod images found.\n");
					return;
				}
				log("");
				table(
					["IMAGE", "TAG"],
					list.map((i: any) => [i.image || i.name || "-", i.tag || "latest"]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("runpod-available")
		.description("Check if RunPod GPU cloud is available")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Checking RunPod availability...");
				const result = await client.virtualMachine.isRunPodAvailable.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const available = (result as any)?.available ?? result;
				log(
					`\nRunPod: ${available ? colors.success("available") : colors.error("unavailable")}\n`,
				);
			} catch (err) {
				handleError(err);
			}
		});

	servers
		.command("check-quota")
		.description("Check VM quota and limits for the organization")
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
				const q = quota as any;
				log("");
				log(colors.bold("VM Quota"));
				log(`  Used:  ${q.used ?? "-"} / ${q.limit ?? "-"}`);
				log(`  CPU:   ${q.cpuUsed ?? "-"} / ${q.cpuLimit ?? "-"}`);
				log(`  RAM:   ${q.ramUsed ?? "-"} / ${q.ramLimit ?? "-"} GB`);
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
	if (!bytes || bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

function formatPercent(value: number): string {
	const pct = Math.round(value);
	if (pct >= 90) return colors.error(`${pct}%`);
	if (pct >= 70) return colors.warn(`${pct}%`);
	return colors.success(`${pct}%`);
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
