import { describe, expect, it } from "vitest";
import {
	assertStorageBucketReady,
	findStorageBucket,
	parseNativeDestinationFlags,
	type StorageBucketSummary,
	storageBucketIdOf,
} from "../src/commands/destinations";
import {
	findGiteaProvider,
	type GiteaProviderSummary,
	giteaProviderName,
	readGiteaProviders,
} from "../src/commands/providers";
import { InvalidArgumentError, NotFoundError } from "../src/lib/errors";
import { ExitCode } from "../src/utils/exit-codes";

/**
 * Pure-helper contracts behind the two commands added for the Gitea read
 * surface (`tarout providers gitea ...`) and the native backup destination
 * (`tarout destinations create-native`). No client, no tRPC: every helper here
 * takes a plain response shape so the argument rules can be pinned down
 * without a network.
 */

const buckets: StorageBucketSummary[] = [
	{
		bucketId: "bkt_aaa111",
		name: "backups",
		region: "me-central2",
		applicationStatus: "done",
	},
	{
		bucketId: "bkt_aaa222",
		name: "assets",
		region: "me-central2",
		applicationStatus: "done",
	},
	// Two buckets can legitimately share a name: the dashboard never enforced
	// uniqueness, and `--bucket assets-cdn` must not pick one of them at random.
	{
		bucketId: "bkt_bbb111",
		name: "assets-cdn",
		region: "me-central2",
		applicationStatus: "done",
	},
	{
		bucketId: "bkt_ccc111",
		name: "assets-cdn",
		region: "europe-west1",
		applicationStatus: "done",
	},
	{
		bucketId: "bkt_ddd111",
		name: "fresh",
		region: "me-central2",
		applicationStatus: "creating",
	},
];

describe("destinations create-native flags", () => {
	it("refuses credential flags alongside the native bucket flag", () => {
		expect(() =>
			parseNativeDestinationFlags({
				name: "nightly",
				bucket: "bkt_aaa111",
				accessKey: "AKIA...",
				secretKey: "s3cr3t",
			}),
		).toThrow(InvalidArgumentError);

		// The message has to name the offending flags and the other command,
		// because the whole point of the sibling command is that the two
		// argument sets never mix.
		expect(() =>
			parseNativeDestinationFlags({
				bucket: "bkt_aaa111",
				endpoint: "https://s3.example.com",
			}),
		).toThrow(/--endpoint is not accepted here/);
		expect(() =>
			parseNativeDestinationFlags({
				bucket: "bkt_aaa111",
				accessKey: "AKIA...",
				secretKey: "s3cr3t",
			}),
		).toThrow(/tarout destinations create/);
	});

	it("refuses credential flags on their own", () => {
		expect(() =>
			parseNativeDestinationFlags({
				name: "nightly",
				provider: "s3",
				region: "us-east-1",
			}),
		).toThrow(/--provider, --region are not accepted here/);
	});

	it("requires a bucket when neither flag set is supplied", () => {
		expect(() => parseNativeDestinationFlags({})).toThrow(InvalidArgumentError);
		expect(() => parseNativeDestinationFlags({})).toThrow(
			/--bucket is required/,
		);
		expect(() => parseNativeDestinationFlags({ name: "nightly" })).toThrow(
			/--bucket is required/,
		);
		// A blank or whitespace --bucket is the same thing, not an empty lookup.
		expect(() => parseNativeDestinationFlags({ bucket: "   " })).toThrow(
			/--bucket is required/,
		);
	});

	it("exits INVALID_ARGUMENTS for a bad flag set", () => {
		try {
			parseNativeDestinationFlags({ bucket: "bkt_aaa111", provider: "s3" });
			throw new Error("expected parseNativeDestinationFlags to throw");
		} catch (err) {
			expect((err as InvalidArgumentError).code).toBe(
				ExitCode.INVALID_ARGUMENTS,
			);
		}
	});

	it("passes a clean native flag set through, trimmed", () => {
		expect(
			parseNativeDestinationFlags({ name: "  nightly  ", bucket: " backups " }),
		).toEqual({ name: "nightly", bucket: "backups" });
		// --name is optional here: the command prompts for it (and an agent gets
		// a needs_input event naming --name).
		expect(parseNativeDestinationFlags({ bucket: "backups" })).toEqual({
			name: undefined,
			bucket: "backups",
		});
	});
});

describe("destinations create-native bucket resolution", () => {
	it("resolves a bucket by id, exact name, and unique id prefix", () => {
		expect(storageBucketIdOf(findStorageBucket(buckets, "bkt_aaa111"))).toBe(
			"bkt_aaa111",
		);
		expect(storageBucketIdOf(findStorageBucket(buckets, "backups"))).toBe(
			"bkt_aaa111",
		);
		expect(storageBucketIdOf(findStorageBucket(buckets, "BACKUPS"))).toBe(
			"bkt_aaa111",
		);
		expect(storageBucketIdOf(findStorageBucket(buckets, "bkt_bbb"))).toBe(
			"bkt_bbb111",
		);
	});

	it("reads the id from either `bucketId` or `id`", () => {
		expect(storageBucketIdOf({ id: "bkt_legacy" })).toBe("bkt_legacy");
		expect(
			storageBucketIdOf(
				findStorageBucket([{ id: "bkt_legacy", name: "old" }], "old"),
			),
		).toBe("bkt_legacy");
	});

	it("refuses an ambiguous bucket name instead of guessing", () => {
		expect(() => findStorageBucket(buckets, "assets-cdn")).toThrow(
			InvalidArgumentError,
		);
		expect(() => findStorageBucket(buckets, "assets-cdn")).toThrow(
			/matches 2 buckets: bkt_bbb111 \(assets-cdn\), bkt_ccc111 \(assets-cdn\)/,
		);
	});

	it("refuses an ambiguous id prefix instead of guessing", () => {
		expect(() => findStorageBucket(buckets, "bkt_aaa")).toThrow(
			/id prefix "bkt_aaa" matches 2 buckets/,
		);
	});

	it("reports an unknown bucket as not found, with suggestions", () => {
		expect(() => findStorageBucket(buckets, "backup")).toThrow(NotFoundError);
		try {
			findStorageBucket(buckets, "backup");
			throw new Error("expected findStorageBucket to throw");
		} catch (err) {
			const error = err as NotFoundError;
			expect(error.code).toBe(ExitCode.NOT_FOUND);
			expect(error.message).toContain('Storage bucket "backup" not found');
			expect(error.suggestions).toContain("backups");
		}
	});

	it("reports an unknown bucket when the organization has none", () => {
		expect(() => findStorageBucket([], "backups")).toThrow(NotFoundError);
	});

	it("blocks a bucket that is still provisioning before the round trip", () => {
		const fresh = findStorageBucket(buckets, "fresh");
		expect(() => assertStorageBucketReady(fresh)).toThrow(InvalidArgumentError);
		expect(() => assertStorageBucketReady(fresh)).toThrow(
			/not ready yet \(status: creating\)/,
		);
	});

	it("allows a ready bucket, and leaves an unknown status to the server", () => {
		expect(() =>
			assertStorageBucketReady(findStorageBucket(buckets, "backups")),
		).not.toThrow();
		expect(() =>
			assertStorageBucketReady({ bucketId: "bkt_x", name: "x" }),
		).not.toThrow();
	});
});

const giteaProviders: GiteaProviderSummary[] = [
	{
		giteaId: "gt_aaa111",
		giteaUrl: "https://git.example.sa",
		gitProviderId: "gp_1",
		git_provider: { name: "internal-gitea" },
	},
	{
		giteaId: "gt_aaa222",
		giteaUrl: "https://git2.example.sa",
		gitProviderId: "gp_2",
		git_provider: { name: "shared" },
	},
	{
		giteaId: "gt_bbb111",
		giteaUrl: "https://git3.example.sa",
		gitProviderId: "gp_3",
		git_provider: { name: "shared" },
	},
];

describe("providers gitea id resolution", () => {
	it("reads the display name off the joined git_provider row", () => {
		expect(giteaProviderName(giteaProviders[0] as GiteaProviderSummary)).toBe(
			"internal-gitea",
		);
		// The camelCase join and a flattened name are both tolerated, so a
		// future response shape does not render every row as "-".
		expect(giteaProviderName({ gitProvider: { name: "camel" } })).toBe("camel");
		expect(giteaProviderName({ name: "flat" })).toBe("flat");
		expect(giteaProviderName({ giteaId: "gt_x" })).toBe("");
	});

	it("narrows a non-array response to an empty list", () => {
		expect(readGiteaProviders(undefined)).toEqual([]);
		expect(readGiteaProviders({ gitea: [] })).toEqual([]);
		expect(readGiteaProviders(giteaProviders)).toHaveLength(3);
	});

	it("resolves a connection by id, name, and unique id prefix", () => {
		expect(findGiteaProvider(giteaProviders, "gt_aaa111").giteaId).toBe(
			"gt_aaa111",
		);
		expect(findGiteaProvider(giteaProviders, "internal-gitea").giteaId).toBe(
			"gt_aaa111",
		);
		expect(findGiteaProvider(giteaProviders, "INTERNAL-GITEA").giteaId).toBe(
			"gt_aaa111",
		);
		expect(findGiteaProvider(giteaProviders, "gt_bbb").giteaId).toBe(
			"gt_bbb111",
		);
	});

	it("refuses an ambiguous connection name instead of guessing", () => {
		expect(() => findGiteaProvider(giteaProviders, "shared")).toThrow(
			InvalidArgumentError,
		);
		expect(() => findGiteaProvider(giteaProviders, "shared")).toThrow(
			/matches 2 connections: gt_aaa222 \(shared\), gt_bbb111 \(shared\)/,
		);
		expect(() => findGiteaProvider(giteaProviders, "gt_aaa")).toThrow(
			/id prefix "gt_aaa" matches 2 connections/,
		);
	});

	it("reports an unknown connection as not found, with suggestions", () => {
		try {
			findGiteaProvider(giteaProviders, "internal-gitae");
			throw new Error("expected findGiteaProvider to throw");
		} catch (err) {
			const error = err as NotFoundError;
			expect(error).toBeInstanceOf(NotFoundError);
			expect(error.code).toBe(ExitCode.NOT_FOUND);
			expect(error.message).toContain(
				'Gitea provider "internal-gitae" not found',
			);
			expect(error.suggestions).toContain("internal-gitea");
		}
	});

	it("reports an empty identifier as an argument error, not a lookup miss", () => {
		expect(() => findGiteaProvider(giteaProviders, "  ")).toThrow(
			InvalidArgumentError,
		);
	});

	it("reports a missing connection when the organization has none", () => {
		expect(() => findGiteaProvider([], "gt_aaa111")).toThrow(NotFoundError);
	});
});
