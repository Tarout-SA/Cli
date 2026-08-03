# CLI Account-Only Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tarout login` authorizes the account + organization only; projects are created and switched from the CLI without re-authenticating.

**Architecture:** New CLI logins mint an **account-scoped** API key (metadata `{ organizationId, accountScoped: true }`, no `projectId`). The CLI sends the active project per request in an `x-tarout-project` header; the server resolves it to `session.projectScopeId` after verifying the project belongs to the key's organization. Legacy project-pinned keys keep today's behavior exactly.

**Tech Stack:** TypeScript, Bun, tRPC, Prisma, better-auth (platform: Next.js 16 Pages Router; CLI: Commander + Vitest).

## Global Constraints

- **Two repos.** `platform/` (spec: server side) and `cli/`. They are separate git repos.
- **Git in `platform/` is user-managed.** `platform/CLAUDE.md` forbids proactive git commands. **Do not run any git command in `platform/`** — no add, no commit, no branch. Leave changes in the working tree and tell the user. Commit steps in this plan apply to `cli/` **only**.
- **`cli/` work happens in a git worktree**, not the shared checkout (concurrent sessions reset it).
- **Test commands:** platform → `bun run test <path>` (Vitest via `__test__/unit.config.ts`). A bare `bun test` is a bunfig no-op and breaks `vi.importActual` — never use it. CLI → `bun run test` (`vitest run && bun test`).
- **Typecheck is the real gate:** `bun run typecheck` in each repo. Biome lint: `bun run lint`. No formatter — match surrounding style, **tabs for indentation**.
- **Metadata discriminator is exactly `accountScoped: true`** (boolean, in `apikey.metadata` JSON). Never infer "account key" from an absent `projectId`.
- **Header name is exactly `x-tarout-project`** (lowercase).
- **Rollout order: platform first, then CLI.** Never ship the CLI before the server understands the header.
- No Prisma migration is needed — `apikey.metadata` is already a JSON string column.

---

## File Structure

**platform/ (no git operations)**
- Modify `src/server/services/cli-authorization.ts` — make intent `projectId` optional
- Modify `src/pages/api/cli/exchange.ts` — mint account-scoped keys
- Modify `src/server/api/routers/user.ts` — `createCliSession` stops requiring a project
- Modify `src/server/lib/auth.ts` — header-based scope resolution + skip back-fill for account keys
- Modify `src/pages/cli-auth.tsx` — remove the project picker
- Test `__test__/services/cli-account-scope.test.ts` (new)

**cli/ (worktree + commits)**
- Modify `src/lib/api.ts` — attach `x-tarout-project`
- Create `src/lib/active-project.ts` — `resolveActiveProject()` + picker
- Modify `src/index.ts` — `PROJECT_EXEMPT_LEAF` + hook call
- Modify `src/commands/projects.ts` — `use` works for account keys; `create` auto-activates
- Test `__test__/active-project.test.ts` (new), `__test__/api-project-header.test.ts` (new)

---

## Task 1: Make the authorization intent project-optional (platform)

**Files:**
- Modify: `platform/src/server/services/cli-authorization.ts:174-190` (parseIntent), `:192-237` (createCliAuthorizationIntent), and the `CliAuthorizationIntent` interface
- Test: `platform/__test__/services/cli-account-scope.test.ts` (create)

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `CliAuthorizationIntent.projectId?: string` (now optional); `createCliAuthorizationIntent(input: { userId: string; organizationId: string; projectId?: string; codeChallenge: string }, deps?)` → `Promise<{ code: string; expiresAt: number }>`

- [ ] **Step 1: Write the failing test**

Create `platform/__test__/services/cli-account-scope.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
	createCliAuthorizationIntent,
	consumeCliAuthorizationIntent,
} from "@/server/services/cli-authorization";

const CHALLENGE = "a".repeat(43);

function memoryStore() {
	const map = new Map<string, string>();
	return {
		map,
		async replaceForSubject(key: string, _subject: string, value: string) {
			map.set(key, value);
			return "OK" as const;
		},
		async consumeWhenChallengeMatches(key: string) {
			const value = map.get(key);
			if (!value) return null;
			map.delete(key);
			return value;
		},
	};
}

describe("CLI authorization intent without a project", () => {
	it("creates and round-trips an intent that carries no projectId", async () => {
		const store = memoryStore();
		const codeFactory = () => "b".repeat(43);

		const { code } = await createCliAuthorizationIntent(
			{
				userId: "user_1",
				organizationId: "org_1",
				codeChallenge: CHALLENGE,
			},
			{ store: store as never, codeFactory, now: () => 1_000 },
		);

		const stored = JSON.parse([...store.map.values()][0] as string);
		expect(stored.projectId).toBeUndefined();
		expect(stored.organizationId).toBe("org_1");
		expect(code).toBe("b".repeat(43));
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd platform && bun run test __test__/services/cli-account-scope.test.ts`
Expected: FAIL — `createCliAuthorizationIntent` currently calls `assertIdentifier(input.projectId, "project")` and throws `CliAuthorizationError`.

- [ ] **Step 3: Make projectId optional**

In `platform/src/server/services/cli-authorization.ts`:

Interface — change the `projectId` field on `CliAuthorizationIntent` to:

```ts
	projectId?: string;
```

In `parseIntent` (line ~178), replace the strict project check inside the `if (...)` condition:

```ts
		typeof intent.projectId === "string" ||
```

with:

```ts
		(intent.projectId !== undefined && typeof intent.projectId !== "string") ||
```

(Note the inverted sense: the surrounding `if` throws when a clause is **true**, so this rejects only a *present but non-string* projectId.)

In `createCliAuthorizationIntent`, change the signature's `projectId: string` to `projectId?: string`, and replace:

```ts
	assertIdentifier(input.projectId, "project");
```

with:

```ts
	if (input.projectId !== undefined) assertIdentifier(input.projectId, "project");
```

The `intent` object literal already spreads `projectId: input.projectId`; leave it — `JSON.stringify` drops `undefined`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd platform && bun run test __test__/services/cli-account-scope.test.ts`
Expected: PASS

- [ ] **Step 5: Verify no regression in existing authorization tests**

Run: `cd platform && bun run test __test__/services/ && bun run typecheck`
Expected: PASS. Do **not** commit (platform git is user-managed).

---

## Task 2: Mint account-scoped keys at exchange (platform)

**Files:**
- Modify: `platform/src/pages/api/cli/exchange.ts:101-178`
- Modify: `platform/src/server/api/routers/user.ts:1423-1509`
- Test: `platform/__test__/services/cli-account-scope.test.ts` (extend)

**Interfaces:**
- Consumes: `CliAuthorizationIntent.projectId?: string` from Task 1
- Produces: keys with metadata `{ organizationId: string; accountScoped: true }`; `/api/cli/exchange` response omits `projectId`/`projectName`/`projectSlug`; `user.createCliSession` input `{ codeChallenge: string }` (no `projectId`), returns `{ code, expiresAt, identity: { userId, organizationId } }`

- [ ] **Step 1: Write the failing test**

Append to `platform/__test__/services/cli-account-scope.test.ts`:

```ts
describe("account-scoped key metadata", () => {
	it("marks CLI keys accountScoped with no projectId", () => {
		const metadata = { organizationId: "org_1", accountScoped: true as const };
		expect(metadata.accountScoped).toBe(true);
		expect((metadata as { projectId?: string }).projectId).toBeUndefined();
	});
});
```

Then the real assertion — a unit test of the metadata builder you are about to extract:

```ts
import { buildCliKeyMetadata } from "@/server/services/cli-authorization";

describe("buildCliKeyMetadata", () => {
	it("omits projectId and sets accountScoped", () => {
		expect(buildCliKeyMetadata("org_1")).toEqual({
			organizationId: "org_1",
			accountScoped: true,
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd platform && bun run test __test__/services/cli-account-scope.test.ts`
Expected: FAIL — `buildCliKeyMetadata` is not exported from `cli-authorization`.

- [ ] **Step 3: Add the builder and use it**

Add to the end of `platform/src/server/services/cli-authorization.ts`:

```ts
/**
 * Metadata for a CLI credential. `accountScoped` is the explicit marker that
 * stops validateRequest() from back-filling a projectId into the key: the
 * active project travels per-request in the x-tarout-project header instead.
 */
export function buildCliKeyMetadata(organizationId: string): {
	organizationId: string;
	accountScoped: true;
} {
	return { organizationId, accountScoped: true };
}
```

In `platform/src/pages/api/cli/exchange.ts`:

- Add to the imports: `import { buildCliKeyMetadata } from "@/server/services/cli-authorization";` (merge with the existing import from that module if one exists).
- Delete the `db.project.findFirst({...})` entry from the `Promise.all` array (lines ~101-107) and the matching `project` binding in its destructuring.
- Remove `!project ||` from the deny condition (line ~129).
- Remove `projectId: intent.projectId,` from the denied-event payload (line ~136).
- Replace the `metadata:` object in the `createApiKey` call with:

```ts
			metadata: buildCliKeyMetadata(organization.id),
```

- Remove `projectId: project.projectId,` from the `recordAuthMonitorEvent` call (line ~162).
- Remove the three project fields from the 200 response body (lines ~175-177), leaving `token`, `userId`, `userEmail`, `userName`, `organizationId`, `organizationName`.

In `platform/src/server/api/routers/user.ts` `createCliSession` (line 1423):

- Change the input schema to drop `projectId`:

```ts
			z.object({
				codeChallenge: z
					.string()
					.regex(/^[A-Za-z0-9_-]{43}$/, "Invalid PKCE code challenge"),
			}),
```

- Delete the whole project-resolution block (lines ~1438-1479: `requestedProjectId`, `projectSelect`, `targetProject`, and both `TRPCError` throws).
- Change the intent call to omit the project:

```ts
			const authorization = await createCliAuthorizationIntent({
				userId: ctx.user.id,
				organizationId: ctx.session.activeOrganizationId,
				codeChallenge: input.codeChallenge,
			});
```

- In the `recordAuthMonitorEvent` call, remove `projectId: targetProject.projectId,` and replace the `metadata` object with `metadata: { accountScoped: true, expiresAt: authorization.expiresAt, protocol: 2 }`.
- Change the return `identity` to `{ userId: ctx.user.id, organizationId: ctx.session.activeOrganizationId }`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd platform && bun run test __test__/services/cli-account-scope.test.ts && bun run typecheck`
Expected: PASS. Typecheck will surface any remaining reference to the removed `project` binding — fix those in this task.

---

## Task 3: Resolve project scope from the request header (platform)

**Files:**
- Modify: `platform/src/server/lib/auth.ts:1243-1246` (metadata type), `:1326-1424` (scope resolution), `:984-998` (`getApiKeyProjectScope` message)
- Test: `platform/__test__/services/cli-account-scope.test.ts` (extend)

**Interfaces:**
- Consumes: `buildCliKeyMetadata` from Task 2 (metadata shape `{ organizationId, accountScoped: true }`)
- Produces: `resolveAccountKeyProjectScope(...)` exported from `auth.ts`:

```ts
export async function resolveAccountKeyProjectScope(input: {
	requestedProjectId: string | undefined;
	organizationId: string;
	findProject: (projectId: string, organizationId: string) => Promise<boolean>;
}): Promise<string | undefined>
```

Throws `TRPCError({ code: "FORBIDDEN" })` when the requested project is not in the org.

- [ ] **Step 1: Write the failing test**

Append to `platform/__test__/services/cli-account-scope.test.ts`:

```ts
import { resolveAccountKeyProjectScope } from "@/server/lib/auth";

describe("resolveAccountKeyProjectScope", () => {
	const inOrg = async () => true;
	const notInOrg = async () => false;

	it("returns undefined when no project was requested", async () => {
		await expect(
			resolveAccountKeyProjectScope({
				requestedProjectId: undefined,
				organizationId: "org_1",
				findProject: inOrg,
			}),
		).resolves.toBeUndefined();
	});

	it("returns the requested project when it belongs to the org", async () => {
		await expect(
			resolveAccountKeyProjectScope({
				requestedProjectId: "proj_1",
				organizationId: "org_1",
				findProject: inOrg,
			}),
		).resolves.toBe("proj_1");
	});

	it("rejects a project outside the key's organization", async () => {
		await expect(
			resolveAccountKeyProjectScope({
				requestedProjectId: "proj_other",
				organizationId: "org_1",
				findProject: notInOrg,
			}),
		).rejects.toThrow(/proj_other/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd platform && bun run test __test__/services/cli-account-scope.test.ts`
Expected: FAIL — `resolveAccountKeyProjectScope` is not exported.

- [ ] **Step 3: Implement the resolver**

Add to `platform/src/server/lib/auth.ts`, next to `getApiKeyProjectScope` (~line 998):

```ts
/**
 * Project scope for an account-scoped key. The active project arrives per
 * request (x-tarout-project) rather than pinned in key metadata, so it must be
 * proven to belong to the key's organization before it becomes an
 * authorization boundary. No header simply means "no project selected yet".
 */
export async function resolveAccountKeyProjectScope(input: {
	requestedProjectId: string | undefined;
	organizationId: string;
	findProject: (
		projectId: string,
		organizationId: string,
	) => Promise<boolean>;
}): Promise<string | undefined> {
	if (!input.requestedProjectId) return undefined;
	const belongs = await input.findProject(
		input.requestedProjectId,
		input.organizationId,
	);
	if (!belongs) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: `Project ${input.requestedProjectId} is not in this credential's organization`,
		});
	}
	return input.requestedProjectId;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd platform && bun run test __test__/services/cli-account-scope.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the resolver into validateRequest**

In `platform/src/server/lib/auth.ts`:

Widen the metadata type (line ~1243):

```ts
			const apiKeyMetadata = JSON.parse(apiKeyRecord.metadata || "{}") as {
				organizationId?: string;
				projectId?: string;
				accountScoped?: boolean;
			};
```

Read the header once, near the top of the API-key branch (after line ~1200, `if (apiKey) {`):

```ts
			const requestedProjectHeader = request.headers["x-tarout-project"];
			const requestedProjectId = Array.isArray(requestedProjectHeader)
				? requestedProjectHeader[0]
				: requestedProjectHeader;
```

Then replace the scope block. Immediately after the existing `let activeProjectId = apiKeyMetadata.projectId;` (line ~1326), insert the account-key branch, which returns early past the whole legacy fallback/bootstrap/back-fill sequence:

```ts
			if (apiKeyMetadata.accountScoped === true) {
				// Account-scoped keys carry no pinned project: no fallback to the
				// org default, no bootstrap, no metadata back-fill. An org with zero
				// projects is a valid (un-bootstrapped) state for this credential.
				activeProjectId = await resolveAccountKeyProjectScope({
					requestedProjectId,
					organizationId,
					findProject: async (projectId, orgId) =>
						(await db.project.findFirst({
							where: { projectId, organizationId: orgId },
							select: { projectId: true },
						})) !== null,
				});
			} else {
```

Wrap the existing legacy sequence (the `if (activeProjectId) {...}` project check at ~1328 through the back-fill `if (!apiKeyMetadata.projectId) {...}` ending at ~1424) inside that `else` block, then close it with `}`.

Add the pinned-key mismatch guard inside the `else` branch, right after the existing `if (activeProjectId) { ... }` org-membership check:

```ts
				if (
					activeProjectId &&
					requestedProjectId &&
					requestedProjectId !== activeProjectId
				) {
					void recordAuthMonitorEvent({
						event: "api_key_rejected_project_scope",
						userId: apiKeyRecord.user.id,
						email: apiKeyRecord.user.email,
						apiKeyId: apiKeyRecord.id,
						organizationId,
						projectId: requestedProjectId,
						level: "warning",
						reason: "Requested project does not match the key's pinned project",
					});
					return { session: null, user: null };
				}
```

In the `mockSession` literal (line ~1459), `activeProjectId` and `projectScopeId` already both read the `activeProjectId` variable — leave those lines alone. For account keys the value may now be `undefined`, which is the intended "no scope selected" state. Add one field so downstream procedures can tell an account key from a pinned one:

```ts
					accountScoped: apiKeyMetadata.accountScoped === true,
```

And declare it on the `ValidatedSession` interface (line ~1037, beside `projectScopeId`):

```ts
	/**
	 * True for CLI keys minted after the account-only auth change. Such keys
	 * carry no pinned project — the active one arrives per request — so
	 * project-management procedures must not treat them as project-scoped.
	 */
	accountScoped?: boolean;
```

- [ ] **Step 6: Improve the no-scope error message**

In `getApiKeyProjectScope` (line ~992), replace the `message` with:

```ts
					message:
						"No project selected. Run `tarout projects use <slug>` or pass --project.",
```

- [ ] **Step 7: Run the full check**

Run: `cd platform && bun run test __test__/services/ && bun run typecheck && bun run lint`
Expected: PASS

---

## Task 4: Remove the project picker from the authorize page (platform)

**Files:**
- Modify: `platform/src/pages/cli-auth.tsx:68-119` (props/state/mutation), the project `Select` block (~230-262), and `getServerSideProps` (~304-360)
- Modify: `platform/public/locales/en/common.json`, `platform/public/locales/ar/common.json` (only if a key is newly added)

**Interfaces:**
- Consumes: `user.createCliSession` input `{ codeChallenge }` from Task 2
- Produces: no exported API; the page posts `{ codeChallenge }` only

- [ ] **Step 1: Remove project state and the mutation argument**

In `platform/src/pages/cli-auth.tsx`:

- Delete `projects` and `defaultProjectId` from the `CliAuthProps` type and from the component's destructured props.
- Delete `const [selectedProjectId, setSelectedProjectId] = useState(defaultProjectId);` (line 78).
- Change the mutate call (line 105) to:

```ts
		createSession.mutate({ codeChallenge });
```

- [ ] **Step 2: Remove the picker UI**

Delete the project `Select` block (the `SelectTrigger`/`SelectContent` group around lines 230-262) together with its wrapping label/container, leaving the account + organization summary and the Authorize/Cancel buttons. Remove any `Select*` imports that become unused (Biome's `noUnusedImports` is an error).

- [ ] **Step 3: Stop fetching projects server-side**

In `getServerSideProps` (~304-360), delete the project query (~329-338) and the `defaultProjectId` computation (~339-343), and remove both from the returned `props`. Keep the session/redirect logic and `serverSideTranslations` untouched.

- [ ] **Step 4: Verify**

Run: `cd platform && bun run typecheck && bun run lint`
Expected: PASS, with no unused-import or unused-variable errors.

- [ ] **Step 5: Check translation keys**

Run: `cd platform && bun run check:i18n`
Expected: PASS. If a project-picker key is now orphaned, leave it (orphans are harmless); if you added any new string, add it to **both** `en` and `ar` `common.json`.

---

## Task 5: Set up the CLI worktree

**Files:** none modified

- [ ] **Step 1: Create the worktree**

```bash
cd /home/stanoid/tarout/cli
git worktree add ../cli-account-auth -b feat/account-only-auth
cd ../cli-account-auth && bun install
```

- [ ] **Step 2: Confirm a clean baseline**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run typecheck && bun run test`
Expected: PASS. If the baseline is already red, stop and report — do not build on a broken tree.

**All remaining CLI tasks run in `/home/stanoid/tarout/cli-account-auth`.**

---

## Task 6: Attach the project header on every request (cli)

**Files:**
- Modify: `cli/src/lib/api.ts:31-49`
- Test: `cli/__test__/api-project-header.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier CLI tasks
- Produces: `setRequestProjectId(projectId: string | null): void` and `getRequestProjectId(): string | null`, both exported from `src/lib/api.ts`. The header function sends `x-tarout-project` when a project id is set, falling back to `getCurrentProfile()?.projectId`.

- [ ] **Step 1: Write the failing test**

Create `cli/__test__/api-project-header.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/config.js", () => ({
	getApiUrl: () => "https://api.example.com",
	getToken: () => "tok_123",
	isLoggedIn: () => true,
	getCurrentProfile: () => ({ projectId: "proj_profile" }),
}));

import {
	buildRequestHeaders,
	setRequestProjectId,
} from "../src/lib/api.js";

describe("x-tarout-project header", () => {
	beforeEach(() => {
		setRequestProjectId(null);
	});

	it("falls back to the profile project", () => {
		expect(buildRequestHeaders()["x-tarout-project"]).toBe("proj_profile");
	});

	it("prefers an explicitly set project over the profile", () => {
		setRequestProjectId("proj_override");
		expect(buildRequestHeaders()["x-tarout-project"]).toBe("proj_override");
	});

	it("always sends the api key", () => {
		expect(buildRequestHeaders()["x-api-key"]).toBe("tok_123");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/api-project-header.test.ts`
Expected: FAIL — `buildRequestHeaders` / `setRequestProjectId` are not exported.

- [ ] **Step 3: Implement**

In `cli/src/lib/api.ts`, change the config import to include `getCurrentProfile`:

```ts
import {
	getApiUrl,
	getCurrentProfile,
	getToken,
	isLoggedIn,
} from "./config.js";
```

Add above `createApiClient`:

```ts
/**
 * Active project for this invocation. Set from `--project` or the interactive
 * picker before any project-scoped request; falls back to the saved profile.
 */
let requestProjectId: string | null = null;

export function setRequestProjectId(projectId: string | null): void {
	requestProjectId = projectId;
}

export function getRequestProjectId(): string | null {
	return requestProjectId ?? getCurrentProfile()?.projectId ?? null;
}

export function buildRequestHeaders(): Record<string, string> {
	const headers: Record<string, string> = {};
	const token = getToken();
	if (token) headers["x-api-key"] = token;
	const projectId = getRequestProjectId();
	if (projectId) headers["x-tarout-project"] = projectId;
	return headers;
}
```

Replace the `headers` line inside `httpBatchLink` (line 44) with:

```ts
				headers: () => buildRequestHeaders(),
```

Delete the now-unused `const token = getToken();` at line 36 (Biome errors on unused variables).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/api-project-header.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/stanoid/tarout/cli-account-auth
git add src/lib/api.ts __test__/api-project-header.test.ts
git commit -m "feat(api): send active project in x-tarout-project header"
```

---

## Task 7: Resolve the active project (cli)

**Files:**
- Create: `cli/src/lib/active-project.ts`
- Test: `cli/__test__/active-project.test.ts` (create)

**Interfaces:**
- Consumes: `setRequestProjectId` from Task 6; `select` (`src/utils/prompts.ts:113`), `updateProfile`/`getCurrentProfile` (`src/lib/config.ts:276,125`), `getApiClient` (`src/lib/api.ts:60`)
- Produces:

```ts
export interface ProjectChoice {
	projectId: string;
	name: string;
	slug: string;
}
export async function resolveActiveProject(opts?: {
	projectFlag?: string;
}): Promise<string | null>;
export function findProject(
	all: ProjectChoice[],
	slugOrId: string,
): ProjectChoice | undefined;
```

`resolveActiveProject` returns the resolved project id, persists it via `updateProfile`, and calls `setRequestProjectId`. Returns `null` only when the org has no projects and the user declined to create one.

- [ ] **Step 1: Write the failing test**

Create `cli/__test__/active-project.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateProfile = vi.fn();
const setRequestProjectId = vi.fn();
const select = vi.fn();
let profile: { projectId?: string } | null = null;
let projects: Array<{ projectId: string; name: string; slug: string }> = [];

vi.mock("../src/lib/config.js", () => ({
	getCurrentProfile: () => profile,
	updateProfile: (u: unknown) => updateProfile(u),
}));
vi.mock("../src/lib/api.js", () => ({
	getApiClient: () => ({
		project: { all: { query: async () => projects } },
	}),
	setRequestProjectId: (id: string | null) => setRequestProjectId(id),
}));
vi.mock("../src/utils/prompts.js", () => ({
	select: (...args: unknown[]) => select(...args),
}));

import { findProject, resolveActiveProject } from "../src/lib/active-project.js";

describe("findProject", () => {
	const all = [{ projectId: "p1", name: "Alpha", slug: "alpha" }];

	it("matches by id, slug, and case-insensitive name", () => {
		expect(findProject(all, "p1")?.projectId).toBe("p1");
		expect(findProject(all, "alpha")?.projectId).toBe("p1");
		expect(findProject(all, "ALPHA")?.projectId).toBe("p1");
		expect(findProject(all, "nope")).toBeUndefined();
	});
});

describe("resolveActiveProject", () => {
	beforeEach(() => {
		updateProfile.mockClear();
		setRequestProjectId.mockClear();
		select.mockReset();
		profile = null;
		projects = [];
	});

	it("prefers the --project flag over the saved profile", async () => {
		profile = { projectId: "p_saved" };
		projects = [
			{ projectId: "p_saved", name: "Saved", slug: "saved" },
			{ projectId: "p_flag", name: "Flag", slug: "flag" },
		];

		await expect(resolveActiveProject({ projectFlag: "flag" })).resolves.toBe(
			"p_flag",
		);
		expect(setRequestProjectId).toHaveBeenCalledWith("p_flag");
		expect(select).not.toHaveBeenCalled();
	});

	it("uses the saved profile project without prompting", async () => {
		profile = { projectId: "p_saved" };
		await expect(resolveActiveProject()).resolves.toBe("p_saved");
		expect(select).not.toHaveBeenCalled();
	});

	it("auto-selects when the org has exactly one project", async () => {
		projects = [{ projectId: "p_only", name: "Only", slug: "only" }];
		await expect(resolveActiveProject()).resolves.toBe("p_only");
		expect(select).not.toHaveBeenCalled();
		expect(updateProfile).toHaveBeenCalledWith({
			projectId: "p_only",
			projectName: "Only",
			projectSlug: "only",
		});
	});

	it("prompts when several projects exist and saves the choice", async () => {
		projects = [
			{ projectId: "p1", name: "Alpha", slug: "alpha" },
			{ projectId: "p2", name: "Beta", slug: "beta" },
		];
		select.mockResolvedValue("p2");

		await expect(resolveActiveProject()).resolves.toBe("p2");
		expect(updateProfile).toHaveBeenCalledWith({
			projectId: "p2",
			projectName: "Beta",
			projectSlug: "beta",
		});
		expect(setRequestProjectId).toHaveBeenCalledWith("p2");
	});

	it("throws a helpful error when the flag names an unknown project", async () => {
		projects = [{ projectId: "p1", name: "Alpha", slug: "alpha" }];
		await expect(
			resolveActiveProject({ projectFlag: "ghost" }),
		).rejects.toThrow(/ghost/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/active-project.test.ts`
Expected: FAIL — `src/lib/active-project.ts` does not exist.

- [ ] **Step 3: Implement**

Create `cli/src/lib/active-project.ts`:

```ts
/**
 * Active-project resolution. Login authorizes the account and organization
 * only, so the project a command acts on is chosen here and travels per
 * request in the x-tarout-project header.
 */
import { select } from "../utils/prompts.js";
import { getApiClient, setRequestProjectId } from "./api.js";
import { getCurrentProfile, updateProfile } from "./config.js";
import { NotFoundError } from "./errors.js";

export interface ProjectChoice {
	projectId: string;
	name: string;
	slug: string;
}

export function findProject(
	all: ProjectChoice[],
	slugOrId: string,
): ProjectChoice | undefined {
	return all.find(
		(p) =>
			p.projectId === slugOrId ||
			p.slug === slugOrId ||
			p.name.toLowerCase() === slugOrId.toLowerCase(),
	);
}

function activate(project: ProjectChoice): string {
	updateProfile({
		projectId: project.projectId,
		projectName: project.name,
		projectSlug: project.slug,
	});
	setRequestProjectId(project.projectId);
	return project.projectId;
}

export async function resolveActiveProject(opts?: {
	projectFlag?: string;
}): Promise<string | null> {
	const flag = opts?.projectFlag;

	if (!flag) {
		const saved = getCurrentProfile()?.projectId;
		if (saved) {
			setRequestProjectId(saved);
			return saved;
		}
	}

	const client = getApiClient();
	const all: ProjectChoice[] = await client.project.all.query();

	if (flag) {
		const target = findProject(all, flag);
		if (!target) {
			throw new NotFoundError("Project", flag, [
				"Run `tarout projects list` to see available projects.",
				"Run `tarout projects create <name>` to make a new one.",
			]);
		}
		return activate(target);
	}

	if (all.length === 0) return null;
	if (all.length === 1) return activate(all[0] as ProjectChoice);

	const chosen = await select(
		"Select a project",
		all.map((p) => ({ name: `${p.name} (${p.slug})`, value: p.projectId })),
		{ field: "project", flag: "--project" },
	);
	const target = all.find((p) => p.projectId === chosen);
	if (!target) {
		throw new NotFoundError("Project", chosen);
	}
	return activate(target);
}
```

`NotFoundError(resource, id, suggestions?)` (`src/lib/errors.ts:136`) composes the message itself and exits `NOT_FOUND`. There is no `ValidationError` class in this codebase — do not invent one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/active-project.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/stanoid/tarout/cli-account-auth
git add src/lib/active-project.ts __test__/active-project.test.ts
git commit -m "feat(project): resolve active project from flag, profile, or picker"
```

---

## Task 8: Run project resolution in the command hook (cli)

**Files:**
- Modify: `cli/src/index.ts:54-97` (exempt sets + predicate), `:181-193` (hook body), and the root `.option(...)` chain (~104-120)
- Test: `cli/__test__/project-gate.test.ts` (create)

**Interfaces:**
- Consumes: `resolveActiveProject` from Task 7
- Produces: `commandRequiresProject(actionCommand: Command | undefined, root: Command): boolean` exported from `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `cli/__test__/project-gate.test.ts`:

```ts
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { commandRequiresProject } from "../src/index.js";

function tree(): { root: Command; leaf: (path: string[]) => Command } {
	const root = new Command();
	const made = new Map<string, Command>();
	const leaf = (path: string[]) => {
		let parent: Command = root;
		let key = "";
		for (const name of path) {
			key = key ? `${key} ${name}` : name;
			let next = made.get(key);
			if (!next) {
				next = parent.command(name);
				made.set(key, next);
			}
			parent = next;
		}
		return parent;
	};
	return { root, leaf };
}

describe("commandRequiresProject", () => {
	it("gates resource commands", () => {
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["db", "list"]), root)).toBe(true);
		expect(commandRequiresProject(leaf(["storage", "list"]), root)).toBe(true);
	});

	it("exempts project, org, billing, and auth commands", () => {
		const { root, leaf } = tree();
		for (const path of [
			["projects", "list"],
			["orgs", "list"],
			["billing", "status"],
			["login"],
			["logout"],
			["whoami"],
		]) {
			expect(commandRequiresProject(leaf(path), root)).toBe(false);
		}
	});

	it("exempts the agent namespace and the bare root", () => {
		const { root, leaf } = tree();
		expect(commandRequiresProject(leaf(["agent", "init"]), root)).toBe(false);
		expect(commandRequiresProject(root, root)).toBe(false);
		expect(commandRequiresProject(undefined, root)).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/project-gate.test.ts`
Expected: FAIL — `commandRequiresProject` is not exported.

- [ ] **Step 3: Implement the predicate**

In `cli/src/index.ts`, add below `AUTH_EXEMPT_LEAF` (after line 74):

```ts
/**
 * Commands that run without an active project. Everything else resolves one in
 * the preAction hook, so a resource command never acts on an unexpected
 * project. These are org-level surfaces or manage the selection itself.
 */
const PROJECT_EXEMPT_LEAF = new Set([
	"login",
	"register",
	"token",
	"logout",
	"whoami",
	"projects",
	"orgs",
	"billing",
]);

/**
 * Whether the about-to-run command needs an active project. Mirrors
 * commandRequiresAuth: walks the ancestry so nested commands and the `agent`
 * namespace classify correctly, and never gates the bare root program.
 */
export function commandRequiresProject(
	actionCommand: Command | undefined,
	root: Command,
): boolean {
	if (!actionCommand || actionCommand === root) return false;
	const names: string[] = [];
	for (
		let cur: Command | null | undefined = actionCommand;
		cur && cur !== root;
		cur = cur.parent
	) {
		names.push(cur.name());
	}
	if (names.includes("agent")) return false;
	for (const name of names) {
		if (PROJECT_EXEMPT_LEAF.has(name)) return false;
	}
	return names.length > 0;
}
```

Note the difference from `commandRequiresAuth`: it checks **every** ancestor name against the exempt set (so `projects use` and `billing upgrade` are both exempt), not just the leaf.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/project-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Wire it into the hook**

Add the global flag to the root option chain in `cli/src/index.ts` (after the `--global-auth` option, ~line 120):

```ts
		.option(
			"--project <slugOrId>",
			"Act on this project for this invocation (overrides the saved project)",
		)
```

Add the import near the other lib imports:

```ts
import { resolveActiveProject } from "./lib/active-project.js";
```

In the `preAction` hook, immediately after the `ensureAuthenticated` block (after line 193), add:

```ts
			// Resolve the project the command will act on. Login binds the account
			// and organization only, so this is where a project is chosen — from
			// --project, the saved profile, or a picker. The id then rides along in
			// the x-tarout-project header on every request.
			if (commandRequiresProject(actionCommand, thisCommand)) {
				const projectFlag =
					typeof opts.project === "string"
						? opts.project
						: typeof actionCommand?.opts().project === "string"
							? (actionCommand.opts().project as string)
							: undefined;
				await resolveActiveProject({ projectFlag });
			}
```

- [ ] **Step 6: Verify the whole suite**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run typecheck && bun run lint && bun run test`
Expected: PASS. Existing tests that construct the program may now hit the new hook — if a test fails because it lacks a project, mock `resolveActiveProject` in that test rather than weakening the gate.

- [ ] **Step 7: Commit**

```bash
cd /home/stanoid/tarout/cli-account-auth
git add src/index.ts __test__/project-gate.test.ts
git commit -m "feat(cli): resolve the active project before non-exempt commands"
```

---

## Task 9: Make `projects use` and `create` work with account keys (cli)

**Files:**
- Modify: `cli/src/commands/projects.ts:26-42` (`verifyProjectCredentialScope`), `:106-154` (`use`), `:156-191` (`create`)
- Test: `cli/__test__/projects-use.test.ts` (create)

**Interfaces:**
- Consumes: `findProject` from Task 7; `setRequestProjectId` from Task 6
- Produces: no new exports; `verifyProjectCredentialScope` gains an account-key fast path

- [ ] **Step 1: Write the failing test**

Create `cli/__test__/projects-use.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { verifyProjectCredentialScope } from "../src/commands/projects.js";

const target = { projectId: "p_new", name: "New", slug: "new" };

function clientReturning(scope: {
	accountScoped: boolean;
	projectId: string | null;
}) {
	return { project: { credentialScope: { query: async () => scope } } };
}

describe("verifyProjectCredentialScope", () => {
	it("allows switching when the credential is account-scoped", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: true, projectId: "p_old" }),
				target,
			),
		).resolves.toEqual(target);
	});

	it("allows switching when an account key has nothing selected yet", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: true, projectId: null }),
				target,
			),
		).resolves.toEqual(target);
	});

	it("still blocks a pinned legacy credential", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: false, projectId: "p_old" }),
				target,
			),
		).rejects.toThrow(/tarout login/);
	});

	it("passes through when the pinned project already matches", async () => {
		await expect(
			verifyProjectCredentialScope(
				clientReturning({ accountScoped: false, projectId: "p_new" }),
				target,
			),
		).resolves.toEqual(target);
	});
});
```

These tests call `project.credentialScope`, the procedure added in Step 6 — write them this way from the start.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/projects-use.test.ts`
Expected: FAIL — the account-scoped case throws today.

- [ ] **Step 3: Add the account-key fast path**

In `cli/src/commands/projects.ts`, replace the body of `verifyProjectCredentialScope` (lines 31-42) with:

```ts
export async function verifyProjectCredentialScope(
	client: any,
	target: ProjectSummary,
): Promise<ProjectSummary> {
	const effective = await client.project.credentialScope.query();
	// Account-scoped credentials carry no pinned project — the active project
	// travels per request, so switching is a local change and always allowed.
	if (effective?.accountScoped === true) return target;
	if (effective?.projectId !== target.projectId) {
		throw new AuthError(
			`Cannot switch to ${target.name} with the current project-scoped credential. Run \`tarout login\` and select that project in the browser.`,
		);
	}
	return target;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run test __test__/projects-use.test.ts`
Expected: PASS

- [ ] **Step 5: Unblock project creation for account keys (platform) — REQUIRED**

`project.create` currently rejects **every** API-key session that has a project scope (`platform/src/server/api/routers/project.ts:134-139`):

```ts
			if (getApiKeyProjectScope(ctx.session)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "A project-scoped API key cannot create projects",
				});
			}
```

This is the exact blocker behind "let the CLI create projects". Note `getApiKeyProjectScope` **throws** when an API-key session has no scope at all, so an account key with nothing selected would fail here too. Replace the guard with:

```ts
			// Account-scoped keys are the CLI's normal credential and may create
			// projects. Only a legacy key pinned to one project is refused.
			if (!ctx.session.accountScoped && ctx.session.apiKeyId) {
				if (getApiKeyProjectScope(ctx.session)) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "A project-scoped API key cannot create projects",
					});
				}
			}
```

- [ ] **Step 6: Report the credential shape to the CLI (platform)**

`project.getActive` returns a Prisma project row or `null` (line 119-129), so it cannot carry this flag. Add a sibling procedure to the same router:

```ts
	credentialScope: protectedProcedure.query(({ ctx }) => ({
		accountScoped: ctx.session.accountScoped === true,
		projectId: ctx.session.projectScopeId ?? null,
	})),
```

The CLI code in Step 3 and the tests in Step 1 already call this procedure.

Run `cd /home/stanoid/tarout/platform && bun run test __test__/contract/trpc-rest-mcp-parity.test.ts` — a new procedure must satisfy the parity gate. It takes no input, so it should map cleanly; if the gate complains about an undeclared procedure, follow the instructions in `src/server/api/surface-scope.ts`.

- [ ] **Step 7: Make `create` activate the new project**

In the `create` action (`cli/src/commands/projects.ts:157-191`), after the successful create call and before the success output, add:

```ts
				if (!getCurrentProfile()?.projectId) {
					updateProfile({
						projectId: created.projectId,
						projectName: created.name,
						projectSlug: created.slug,
					});
					log(`Active project set to ${colors.success(created.name)}.`);
				}
```

Use whatever variable the mutation result is bound to in place of `created`, and add `getCurrentProfile` to the existing `../lib/config.js` import.

- [ ] **Step 8: Verify and commit**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run typecheck && bun run lint && bun run test`
Expected: PASS

```bash
cd /home/stanoid/tarout/cli-account-auth
git add src/commands/projects.ts __test__/projects-use.test.ts
git commit -m "fix(projects): allow switching projects with account-scoped credentials"
```

---

## Task 10: Drop project fields from the login flow (cli)

**Files:**
- Modify: `cli/src/lib/auth-server.ts:7-16` (`AuthCallbackData`), and the profile persistence in `cli/src/commands/auth.ts:408-584`
- Test: `cli/__test__/cli-auth-page.test.ts` (update if it asserts project fields)

**Interfaces:**
- Consumes: the Task 2 exchange response (no `projectId`/`projectName`/`projectSlug`)
- Produces: `AuthCallbackData` with the three project fields optional

- [ ] **Step 1: Make the project fields optional**

In `cli/src/lib/auth-server.ts`, change the three project fields on `AuthCallbackData` to optional:

```ts
	projectId?: string;
	projectName?: string;
	projectSlug?: string;
```

- [ ] **Step 2: Offer project selection after an interactive login**

In `cli/src/commands/auth.ts`, after the profile is persisted in the browser-login success path, add:

```ts
		// Login binds the account and organization. Offer a project now so the
		// next command doesn't stop to ask; skippable, and never blocking for
		// agents (select() emits needs_input in --json / non-TTY mode).
		if (!isJsonMode() && !isNonInteractiveMode()) {
			await resolveActiveProject().catch(() => null);
		}
```

Import `resolveActiveProject` from `../lib/active-project.js` and reuse the `isJsonMode`/`isNonInteractiveMode` helpers already imported in that file (add them to the existing `../lib/output.js` import if absent).

- [ ] **Step 3: Run the suite**

Run: `cd /home/stanoid/tarout/cli-account-auth && bun run typecheck && bun run lint && bun run test`
Expected: PASS. Fix any test asserting that login persists a `projectId` — after this change it legitimately does not.

- [ ] **Step 4: Commit**

```bash
cd /home/stanoid/tarout/cli-account-auth
git add src/lib/auth-server.ts src/commands/auth.ts __test__/
git commit -m "feat(auth): login binds the account and organization only"
```

---

## Task 11: End-to-end verification

**Files:** none modified

- [ ] **Step 1: Full gates in both repos**

```bash
cd /home/stanoid/tarout/platform && bun run typecheck && bun run lint && bun run test __test__/services/
cd /home/stanoid/tarout/cli-account-auth && bun run typecheck && bun run lint && bun run test
```

Expected: PASS in both.

- [ ] **Step 2: Confirm the parity gate still holds (platform)**

Run: `cd /home/stanoid/tarout/platform && bun run test __test__/contract/trpc-rest-mcp-parity.test.ts`
Expected: PASS — `createCliSession`'s input schema changed shape, and this gate fails on unmappable inputs.

- [ ] **Step 3: Manual smoke against a dev server**

Start the platform (`cd platform && bun run dev`), build the CLI (`cd cli-account-auth && bun run build`), then against the local API:

1. `tarout logout && tarout login` → browser shows account + org, **no project dropdown**.
2. `tarout whoami` → succeeds with no project selected.
3. `tarout projects create smoke-test` → succeeds and reports the active project.
4. `tarout projects list` → shows `smoke-test` marked active.
5. `tarout apps list` → succeeds (header carried).
6. `tarout projects create second` then `tarout projects use second` → switches with **no** re-login.
7. `tarout apps list --project smoke-test` → acts on the flagged project.
8. `tarout apps list --json` with no saved project (clear it first) → emits `needs_input` with `field: "project"` and exits 6; does not hang.

- [ ] **Step 4: Confirm legacy keys are untouched**

With a pre-existing project-pinned key (a profile from before this change), run `tarout apps list` and `tarout projects use <other>`. Expected: the first succeeds as before; the second still reports that a re-login is required. If either behaves differently, the `accountScoped` branch is leaking into the legacy path — stop and fix before release.

- [ ] **Step 5: Report and hand off**

Summarize for the user: platform changes are uncommitted in `platform/` (their git to manage), CLI changes are committed on `feat/account-only-auth` in the worktree. Remind them of the rollout order — **deploy platform before publishing the CLI**.

---

## Self-Review Notes

- Spec coverage: platform auth page (T4), `createCliSession` (T2), scope resolution incl. the back-fill discovery (T3), intent (T1), api client header (T6), `resolveActiveProject` + picker (T7), central gate (T8), `projects use`/`create` (T9), login flow (T10), compat + testing (T11).
- The spec's error-handling row "deleted active project → CLI clears stale profile and re-prompts" is **not** implemented by these tasks; the server returns 403 and the user re-runs `tarout projects use`. Called out here rather than silently dropped — add it as a follow-up if the rough edge shows up in practice.
- Task 9 Steps 5-6 touch platform routers; they are grouped with the CLI task that needs them because they are one behavior. Remember: **no git commands in platform/**.
- Two blockers were found while writing this plan and are handled above; do not "simplify" them away:
  1. `validateRequest` **auto-pins** any key lacking a `projectId` and persists it (auth.ts:1414-1424). Without the `accountScoped` marker, the first request would undo the whole feature. (Task 3)
  2. `project.create` **rejects project-scoped API keys outright** (project.ts:134-139), and `getApiKeyProjectScope` throws when an API-key session has no scope — so `tarout projects create`, the headline capability, fails on both paths until that guard is rewritten. (Task 9 Step 5)
