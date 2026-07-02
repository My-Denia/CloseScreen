import { describe, expect, it } from "vitest";
import { isHighlightActive } from "./highlightRegions";

const region = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs });

describe("isHighlightActive", () => {
	it("is false for empty or missing regions", () => {
		expect(isHighlightActive(undefined, 100)).toBe(false);
		expect(isHighlightActive([], 100)).toBe(false);
	});

	it("is active inside a region, start-inclusive and end-exclusive", () => {
		const regions = [region("h1", 1000, 2000)];
		expect(isHighlightActive(regions, 999)).toBe(false);
		expect(isHighlightActive(regions, 1000)).toBe(true);
		expect(isHighlightActive(regions, 1999)).toBe(true);
		expect(isHighlightActive(regions, 2000)).toBe(false);
	});

	it("checks every region, not just the first", () => {
		const regions = [region("h1", 0, 500), region("h2", 3000, 4000)];
		expect(isHighlightActive(regions, 3500)).toBe(true);
		expect(isHighlightActive(regions, 1000)).toBe(false);
	});
});
