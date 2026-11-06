/**
 * @fileoverview Why a customer-facing platform procedure has no CLI command.
 *
 * The platform's `surface-scope.ts` decides which tRPC procedures are exposed
 * to API callers at all. Everything it exposes is, by definition, a capability
 * a headless operator or an agent might want — so the CLI should either reach
 * it or say why not. This map is the "why not", and
 * `__test__/surface-coverage.test.ts` enforces that there is no third option:
 * a procedure on the surface that neither has a command nor an entry here
 * fails the suite.
 *
 * That guard exists because the gap reopened silently once already. A
 * 2026-11-05 audit found 104 exposed procedures with no command, including the
 * whole Tarout Email product — not through any decision, just drift. Counting
 * is cheap; noticing is the part that needs automating.
 *
 * Value = the human reason, and it must be non-empty. "Not implemented yet" is
 * not a reason — if it is simply missing, write the command instead.
 * @module lib/coverage-exceptions
 */

export const KNOWN_UNCOVERED = new Map<string, string>([
	// --- Cannot work over the CLI's transport ---
	[
		"dashboard.agentActivityStream",
		"tRPC subscription; the CLI speaks httpBatchLink and cannot consume one. `tarout dashboard agent-digest` and `tarout agent events` are the pollable equivalents.",
	],
	[
		"backup.restoreBackupWithLogs",
		"tRPC subscription (streams restore logs); same transport limit. `tarout backups restore` drives the non-streaming path.",
	],

	// --- Browser-only flows ---
	[
		"user.getUserByToken",
		"publicProcedure backing the pre-signin /auth/invitation page, IP rate-limited against token enumeration. Keyed on an emailed invitation token the CLI never holds.",
	],
	[
		"github.createSetupState",
		"returns the signed state blob for the GitHub App install redirect. `tarout providers github connect` already builds that URL; the handshake only completes in a browser.",
	],

	// --- Procedures that always refuse ---
	[
		"user.generateToken",
		"tombstone: the body unconditionally throws BAD_REQUEST 'Token generation is disabled', so no command could ever succeed.",
	],
	[
		"backup.manualBackupWebServer",
		"always throws ('not supported'); web-server backups are not a customer capability. Documented at the top of src/commands/backups.ts.",
	],
	[
		"virtualMachine.cancelSubscription",
		"cloud servers are billed hourly and have no subscription to cancel. `tarout servers cancel-vm-subscription` is kept as a tombstone that explains this and points at `servers terminate`, so old scripts get an answer rather than a crash.",
	],

	// --- Platform-ops / maintenance plumbing, not user capabilities ---
	[
		"postgres.backfillExternalAccess",
		"rootAdminProcedure: a fleet-wide idempotent repair job for external-access rows. Platform ops, not an operator action.",
	],
	[
		"storage.releaseStorageSlot",
		"decrements legacy subscription_item slot rows. Its purchase twin always throws now that storage bills per-GB, so this can only unwind historical rows — support/ops territory.",
	],

	// --- Covered by a deliberately different command ---
	[
		"postgres.changeStatus",
		"writes an inert applicationStatus column and refuses managed rows outright. `tarout db stop` / `db restart` are engine-agnostic refusals that explain managed databases cannot be stopped; wiring this procedure up would imply otherwise.",
	],
	[
		"mysql.changeStatus",
		"exact twin of postgres.changeStatus, refused for the same reason. `tarout db reactivate` already branches to mysql.reactivate for the real lifecycle action.",
	],
	[
		"settings.isUserSubscribed",
		"only answers 'does the org own any app?', which reads as a billing check but is not one. `tarout settings subscription-status` and `tarout billing status` answer the real question.",
	],
	[
		"user.sendInvitation",
		"not reachable over the CLI's x-api-key transport. `tarout account invitations` lists them; sending one is a dashboard action.",
	],
	[
		"deployment.allByType",
		"reached through buildDeploymentTypeQuery in src/commands/deploy.ts rather than a literal client call site, so static matching misses it. `tarout deploy:list` uses it.",
	],

	// --- Withheld on purpose ---
	[
		"domainRegistrar.updateNameservers",
		"deliberately un-surfaced. The platform's own parity test guards three sibling nameserver paths, and delegating a zone away from Tarout's Cloudflare zone dark-breaks managed DNS, linked-app routing and Universal SSL with no reverse command. If it is ever wanted, restrict it to re-applying the domain's own nameservers.",
	],
]);

/**
 * Procedure paths in the snapshot that the CLI neither calls nor excuses.
 * Empty is the only passing state; see this module's header for why.
 */
export function findUnexplainedGaps(
	surface: readonly string[],
	isCalled: (path: string) => boolean,
): string[] {
	return surface.filter(
		(path) => !isCalled(path) && !KNOWN_UNCOVERED.has(path),
	);
}

/** Entries that no longer match a procedure on the surface, so they are stale. */
export function findStaleExceptions(surface: readonly string[]): string[] {
	const live = new Set(surface);
	return [...KNOWN_UNCOVERED.keys()].filter((path) => !live.has(path));
}

/** Entries whose reason is missing or whitespace, which defeats the point. */
export function findEmptyReasons(): string[] {
	return [...KNOWN_UNCOVERED.entries()]
		.filter(([, reason]) => reason.trim().length === 0)
		.map(([path]) => path);
}
