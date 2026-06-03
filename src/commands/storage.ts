import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn } from "../lib/config.js";
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
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";

export function registerStorageCommands(program: Command) {
	const storage = program
		.command("storage")
		.description("Manage cloud storage buckets");

	// List storage buckets
	storage
		.command("list")
		.alias("ls")
		.description("List all storage buckets")
		.action(async () => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();
				const _spinner = startSpinner("Fetching storage buckets...");

				const buckets = await client.storage.allByOrganization.query();

				succeedSpinner();

				if (isJsonMode()) {
					outputData(buckets);
					return;
				}

				if (!buckets || buckets.length === 0) {
					log("");
					log("No storage buckets found.");
					log("");
					log(`Create one with: ${colors.dim("tarout storage create <name>")}`);
					return;
				}

				log("");
				table(
					["ID", "NAME", "PLAN", "REGION", "PUBLIC", "CREATED"],
					buckets.map((b: any) => [
						colors.cyan((b.bucketId || b.id || "").slice(0, 8)),
						b.name,
						b.plan || colors.dim("free"),
						b.region || colors.dim("-"),
						b.publicAccess ? colors.success("yes") : colors.dim("no"),
						formatDate(b.createdAt),
					]),
				);
				log("");
				log(
					colors.dim(
						`${buckets.length} bucket${buckets.length === 1 ? "" : "s"}`,
					),
				);
			} catch (err) {
				handleError(err);
			}
		});

	// Create storage bucket
	storage
		.command("create")
		.argument("[name]", "Bucket name")
		.description("Create a new storage bucket")
		.option("-p, --plan <plan>", "Plan: FREE, STARTER, STANDARD, PRO", "FREE")
		.option("--public", "Enable public read access")
		.option("-d, --description <text>", "Bucket description")
		.action(async (name, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				let bucketName = name;
				let plan = (options.plan || "FREE").toUpperCase();

				if (!bucketName) {
					bucketName = await input("Bucket name:", undefined, {
						field: "name",
						flag: "--name",
					});
				}

				if (!options.plan && !shouldSkipConfirmation()) {
					plan = await select(
						"Storage plan:",
						[
							{ name: "FREE (1 GB)", value: "FREE" },
							{ name: "STARTER (10 GB)", value: "STARTER" },
							{ name: "STANDARD (100 GB)", value: "STANDARD" },
							{ name: "PRO (1 TB)", value: "PRO" },
						],
						{ field: "plan", flag: "--plan" },
					);
				}

				const client = getApiClient();
				const _spinner = startSpinner("Creating storage bucket...");

				const bucket = await client.storage.create.mutate({
					name: bucketName,
					plan,
					description: options.description,
					publicAccess: options.public || false,
				});

				succeedSpinner("Storage bucket created!");

				const bucketId = bucket.bucketId || bucket.id;

				if (isJsonMode()) {
					outputData(bucket);
					return;
				}

				quietOutput(bucketId);

				box("Storage Bucket Created", [
					`ID: ${colors.cyan(bucketId)}`,
					`Name: ${bucket.name}`,
					`Plan: ${plan}`,
					`Access: ${options.public ? colors.warn("public") : "private"}`,
				]);

				log(
					`Browse files: ${colors.dim(`tarout storage files ${bucketId.slice(0, 8)}`)}`,
				);
				log(
					`Get credentials: ${colors.dim(`tarout storage credentials ${bucketId.slice(0, 8)}`)}`,
				);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Delete storage bucket
	storage
		.command("delete")
		.alias("rm")
		.argument("<bucket>", "Bucket ID or name")
		.description("Delete a storage bucket")
		.action(async (bucketIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding bucket...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets, bucketIdentifier);

				if (!bucket) {
					failSpinner();
					const suggestions = findSimilar(
						bucketIdentifier,
						buckets.map((b: any) => b.name),
					);
					throw new NotFoundError(
						"Storage bucket",
						bucketIdentifier,
						suggestions,
					);
				}

				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					log("");
					log(`Bucket: ${colors.bold(bucket.name)}`);
					log(`ID: ${colors.dim(bucket.bucketId || bucket.id)}`);
					log("");
					log(
						colors.warn(
							"Warning: All files in this bucket will be permanently deleted.",
						),
					);
					log("");

					const confirmed = await confirm(
						`Are you sure you want to delete bucket "${bucket.name}"?`,
						false,
						{
							field: "confirm_delete_bucket",
							flag: "--yes",
							context: { bucketName: bucket.name },
						},
					);

					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting bucket...");

				await client.storage.delete.mutate({
					bucketId: bucket.bucketId || bucket.id,
				});

				succeedSpinner("Storage bucket deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, bucketId: bucket.bucketId || bucket.id });
				} else {
					quietOutput(bucket.bucketId || bucket.id);
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Show bucket info
	storage
		.command("info")
		.argument("<bucket>", "Bucket ID or name")
		.description("Show bucket details")
		.action(async (bucketIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching bucket info...");
				const buckets = await client.storage.allByOrganization.query();
				const bucketSummary = findBucket(buckets, bucketIdentifier);

				if (!bucketSummary) {
					failSpinner();
					const suggestions = findSimilar(
						bucketIdentifier,
						buckets.map((b: any) => b.name),
					);
					throw new NotFoundError(
						"Storage bucket",
						bucketIdentifier,
						suggestions,
					);
				}

				const bucket = await client.storage.findById.query({
					bucketId: bucketSummary.bucketId || bucketSummary.id,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(bucket);
					return;
				}

				const bucketId = bucket.bucketId || bucket.id;

				log("");
				log(colors.bold(bucket.name));
				log(colors.dim(bucketId));
				log("");
				log(`  Plan: ${colors.cyan(bucket.plan || "free")}`);
				log(`  Region: ${bucket.region || colors.dim("auto")}`);
				log(
					`  Access: ${bucket.publicAccess ? colors.warn("public") : "private"}`,
				);
				if (bucket.description) {
					log(`  Description: ${bucket.description}`);
				}
				log("");
				log(colors.bold("Storage Usage"));
				log(
					`  Used: ${formatBytes(bucket.usedBytes || 0)} / ${formatBytes(bucket.storageLimit || 0)}`,
				);
				log(`  Files: ${bucket.fileCount || 0}`);
				log("");
				log(colors.bold("Endpoint"));
				if (bucket.endpoint) {
					log(`  ${colors.cyan(bucket.endpoint)}`);
				} else {
					log(`  ${colors.dim("Not available")}`);
				}
				log("");
				log(`  Created: ${formatDate(bucket.createdAt)}`);
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// List files in a bucket
	storage
		.command("files")
		.argument("<bucket>", "Bucket ID or name")
		.description("List files in a storage bucket")
		.option("-p, --prefix <prefix>", "Filter by prefix (folder path)")
		.option("-n, --limit <n>", "Max files to show", Number.parseInt)
		.action(async (bucketIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching files...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets, bucketIdentifier);

				if (!bucket) {
					failSpinner();
					const suggestions = findSimilar(
						bucketIdentifier,
						buckets.map((b: any) => b.name),
					);
					throw new NotFoundError(
						"Storage bucket",
						bucketIdentifier,
						suggestions,
					);
				}

				const files = await client.storage.getFiles.query({
					bucketId: bucket.bucketId || bucket.id,
					prefix: options.prefix,
					maxResults: options.limit || 100,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(files);
					return;
				}

				const items = files?.files || files?.items || files || [];

				if (!items || items.length === 0) {
					log("");
					log(`No files in bucket ${colors.cyan(bucket.name)}.`);
					return;
				}

				log("");
				log(`Files in ${colors.cyan(bucket.name)}:`);
				log("");
				table(
					["NAME", "SIZE", "CONTENT TYPE", "UPDATED"],
					items.map((f: any) => [
						f.name || f.key || "",
						formatBytes(f.size || f.sizeBytes || 0),
						f.contentType || colors.dim("-"),
						formatDate(f.updated || f.updatedAt || f.lastModified),
					]),
				);
				log("");
				log(colors.dim(`${items.length} file${items.length === 1 ? "" : "s"}`));
			} catch (err) {
				handleError(err);
			}
		});

	// Delete a file from a bucket
	storage
		.command("rm-file")
		.argument("<bucket>", "Bucket ID or name")
		.argument("<file>", "File name / path to delete")
		.description("Delete a file from a storage bucket")
		.action(async (bucketIdentifier, fileName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding bucket...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets, bucketIdentifier);

				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}

				succeedSpinner();

				if (!shouldSkipConfirmation()) {
					const confirmed = await confirm(
						`Delete file "${fileName}" from bucket "${bucket.name}"?`,
						false,
						{
							field: "confirm_delete_file",
							flag: "--yes",
							context: { fileName, bucketName: bucket.name },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				}

				const _deleteSpinner = startSpinner("Deleting file...");

				await client.storage.deleteFile.mutate({
					bucketId: bucket.bucketId || bucket.id,
					fileName,
				});

				succeedSpinner("File deleted!");

				if (isJsonMode()) {
					outputData({ deleted: true, fileName });
				}
			} catch (err) {
				handleError(err);
			}
		});

	// Get S3-compatible credentials for a bucket
	storage
		.command("credentials")
		.argument("<bucket>", "Bucket ID or name")
		.description("Get S3-compatible credentials for SDK access")
		.action(async (bucketIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Fetching credentials...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets, bucketIdentifier);

				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}

				const creds = await client.storage.getCredentials.query({
					bucketId: bucket.bucketId || bucket.id,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(creds);
					return;
				}

				box(`Credentials for ${bucket.name}`, [
					`Access Key ID: ${colors.cyan(creds.accessKeyId || "")}`,
					`Secret Access Key: ${colors.dim(creds.secretAccessKey || "")}`,
					`Region: ${creds.region || "auto"}`,
					`Endpoint: ${creds.endpoint || ""}`,
					`Bucket: ${creds.bucket || bucket.name}`,
				]);

				log("These are S3-compatible credentials. Keep them secure.");
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// Get download URL for a file
	storage
		.command("download-url")
		.argument("<bucket>", "Bucket ID or name")
		.argument("<file>", "File name / path")
		.description("Get a temporary download URL for a file")
		.option("-e, --expires <seconds>", "URL expiry in seconds", Number.parseInt)
		.action(async (bucketIdentifier, fileName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Generating download URL...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets, bucketIdentifier);

				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}

				const result = await client.storage.getDownloadUrl.query({
					bucketId: bucket.bucketId || bucket.id,
					fileName,
					expiresIn: options.expires || 3600,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				log("");
				log(`Download URL for ${colors.cyan(fileName)}:`);
				log("");
				log(`  ${colors.cyan(result.url || result)}`);
				log("");
				log(colors.dim(`Expires in ${options.expires || 3600} seconds`));
				log("");
			} catch (err) {
				handleError(err);
			}
		});

	// ── Upgrade bucket ──────────────────────────────────────────────────────────
	storage
		.command("upgrade")
		.argument("<bucket>", "Bucket name or ID")
		.description("Upgrade bucket to a higher plan")
		.option("--plan <plan>", "Target plan (standard, pro)")
		.action(async (bucketIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const targetPlan =
					options.plan ||
					(await input("Target plan (standard/pro):", undefined, {
						field: "plan",
						flag: "--plan",
					}));
				const _upgradeSpinner = startSpinner(
					`Upgrading bucket to ${targetPlan}...`,
				);
				await client.storage.upgrade.mutate({ bucketId, targetPlan } as any);
				succeedSpinner(`Bucket upgraded to ${targetPlan}.`);
				if (isJsonMode()) outputData({ upgraded: true, bucketId, targetPlan });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Update bucket ────────────────────────────────────────────────────────────
	storage
		.command("update")
		.argument("<bucket>", "Bucket name or ID")
		.description("Update bucket settings")
		.option("-n, --name <name>", "New name")
		.option("--description <text>", "New description")
		.option("--public", "Make bucket public")
		.option("--private", "Make bucket private")
		.option("--storage-limit <bytes>", "Storage limit in bytes")
		.action(async (bucketIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const publicAccess = options.public
					? true
					: options.private
						? false
						: undefined;
				const _updateSpinner = startSpinner("Updating bucket...");
				await client.storage.update.mutate({
					bucketId,
					name: options.name,
					description: options.description,
					publicAccess,
					storageLimit: options.storageLimit
						? Number.parseInt(options.storageLimit)
						: undefined,
				} as any);
				succeedSpinner("Bucket updated.");
				if (isJsonMode()) outputData({ updated: true, bucketId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── External access ──────────────────────────────────────────────────────────
	storage
		.command("external-access")
		.argument("<bucket>", "Bucket name or ID")
		.description("Configure external access CIDRs for a bucket")
		.option("--enable", "Enable external access")
		.option("--disable", "Disable external access")
		.option("--cidrs <list>", "Comma-separated list of allowed CIDRs")
		.action(async (bucketIdentifier, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const enabled = options.enable ? true : !options.disable;
				const allowedCidrs = options.cidrs
					? options.cidrs.split(",").map((c: string) => c.trim())
					: undefined;
				const _updateSpinner = startSpinner("Updating external access...");
				await client.storage.updateExternalAccess.mutate({
					bucketId,
					enabled,
					allowedCidrs,
				} as any);
				succeedSpinner("External access updated.");
				if (isJsonMode()) outputData({ updated: true, bucketId, enabled });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Get upload URL ──────────────────────────────────────────────────────────
	storage
		.command("upload-url")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<filename>", "File name to upload")
		.description("Get a pre-signed upload URL for direct file upload")
		.option("--size <bytes>", "File size in bytes")
		.option("--content-type <type>", "Content type")
		.option("--expires <seconds>", "URL expiry in seconds", "3600")
		.action(async (bucketIdentifier, fileName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _urlSpinner = startSpinner("Generating upload URL...");
				const result = await client.storage.getUploadUrl.mutate({
					bucketId,
					fileName,
					fileSizeBytes: options.size ? Number.parseInt(options.size) : 0,
					contentType: options.contentType,
					expiresIn: Number.parseInt(options.expires || "3600"),
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				log("");
				log(
					`Upload URL: ${colors.cyan(r.url || r.uploadUrl || String(result))}`,
				);
				if (r.fields) log(`Fields:     ${JSON.stringify(r.fields)}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Complete upload ──────────────────────────────────────────────────────────
	storage
		.command("complete-upload")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<filename>", "Uploaded file name")
		.description("Notify the platform that a file upload completed")
		.option("--size <bytes>", "Actual uploaded size in bytes", "0")
		.option("--expected-size <bytes>", "Expected size in bytes", "0")
		.action(async (bucketIdentifier, fileName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _completeSpinner = startSpinner("Completing upload...");
				await client.storage.completeUpload.mutate({
					bucketId,
					fileName,
					expectedSizeBytes: Number.parseInt(options.expectedSize || "0"),
					existingSizeBytes: Number.parseInt(options.size || "0"),
				} as any);
				succeedSpinner("Upload completed.");
				if (isJsonMode()) outputData({ completed: true, fileName });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Create folder ────────────────────────────────────────────────────────────
	storage
		.command("mkdir")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<folder>", "Folder name")
		.description("Create a folder in a storage bucket")
		.option("--prefix <prefix>", "Parent folder prefix")
		.action(async (bucketIdentifier, folderName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _mkdirSpinner = startSpinner(`Creating folder ${folderName}...`);
				await client.storage.createFolder.mutate({
					bucketId,
					folderName,
					prefix: options.prefix,
				} as any);
				succeedSpinner(`Folder created: ${folderName}`);
				if (isJsonMode()) outputData({ created: true, folderName });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Attach to application ────────────────────────────────────────────────────
	storage
		.command("attach")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<app-id>", "Application ID")
		.description("Attach a storage bucket to an application")
		.action(async (bucketIdentifier, applicationId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _attachSpinner = startSpinner("Attaching bucket...");
				await client.storage.attachToApplication.mutate({
					bucketId,
					applicationId,
				} as any);
				succeedSpinner("Bucket attached to application.");
				if (isJsonMode())
					outputData({ attached: true, bucketId, applicationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Detach from application ──────────────────────────────────────────────────
	storage
		.command("detach")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<app-id>", "Application ID")
		.description("Detach a storage bucket from an application")
		.action(async (bucketIdentifier, applicationId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _detachSpinner = startSpinner("Detaching bucket...");
				await client.storage.detachFromApplication.mutate({
					bucketId,
					applicationId,
				} as any);
				succeedSpinner("Bucket detached from application.");
				if (isJsonMode())
					outputData({ detached: true, bucketId, applicationId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── File versions ────────────────────────────────────────────────────────────
	storage
		.command("versions")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<filename>", "File name")
		.description("List versions of a file in a storage bucket")
		.action(async (bucketIdentifier, fileName) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _versionsSpinner = startSpinner("Fetching versions...");
				const versions = await client.storage.getFileVersions.query({
					bucketId,
					fileName,
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(versions);
					return;
				}
				const list = Array.isArray(versions) ? versions : [];
				if (list.length === 0) {
					log("No versions found.");
					return;
				}
				log("");
				table(
					["VERSION ID", "SIZE", "LAST MODIFIED", "CURRENT"],
					list.map((v: any) => [
						colors.dim(v.versionId || v.id || "-"),
						v.size ? formatBytes(v.size) : "-",
						v.lastModified ? new Date(v.lastModified).toLocaleString() : "-",
						v.isLatest ? colors.success("●") : "",
					]),
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Restore file version ─────────────────────────────────────────────────────
	storage
		.command("restore-version")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<filename>", "File name")
		.argument("<version-id>", "Version ID to restore")
		.description("Restore a file to a previous version")
		.action(async (bucketIdentifier, fileName, versionId) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _restoreSpinner = startSpinner("Restoring file version...");
				await client.storage.restoreFileVersion.mutate({
					bucketId,
					fileName,
					versionId,
				} as any);
				succeedSpinner(`File restored to version ${versionId}.`);
				if (isJsonMode()) outputData({ restored: true, fileName, versionId });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Version download URL ─────────────────────────────────────────────────────
	storage
		.command("version-url")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<filename>", "File name")
		.argument("<version-id>", "Version ID")
		.description("Get a download URL for a specific file version")
		.option("--expires <seconds>", "URL expiry in seconds", "3600")
		.action(async (bucketIdentifier, fileName, versionId, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
				if (!bucket) {
					failSpinner();
					throw new NotFoundError("Storage bucket", bucketIdentifier);
				}
				const bucketId = bucket.bucketId || bucket.id;
				const _urlSpinner = startSpinner("Generating version download URL...");
				const result = await client.storage.getVersionDownloadUrl.query({
					bucketId,
					fileName,
					versionId,
					expiresIn: Number.parseInt(options.expires || "3600"),
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				log("");
				log(`Version URL: ${colors.cyan(r.url || String(result))}`);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});
}

function findBucket(buckets: any[], identifier: string) {
	const lower = identifier.toLowerCase();
	return buckets.find(
		(b: any) =>
			(b.bucketId || b.id) === identifier ||
			(b.bucketId || b.id || "").startsWith(identifier) ||
			b.name.toLowerCase() === lower,
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
