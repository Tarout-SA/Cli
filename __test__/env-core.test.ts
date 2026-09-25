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

	// Application ids are 21-char nanoids (services/application.ts), not
	// `app_*`: an exact id must resolve whatever its shape.
	it("resolves a full nanoid application id", async () => {
		const c = client([
			{ applicationId: "Vq3kPz81xYbT0nLm4sRwE", name: "web" },
		]);
		const r = await resolveAppRef(c, "Vq3kPz81xYbT0nLm4sRwE");
		expect(r).toEqual({ applicationId: "Vq3kPz81xYbT0nLm4sRwE", name: "web" });
	});

	it("resolves a unique id prefix, as printed by `tarout apps list`", async () => {
		const c = client([
			{ applicationId: "Vq3kPz81xYbT0nLm4sRwE", name: "web" },
			{ applicationId: "Ab9aaaaaaaaaaaaaaaaaa", name: "api" },
		]);
		const r = await resolveAppRef(c, "Vq3kPz81");
		expect(r).toEqual({ applicationId: "Vq3kPz81xYbT0nLm4sRwE", name: "web" });
	});

	it("refuses an ambiguous id prefix and lists the candidates", async () => {
		const c = client([
			{ applicationId: "Vq3kPz81xYbT0nLm4sRwE", name: "web" },
			{ applicationId: "Vq3kZZZZZZZZZZZZZZZZZ", name: "api" },
		]);
		await expect(resolveAppRef(c, "Vq3k")).rejects.toThrow(
			/Vq3kPz81xYbT0nLm4sRwE.*Vq3kZZZZZZZZZZZZZZZZZ/,
		);
	});

	it("refuses a name shared by several apps and lists their ids", async () => {
		const c = client([
			{ applicationId: "id_one_aaaaaaaaaaaaaa", name: "web" },
			{ applicationId: "id_two_bbbbbbbbbbbbbb", name: "web" },
		]);
		await expect(resolveAppRef(c, "web")).rejects.toThrow(
			/id_one_aaaaaaaaaaaaaa.*id_two_bbbbbbbbbbbbbb/,
		);
	});

	it("prefers an exact name over an id prefix", async () => {
		const c = client([
			{ applicationId: "webhook0000000000000A", name: "hooks" },
			{ applicationId: "Zz00000000000000000AB", name: "webh" },
		]);
		const r = await resolveAppRef(c, "webh");
		expect(r.applicationId).toBe("Zz00000000000000000AB");
	});
});
