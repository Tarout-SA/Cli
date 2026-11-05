import { type Command, Option } from "commander";
import { getApiClient } from "../lib/api.js";
import { isLoggedIn } from "../lib/config.js";
import {
	AuthError,
	findSimilar,
	handleError,
	InvalidArgumentError,
	NotFoundError,
} from "../lib/errors.js";
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
import {
	failSpinner,
	startSpinner,
	succeedSpinner,
	updateSpinner,
} from "../utils/spinner.js";

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
				quietOutput(d.id || d.destinationId || id);
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
			"Storage provider (s3, gcs, cloudflare-r2, wasabi, minio)",
		)
		.option("-b, --bucket <bucket>", "Bucket name")
		.option("-r, --region <region>", "Region")
		.option("-e, --endpoint <url>", "Endpoint URL")
		.option("--access-key <key>", "Access key ID")
		.option("--secret-key <secret>", "Secret access key")
		.addHelpText(
			"after",
			"\nNote: this is for a bucket on an external S3-compatible provider, which is why an endpoint and keys are required. To back up into one of your own Tarout storage buckets instead, run `tarout destinations create-native` — it needs no endpoint, key or secret.",
		)
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
								{ name: "R2 (Cloudflare)", value: "cloudflare-r2" },
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
					// region and endpoint are REQUIRED by the server (z.string().min(1)).
					// Prompt/validate instead of coercing blanks to undefined.
					const region =
						options.region ||
						(await input("Region (e.g. auto, us-east-1):", undefined, {
							field: "region",
							flag: "--region",
						}));
					if (!region) {
						throw new InvalidArgumentError("--region is required.");
					}
					const endpoint =
						options.endpoint ||
						(await input("Endpoint URL:", undefined, {
							field: "endpoint",
							flag: "--endpoint",
						}));
					if (!endpoint) {
						throw new InvalidArgumentError("--endpoint is required.");
					}
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

	// ── Create (native Tarout object storage) ────────────────────────────────────
	// A sibling command rather than a flag on `create`: the two argument sets are
	// disjoint (a Tarout bucket carries no endpoint, access key or secret) and
	// they hit two different procedures, destination.create vs
	// destination.createNative. A `--bucket <id>` switch on `create` would reuse
	// the flag that already means "bucket name at the external provider" and
	// would silently turn five required flags optional, which neither `--help`
	// nor an agent reading `--help` can express.
	dest
		.command("create-native")
		.description(
			"Create a backup destination that writes into one of this organization's own Tarout storage buckets. Unlike `destinations create` it takes no endpoint, access key or secret: the platform resolves the bucket's credentials itself at backup time, so you only name the destination and say which bucket it writes into.",
		)
		.option("-n, --name <name>", "Name for the destination (1-100 characters)")
		.option(
			"-b, --bucket <bucket>",
			"Tarout storage bucket to back up into: its id, its exact name, or a unique id prefix (`tarout storage list` shows them)",
		)
		// Accepted only so that passing a credential flag here fails with an
		// explanation and a pointer to `destinations create`, instead of
		// Commander's bare "unknown option". Hidden: listing them under a command
		// that refuses them would muddy exactly the distinction this command
		// exists to make.
		.addOption(new Option("-p, --provider <provider>").hideHelp())
		.addOption(new Option("-r, --region <region>").hideHelp())
		.addOption(new Option("-e, --endpoint <url>").hideHelp())
		.addOption(new Option("--access-key <key>").hideHelp())
		.addOption(new Option("--secret-key <secret>").hideHelp())
		.action(async (options: NativeDestinationFlags) => {
			try {
				if (!isLoggedIn()) throw new AuthError();
				const request = parseNativeDestinationFlags(options);
				const name =
					request.name ||
					(await input("Destination name:", undefined, {
						field: "name",
						flag: "--name",
					}));

				const client = getApiClient();
				const _spinner = startSpinner("Finding storage bucket...");
				const buckets = await client.storage.allByOrganization.query();
				const bucket = findStorageBucket(buckets, request.bucket);
				assertStorageBucketReady(bucket);

				updateSpinner("Creating destination...");
				const result = await client.destination.createNative.mutate({
					name,
					storageBucketId: storageBucketIdOf(bucket),
				} as any);
				succeedSpinner("Backup destination created.");

				if (isJsonMode()) {
					outputData(result);
					return;
				}
				const created = result as any;
				quietOutput(created.id || created.destinationId || "created");
				log("");
				log(colors.bold(created.name || name));
				log(`  Bucket:   ${bucket.name || created.bucket || "-"}`);
				log(`  Region:   ${created.region || bucket.region || "-"}`);
				log(
					`  ID:       ${colors.cyan(created.id || created.destinationId || "-")}`,
				);
				log("");
				log(
					colors.dim(
						"No keys are stored for this destination; it is addressed through the bucket it was created from.",
					),
				);
			} catch (err) {
				failSpinner();
				handleError(err);
			}
		});

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
					else quietOutput(destinationId);
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
				else quietOutput(destinationId);
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
						(await input(
							"Storage provider (s3/gcs/cloudflare-r2):",
							undefined,
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
					// region and endpoint are REQUIRED by testCredentials (z.string()).
					const region =
						options.region ||
						(await input("Region (e.g. auto, us-east-1):", undefined, {
							field: "region",
							flag: "--region",
						}));
					if (!region) {
						throw new InvalidArgumentError("--region is required.");
					}
					const endpoint =
						options.endpoint ||
						(await input("Endpoint URL:", undefined, {
							field: "endpoint",
							flag: "--endpoint",
						}));
					if (!endpoint) {
						throw new InvalidArgumentError("--endpoint is required.");
					}
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
						region,
						endpoint,
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

/** Flags Commander hands `destinations create-native`. */
export interface NativeDestinationFlags {
	name?: string;
	bucket?: string;
	provider?: string;
	region?: string;
	endpoint?: string;
	accessKey?: string;
	secretKey?: string;
}

/** The validated input for `destination.createNative`. */
export interface NativeDestinationRequest {
	name?: string;
	/** Bucket id, exact name, or unique id prefix — still to be resolved. */
	bucket: string;
}

/**
 * The flags that only make sense for a destination on an external
 * S3-compatible provider, i.e. the ones `destination.create` requires and
 * `destination.createNative` has no field for.
 */
const CREDENTIAL_FLAGS: ReadonlyArray<[keyof NativeDestinationFlags, string]> = [
	["provider", "--provider"],
	["region", "--region"],
	["endpoint", "--endpoint"],
	["accessKey", "--access-key"],
	["secretKey", "--secret-key"],
];

/**
 * Validates the `create-native` flag set against the `create` one.
 *
 * The two creates are mutually exclusive: a Tarout bucket is a prefix inside a
 * platform-owned bucket that the backup worker reaches with its own
 * credentials, so there is nothing for an endpoint or a key pair to describe.
 * Accepting a credential flag here and ignoring it would be the dangerous
 * reading — the caller would believe backups go to the bucket those keys
 * address — so a supplied credential flag is an error that names the other
 * command, and a missing `--bucket` is an error rather than a prompt, because
 * the bucket is the one field that decides where the data lands.
 */
export function parseNativeDestinationFlags(
	flags: NativeDestinationFlags,
): NativeDestinationRequest {
	const supplied = CREDENTIAL_FLAGS.filter(([key]) => {
		const value = flags?.[key];
		return value !== undefined && value !== null && String(value).trim() !== "";
	}).map(([, flag]) => flag);

	if (supplied.length > 0) {
		throw new InvalidArgumentError(
			`A Tarout storage destination holds no credentials, so ${supplied.join(
				", ",
			)} ${supplied.length === 1 ? "is" : "are"} not accepted here. Pass only --name and --bucket, or use \`tarout destinations create\` for a bucket on an external S3-compatible provider.`,
		);
	}

	const bucket = (flags?.bucket ?? "").trim();
	if (!bucket) {
		throw new InvalidArgumentError(
			"--bucket is required: name the Tarout storage bucket this destination writes into (`tarout storage list` shows the ids). For a bucket on an external S3-compatible provider, use `tarout destinations create` instead.",
		);
	}

	const name = (flags?.name ?? "").trim();
	return { name: name || undefined, bucket };
}

/** The fields `storage.allByOrganization` returns that this command reads. */
export interface StorageBucketSummary {
	bucketId?: string | null;
	id?: string | null;
	name?: string | null;
	region?: string | null;
	applicationStatus?: string | null;
}

/** `storage.allByOrganization` calls it `bucketId`; the destination router wants that same id. */
export function storageBucketIdOf(bucket: StorageBucketSummary): string {
	return String(bucket?.bucketId || bucket?.id || "");
}

/**
 * Resolves what the caller typed for `--bucket` to one of their storage
 * buckets, accepting the id, the exact name, or an unambiguous id prefix —
 * the same three forms `tarout storage` already accepts, so a bucket name
 * copied out of `tarout storage list` works here too.
 *
 * Pure: the caller supplies the list. Two buckets may share a name, so
 * ambiguity is an argument error that lists the candidates rather than a
 * silent pick — picking wrong would point every backup at the wrong bucket.
 */
export function findStorageBucket(
	buckets: StorageBucketSummary[],
	identifier: string,
): StorageBucketSummary {
	const list = Array.isArray(buckets) ? buckets : [];
	const trimmed = (identifier ?? "").trim();
	if (!trimmed) {
		throw new InvalidArgumentError(
			"--bucket is required: name the Tarout storage bucket this destination writes into.",
		);
	}

	const exact = list.find((b) => storageBucketIdOf(b) === trimmed);
	if (exact) return exact;

	const lower = trimmed.toLowerCase();
	const byName = list.filter(
		(b) => String(b?.name ?? "").toLowerCase() === lower,
	);
	if (byName.length === 1) return byName[0] as StorageBucketSummary;
	if (byName.length > 1) throw ambiguousStorageBucket(trimmed, "name", byName);

	const byPrefix = list.filter((b) => {
		const id = storageBucketIdOf(b);
		return id !== "" && id.startsWith(trimmed);
	});
	if (byPrefix.length === 1) return byPrefix[0] as StorageBucketSummary;
	if (byPrefix.length > 1)
		throw ambiguousStorageBucket(trimmed, "id prefix", byPrefix);

	throw new NotFoundError(
		"Storage bucket",
		trimmed,
		findSimilar(
			trimmed,
			list.map((b) => String(b?.name ?? "")).filter(Boolean),
		),
	);
}

function ambiguousStorageBucket(
	identifier: string,
	kind: "name" | "id prefix",
	matches: StorageBucketSummary[],
): InvalidArgumentError {
	const ids = matches
		.map((b) => `${storageBucketIdOf(b)} (${b.name || "unnamed"})`)
		.join(", ");
	return new InvalidArgumentError(
		`Bucket ${kind} "${identifier}" matches ${matches.length} buckets: ${ids}. Pass the full bucket id instead.`,
	);
}

/**
 * The platform refuses a native destination on a bucket that is still being
 * provisioned (it has no backing bucket name yet). Say so before the round
 * trip, and only when the status is actually known — a payload without the
 * field is left for the server to judge.
 */
export function assertStorageBucketReady(bucket: StorageBucketSummary): void {
	const status = String(bucket?.applicationStatus ?? "");
	if (!status || status === "done") return;
	throw new InvalidArgumentError(
		`Storage bucket "${bucket?.name || storageBucketIdOf(bucket)}" is not ready yet (status: ${status}). A destination can only be created once the bucket is provisioned — wait until \`tarout storage list\` reports it done, then rerun.`,
	);
}
