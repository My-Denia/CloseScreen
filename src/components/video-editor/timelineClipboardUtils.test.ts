import { describe, expect, it } from "vitest";
import {
	buildPastedAnnotationRegion,
	buildPastedZoomRegion,
	cloneAnnotationRegion,
	getPastedAnnotationPosition,
	getPastedSpan,
	getPlayheadRegionSpan,
	spansOverlap,
} from "./timelineClipboardUtils";
import type { AnnotationRegion, ZoomRegion } from "./types";

function createAnnotationRegion(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
	return {
		id: "annotation-1",
		startMs: 100,
		endMs: 600,
		type: "blur",
		content: "",
		position: { x: 10, y: 15 },
		size: { width: 30, height: 20 },
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
		zIndex: 1,
		blurData: {
			type: "mosaic",
			shape: "freehand",
			color: "white",
			intensity: 12,
			blockSize: 8,
			freehandPoints: [
				{ x: 10, y: 20 },
				{ x: 30, y: 40 },
			],
		},
		...overrides,
	};
}

function createZoomRegion(overrides: Partial<ZoomRegion> = {}): ZoomRegion {
	return {
		id: "zoom-1",
		startMs: 500,
		endMs: 2500,
		depth: 3,
		customScale: 1.8,
		focus: { cx: 0.25, cy: 0.75 },
		focusMode: "auto",
		source: "auto",
		...overrides,
	};
}

describe("timelineClipboardUtils", () => {
	it("deep clones nested annotation data", () => {
		const original = createAnnotationRegion();
		const cloned = cloneAnnotationRegion(original);

		expect(cloned).toEqual(original);
		expect(cloned).not.toBe(original);
		expect(cloned.position).not.toBe(original.position);
		expect(cloned.size).not.toBe(original.size);
		expect(cloned.style).not.toBe(original.style);
		expect(cloned.blurData).not.toBe(original.blurData);
		expect(cloned.blurData?.freehandPoints).not.toBe(original.blurData?.freehandPoints);
		expect(cloned.blurData?.freehandPoints?.[0]).not.toBe(original.blurData?.freehandPoints?.[0]);
	});

	it("detects true overlaps but not adjacent spans", () => {
		expect(spansOverlap(100, 200, 150, 250)).toBe(true);
		expect(spansOverlap(100, 200, 200, 300)).toBe(false);
		expect(spansOverlap(100, 200, 0, 100)).toBe(false);
	});

	it("pastes at the playhead, keeping the source duration", () => {
		expect(getPastedSpan(1000, 1500, 3000, 10_000)).toEqual({ startMs: 3000, endMs: 3500 });
	});

	it("shifts the pasted span back when it would run past the end of the video", () => {
		expect(getPastedSpan(0, 2000, 9500, 10_000)).toEqual({ startMs: 8000, endMs: 10_000 });
	});

	it("truncates spans longer than the whole video and rejects empty videos", () => {
		expect(getPastedSpan(0, 20_000, 500, 10_000)).toEqual({ startMs: 0, endMs: 10_000 });
		expect(getPastedSpan(0, 1000, 0, 0)).toBeNull();
	});

	it("adds a region at the playhead, clamped back so it is never zero-length at EOF", () => {
		expect(getPlayheadRegionSpan(3000, 10_000, 1500)).toEqual({ start: 3000, end: 4500 });
		// at the very end: clamp the start back so it keeps its full duration
		expect(getPlayheadRegionSpan(10_000, 10_000, 1500)).toEqual({ start: 8500, end: 10_000 });
		// short video: start pins to 0 and the region spans the whole clip
		expect(getPlayheadRegionSpan(500, 800, 800)).toEqual({ start: 0, end: 800 });
	});

	it("preserves pasted annotation positions when they are already in bounds", () => {
		expect(getPastedAnnotationPosition({ x: 10, y: 15 }, { width: 30, height: 20 })).toEqual({
			x: 10,
			y: 15,
		});
	});

	it("clamps pasted annotation positions when the source would overflow its bounds", () => {
		expect(getPastedAnnotationPosition({ x: 94, y: 93 }, { width: 12, height: 9 })).toEqual({
			x: 88,
			y: 91,
		});
	});

	it("pins oversized pasted annotations to the visible origin", () => {
		// A full-frame region (e.g. freehand blur at {0,0,100,100}) must stay exactly at the origin.
		expect(getPastedAnnotationPosition({ x: 50, y: 50 }, { width: 140, height: 120 })).toEqual({
			x: 0,
			y: 0,
		});
		expect(getPastedAnnotationPosition({ x: 0, y: 0 }, { width: 100, height: 100 })).toEqual({
			x: 0,
			y: 0,
		});
	});

	it("pastes zooms as manual regions so wand toggles never remove them", () => {
		const source = createZoomRegion({ source: "auto" });
		const pasted = buildPastedZoomRegion(source, "zoom-9", { startMs: 4000, endMs: 6000 });

		expect(pasted).toEqual({
			...source,
			id: "zoom-9",
			startMs: 4000,
			endMs: 6000,
			source: "manual",
		});
		expect(pasted.focus).not.toBe(source.focus);
	});

	it("applies the global Auto-Focus All mode to pasted zooms while it is on", () => {
		const manualSource = createZoomRegion({ focusMode: "manual" });
		const pasted = buildPastedZoomRegion(
			manualSource,
			"zoom-9",
			{ startMs: 4000, endMs: 6000 },
			{ forceAutoFocus: true },
		);
		expect(pasted.focusMode).toBe("auto");
	});

	it("preserves the copied zoom's focus mode while Auto-Focus All is off", () => {
		const autoSource = createZoomRegion({ focusMode: "auto" });
		const pasted = buildPastedZoomRegion(
			autoSource,
			"zoom-9",
			{ startMs: 4000, endMs: 6000 },
			{ forceAutoFocus: false },
		);
		expect(pasted.focusMode).toBe("auto");

		const manualSource = createZoomRegion({ focusMode: "manual" });
		const pastedManual = buildPastedZoomRegion(manualSource, "zoom-10", {
			startMs: 4000,
			endMs: 6000,
		});
		expect(pastedManual.focusMode).toBe("manual");
	});

	it("pastes annotations with a new identity and without the auto-caption link", () => {
		const source = createAnnotationRegion({
			annotationSource: "auto-caption",
			position: { x: 94, y: 93 },
			size: { width: 12, height: 9 },
		});
		const pasted = buildPastedAnnotationRegion(source, "annotation-9", 7, {
			startMs: 4000,
			endMs: 4500,
		});

		expect(pasted.id).toBe("annotation-9");
		expect(pasted.zIndex).toBe(7);
		expect(pasted.startMs).toBe(4000);
		expect(pasted.endMs).toBe(4500);
		expect(pasted.annotationSource).toBeUndefined();
		expect(pasted.position).toEqual({ x: 88, y: 91 });
		// The paste is fully independent of the source region.
		expect(pasted.blurData).not.toBe(source.blurData);
		expect(pasted.style).not.toBe(source.style);
	});
});
