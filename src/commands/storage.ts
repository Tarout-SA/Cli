import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	CliError,
	findSimilar,
	handleError,
	InvalidArgumentError,
	NotFoundError,
	PermissionError,
} from "../lib/errors.js";
import {
	box,
	colors,
	isJsonMode,
	isQuietMode,
	log,
	outputData,
	quietOutput,
	shouldSkipConfirmation,
	table,
} from "../lib/output.js";
import { confirm, input } from "../utils/prompts.js";
import {
	failSpinner,
	startSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";
import { requireProfile } from "../lib/auth-profile.js";

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

/**
 * The platform's own `MAX_FILE_LIST_PAGE_SIZE` (its storage router). Asking for
 * more than this is rejected by Zod, so the CLI never requests a bigger page.
 */
const FILE_LIST_MAX_PAGE_SIZE = 1000;

/**
 * Split a user-supplied folder path into its segments, rejecting anything that
 * would address something other than a folder inside this bucket. `..` is the
 * one that matters: object keys are strings, so a `../` segment does not walk
 * out of the bucket the way a filesystem path would — it silently builds a
 * DIFFERENT prefix (`a/../b/` is not `b/`), and on a recursive delete that is a
 * prefix the caller never meant to name. `.` is rejected for the same reason,
 * and empty segments (`a//b`) because they produce a prefix that matches
 * nothing.
 */
function splitFolderSegments(raw: string, flagHint: string): string[] {
	const trimmed = String(raw ?? "").trim();
	const stripped = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
	if (!stripped) {
		throw new InvalidArgumentError(
			`A folder path is required${flagHint}. "/" and "" mean the whole bucket, which this command will not act on.`,
		);
	}
	const segments = stripped.split("/");
	if (segments.some((segment) => segment === "" )) {
		throw new InvalidArgumentError(
			`Folder path "${raw}" has an empty path segment. Use single slashes, for example "logs/2026".`,
		);
	}
	if (segments.some((segment) => segment === "." || segment === "..")) {
		throw new InvalidArgumentError(
			`Folder path "${raw}" contains a "." or ".." segment. Object keys are not filesystem paths: a relative segment does not escape to a parent, it names a literally different prefix. Pass the path as it appears in \`tarout storage browse\`.`,
		);
	}
	return segments;
}

/**
 * Normalize a folder path into the `prefix` the platform's storage procedures
 * expect: no leading slash, exactly one trailing slash. Required — the whole
 * bucket is never an acceptable target here (`storage delete` is the command
 * that removes a bucket).
 */
export function normalizeFolderPrefix(raw: string): string {
	return `${splitFolderSegments(raw, " (for example logs/2026)").join("/")}/`;
}

/**
 * Same normalization for a browse/listing prefix, except that the root of the
 * bucket is legal and is expressed as the empty string (which is exactly what
 * `storage.browse` wants for the top level).
 */
export function normalizeBrowsePrefix(raw: string | undefined): string {
	const trimmed = String(raw ?? "").trim();
	if (!trimmed || trimmed === "/") return "";
	return `${splitFolderSegments(trimmed, "").join("/")}/`;
}

/**
 * How much a recursive folder delete is about to remove, in words. The count
 * comes from a listing page, so it is a floor whenever that listing was capped:
 * say so rather than under-reporting a destructive operation.
 */
export function describeFolderDeletionScope(
	objectCount: number,
	truncated: boolean,
): string {
	const count = Math.max(0, Math.trunc(objectCount)).toLocaleString("en-US");
	if (truncated) {
		return `at least ${count} objects (the listing was capped at ${FILE_LIST_MAX_PAGE_SIZE.toLocaleString("en-US")}, so there may be more)`;
	}
	if (objectCount === 0) {
		return "no objects (this folder is already empty, or nothing in the bucket has that prefix)";
	}
	return `${count} object${objectCount === 1 ? "" : "s"}`;
}

/**
 * `storage.getBucketStats` as display lines. These numbers are measured live
 * from the object store, unlike the `storageUsed` / `filesCount` counters
 * `storage info` prints, which only track writes that went through the Tarout
 * gateway and therefore read 0 for a bucket written to directly with S3
 * credentials. `truncated` means the server stopped paging and the counts are a
 * floor; `noncurrentBytes` is retained object versions, which are invisible to
 * a listing but are stored and billed.
 */
export function formatBucketStatsLines(stats: {
	fileCount?: unknown;
	totalBytes?: unknown;
	noncurrentBytes?: unknown;
	truncated?: unknown;
}): string[] {
	const count =
		typeof stats?.fileCount === "number" && Number.isFinite(stats.fileCount)
			? stats.fileCount
			: 0;
	const totalBytes =
		typeof stats?.totalBytes === "number" ? stats.totalBytes : 0;
	const noncurrentBytes =
		typeof stats?.noncurrentBytes === "number" ? stats.noncurrentBytes : 0;
	const truncated = Boolean(stats?.truncated);

	const lines = [
		`Objects: ${truncated ? "at least " : ""}${count.toLocaleString("en-US")}`,
		`Live size: ${truncated ? "at least " : ""}${formatBytes(totalBytes)}`,
	];
	if (noncurrentBytes > 0) {
		lines.push(
			`Retained versions: ${formatBytes(noncurrentBytes)} (older generations kept by versioning — stored and billed, but not listed)`,
		);
		lines.push(`Billed total: ${formatBytes(totalBytes + noncurrentBytes)}`);
	}
	if (truncated) {
		lines.push(
			"Truncated: yes — the bucket holds more objects than one measurement pass covers, so these are floors, not totals",
		);
	}
	return lines;
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
			"Ignored: the platform picks the bucket plan from this project's subscription (kept so older scripts keep working)",
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

				await requireProfile();

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
				// storage.create stores `input.name.trim()`; send the same value so
				// the name printed below is the one the platform kept.
				const sentName =
					typeof bucketName === "string" && bucketName.trim()
						? bucketName.trim()
						: undefined;

				// storage.create derives the bucket plan from the project's
				// subscription (managedStoragePlanForPlanKey) and ignores any plan
				// in the input, so there is nothing to choose here. --plan stays
				// accepted for old scripts but is not sent.
				if (options.plan && !isJsonMode()) {
					log(
						colors.dim(
							"Note: --plan is ignored. The platform picks the bucket plan from this project's subscription.",
						),
					);
				}

				const client = getApiClient();

				const _spinner = startSpinner("Creating storage bucket...");

				// storage.create takes `publicAccess: z.boolean().default(false)` and
				// persists it as-is. Public buckets are a supported product feature
				// (the gateway answers anonymous reads for them), so pass the user's
				// choice through instead of hardcoding private.
				const bucket = (await client.storage.create.mutate({
					name: sentName,
					description: options.description,
					publicAccess,
				})) as {
					bucketId: string;
					plan?: string;
					publicAccess?: boolean;
					publicUrl?: string | null;
					endpoint?: string | null;
				};

				succeedSpinner("Storage bucket created!");

				const bucketId = bucket.bucketId;

				if (isJsonMode()) {
					outputData(bucket);
					return;
				}

				quietOutput(bucketId);

				// Trust the server's echo of publicAccess over the local flag: the
				// procedure is the one that decided.
				const isPublic = Boolean(bucket.publicAccess);
				const publicUrl = bucket.publicUrl;

				// The create response carries no `name` (only bucketId, plan,
				// publicAccess, endpoint, publicUrl and provider internals), so the
				// name line shows what was sent, which the server stores verbatim.
				box("Storage Bucket Created", [
					`ID: ${colors.cyan(bucketId)}`,
					...(sentName ? [`Name: ${sentName}`] : []),
					...(bucket.plan ? [`Plan: ${bucket.plan}`] : []),
					`Access: ${isPublic ? colors.warn("public (unauthenticated reads)") : "private"}`,
					...(isPublic && publicUrl ? [`Public URL: ${publicUrl}`] : []),
				]);

				// The box already carries the URL; don't repeat it in the warning.
				if (isPublic) warnPublicAccess();

				log(`Browse files: ${colors.dim(`tarout storage files ${bucketId}`)}`);
				// Managed buckets never hand out provider credentials
				// (storage.getCredentials is FORBIDDEN unless plan is CUSTOM). An app
				// gets a scoped key and the S3 env vars through attachToApplication.
				log(
					`Use it from an app: ${colors.dim(`tarout storage attach ${bucketId} <app-id>`)}`,
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
				// findById sends `storageUsed` and `filesCount` (the dashboard reads
				// the same pair). There is no usedBytes/fileCount field.
				log(
					`  Used: ${formatBytes(Number(bucket.storageUsed) || 0)} / ${formatBytes(Number(bucket.storageLimit) || 0)}`,
				);
				log(`  Files: ${Number(bucket.filesCount) || 0}`);
				// Those two counters only track writes made through the Tarout
				// gateway, so a bucket written to directly with S3 credentials reports
				// 0 here. `storage stats` measures the object store itself.
				log(
					colors.dim(
						`  Counters track gateway writes only — measure the bucket itself with: tarout storage stats ${bucket.name}`,
					),
				);
				log("");
				log(colors.bold("Endpoint"));
				if (bucket.endpoint) {
					log(`  ${colors.cyan(bucket.endpoint)}`);
				} else {
					log(`  ${colors.dim("Not available")}`);
				}
				// findById returns `publicUrl` (non-null only for public, non-CUSTOM
				// buckets). Never build this URL by hand: the server owns the shape.
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

	// Live object/size measurement. Deliberately a second command rather than
	// folded into `storage info`: info is a cheap metadata read, while this walks
	// the object store page by page (up to ~20k objects server-side) and is the
	// only source that is correct for a bucket written to directly.
	storage
		.command("stats")
		.argument("<bucket>", "Bucket ID or name")
		.description(
			"Measure a bucket's real object count and size by walking the object store, and report retained (noncurrent) versions alongside. This is the number to trust: the Used / Files figures in `tarout storage info` come from counters that only track writes made through the Tarout gateway, so they read 0 for a bucket an application wrote to directly with its own S3 credentials. Very large buckets are reported as floors — the server caps the measurement and flags it.",
		)
		.action(async (bucketIdentifier) => {
			try {
				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding bucket...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);

				if (!bucket) {
					failSpinner();
					const suggestions = findSimilar(
						bucketIdentifier,
						(buckets as any[]).map((b: any) => b.name),
					);
					throw new NotFoundError(
						"Storage bucket",
						bucketIdentifier,
						suggestions,
					);
				}

				const bucketId = bucket.bucketId || bucket.id;
				const _statsSpinner = startSpinner("Measuring bucket...");
				// Returns { fileCount, totalBytes, noncurrentBytes, truncated }.
				const stats: any = await client.storage.getBucketStats.query({
					bucketId,
				});
				succeedSpinner();

				if (isJsonMode()) {
					outputData(stats);
					return;
				}

				quietOutput(String(Number(stats?.totalBytes) || 0));

				log("");
				log(colors.bold(`${bucket.name} — measured now`));
				for (const line of formatBucketStatsLines(stats)) {
					log(`  ${line}`);
				}
				log("");
			} catch (err) {
				failSpinner();
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

	// One-level, hierarchical listing. Genuinely different from `storage files`,
	// which calls `storage.getFiles`: that one lists every object under a prefix,
	// nested ones included and flattened, with folders appearing only as
	// ".placeholder" markers. This calls `storage.browse`, which uses a delimiter
	// listing and returns the immediate children plus the real subfolders, so a
	// bucket can be walked a directory at a time.
	storage
		.command("browse")
		.argument("<bucket>", "Bucket ID or name")
		.argument("[folder]", "Folder to open (default: the bucket root)")
		.description(
			"Open one folder of a bucket and list its immediate contents: the subfolders you can descend into and the files directly inside it. Use this to navigate a bucket level by level — `tarout storage files` is the flat alternative that lists every object under a prefix, nested ones included, and shows folders only as placeholder markers. Pass a folder path (as printed here) to descend, and --limit with the printed next-page token to page through a wide folder.",
		)
		.option("-n, --limit <n>", `Max entries per page (1-${FILE_LIST_MAX_PAGE_SIZE})`)
		.option("--page-token <token>", "Continue from a previous page's token")
		.action(async (bucketIdentifier, folder, options) => {
			try {
				const prefix = normalizeBrowsePrefix(folder);
				let maxResults: number | undefined;
				if (options.limit !== undefined) {
					const parsed = Number(options.limit);
					if (
						!Number.isInteger(parsed) ||
						parsed < 1 ||
						parsed > FILE_LIST_MAX_PAGE_SIZE
					) {
						throw new InvalidArgumentError(
							`--limit must be a whole number from 1 to ${FILE_LIST_MAX_PAGE_SIZE}; got "${options.limit}".`,
						);
					}
					maxResults = parsed;
				}

				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding bucket...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);

				if (!bucket) {
					failSpinner();
					const suggestions = findSimilar(
						bucketIdentifier,
						(buckets as any[]).map((b: any) => b.name),
					);
					throw new NotFoundError(
						"Storage bucket",
						bucketIdentifier,
						suggestions,
					);
				}

				const bucketId = bucket.bucketId || bucket.id;
				const _browseSpinner = startSpinner("Listing folder...");
				// Returns { prefix, folders: [{ name, prefix }], files: [{ name,
				// path, size, contentType, createdAt, updatedAt }], nextPageToken }.
				const listing: any = await client.storage.browse.query({
					bucketId,
					prefix,
					...(maxResults === undefined ? {} : { maxResults }),
					...(options.pageToken ? { pageToken: options.pageToken } : {}),
				});
				succeedSpinner();

				if (isJsonMode()) {
					outputData(listing);
					return;
				}

				const folders: any[] = Array.isArray(listing?.folders)
					? listing.folders
					: [];
				const files: any[] = Array.isArray(listing?.files) ? listing.files : [];

				if (isQuietMode()) {
					// One path per line, folders with their trailing slash, so the
					// output can be fed straight back into this command.
					for (const f of folders) quietOutput(`${prefix}${f.name}/`);
					for (const f of files) quietOutput(String(f.path ?? f.name ?? ""));
					return;
				}

				const here = prefix || "/";
				log("");
				log(`${colors.cyan(bucket.name)} ${colors.dim(here)}`);

				if (folders.length === 0 && files.length === 0) {
					log("");
					log(
						prefix
							? `This folder is empty, or no object in the bucket has the prefix ${colors.dim(prefix)}.`
							: "This bucket is empty.",
					);
					log("");
					return;
				}

				log("");
				table(
					["TYPE", "NAME", "SIZE", "UPDATED"],
					[
						...folders.map((f: any) => [
							colors.dim("dir"),
							`${colors.cyan(String(f.name ?? ""))}/`,
							colors.dim("-"),
							colors.dim("-"),
						]),
						...files.map((f: any) => [
							colors.dim("file"),
							String(f.name ?? ""),
							formatBytes(Number(f.size) || 0),
							formatDate(f.updatedAt ?? f.createdAt),
						]),
					],
				);
				log("");
				log(
					colors.dim(
						`${folders.length} folder${folders.length === 1 ? "" : "s"}, ${files.length} file${files.length === 1 ? "" : "s"}`,
					),
				);
				if (folders.length > 0) {
					log(
						colors.dim(
							`Descend with: tarout storage browse ${bucket.name} ${prefix}${folders[0].name}`,
						),
					);
				}
				if (listing?.nextPageToken) {
					log(
						colors.dim(
							`More entries: tarout storage browse ${bucket.name}${prefix ? ` ${prefix}` : ""} --page-token ${listing.nextPageToken}`,
						),
					);
				}
				log("");
			} catch (err) {
				failSpinner();
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

	// Recursive folder delete. The platform deletes every object under the
	// prefix in one pass, so the only protection against naming the wrong prefix
	// is here: normalize and reject traversal, count what is in scope, then
	// confirm with that count on screen.
	storage
		.command("rm-folder")
		.argument("<bucket>", "Bucket ID or name")
		.argument("<folder>", "Folder path to delete, as shown by `tarout storage browse`")
		.description(
			"Recursively delete a folder and everything under it — every object sharing that prefix, at any depth, plus the folder marker itself. This cannot be undone and there is no per-object prompt, so the command first counts what is in scope and shows that count before asking. The whole bucket is never a legal target: remove a bucket with `tarout storage delete`. Requires confirmation unless --yes is passed.",
		)
		.action(async (bucketIdentifier, folder) => {
			try {
				const prefix = normalizeFolderPrefix(folder);

				if (!isLoggedIn()) throw new AuthError();

				const client = getApiClient();

				const _spinner = startSpinner("Finding bucket...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findBucket(buckets as any[], bucketIdentifier);

				if (!bucket) {
					failSpinner();
					const suggestions = findSimilar(
						bucketIdentifier,
						(buckets as any[]).map((b: any) => b.name),
					);
					throw new NotFoundError(
						"Storage bucket",
						bucketIdentifier,
						suggestions,
					);
				}

				const bucketId = bucket.bucketId || bucket.id;

				// What the delete will cover. `getFiles` is a flat listing of every
				// object under the prefix, which is exactly the delete's scope; one
				// page is enough to give an honest number (or an honest floor).
				let scope = "an unknown number of objects (the listing failed)";
				if (!shouldSkipConfirmation()) {
					updateSpinner("Counting objects...");
					try {
						const page: any = await client.storage.getFiles.query({
							bucketId,
							prefix,
							maxResults: FILE_LIST_MAX_PAGE_SIZE,
						});
						const items: any[] = Array.isArray(page?.files) ? page.files : [];
						scope = describeFolderDeletionScope(
							items.length,
							Boolean(page?.nextPageToken),
						);
					} catch {
						// Counting is a courtesy; never block the delete on it.
					}
					succeedSpinner();

					log("");
					log(`Bucket: ${colors.bold(bucket.name)}`);
					log(`Folder: ${colors.bold(prefix)}`);
					log("");
					log(
						colors.warn(
							`This recursively removes ${scope} and cannot be undone.`,
						),
					);
					log("");

					const confirmed = await confirm(
						`Delete folder "${prefix}" and everything under it from bucket "${bucket.name}"?`,
						false,
						{
							field: "confirm_delete_folder",
							flag: "--yes",
							context: { bucketName: bucket.name, prefix, scope },
						},
					);
					if (!confirmed) {
						log("Cancelled.");
						return;
					}
				} else {
					succeedSpinner();
				}

				const _deleteSpinner = startSpinner("Deleting folder...");
				// Returns { success, deletedCount }.
				const result: any = await client.storage.deleteFolder.mutate({
					bucketId,
					prefix,
				});
				const deletedCount =
					typeof result?.deletedCount === "number" ? result.deletedCount : null;
				succeedSpinner(
					deletedCount === null
						? "Folder deleted."
						: `Folder deleted — ${deletedCount.toLocaleString("en-US")} object${deletedCount === 1 ? "" : "s"} removed.`,
				);

				if (isJsonMode()) {
					outputData({ deleted: true, bucketId, prefix, deletedCount });
					return;
				}

				quietOutput(prefix);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

	// Direct provider credentials. The platform only hands these out for
	// CUSTOM (bring-your-own) buckets: storage.getCredentials throws FORBIDDEN
	// for every managed bucket. Managed buckets reach an app through
	// `tarout storage attach`, which mints a scoped key and injects the env vars.
	storage
		.command("credentials")
		.argument("<bucket>", "Bucket ID or name")
		.description(
			"Show direct S3-compatible credentials (custom buckets only; for managed buckets use `tarout storage attach <bucket> <app-id>`)",
		)
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

				const bucketId = bucket.bucketId || bucket.id;
				let creds: any;
				try {
					creds = await client.storage.getCredentials.query({ bucketId });
				} catch (credErr) {
					failSpinner();
					const code =
						(credErr as { data?: { code?: string } })?.data?.code ??
						(credErr as { code?: string })?.code;
					if (code === "FORBIDDEN" && bucket.plan !== "CUSTOM") {
						throw new PermissionError(
							`Bucket "${bucket.name}" is managed by Tarout, and managed buckets never expose direct provider credentials. To use it from a Tarout app, run: tarout storage attach ${bucketId} <app-id> (it creates a scoped access key and sets the S3 env vars on the app).`,
						);
					}
					throw credErr;
				}

				succeedSpinner();

				if (isJsonMode()) {
					outputData(creds);
					return;
				}

				box(`Credentials for ${bucket.name}`, [
					`Access Key ID: ${colors.cyan(creds.accessKeyId || colors.dim("none (workload identity)"))}`,
					`Secret Access Key: ${colors.dim(creds.secretAccessKey || "none")}`,
					`Region: ${creds.region || "auto"}`,
					`Endpoint: ${creds.endpoint || ""}`,
					`Bucket: ${creds.bucket || bucket.name}`,
					...(creds.prefix ? [`Prefix: ${creds.prefix}`] : []),
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
		.option(
			"--size <bytes>",
			"Optional and ignored by the platform (legacy: size before this upload, in bytes)",
		)
		.option(
			"--expected-size <bytes>",
			"Optional and ignored by the platform (legacy: expected uploaded size in bytes)",
		)
		.option(
			"--reservation-token <token>",
			"Durable reservation token returned by upload-url",
		)
		.action(async (bucketIdentifier, fileName, options) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				// storage.completeUpload resolves the durable reservation by
				// token (or by object name) and reads the real size from the
				// provider. expectedSizeBytes / existingSizeBytes are accepted but
				// ignored, so they are optional here; when given they still have to
				// match the server's schema (positive / non-negative integers).
				const expectedSizeBytes = parseOptionalBytes(
					options.expectedSize,
					"--expected-size",
					1,
				);
				const existingSizeBytes = parseOptionalBytes(
					options.size,
					"--size",
					0,
				);
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
				const completed = (await client.storage.completeUpload.mutate({
					bucketId,
					reservationToken: options.reservationToken,
					fileName,
					...(expectedSizeBytes !== undefined ? { expectedSizeBytes } : {}),
					...(existingSizeBytes !== undefined ? { existingSizeBytes } : {}),
				} as any)) as {
					sizeBytes?: number;
					contentType?: string | null;
					lastModified?: string;
					generation?: string;
				} | null;
				succeedSpinner(
					typeof completed?.sizeBytes === "number"
						? `Upload completed (${formatBytes(completed.sizeBytes)}).`
						: "Upload completed.",
				);
				if (isJsonMode()) {
					outputData({ completed: true, fileName, ...(completed ?? {}) });
				}
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
				const res = await fetchRetryingRateLimit(downloadUrl);
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

/**
 * Resolve a bucket reference: an exact id first, then an exact
 * (case-insensitive) name, then a unique id prefix. Bucket names are NOT
 * unique within a project, so a name or prefix that matches several buckets
 * is refused with the candidate ids instead of silently picking the first
 * (which, on `delete`, would remove the wrong bucket).
 */
function findBucket(buckets: any[], identifier: string) {
	const idOf = (b: any) => String(b?.bucketId || b?.id || "");
	const exact = buckets.find((b: any) => idOf(b) === identifier);
	if (exact) return exact;

	const lower = identifier.toLowerCase();
	const byName = buckets.filter(
		(b: any) => String(b?.name ?? "").toLowerCase() === lower,
	);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) throw ambiguousBucket(identifier, "name", byName);

	if (!identifier) return undefined;
	const byPrefix = buckets.filter((b: any) => {
		const id = idOf(b);
		return id !== "" && id.startsWith(identifier);
	});
	if (byPrefix.length === 1) return byPrefix[0];
	if (byPrefix.length > 1) throw ambiguousBucket(identifier, "id prefix", byPrefix);
	return undefined;
}

function ambiguousBucket(
	identifier: string,
	kind: "name" | "id prefix",
	matches: any[],
): InvalidArgumentError {
	failSpinner();
	const ids = matches
		.map((b: any) => `${b.bucketId || b.id} (${b.name})`)
		.join(", ");
	return new InvalidArgumentError(
		`Bucket ${kind} "${identifier}" matches ${matches.length} buckets: ${ids}. Pass the full bucket id instead.`,
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

/** Human-readable byte size (1024-based), e.g. `5.0 MB`. */
export function formatBytes(bytes: number): string {
	if (!bytes || bytes === 0 || !Number.isFinite(bytes)) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	// Clamp: without it a petabyte-scale bucket renders as "1.0 undefined".
	const i = Math.max(
		0,
		Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
	);
	return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

/**
 * Parse an optional byte-count flag. Absent stays `undefined` so it is not
 * sent at all; present must be an integer of at least `min`.
 */
function parseOptionalBytes(
	value: string | undefined,
	flag: string,
	min: number,
): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < min) {
		throw new InvalidArgumentError(
			`${flag} must be ${min === 0 ? "a non-negative" : "a positive"} whole number of bytes (got "${value}").`,
		);
	}
	return n;
}

/**
 * GET that waits out an HTTP 429 (honouring Retry-After, capped) instead of
 * failing the transfer. The download proxy rate-limits per user, so a script
 * pulling a folder file by file hits it in bursts; the next minute is fine.
 */
export async function fetchRetryingRateLimit(
	url: string,
	{
		attempts = 4,
		maxWaitMs = 60_000,
		sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
		fetchImpl = fetch,
	}: {
		attempts?: number;
		maxWaitMs?: number;
		sleep?: (ms: number) => Promise<void>;
		fetchImpl?: typeof fetch;
	} = {},
): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		const res = await fetchImpl(url, { method: "GET" });
		if (res.status !== 429 || attempt >= attempts) return res;
		const retryAfter = Number(res.headers.get("retry-after"));
		const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
			? retryAfter * 1000
			: 2 ** attempt * 1000;
		await res.body?.cancel().catch(() => {});
		await sleep(Math.min(waitMs, maxWaitMs));
	}
}
