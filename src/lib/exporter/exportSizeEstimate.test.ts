import { describe, expect, it } from "vitest";
import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";
import {
	estimateEffectiveDurationSec,
	estimateVideoExportBytes,
	formatEstimatedFileSize,
} from "./exportSizeEstimate";

const trim = (startMs: number, endMs: number): TrimRegion => ({
	id: `t-${startMs}`,
	startMs,
	endMs,
});
const speed = (startMs: number, endMs: number, s: SpeedRegion["speed"]): SpeedRegion => ({
	id: `s-${startMs}`,
	startMs,
	endMs,
	speed: s,
});

describe("estimateEffectiveDurationSec", () => {
	it("returns the full duration when there are no trims or speed regions", () => {
		expect(estimateEffectiveDurationSec(10)).toBe(10);
		expect(estimateEffectiveDurationSec(10, [], [])).toBe(10);
	});

	it("subtracts trimmed ranges", () => {
		// Remove 2s..5s (3s) from a 10s timeline => 7s remain.
		expect(estimateEffectiveDurationSec(10, [trim(2000, 5000)])).toBeCloseTo(7, 5);
	});

	it("merges/clamps trims that overlap or exceed the timeline bounds", () => {
		expect(estimateEffectiveDurationSec(10, [trim(-1000, 3000), trim(2000, 4000)])).toBeCloseTo(
			6,
			5,
		);
		expect(estimateEffectiveDurationSec(10, [trim(8000, 99000)])).toBeCloseTo(8, 5);
	});

	it("divides sped-up regions by their speed", () => {
		// 0..4s at 2x => 2s, plus 4..10s at 1x => 6s, total 8s.
		expect(estimateEffectiveDurationSec(10, [], [speed(0, 4000, 2)])).toBeCloseTo(8, 5);
		// 0..4s at 0.5x => 8s, plus 6s => 14s.
		expect(estimateEffectiveDurationSec(10, [], [speed(0, 4000, 0.5)])).toBeCloseTo(14, 5);
	});

	it("applies trims and speed together", () => {
		// Trim 0..2s (gone). Kept 2..10s. Speed 4..6s at 2x => that 2s becomes 1s.
		// Kept = 6s of 1x time + 1s of sped time = 7s.
		expect(estimateEffectiveDurationSec(10, [trim(0, 2000)], [speed(4000, 6000, 2)])).toBeCloseTo(
			7,
			5,
		);
	});

	it("returns 0 for a non-positive or invalid duration", () => {
		expect(estimateEffectiveDurationSec(0)).toBe(0);
		expect(estimateEffectiveDurationSec(Number.NaN)).toBe(0);
		expect(estimateEffectiveDurationSec(-5)).toBe(0);
	});
});

describe("estimateVideoExportBytes", () => {
	it("computes bitrate x duration / 8", () => {
		// 20 Mbps for 10s = 200 Mbit = 25 MB (decimal-ish: 25_000_000 bytes).
		expect(estimateVideoExportBytes(20_000_000, 10)).toBe(25_000_000);
	});

	it("returns 0 for invalid or non-positive inputs", () => {
		expect(estimateVideoExportBytes(0, 10)).toBe(0);
		expect(estimateVideoExportBytes(20_000_000, 0)).toBe(0);
		expect(estimateVideoExportBytes(Number.NaN, 10)).toBe(0);
		expect(estimateVideoExportBytes(20_000_000, Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("formatEstimatedFileSize", () => {
	it("formats across byte ranges with decimal units", () => {
		expect(formatEstimatedFileSize(500)).toBe("500 B");
		expect(formatEstimatedFileSize(2_000)).toBe("2 KB");
		expect(formatEstimatedFileSize(25_000_000)).toBe("25 MB");
		expect(formatEstimatedFileSize(2_500_000_000)).toBe("2.5 GB");
	});

	it("returns an em dash for zero/invalid sizes", () => {
		expect(formatEstimatedFileSize(0)).toBe("—");
		expect(formatEstimatedFileSize(Number.NaN)).toBe("—");
		expect(formatEstimatedFileSize(-100)).toBe("—");
	});
});
