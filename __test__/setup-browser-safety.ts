import { afterEach, beforeEach, expect, vi } from "vitest";

const browserSafety = vi.hoisted(() => ({
	open: vi.fn(async () => ({ pid: 0 })),
}));

vi.mock("open", () => ({
	default: browserSafety.open,
}));

beforeEach(() => {
	browserSafety.open.mockClear();
});

afterEach(() => {
	expect(
		browserSafety.open,
		"Vitest unit tests must not launch external browsers",
	).not.toHaveBeenCalled();
});
