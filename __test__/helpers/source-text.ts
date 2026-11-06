import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Concatenate every .ts file under `dir`, recursively, for static scanning. */
export function collectSourceText(dir: string): string {
	let text = "";
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			text += collectSourceText(full);
		} else if (entry.endsWith(".ts")) {
			text += `${readFileSync(full, "utf8")}\n`;
		}
	}
	return text;
}
