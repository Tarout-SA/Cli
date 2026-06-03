import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	NotFoundError,
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
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerKeysCommands(program: Command) {
	const keys = program
		.command("keys")
		.description("Manage SSH keys for server access");

	// List SSH keys
	keys
		.command("list")
		.alias("ls")
		.description("List all SSH keys")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching SSH keys...");

				const keyList = await client.sshKey.list.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(keyList);
					return;
				}

				if (!keyList || keyList.length === 0) {
					log("");
					log("No SSH keys found.");
					log("");
					log(`Add one with: ${colors.dim("tarout keys add <name>")}`);
					return;
				}

				log("");
				table(
					["ID", "NAME", "FINGERPRINT", "DEFAULT", "CREATED"],
					keyList.map((k: any) => [
						colors.cyan((k.keyId || k.id || "").slice(0, 8)),
						k.name,
						colors.dim(`${(k.fingerprint || "").slice(0, 20)}...`),
						k.isDefault ? colors.success("*") : "",
						formatDate(k.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(`${keyList.length} key${keyList.length === 1 ? "" : "s"}`),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Add SSH key
	keys
		.command("add")
		.argument("[name]", "Key name")
		.description("Add an SSH public key")
		.option("-k, --public-key <key>", "Public key content")
		.option("-f, --file <path>", "Path to public key file")
		.action(async (name, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				let keyName = name;
				let publicKey = options.publicKey;

				if (!keyName) {
					keyName = await input("Key name:", undefined, {
						field: "name",
						flag: "--name",
					});
				}

				if (!publicKey && options.file) {
					const { readFileSync } = await import("node:fs");
					publicKey = readFileSync(options.file, "utf-8").trim();
				}

				if (!publicKey) {
					log(
						"Paste your public key below (usually found in ~/.ssh/id_rsa.pub):",
					);
					publicKey = await input("Public key:", undefined, {
						field: "publicKey",
						flag: "--public-key",
						sensitive: false,
					});
				}

				const client = getApiClient();
				const _spinner = startSpinner("Adding SSH key...");

				const result = await client.sshKey.add.mutate({
					name: keyName,
					publicKey: publicKey.trim(),
				});

				succeedSpinner("SSH key added!");

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				quietOutput(result.keyId || result.id || keyName);

				box("SSH Key Added", [
					`Name: ${colors.cyan(keyName)}`,
					`Fingerprint: ${colors.dim(result.fingerprint || "")}`,
				]);
			} catch (err) {
				handleError(err);
			}
		});

	// Delete SSH key
	keys
		.command("delete")
		.alias("rm")
		.argument("<key>", "Key ID or name")
		.description("Remove an SSH key")
		.action(async (keyIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding SSH key...");
				const keyList = await client.sshKey.list.query();
				const key = findKey(keyList, keyIdentifier);

				if (!key) {
					failSpinner();
					const suggestions = findSimilar(
						keyIdentifier,
						keyList.map((k: any) => k.name),
					);
					throw new NotFoundError("SSH key", keyIdentifier, suggestions);
				}

				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Key: ${colors.bold(key.name)}`);
					log(`ID: ${colors.dim(key.keyId || key.id)}`);
					log("");

					const confirmed = await confirm(
						`Are you sure you want to delete SSH key "${key.name}"?`,
						false,
						{
							field: "confirm_delete_ssh_key",
							flag: "--yes",
							context: { keyName: key.name },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting SSH key...");

				await client.sshKey.delete.mutate({ keyId: key.keyId || key.id });

				succeedSpinner("SSH key deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, keyId: key.keyId || key.id });
				} else {
					quietOutput(key.keyId || key.id);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Set default SSH key
	keys
		.command("default")
		.argument("<key>", "Key ID or name to set as default")
		.description("Set a key as the default for new servers")
		.action(async (keyIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding SSH key...");
				const keyList = await client.sshKey.list.query();
				const key = findKey(keyList, keyIdentifier);

				if (!key) {
					failSpinner();
					const suggestions = findSimilar(
						keyIdentifier,
						keyList.map((k: any) => k.name),
					);
					throw new NotFoundError("SSH key", keyIdentifier, suggestions);
				}

				await client.sshKey.setDefault.mutate({ keyId: key.keyId || key.id });

				succeedSpinner(`Set "${key.name}" as default SSH key`);

				if (isJsonMode()) {
					outputData({ keyId: key.keyId || key.id, isDefault: true });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Deploy SSH key to a server
	keys
		.command("deploy")
		.argument("<key>", "Key ID or name")
		.argument("<server-id>", "Target server ID")
		.description("Deploy an SSH key to a cloud server")
		.action(async (keyIdentifier, serverId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding SSH key...");
				const keyList = await client.sshKey.list.query();
				const key = findKey(keyList, keyIdentifier);
				if (!key) {
					failSpinner();
					throw new NotFoundError("SSH key", keyIdentifier);
				}
				const _deploySpinner = startSpinner("Deploying key to server...");
				await client.sshKey.deployToServer.mutate({
					keyId: key.keyId || key.id,
					serverId,
				} as any);
				succeedSpinner("SSH key deployed to server!");
				if (isJsonMode())
					outputData({ deployed: true, keyId: key.keyId || key.id, serverId });
			} catch (err) {
				handleError(err);
			}
		});

	// Remove SSH key from a server
	keys
		.command("undeploy")
		.argument("<key>", "Key ID or name")
		.argument("<server-id>", "Target server ID")
		.description("Remove an SSH key from a cloud server")
		.action(async (keyIdentifier, serverId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Finding SSH key...");
				const keyList = await client.sshKey.list.query();
				const key = findKey(keyList, keyIdentifier);
				if (!key) {
					failSpinner();
					throw new NotFoundError("SSH key", keyIdentifier);
				}
				const _removeSpinner = startSpinner("Removing key from server...");
				await client.sshKey.removeFromServer.mutate({
					keyId: key.keyId || key.id,
					serverId,
				} as any);
				succeedSpinner("SSH key removed from server!");
				if (isJsonMode())
					outputData({ removed: true, keyId: key.keyId || key.id, serverId });
			} catch (err) {
				handleError(err);
			}
		});

	// List SSH keys on a server
	keys
		.command("server-keys")
		.argument("<server-id>", "Server ID")
		.description("List SSH keys deployed to a server")
		.action(async (serverId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching server keys...");
				const result = await client.sshKey.listServerKeys.query({
					serverId,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const list = Array.isArray(result)
					? result
					: (result as any)?.keys || [];
				if (!list.length) {
					log(`\nNo SSH keys deployed to server ${serverId}.\n`);
					return;
				}
				log("");
				table(
					["ID", "NAME", "FINGERPRINT"],
					list.map((k: any) => [
						colors.cyan((k.keyId || k.id || "").slice(0, 8)),
						k.name || "-",
						colors.dim((k.fingerprint || "").slice(0, 20)),
					]),
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});
}

function findKey(keys: any[], identifier: string) {
	const lower = identifier.toLowerCase();
	return keys.find(
		(k: any) =>
			(k.keyId || k.id) === identifier ||
			(k.keyId || k.id || "").startsWith(identifier) ||
			k.name.toLowerCase() === lower,
	);
}

function formatDate(date: Date | string): string {
	if (!date) return colors.dim("-");
	return new Date(date).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
