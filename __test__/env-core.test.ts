import { describe, expect, it, vi } from "vitest";
import {
	parseDotenv,
	resolveAppRef,
	serializeDotenv,
} from "../src/lib/env-core";
import { NotFoundError } from "../src/lib/errors";

describe("parseDotenv", () => {
	it("parses plain KEY=value pairs", () => {
		expect(parseDotenv("A=1\nB=2\n")).toEqual({ A: "1", B: "2" });
	});

	it("supports double-quoted values", () => {
		expect(parseDotenv('A="hello world"\n')).toEqual({ A: "hello world" });
	});

	it("supports single-quoted values with escapes ignored", () => {
		expect(parseDotenv("A='raw\\nstring'\n")).toEqual({ A: "raw\\nstring" });
	});

	it("strips inline comments only outside quoted values", () => {
		expect(parseDotenv('A=1 # note\nB="x # keep"\n')).toEqual({
			A: "1",
			B: "x # keep",
		});
	});

	it("ignores blank lines and full-line comments", () => {
		expect(parseDotenv("\n# c\nA=1\n")).toEqual({ A: "1" });
	});
});

describe("serializeDotenv", () => {
	it("sorts keys and quotes values with whitespace", () => {
		const out = serializeDotenv({ B: "with space", A: "1" });
		expect(out).toBe('A=1\nB="with space"\n');
	});

	it("escapes double quotes inside quoted values", () => {
		expect(serializeDotenv({ K: 'a"b' })).toBe('K="a\\"b"\n');
	});
});

describe("resolveAppRef", () => {
	function client(apps: Array<{ applicationId: string; name: string }>) {
		return {
			application: {
				allByOrganization: {
					query: vi.fn().mockResolvedValue(apps),
				},
			},
		};
	}

	it("returns id + name when ref matches an id", async () => {
		const c = client([{ applicationId: "app_1", name: "web" }]);
		const r = await resolveAppRef(c, "app_1");
		expect(r).toEqual({ applicationId: "app_1", name: "web" });
	});

	it("returns id + name when ref matches a name", async () => {
		const c = client([{ applicationId: "app_1", name: "web" }]);
		const r = await resolveAppRef(c, "web");
		expect(r).toEqual({ applicationId: "app_1", name: "web" });
	});

	it("throws NotFoundError when ref matches nothing", async () => {
		const c = client([{ applicationId: "app_1", name: "web" }]);
		await expect(resolveAppRef(c, "other")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});
});
