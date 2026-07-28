import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { getCurrentProfile, isLoggedIn } from "../lib/config.js";
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
	isJsonMode,
	isNonInteractiveMode,
	isQuietMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input, select } from "../utils/prompts.js";
import { failSpinner, startSpinner, succeedSpinner } from "../utils/spinner.js";
import {
	loadResourceTiers,
	pickDefaultResourceTier,
	type ResourcePlan,
} from "./deploy.js";

const STORAGE_TIER_LABEL: Record<ResourcePlan, string> = {
	FREE: "FREE (1 GB)",
	STARTER: "STARTER (10 GB)",
	STANDARD: "STANDARD (100 GB)",
	PRO: "PRO (1 TB)",
};

function normalizeStoragePlan(
	value: string | undefined,
): ResourcePlan | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toUpperCase();
	if (
		normalized === "FREE" ||
		normalized === "STARTER" ||
		normalized === "STANDARD" ||
		normalized === "PRO"
	) {
		return normalized as ResourcePlan;
	}
	return undefined;
}

/**
 * Resolve the `--public` / `--private` pair into the `publicAccess` boolean the
 * platform expects. This file expresses booleans as explicit opposing flags
 * (see `--enable`/`--disable` on `external-access`), not commander's
 * `--x/--no-x`, so both flags are plain booleans and may both be absent —
 * which must mean "leave it alone" on `update`, hence `undefined`.
 */
function resolvePublicAccess(options: {
	public?: boolean;
	private?: boolean;
}): boolean | undefined {
	if (options.public && options.private) {
		throw new InvalidArgumentError(
			"Cannot use --public and --private together. Pick one.",
		);
	}
	if (options.public) return true;
	if (options.private) return false;
	return undefined;
}

/**
 * A public bucket is served to the entire internet with no credentials at all
 * (the storage gateway resolves public buckets and answers anonymous GETs), so
 * every surface that flips the flag on has to say so out loud.
 */
function warnPublicAccess(publicUrl?: string | null) {
	if (isJsonMode()) return;
	log("");
	log(
		colors.warn(
			"This bucket is PUBLIC: anyone with the object URL can read its files without credentials, no signed URL required.",
		),
	);
	if (publicUrl) {
		log(`Public base URL: ${colors.cyan(publicUrl)}`);
	}
}

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

				if (isQuietMode()) {
					for (const b of (buckets || []) as any[]) {
						const id = b.bucketId || b.id;
						if (id) quietOutput(String(id));
					}
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
		.option(
			"-p, --plan <plan>",
			"Plan: free, starter, standard, or pro (defaults to this project's entitled tier)",
		)
		.option("-d, --description <text>", "Bucket description")
		.option(
			"--public",
			"Serve this bucket's objects to anyone, unauthenticated (default: private)",
		)
		.option("--private", "Keep the bucket private (default)")
		.action(async (name, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const profile = getCurrentProfile();
				if (!profile) throw new AuthError();

				// Default to private: omitting both flags must not change the
				// behaviour anyone already scripted against.
				const publicAccess = resolvePublicAccess(options) ?? false;

				let bucketName = name;

				if (!bucketName) {
					bucketName = await input("Bucket name:", undefined, {
						field: "name",
						flag: "--name",
					});
				}

				const client = getApiClient();

				// Default to the tier the org is actually entitled to instead of
				// hardcoding FREE — a paid org without a free storage slot would
				// otherwise hit storage.free.slots: 1/0. Explicit --plan always wins.
				let plan: ResourcePlan;
				const explicit = normalizeStoragePlan(options.plan);
				if (explicit) {
					plan = explicit;
				} else {
					const tiers = await loadResourceTiers(client, "storage");
					const def = pickDefaultResourceTier(tiers);
					if (
						isJsonMode() ||
						isNonInteractiveMode() ||
						shouldSkipConfirmation()
					) {
						plan = def;
					} else {
						const order: ResourcePlan[] = [
							def,
							...(
								["FREE", "STARTER", "STANDARD", "PRO"] as ResourcePlan[]
							).filter((t) => t !== def),
						];
						plan = await select<ResourcePlan>(
							"Storage plan:",
							order.map((t) => ({
								name: `${STORAGE_TIER_LABEL[t]}${t === def ? `  ${colors.dim("recommended")}` : ""}`,
								value: t,
							})),
							{ field: "plan", flag: "--plan" },
						);
					}
				}

				const _spinner = startSpinner("Creating storage bucket...");

				// storage.create takes `publicAccess: z.boolean().default(false)` and
				// persists it as-is — public buckets are a supported product feature
				// (the gateway answers anonymous reads for them), so pass the user's
				// choice through instead of hardcoding private.
				const bucket = await client.storage.create.mutate({
					name: bucketName,
					plan,
					description: options.description,
					publicAccess,
				});

				succeedSpinner("Storage bucket created!");

				const bucketId = bucket.bucketId || bucket.id;

				if (isJsonMode()) {
					outputData(bucket);
					return;
				}

				quietOutput(bucketId);

				// Trust the server's echo of publicAccess over the local flag — the
				// procedure is the one that decided.
				const isPublic = Boolean((bucket as any).publicAccess);
				const publicUrl = (bucket as any).publicUrl as string | null | undefined;

				box("Storage Bucket Created", [
					`ID: ${colors.cyan(bucketId)}`,
					`Name: ${bucket.name}`,
					`Plan: ${plan}`,
					`Access: ${isPublic ? colors.warn("public (unauthenticated reads)") : "private"}`,
					...(isPublic && publicUrl ? [`Public URL: ${publicUrl}`] : []),
				]);

				// The box already carries the URL; don't repeat it in the warning.
				if (isPublic) warnPublicAccess();

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

				quietOutput(bucketId);

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
				// findById returns `publicUrl` (non-null only for public, non-CUSTOM
				// buckets). Never build this URL by hand — the server owns the shape.
				const infoPublicUrl = (bucket as any).publicUrl as
					| string
					| null
					| undefined;
				if (bucket.publicAccess) {
					log("");
					log(colors.bold("Public URL"));
					log(
						`  ${infoPublicUrl ? colors.cyan(infoPublicUrl) : colors.dim("Not available")}`,
					);
					log("");
					log(
						colors.warn(
							"  Anyone can read this bucket's objects without credentials.",
						),
					);
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
				} else {
					quietOutput(fileName);
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

				const result = await client.storage.getDownloadUrl.mutate({
					bucketId: bucket.bucketId || bucket.id,
					fileName,
					expiresIn: options.expires || 3600,
				});

				succeedSpinner();

				if (isJsonMode()) {
					outputData(result);
					return;
				}

				// Quiet mode: emit the bare download URL for scripting/piping.
				quietOutput(String((result as any)?.url || result));

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
				const rawPlan =
					options.plan ||
					(await input("Target plan (STARTER/STANDARD/PRO):", undefined, {
						field: "plan",
						flag: "--plan",
					}));
				// upgrade input is { bucketId, targetPlan: enum STARTER/STANDARD/PRO }.
				const targetPlan = String(rawPlan).trim().toUpperCase();
				if (
					targetPlan !== "STARTER" &&
					targetPlan !== "STANDARD" &&
					targetPlan !== "PRO"
				) {
					failSpinner();
					throw new CliError(
						`Invalid target plan "${rawPlan}". Must be one of: STARTER, STANDARD, PRO.`,
					);
				}
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
		.option(
			"--public",
			"Make the bucket public (unauthenticated reads for anyone)",
		)
		.option("--private", "Make bucket private")
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
				// update input is .strict() and only accepts
				// { bucketId, name?, description?, publicAccess? }; there is no
				// storageLimit field on this procedure. publicAccess:true IS accepted
				// and persisted (public buckets are a real feature), so both --public
				// and --private are wired. Leaving both off sends `undefined`, which
				// keeps the bucket's current visibility.
				const publicAccess = resolvePublicAccess(options);
				const _updateSpinner = startSpinner("Updating bucket...");
				const updated = (await client.storage.update.mutate({
					bucketId,
					name: options.name,
					description: options.description,
					publicAccess,
				} as any)) as any;
				succeedSpinner("Bucket updated.");
				if (isJsonMode()) {
					outputData({ updated: true, bucketId, ...updated });
					return;
				}
				// Only shout when the bucket ends up public — `update` echoes the
				// stored publicAccess/publicUrl, so this is accurate even when the
				// flags were left off and it was already public.
				if (updated?.publicAccess) warnPublicAccess(updated.publicUrl);
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
				// getUploadUrl requires a positive fileSizeBytes — the server
				// reserves that much quota up front, so --size is mandatory.
				const fileSizeBytes = options.size
					? Number.parseInt(options.size)
					: Number.NaN;
				if (!Number.isInteger(fileSizeBytes) || fileSizeBytes <= 0) {
					failSpinner();
					throw new CliError(
						"A positive --size <bytes> is required to generate an upload URL.",
					);
				}
				const _urlSpinner = startSpinner("Generating upload URL...");
				const result = await client.storage.getUploadUrl.mutate({
					bucketId,
					fileName,
					fileSizeBytes,
					contentType: options.contentType,
					expiresIn: Number.parseInt(options.expires || "3600"),
				} as any);
				succeedSpinner();
				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const r = result as any;
				// Quiet mode: emit the bare upload URL for scripting/piping.
				quietOutput(String(r.url || r.uploadUrl || result));
				log("");
				log(
					`Upload URL: ${colors.cyan(r.url || r.uploadUrl || String(result))}`,
				);
				if (r.requiredHeaders && Object.keys(r.requiredHeaders).length > 0) {
					log("Required headers:");
					for (const [key, value] of Object.entries(r.requiredHeaders)) {
						log(`  ${key}: ${String(value)}`);
					}
				}
				if (r.reservationToken) {
					log(`Reservation token: ${colors.dim(r.reservationToken)}`);
				}
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
		.option("--size <bytes>", "Size that existed before this upload, in bytes", "0")
		.option("--expected-size <bytes>", "Expected uploaded size in bytes")
		.option(
			"--reservation-token <token>",
			"Durable reservation token returned by upload-url",
		)
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
				// completeUpload requires a positive expectedSizeBytes; existing
				// (pre-upload) size may be 0.
				const expectedSizeBytes = options.expectedSize
					? Number.parseInt(options.expectedSize)
					: Number.NaN;
				if (!Number.isInteger(expectedSizeBytes) || expectedSizeBytes <= 0) {
					failSpinner();
					throw new CliError(
						"A positive --expected-size <bytes> is required to complete an upload.",
					);
				}
				const _completeSpinner = startSpinner("Completing upload...");
				await client.storage.completeUpload.mutate({
					bucketId,
					reservationToken: options.reservationToken,
					fileName,
					expectedSizeBytes,
					existingSizeBytes: Number.parseInt(options.size || "0"),
				} as any);
				succeedSpinner("Upload completed.");
				if (isJsonMode()) outputData({ completed: true, fileName });
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Upload a local file (real byte transfer) ──────────────────────────────────
	storage
		.command("put")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<key>", "Destination object key / file name in the bucket")
		.argument("<file>", "Path to the local file to upload")
		.description("Upload a local file's bytes to a bucket via a pre-signed URL")
		.option("--content-type <type>", "Content type of the uploaded object")
		.option("--expires <seconds>", "Upload URL expiry in seconds", "3600")
		.action(async (bucketIdentifier, key, filePath, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
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
				const bucketId = bucket.bucketId || bucket.id;
				// Read the local file's bytes + size before requesting an upload URL —
				// getUploadUrl reserves exactly fileSizeBytes of quota up front.
				let body: Buffer;
				let fileSizeBytes: number;
				try {
					body = readFileSync(filePath);
					fileSizeBytes = statSync(filePath).size;
				} catch (readErr) {
					failSpinner();
					throw new CliError(
						`Could not read file "${filePath}": ${
							readErr instanceof Error ? readErr.message : String(readErr)
						}`,
					);
				}
				if (fileSizeBytes <= 0) {
					failSpinner();
					throw new CliError(`File "${filePath}" is empty; nothing to upload.`);
				}
				const _urlSpinner = startSpinner("Generating upload URL...");
				const upload = (await client.storage.getUploadUrl.mutate({
					bucketId,
					fileName: key,
					fileSizeBytes,
					contentType: options.contentType,
					expiresIn: Number.parseInt(options.expires || "3600"),
				} as any)) as any;
				const uploadUrl = upload.url || upload.uploadUrl;
				if (!uploadUrl) {
					failSpinner();
					throw new CliError("The platform did not return an upload URL.");
				}
				const _putSpinner = startSpinner(
					`Uploading ${formatBytes(fileSizeBytes)}...`,
				);
				// The presigned PUT signs Content-Length (undici sets it from the
				// Buffer automatically) plus every header in requiredHeaders (the
				// generation precondition and, when given, Content-Type) — forward
				// them verbatim or the signature/precondition check fails.
				const putRes = await fetch(uploadUrl, {
					method: "PUT",
					headers: (upload.requiredHeaders || {}) as Record<string, string>,
					body,
				});
				if (!putRes.ok) {
					failSpinner();
					const detail = await putRes.text().catch(() => "");
					throw new CliError(
						`Upload failed (HTTP ${putRes.status} ${putRes.statusText})${
							detail ? `: ${detail.slice(0, 200)}` : ""
						}.`,
					);
				}
				// Finalize the reservation / quota accounting. Echo the reservation
				// token + sizes returned by getUploadUrl (mirrors `complete-upload`).
				await client.storage.completeUpload.mutate({
					bucketId,
					reservationToken: upload.reservationToken,
					fileName: key,
					expectedSizeBytes: upload.expectedSizeBytes ?? fileSizeBytes,
					existingSizeBytes: upload.existingSizeBytes ?? 0,
				} as any);
				succeedSpinner("File uploaded.");
				if (isJsonMode()) {
					outputData({ uploaded: true, bucketId, key, size: fileSizeBytes });
					return;
				}
				quietOutput(key);
				log("");
				log(
					`Uploaded ${colors.cyan(key)} (${formatBytes(fileSizeBytes)}) to ${colors.bold(bucket.name)}.`,
				);
				log("");
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// ── Download an object to a local file (real byte transfer) ───────────────────
	storage
		.command("get")
		.argument("<bucket>", "Bucket name or ID")
		.argument("<key>", "Object key / file name in the bucket")
		.argument("<file>", "Local path to write the downloaded bytes to")
		.description("Download an object's bytes from a bucket to a local file")
		.option("--expires <seconds>", "Download URL expiry in seconds", "3600")
		.action(async (bucketIdentifier, key, filePath, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const client = getApiClient();
				const _spinner = startSpinner("Fetching buckets...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);
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
				const bucketId = bucket.bucketId || bucket.id;
				const _urlSpinner = startSpinner("Generating download URL...");
				const result = (await client.storage.getDownloadUrl.mutate({
					bucketId,
					fileName: key,
					expiresIn: Number.parseInt(options.expires || "3600"),
				} as any)) as any;
				const downloadUrl = result.url || result;
				if (!downloadUrl || typeof downloadUrl !== "string") {
					failSpinner();
					throw new CliError("The platform did not return a download URL.");
				}
				const _getSpinner = startSpinner("Downloading...");
				const res = await fetch(downloadUrl, { method: "GET" });
				if (!res.ok) {
					failSpinner();
					const detail = await res.text().catch(() => "");
					throw new CliError(
						`Download failed (HTTP ${res.status} ${res.statusText})${
							detail ? `: ${detail.slice(0, 200)}` : ""
						}.`,
					);
				}
				const bytes = Buffer.from(await res.arrayBuffer());
				try {
					writeFileSync(filePath, bytes);
				} catch (writeErr) {
					failSpinner();
					throw new CliError(
						`Could not write to "${filePath}": ${
							writeErr instanceof Error ? writeErr.message : String(writeErr)
						}`,
					);
				}
				succeedSpinner("File downloaded.");
				if (isJsonMode()) {
					outputData({
						downloaded: true,
						bucketId,
						key,
						path: filePath,
						size: bytes.byteLength,
					});
					return;
				}
				quietOutput(filePath);
				log("");
				log(
					`Downloaded ${colors.cyan(key)} → ${colors.bold(filePath)} (${formatBytes(bytes.byteLength)}).`,
				);
				log("");
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
				const result = await client.storage.getVersionDownloadUrl.mutate({
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
				// Quiet mode: emit the bare version download URL for scripting/piping.
				quietOutput(String(r.url || result));
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
