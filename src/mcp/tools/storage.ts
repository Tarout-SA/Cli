/**
 * Curated MCP tools for object storage. Bucket references accept either the
 * platform id (`bucketId`) or the human-readable `name`; resolveBucketRef()
 * lists the org's buckets and matches on either. Names are not unique, so a
 * name shared by several buckets is refused with the candidate ids rather than
 * resolved to whichever came first. Every tool wraps one tRPC
 * procedure on the `storage` router, except storage_upload / storage_download,
 * which additionally move the actual bytes over the presigned URL.
 *
 * Bucket-level:
 * - storage_list: storage.allByOrganization; compact
 *   `{id,name,plan,publicAccess}` projection so agents don't have to eyeball
 *   the raw shape.
 * - storage_create: storage.create. The platform derives the bucket plan from
 *   the project's subscription and ignores any plan in the input, so `plan` is
 *   optional, accepted for compatibility, and never forwarded.
 * - storage_info: storage.findById.
 * - storage_credentials: storage.getCredentials, returned as-is. Only CUSTOM
 *   (bring-your-own) buckets have direct credentials; the platform answers
 *   FORBIDDEN for managed buckets, which use storage_access_key_create.
 * - storage_files: storage.getFiles (prefix filter).
 * - storage_delete: storage.delete (whole bucket, irreversible).
 *
 * Byte transfer (the object-level parity that actually moves data):
 * - storage_upload: storage.getUploadUrl → global fetch PUT of the bytes →
 *   storage.completeUpload. `content` is UTF-8 text, or base64 when
 *   encoding="base64" (Buffer.from(content,"base64")); fileSizeBytes is the
 *   decoded byte length and the presigned requiredHeaders are forwarded verbatim.
 * - storage_download: storage.getDownloadUrl → fetch GET → body returned as text,
 *   or base64 when encoding="base64". Refuses objects over
 *   MAX_INLINE_DOWNLOAD_BYTES (5 MB) with a PRECONDITION_FAILED that still hands
 *   back the signed URL so the caller can fetch it directly.
 *
 * Object ops:
 * - storage_delete_file: storage.deleteFile.
 * - storage_create_folder: storage.createFolder.
 * - storage_move: storage.move (source + destination; isFolder for a prefix).
 * - storage_file_versions: storage.getFileVersions.
 * - storage_restore_version: storage.restoreFileVersion.
 *
 * Access keys (S3 HMAC credential custody):
 * - storage_access_keys: storage.listAccessKeys (never returns secrets).
 * - storage_access_key_create: storage.createAccessKey; returns a ONE-TIME
 *   secret shown only once.
 * - storage_access_key_revoke: storage.revokeAccessKey.
 *
 * Annotations:
 * - readOnlyHint on storage_list / storage_info / storage_credentials /
 *   storage_files / storage_download / storage_file_versions / storage_access_keys
 * - destructiveHint on storage_delete / storage_delete_file /
 *   storage_access_key_revoke
 * - mutating but not destructive (no hint): storage_create / storage_upload /
 *   storage_create_folder / storage_move / storage_restore_version /
 *   storage_access_key_create
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotFoundError } from "../../lib/errors.js";
import { type TrpcClient, withAuth } from "../runtime.js";

const bucketRef = z.string().describe("Bucket name or id.");

/**
 * Resolves a name-or-id reference to the bucket's `{bucketId, name}` pair by
 * listing all buckets in the organization and matching. Same shape as
 * resolveDbRef() from db.ts: a single list-then-find pass covers both keys.
 *
 * Throws `NotFoundError` when no match is found; this maps to `NOT_FOUND`
 * in the tool envelope via `toEnvelope()`.
 */
async function resolveBucketRef(
	client: TrpcClient,
	ref: string,
): Promise<{ bucketId: string; name: string }> {
	const buckets = (await client.storage.allByOrganization.query()) as Array<
		Record<string, unknown>
	>;
	// An exact id always wins. Names are not unique within a project, so a
	// name that matches several buckets is refused: resolving it to the first
	// hit would let storage_delete remove the wrong bucket.
	const byId = buckets.find((b) => b.bucketId === ref);
	const byName = byId ? [] : buckets.filter((b) => b.name === ref);
	if (byName.length > 1) {
		const ids = byName.map((b) => String(b.bucketId)).join(", ");
		throw codedError(
			"INVALID_ARGUMENTS",
			`Bucket name "${ref}" matches ${byName.length} buckets (ids: ${ids}). Pass the bucket id instead.`,
		);
	}
	const match = byId ?? byName[0];
	if (!match) {
		throw new NotFoundError("Bucket", ref);
	}
	return {
		bucketId: match.bucketId as string,
		name: match.name as string,
	};
}

/**
 * Refuse to inline a downloaded object larger than this; hand back the signed
 * URL instead so the caller fetches it directly and the transcript stays small.
 */
const MAX_INLINE_DOWNLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Builds an Error that `toEnvelope()` maps to the given envelope code (via its
 * tRPC-shaped `.data.code` branch).
 */
function codedError(code: string, message: string): Error {
	const err = new Error(message) as Error & { data: { code: string } };
	err.data = { code };
	return err;
}

/**
 * A `PRECONDITION_FAILED` error. Used to refuse an oversized inline download
 * while still handing the signed URL back in the message.
 */
function preconditionFailed(message: string): Error {
	return codedError("PRECONDITION_FAILED", message);
}

export function registerStorageTools(server: McpServer): void {
	server.registerTool(
		"storage_list",
		{
			title: "List storage buckets in the organization",
			description: "Wraps storage.allByOrganization.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () =>
			withAuth(async (client) => {
				const list = (await client.storage.allByOrganization.query()) as Array<
					Record<string, unknown>
				>;
				return {
					count: list.length,
					buckets: list.map((b) => ({
						id: b.bucketId,
						name: b.name,
						plan: b.plan,
						publicAccess: b.publicAccess,
					})),
				};
			}),
	);

	server.registerTool(
		"storage_create",
		{
			title: "Create a storage bucket",
			description:
				"Wraps storage.create. The platform picks the bucket plan from the project's subscription; the response's `plan` is the one it chose. Managed buckets have no direct credentials: to use one from a Tarout app, attach it (the call tool with storage.attachToApplication, or `tarout storage attach <bucket> <app-id>`), or mint a scoped key with storage_access_key_create.",
			inputSchema: {
				name: z.string().min(1),
				plan: z
					.enum(["STARTER", "STANDARD", "PRO"])
					.optional()
					.describe(
						"Ignored: the platform derives the plan from the project's subscription. Accepted for compatibility and not sent.",
					),
				description: z.string().optional(),
				publicAccess: z.boolean().optional().default(false),
			},
		},
		async ({ name, description, publicAccess }) =>
			withAuth(
				async (client) =>
					(await client.storage.create.mutate({
						name,
						description,
						publicAccess,
					})) as unknown,
			),
	);

	server.registerTool(
		"storage_info",
		{
			title: "Details for one bucket",
			description: "Wraps storage.findById.",
			inputSchema: { bucket: bucketRef },
			annotations: { readOnlyHint: true },
		},
		async ({ bucket }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const info = (await client.storage.findById.query({
					bucketId,
				})) as unknown;
				return { bucket: info };
			}),
	);

	server.registerTool(
		"storage_credentials",
		{
			title: "S3-compatible HMAC keys for a custom bucket",
			description:
				"Wraps storage.getCredentials. Only CUSTOM (bring-your-own) buckets have direct provider credentials; for a managed bucket the platform answers FORBIDDEN, so mint a scoped key with storage_access_key_create instead.",
			inputSchema: { bucket: bucketRef },
			annotations: { readOnlyHint: true },
		},
		async ({ bucket }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const creds = (await client.storage.getCredentials.query({
					bucketId,
				})) as unknown;
				return creds;
			}),
	);

	server.registerTool(
		"storage_files",
		{
			title: "List files in a bucket (prefix filter)",
			description: "Wraps storage.getFiles.",
			inputSchema: {
				bucket: bucketRef,
				prefix: z.string().optional(),
				maxResults: z.number().int().positive().max(1000).optional().default(100),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ bucket, prefix, maxResults }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const files = (await client.storage.getFiles.query({
					bucketId,
					prefix,
					maxResults,
				})) as unknown;
				return files;
			}),
	);

	server.registerTool(
		"storage_delete",
		{
			title: "Delete a bucket (irreversible)",
			description: "Wraps storage.delete.",
			inputSchema: { bucket: bucketRef },
			annotations: { destructiveHint: true },
		},
		async ({ bucket }) =>
			withAuth(async (client) => {
				const { bucketId, name } = await resolveBucketRef(client, bucket);
				const result = (await client.storage.delete.mutate({
					bucketId,
				})) as unknown;
				return { deleted: true, bucketId, name, result };
			}),
	);

	// ── Byte transfer ──────────────────────────────────────────────────────────

	server.registerTool(
		"storage_upload",
		{
			title: "Upload bytes to an object in a bucket",
			description:
				'Uploads content to an object key. Flow: storage.getUploadUrl (presigned PUT) → global fetch PUT of the bytes → storage.completeUpload to finalize. Pass UTF-8 text directly, or set encoding:"base64" to upload binary. Returns the object key and the stored size.',
			inputSchema: {
				bucket: bucketRef,
				key: z
					.string()
					.min(1)
					.describe("Destination object key/path within the bucket."),
				content: z
					.string()
					.describe(
						'Object bytes: UTF-8 text, or a base64 string when encoding="base64".',
					),
				encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
				contentType: z.string().max(255).optional(),
				expiresIn: z.number().int().min(60).max(86400).optional().default(3600),
			},
		},
		async ({ bucket, key, content, encoding, contentType, expiresIn }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const body =
					encoding === "base64"
						? Buffer.from(content, "base64")
						: Buffer.from(content, "utf8");
				const upload = (await client.storage.getUploadUrl.mutate({
					bucketId,
					fileName: key,
					fileSizeBytes: body.byteLength,
					contentType,
					expiresIn,
				})) as {
					url: string;
					reservationToken?: string;
					requiredHeaders?: Record<string, string>;
				};
				// The presigned PUT signs Content-Length (undici sets it from the
				// Buffer automatically) plus every header in requiredHeaders (the
				// generation precondition and, when given, Content-Type) — forward
				// them verbatim or the signature/precondition check fails.
				const put = await fetch(upload.url, {
					method: "PUT",
					headers: upload.requiredHeaders ?? {},
					body,
				});
				if (!put.ok) {
					const detail = await put.text().catch(() => "");
					throw new Error(
						`Upload PUT failed (${put.status} ${put.statusText})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
					);
				}
				const completed = (await client.storage.completeUpload.mutate({
					bucketId,
					reservationToken: upload.reservationToken,
					fileName: key,
				})) as {
					sizeBytes?: number;
					contentType?: string | null;
					lastModified?: string;
				};
				return {
					uploaded: true,
					bucketId,
					key,
					size: completed.sizeBytes ?? body.byteLength,
					contentType: completed.contentType ?? contentType ?? null,
					lastModified: completed.lastModified ?? null,
				};
			}),
	);

	server.registerTool(
		"storage_download",
		{
			title: "Download an object's bytes",
			description:
				'Fetches an object via storage.getDownloadUrl (presigned GET) and returns its bytes as UTF-8 text, or base64 when encoding="base64". Objects larger than 5 MB are refused with PRECONDITION_FAILED and the signed URL so you can fetch them directly instead of flooding the transcript.',
			inputSchema: {
				bucket: bucketRef,
				key: z.string().min(1).describe("Object key/path to download."),
				encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
				expiresIn: z.number().int().min(60).max(604800).optional().default(3600),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ bucket, key, encoding, expiresIn }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const { url } = (await client.storage.getDownloadUrl.mutate({
					bucketId,
					fileName: key,
					expiresIn,
				})) as { url: string; expiresIn: number };
				const res = await fetch(url, { method: "GET" });
				if (!res.ok) {
					throw new Error(
						`Download GET failed (${res.status} ${res.statusText}).`,
					);
				}
				// Refuse before reading the body when the server declares an oversized
				// length; otherwise read, then re-check the actual byte length.
				const declared = Number(res.headers.get("content-length"));
				if (Number.isFinite(declared) && declared > MAX_INLINE_DOWNLOAD_BYTES) {
					throw preconditionFailed(
						`Object "${key}" is ${declared} bytes, over the ${MAX_INLINE_DOWNLOAD_BYTES}-byte inline-download cap. Fetch it directly from this signed URL (expires in ${expiresIn}s): ${url}`,
					);
				}
				const buffer = Buffer.from(await res.arrayBuffer());
				if (buffer.byteLength > MAX_INLINE_DOWNLOAD_BYTES) {
					throw preconditionFailed(
						`Object "${key}" is ${buffer.byteLength} bytes, over the ${MAX_INLINE_DOWNLOAD_BYTES}-byte inline-download cap. Fetch it directly from this signed URL (expires in ${expiresIn}s): ${url}`,
					);
				}
				return {
					bucketId,
					key,
					size: buffer.byteLength,
					encoding,
					content:
						encoding === "base64"
							? buffer.toString("base64")
							: buffer.toString("utf8"),
				};
			}),
	);

	// ── Object ops ─────────────────────────────────────────────────────────────

	server.registerTool(
		"storage_delete_file",
		{
			title: "Delete a single object from a bucket",
			description: "Wraps storage.deleteFile.",
			inputSchema: {
				bucket: bucketRef,
				key: z.string().min(1).describe("Object key/path to delete."),
			},
			annotations: { destructiveHint: true },
		},
		async ({ bucket, key }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const result = (await client.storage.deleteFile.mutate({
					bucketId,
					fileName: key,
				})) as unknown;
				return { deleted: true, bucketId, key, result };
			}),
	);

	server.registerTool(
		"storage_create_folder",
		{
			title: "Create a folder (prefix) in a bucket",
			description: "Wraps storage.createFolder.",
			inputSchema: {
				bucket: bucketRef,
				folderName: z
					.string()
					.min(1)
					.max(255)
					.describe(
						"Single folder name (no path separators or traversal segments).",
					),
				prefix: z
					.string()
					.optional()
					.describe("Parent folder prefix to create the folder under."),
			},
		},
		async ({ bucket, folderName, prefix }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				return (await client.storage.createFolder.mutate({
					bucketId,
					folderName,
					prefix,
				})) as unknown;
			}),
	);

	server.registerTool(
		"storage_move",
		{
			title: "Move or rename an object or folder within a bucket",
			description:
				"Wraps storage.move. Set isFolder:true to move an entire prefix. File destination collisions are rejected, not overwritten.",
			inputSchema: {
				bucket: bucketRef,
				sourcePath: z.string().min(1).describe("Existing object/folder path."),
				destinationPath: z.string().min(1).describe("New object/folder path."),
				isFolder: z.boolean().optional().default(false),
			},
		},
		async ({ bucket, sourcePath, destinationPath, isFolder }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				return (await client.storage.move.mutate({
					bucketId,
					sourcePath,
					destinationPath,
					isFolder,
				})) as unknown;
			}),
	);

	server.registerTool(
		"storage_file_versions",
		{
			title: "List stored versions of an object",
			description: "Wraps storage.getFileVersions.",
			inputSchema: {
				bucket: bucketRef,
				key: z
					.string()
					.min(1)
					.describe("Object key/path to list versions for."),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ bucket, key }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const versions = (await client.storage.getFileVersions.query({
					bucketId,
					fileName: key,
				})) as unknown;
				return { key, versions };
			}),
	);

	server.registerTool(
		"storage_restore_version",
		{
			title: "Restore an object to a previous version",
			description: "Wraps storage.restoreFileVersion.",
			inputSchema: {
				bucket: bucketRef,
				key: z.string().min(1).describe("Object key/path to restore."),
				versionId: z
					.string()
					.min(1)
					.describe("Version id from storage_file_versions."),
			},
		},
		async ({ bucket, key, versionId }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const result = (await client.storage.restoreFileVersion.mutate({
					bucketId,
					fileName: key,
					versionId,
				})) as unknown;
				return { restored: true, bucketId, key, versionId, result };
			}),
	);

	// ── Access keys (S3 HMAC credential custody) ───────────────────────────────

	server.registerTool(
		"storage_access_keys",
		{
			title: "List a bucket's S3 access keys",
			description: "Wraps storage.listAccessKeys. Never returns secrets.",
			inputSchema: { bucket: bucketRef },
			annotations: { readOnlyHint: true },
		},
		async ({ bucket }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const keys = (await client.storage.listAccessKeys.query({
					bucketId,
				})) as unknown;
				return { keys };
			}),
	);

	server.registerTool(
		"storage_access_key_create",
		{
			title: "Mint a scoped S3 access key for a bucket",
			description:
				"Wraps storage.createAccessKey. Returns a one-time HMAC secret that is shown ONCE and is never retrievable again — capture it immediately; only its encrypted form is stored server-side.",
			inputSchema: {
				bucket: bucketRef,
				label: z.string().max(100).optional(),
				permissions: z
					.array(z.enum(["read", "write", "delete"]))
					.min(1)
					.optional()
					.describe("Defaults to [read, write, delete] when omitted."),
				expiresAt: z
					.string()
					.optional()
					.describe("Optional ISO 8601 expiry timestamp."),
			},
		},
		async ({ bucket, label, permissions, expiresAt }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				return (await client.storage.createAccessKey.mutate({
					bucketId,
					label,
					permissions,
					expiresAt,
				})) as unknown;
			}),
	);

	server.registerTool(
		"storage_access_key_revoke",
		{
			title: "Revoke a bucket's S3 access key",
			description:
				"Wraps storage.revokeAccessKey. Idempotent; instantly kills access with no provider call.",
			inputSchema: {
				bucket: bucketRef,
				accessKeyId: z
					.string()
					.min(1)
					.describe("The accessKeyId to revoke (from storage_access_keys)."),
			},
			annotations: { destructiveHint: true },
		},
		async ({ bucket, accessKeyId }) =>
			withAuth(async (client) => {
				const { bucketId } = await resolveBucketRef(client, bucket);
				const result = (await client.storage.revokeAccessKey.mutate({
					bucketId,
					accessKeyId,
				})) as unknown;
				return { revoked: true, bucketId, accessKeyId, result };
			}),
	);
}
