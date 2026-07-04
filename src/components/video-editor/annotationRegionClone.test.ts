import { describe, expect, it } from "vitest";
import { buildDuplicatedAnnotationRegion } from "./timelineClipboardUtils";
import type { AnnotationRegion } from "./types";

function createBlurRegion(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
	return {
		id: "blur-1",
		startMs: 100,
		endMs: 900,
		type: "blur",
		content: "",
		position: { x: 12, y: 18 },
		size: { width: 32, height: 24 },
		style: {
			color: "#ffffff",
			backgroundColor: "transparent",
			fontSize: 32,
			fontFamily: "Inter",
			fontWeight: "bold",
			fontStyle: "normal",
			textDecoration: "none",
			textAlign: "center",
			textAnimation: "none",
		},
		zIndex: 3,
		annotationSource: "auto-caption",
		blurData: {
			type: "mosaic",
			shape: "freehand",
			color: "white",
			intensity: 12,
			blockSize: 8,
			freehandPoints: [
				{ x: 10, y: 20 },
				{ x: 40, y: 30 },
				{ x: 70, y: 80 },
			],
		},
		...overrides,
	};
}

describe("buildDuplicatedAnnotationRegion", () => {
	it("deep clones duplicated blur data without sharing mutable references", () => {
		const source = createBlurRegion();
		const duplicate = buildDuplicatedAnnotationRegion(source, "blur-2", 9);

		expect(duplicate.id).toBe("blur-2");
		expect(duplicate.zIndex).toBe(9);
		expect(duplicate.annotationSource).toBeUndefined();
		expect(duplicate.position).toEqual({ x: 16, y: 22 });

		expect(duplicate).not.toBe(source);
		expect(duplicate.position).not.toBe(source.position);
		expect(duplicate.size).not.toBe(source.size);
		expect(duplicate.style).not.toBe(source.style);
		expect(duplicate.blurData).not.toBe(source.blurData);
		expect(duplicate.blurData?.freehandPoints).not.toBe(source.blurData?.freehandPoints);
		expect(duplicate.blurData?.freehandPoints?.[0]).not.toBe(source.blurData?.freehandPoints?.[0]);
	});
});
