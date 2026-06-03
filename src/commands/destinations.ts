import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import { AuthError, handleError } from "../lib/errors.js";
import {
	colors,
	isJsonMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerDestinationsCommands(program: Command) {
	const dest = program
		.command("destinations")
		.description("Manage backup storage destinations");

	// ── List ─────────────────────────────────────────────────────────────────────
	dest
		.command("list")
		.alias("ls")
		.description("List all backup destinations")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching destinations...");
				const all = await client.destination.all.query();
				succeedSpinner();
				if (isJsonMode()) {
					outputData(all);
					return;
				}
				const list = Array.isArray(all) ? all : [];
				if (list.length === 0) {
					log("");
					log("No backup destinations configured.");
					log(`Create one: ${colors.dim("tarout destinations create")}`);
					return;
				}
				log("");
				table(
					["NAME", "PROVIDER", "BUCKET", "REGION", "ID"],
					list.map((d: any) => [
						colors.bold(d.name || "-"),
						d.provider || "-",
						d.bucket || "-",
						d.region || "-",
						colors.dim(d.id || d.destinationId || "-"),
					]),
				);
				log("");
				log(
					colors.dim(
						`${list.length} destination${list.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Info ─────────────────────────────────────────────────────────────────────
	dest
		.command("info <destination-id>")
		.description("Show backup destination details")
		.action(async (id: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching destination...");
				const data = await client.destination.byId.query({ id } as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(data);
					return;
				}
				const d = data as any;
				log("");
				log(colors.bold(d.name || id));
				log(`  Provider: ${d.provider || "-"}`);
				log(`  Bucket:   ${d.bucket || "-"}`);
				log(`  Region:   ${d.region || "-"}`);
				log(`  Endpoint: ${d.endpoint || "-"}`);
				log(`  ID:       ${colors.dim(d.id || d.destinationId || "-")}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Create ───────────────────────────────────────────────────────────────────
	dest
		.command("create")
		.description("Create a new backup destination")
		.option("-n, --name <name>", "Destination name")
		.option(
			"-p, --provider <provider>",
			"Storage provider (s3, gcs, r2, wasabi, minio)",
		)
		.option("-b, --bucket <bucket>", "Bucket name")
		.option("-r, --region <region>", "Region")
		.option("-e, --endpoint <url>", "Custom endpoint URL")
		.option("--access-key <key>", "Access key ID")
		.option("--secret-key <secret>", "Secret access key")
		.action(
			async (options: {
				name?: string;
				provider?: string;
				bucket?: string;
				region?: string;
				endpoint?: string;
				accessKey?: string;
				secretKey?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const name =
						options.name ||
						(await input("Destination name:", undefined, {
							field: "name",
							flag: "--name",
						}));
					const provider =
						options.provider ||
						(await select(
							"Storage provider:",
							[
								{ name: "S3 (AWS)", value: "s3" },
								{ name: "GCS (Google Cloud)", value: "gcs" },
								{ name: "R2 (Cloudflare)", value: "r2" },
								{ name: "Wasabi", value: "wasabi" },
								{ name: "MinIO (custom)", value: "minio" },
							],
							{
								field: "provider",
								flag: "--provider",
							},
						));
					const bucket =
						options.bucket ||
						(await input("Bucket name:", undefined, {
							field: "bucket",
							flag: "--bucket",
						}));
					const region =
						options.region ||
						(await input("Region (or leave blank):", undefined, {
							field: "region",
							flag: "--region",
						})) ||
						undefined;
					const endpoint =
						options.endpoint ||
						(await input("Custom endpoint URL (or leave blank):", undefined, {
							field: "endpoint",
							flag: "--endpoint",
						})) ||
						undefined;
					const accessKey =
						options.accessKey ||
						(await input("Access Key ID:", undefined, {
							field: "access_key",
							flag: "--access-key",
							sensitive: true,
						}));
					const secretAccessKey =
						options.secretKey ||
						(await input("Secret Access Key:", undefined, {
							field: "secret_key",
							flag: "--secret-key",
							sensitive: true,
						}));

					const client = getApiClient();
					const _spinner = startSpinner("Creating destination...");
					const result = await client.destination.create.mutate({
						name,
						provider,
						bucket,
						region,
						endpoint,
						accessKey,
						secretAccessKey,
					} as any);
					succeedSpinner("Backup destination created.");
					if (isJsonMode()) {
						outputData(result);
					} else {
						quietOutput(
							(result as any).id || (result as any).destinationId || "created",
						);
					}
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Update ───────────────────────────────────────────────────────────────────
	dest
		.command("update <destination-id>")
		.description("Update a backup destination")
		.option("-n, --name <name>", "New name")
		.option("-b, --bucket <bucket>", "New bucket")
		.option("-r, --region <region>", "New region")
		.option("-e, --endpoint <url>", "New endpoint URL")
		.option("--access-key <key>", "New access key ID")
		.option("--secret-key <secret>", "New secret access key")
		.action(
			async (
				destinationId: string,
				options: {
					name?: string;
					bucket?: string;
					region?: string;
					endpoint?: string;
					accessKey?: string;
					secretKey?: string;
				},
			) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const client = getApiClient();
					const _spinner = startSpinner("Updating destination...");
					await client.destination.update.mutate({
						destinationId,
						name: options.name,
						bucket: options.bucket,
						region: options.region,
						endpoint: options.endpoint,
						accessKey: options.accessKey,
						secretAccessKey: options.secretKey,
					} as any);
					succeedSpinner("Destination updated.");
					if (isJsonMode()) outputData({ updated: true, destinationId });
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);

	// ── Remove ───────────────────────────────────────────────────────────────────
	dest
		.command("delete <destination-id>")
		.alias("rm")
		.description("Delete a backup destination")
		.action(async (destinationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete destination "${destinationId}"?`,
						false,
						{
							field: "confirm_delete_destination",
							flag: "--yes",
							context: { destinationId },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}
				const client = getApiClient();
				const _spinner = startSpinner("Deleting destination...");
				await client.destination.remove.mutate({ destinationId } as any);
				succeedSpinner("Destination deleted.");
				if (isJsonMode()) outputData({ deleted: true, destinationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Test existing ─────────────────────────────────────────────────────────────
	dest
		.command("test <destination-id>")
		.description("Test an existing backup destination connection")
		.action(async (destinationId: string) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Testing connection...");
				const result = await client.destination.test.mutate({
					destinationId,
				} as any);
				succeedSpinner("Connection test passed.");
				if (isJsonMode()) outputData(result);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Test credentials ──────────────────────────────────────────────────────────
	dest
		.command("test-credentials")
		.description("Test storage credentials before saving")
		.option("-p, --provider <provider>", "Storage provider")
		.option("-b, --bucket <bucket>", "Bucket name")
		.option("-r, --region <region>", "Region")
		.option("-e, --endpoint <url>", "Custom endpoint URL")
		.option("--access-key <key>", "Access key ID")
		.option("--secret-key <secret>", "Secret access key")
		.action(
			async (options: {
				provider?: string;
				bucket?: string;
				region?: string;
				endpoint?: string;
				accessKey?: string;
				secretKey?: string;
			}) => {
				try {
					if (!isLoggedIn()) throw new AuthError();
					const provider =
						options.provider ||
						(await input("Storage provider (s3/gcs/r2):", undefined, {
							field: "provider",
							flag: "--provider",
						}));
					const bucket =
						options.bucket ||
						(await input("Bucket name:", undefined, {
							field: "bucket",
							flag: "--bucket",
						}));
					const accessKey =
						options.accessKey ||
						(await input("Access Key ID:", undefined, {
							field: "access_key",
							flag: "--access-key",
							sensitive: true,
						}));
					const secretAccessKey =
						options.secretKey ||
						(await input("Secret Access Key:", undefined, {
							field: "secret_key",
							flag: "--secret-key",
							sensitive: true,
						}));
					const client = getApiClient();
					const _spinner = startSpinner("Testing credentials...");
					const result = await client.destination.testCredentials.mutate({
						provider,
						bucket,
						region: options.region,
						endpoint: options.endpoint,
						accessKey,
						secretAccessKey,
					} as any);
					succeedSpinner("Credentials are valid.");
					if (isJsonMode()) outputData(result);
				} catch (err) {
					failSpinner();
					handleError(err);
				}
			},
		);
}
