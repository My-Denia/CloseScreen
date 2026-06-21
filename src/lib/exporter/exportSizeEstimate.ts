import type { SpeedRegion, TrimRegion } from "@/components/video-editor/types";

const MIN_SPEED = 0.01;

/**
 * Trim/speed-aware effective output duration (seconds) for an export.
 *
 * Used to estimate the export file size before exporting (issue #4). This mirrors the
 * exporter's segment math closely enough for an estimate: trimmed ranges are removed from
 * the timeline and each kept slice is divided by its playback speed (a 2× region takes half
 * the time). Anything outside the source duration is clamped away.
 */
export function estimateEffectiveDurationSec(
	totalDurationSec: number,
	trimRegions?: TrimRegion[],
	speedRegions?: SpeedRegion[],
): number {
	if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) return 0;

	// Kept intervals = [0, total] minus the trimmed ranges (converted to seconds).
	const trims = (trimRegions ?? [])
		.map((region) => [region.startMs / 1000, region.endMs / 1000] as const)
		.filter(([start, end]) => end > start)
		.sort((a, b) => a[0] - b[0]);

	const kept: Array<[number, number]> = [];
	let cursor = 0;
	for (const [start, end] of trims) {
		const clampedStart = Math.max(0, Math.min(start, totalDurationSec));
		const clampedEnd = Math.max(0, Math.min(end, totalDurationSec));
		if (clampedStart > cursor) kept.push([cursor, clampedStart]);
		cursor = Math.max(cursor, clampedEnd);
	}
	if (cursor < totalDurationSec) kept.push([cursor, totalDurationSec]);

	const speeds = (speedRegions ?? [])
		.map((region) => ({
			start: region.startMs / 1000,
			end: region.endMs / 1000,
			speed: region.speed,
		}))
		.filter((region) => region.end > region.start && region.speed >= MIN_SPEED);

	let effective = 0;
	for (const [segStart, segEnd] of kept) {
		// Split the kept slice at speed-region boundaries, then sum length / speed per piece.
		const points = [segStart, segEnd];
		for (const region of speeds) {
			if (region.start > segStart && region.start < segEnd) points.push(region.start);
			if (region.end > segStart && region.end < segEnd) points.push(region.end);
		}
		points.sort((a, b) => a - b);
		for (let i = 0; i < points.length - 1; i++) {
			const a = points[i];
			const b = points[i + 1];
			if (b <= a) continue;
			const mid = (a + b) / 2;
			const region = speeds.find((r) => mid >= r.start && mid < r.end);
			effective += (b - a) / (region ? region.speed : 1);
		}
	}
	return effective;
}

/**
 * Estimated encoded size in bytes for a constant-bitrate video target: bitrate × duration / 8.
 * Audio is negligible next to the multi-Mbps video bitrate, so it is not modelled. The target
 * bitrate is a VBR ceiling, so real files are usually a bit smaller — treat this as an upper
 * estimate.
 */
export function estimateVideoExportBytes(bitrateBps: number, durationSec: number): number {
	if (!Number.isFinite(bitrateBps) || !Number.isFinite(durationSec)) return 0;
	if (bitrateBps <= 0 || durationSec <= 0) return 0;
	return (bitrateBps * durationSec) / 8;
}

/** Human-readable file size using decimal units (matches macOS/Linux file managers). */
export function formatEstimatedFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "—";
	const KB = 1000;
	const MB = KB * 1000;
	const GB = MB * 1000;
	if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
	if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
	if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
	return `${Math.round(bytes)} B`;
}
