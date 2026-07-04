import { describe, expect, it } from "vitest";
import { type CycleSelectableRegion, getNextOverlappingRegionId } from "./timelineCycleSelection";

function region(
	id: string,
	zIndex: number,
	overrides: Partial<CycleSelectableRegion> = {},
): CycleSelectableRegion {
	return {
		id,
		startMs: 100,
		endMs: 500,
		zIndex,
		...overrides,
	};
}

describe("getNextOverlappingRegionId", () => {
	it("selects the first overlapping region by ascending z-index when none is selected", () => {
		expect(
			getNextOverlappingRegionId({
				regions: [region("top", 20), region("bottom", 5), region("outside", 1, { endMs: 99 })],
				selectedId: null,
				currentTimeMs: 200,
			}),
		).toBe("bottom");
	});

	it("wraps forward and backward through overlapping regions only", () => {
		const regions = [region("bottom", 5), region("middle", 10), region("top", 20)];

		expect(
			getNextOverlappingRegionId({
				regions,
				selectedId: "middle",
				currentTimeMs: 200,
			}),
		).toBe("top");
		expect(
			getNextOverlappingRegionId({
				regions,
				selectedId: "top",
				currentTimeMs: 200,
			}),
		).toBe("bottom");
		expect(
			getNextOverlappingRegionId({
				regions,
				selectedId: "bottom",
				currentTimeMs: 200,
				backward: true,
			}),
		).toBe("top");
	});

	it("stays within the provided region type and ignores mixed-type overlaps", () => {
		const blurRegions = [region("blur-1", 1), region("blur-2", 2)];
		const annotationRegions = [region("annotation-1", 0)];

		expect(
			getNextOverlappingRegionId({
				regions: blurRegions,
				selectedId: "blur-1",
				currentTimeMs: 200,
			}),
		).toBe("blur-2");
		expect(
			getNextOverlappingRegionId({
				regions: annotationRegions,
				selectedId: "blur-1",
				currentTimeMs: 200,
			}),
		).toBe("annotation-1");
	});
});
