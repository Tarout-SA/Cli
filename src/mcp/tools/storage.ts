/**
 * Curated MCP tools for object storage: storage_list, storage_create,
 * storage_info, storage_credentials, storage_files, storage_delete. Each tool
 * wraps a single tRPC procedure on the `storage` router. Bucket references
 * accept either the platform id (`bucketId`) or the human-readable `name`.
 *
 * Dispatch:
 * - storage_list: storage.allByOrganization; returns a compact
 *   `{id,name,plan,publicAccess}` projection so agents don't have to eyeball
 *   the raw shape.
 * - storage_create: storage.create with the fixed plan enum
 *   (STARTER|STANDARD|PRO) matching the DB tools convention.
 * - storage_info / storage_credentials / storage_files / storage_delete:
 *   resolveBucketRef() lists the org's buckets and matches on either
 *   bucketId or name, then dispatches to the underlying procedure.
 *
 * storage_credentials returns the credential envelope as-is because
 * getCredentials already returns S3-shaped fields (accessKeyId, secretAccessKey,
 * etc.) — no field remapping needed. This differs from db_credentials, which
 * has to normalise across postgres/mysql field-name divergence.
 *
 * Annotations:
 * - readOnlyHint on storage_list / storage_info / storage_credentials /
 *   storage_files
 * - destructiveHint on storage_delete
 * - storage_create is mutating but not destructive (no hint)
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { NotFoundError } from "../../lib/errors.js";
import { type TrpcClient, withAuth } from "../runtime.js";

const bucketRef = z.string().describe("Bucket name or id.");

/**
 * Resolves a name-or-id reference to the bucket's `{bucketId, name}` pair by
 * listing all buckets in the organization and matching. Same shape as
 * resolveDbRef() from db.ts — single list-then-find pass covers both keys.
 *
 * Throws `NotFoundError` when no match is found — this maps to `NOT_FOUND`
 * in the tool envelope via `toEnvelope()`.
 */
async function resolveBucketRef(
	client: TrpcClient,
	ref: string,
): Promise<{ bucketId: string; name: string }> {
	const buckets = (await client.storage.allByOrganization.query()) as Array<
		Record<string, unknown>
	>;
	const match = buckets.find(
		(b) => b.bucketId === ref || b.name === ref,
	);
	if (!match) {
		throw new NotFoundError("Bucket", ref);
	}
	return {
		bucketId: match.bucketId as string,
		name: match.name as string,
	};
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
			description: "Wraps storage.create.",
			inputSchema: {
				name: z.string().min(1),
				plan: z.enum(["STARTER", "STANDARD", "PRO"]),
				description: z.string().optional(),
				publicAccess: z.boolean().optional().default(false),
			},
		},
		async (input) =>
			withAuth(
				async (client) => (await client.storage.create.mutate(input)) as unknown,
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
			title: "S3-compatible HMAC keys for a bucket",
			description: "Wraps storage.getCredentials.",
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
}
