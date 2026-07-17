import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSourceArchive } from "../src/commands/deploy";

const cleanup: string[] = [];

afterEach(() => {
	for (const path of cleanup.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("source archive security", () => {
	it("packages the requested directory but excludes root and nested dotenv secrets", async () => {
		const project = mkdtempSync(join(tmpdir(), "tarout-archive-project-"));
		cleanup.push(project);
		mkdirSync(join(project, "apps", "web"), { recursive: true });
		writeFileSync(join(project, "index.js"), "console.log('root')\n");
		writeFileSync(
			join(project, "apps", "web", "index.js"),
			"console.log('web')\n",
		);
		writeFileSync(join(project, ".env"), "ROOT_SECRET=do-not-upload\n");
		writeFileSync(
			join(project, "apps", "web", ".env.local"),
			"NESTED_SECRET=do-not-upload-either\n",
		);

		const archive = await createSourceArchive(project);
		cleanup.push(dirname(archive));
		const entries = execFileSync("unzip", ["-Z1", archive], {
			encoding: "utf8",
		});
		const contents = execFileSync("unzip", ["-p", archive], {
			encoding: "utf8",
		});

		expect(entries).toContain("index.js");
		expect(entries).toContain("apps/web/index.js");
		expect(entries).not.toMatch(/(^|\/)\.env(?:\.|$)/m);
		expect(contents).not.toContain("do-not-upload");
	});
});
