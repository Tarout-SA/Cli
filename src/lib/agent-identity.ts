/**
 * Dynamic, project-local identity for coding agents.
 *
 * AI.md contains only the verified account context an agent needs — never the
 * key itself — so it is safe to keep beside project instructions and cannot
 * become a credential leak when a repository is shared.
 *
 * The key lives in one of two places, and the block says which: `.tarout/auth.json`
 * inside the project (mode 0600, git-ignored, excluded from deploy archives) for
 * the default project-scoped connect, or the CLI's private OS credential file for
 * a machine-wide one. Stating the location matters — an agent that believes the
 * credential is machine-wide will "helpfully" run a global `tarout login` when a
 * command fails, silently replacing the project's key.
 */

import { join } from "node:path";
import type { Profile } from "./config.js";
import {
	type FileAction,
	upsertMarkdownBlock,
} from "./agent-scaffold.js";

const IDENTITY_BLOCK_BEGIN = "<!-- BEGIN TAROUT IDENTITY -->";
const IDENTITY_BLOCK_END = "<!-- END TAROUT IDENTITY -->";

function inlineCode(value: string | undefined, fallback = "not set"): string {
	const normalized = (value || fallback)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/`+/g, "'")
		.trim();
	return `\`${normalized || fallback}\``;
}

export function buildAgentIdentityBlock(
	profile: Profile,
	options: {
		profileName: string;
		generatedAt?: Date;
		scope?: "project" | "global";
		credentialPath?: string;
	} = { profileName: "default" },
): string {
	const generatedAt = (options.generatedAt ?? new Date()).toISOString();
	const scope = options.scope ?? "global";

	const storage =
		scope === "project"
			? `The credential for this project is stored in \`.tarout/auth.json\` (file mode
0600, git-ignored, and excluded from deploy archives). It is **scoped to this
directory**: the \`tarout\` and \`tarout-mcp\` commands pick it up automatically when
run here, and it takes precedence over any machine-wide Tarout login.

**Never run \`tarout login\` or \`tarout logout\` for this project** unless the user
explicitly asks for a machine-wide change — those act on the global credential,
not this one, and a global login will not fix a failure here. If this project's
key stops working, ask the user for a fresh setup command from the Tarout
dashboard and re-run it in this directory.`
			: `The credential is stored outside this repository in Tarout's private CLI profile
(file mode 0600). The API key is intentionally never copied into AI.md. The
\`tarout\` and \`tarout-mcp\` commands reuse it automatically.`;

	const location =
		scope === "project"
			? `- **Credential:** ${inlineCode(options.credentialPath ?? ".tarout/auth.json")} (project-scoped)`
			: `- **CLI profile:** ${inlineCode(options.profileName)} (machine-wide)`;

	return `${IDENTITY_BLOCK_BEGIN}
# Tarout AI Identity

This identity was verified by Tarout and is refreshed by the one-command agent
setup. Use the Tarout CLI for this account; do not ask the user for an API key.

- **Status:** connected
- **Account:** ${inlineCode(profile.userEmail)} (${inlineCode(profile.userId)})
- **Organization:** ${inlineCode(profile.organizationName)} (${inlineCode(profile.organizationId)})
- **Project:** ${inlineCode(profile.projectName)} (${inlineCode(profile.projectId)})
- **Project slug:** ${inlineCode(profile.projectSlug)}
- **API:** ${inlineCode(profile.apiUrl)}
${location}
- **Verified:** ${inlineCode(generatedAt)}

${storage}

**Start every session with \`tarout whoami --json\`.** This block records what was
true when it was written; that command reports what is true now, and its \`scope\`
field tells you which credential is in effect. If it returns \`success: true\`, you
are connected — do not re-authenticate and do not ask the user for a key. If it
fails, follow the auth steps in https://tarout.sa/docs/for-ai/start.md before
diagnosing anything else.
${IDENTITY_BLOCK_END}`;
}

export function writeAgentIdentityFile(
	cwd: string,
	profile: Profile,
	options: {
		profileName: string;
		generatedAt?: Date;
		scope?: "project" | "global";
		credentialPath?: string;
	},
): { path: "AI.md"; action: FileAction } {
	const action = upsertMarkdownBlock(
		join(cwd, "AI.md"),
		buildAgentIdentityBlock(profile, options),
		{
			begin: IDENTITY_BLOCK_BEGIN,
			end: IDENTITY_BLOCK_END,
		},
	);
	return { path: "AI.md", action };
}
