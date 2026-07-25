/**
 * Dynamic, project-local identity for coding agents.
 *
 * The real API key remains in the CLI's private OS credential file (mode 0600).
 * AI.md contains only the verified account context an agent needs, so it is safe
 * to keep beside project instructions and cannot become a credential leak when
 * a repository is shared.
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
	} = { profileName: "default" },
): string {
	const generatedAt = (options.generatedAt ?? new Date()).toISOString();

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
- **CLI profile:** ${inlineCode(options.profileName)}
- **Verified:** ${inlineCode(generatedAt)}

The credential is stored outside this repository in Tarout's private CLI profile
(file mode 0600). The API key is intentionally never copied into AI.md. The
\`tarout\` and \`tarout-mcp\` commands reuse it automatically.

Verify or refresh this context at any time with \`tarout whoami --json\`.
${IDENTITY_BLOCK_END}`;
}

export function writeAgentIdentityFile(
	cwd: string,
	profile: Profile,
	options: {
		profileName: string;
		generatedAt?: Date;
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
