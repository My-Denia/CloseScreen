import fs from "node:fs/promises";

/**
 * Free-space preflight for the recordings dir (issue #23: recording onto a nearly
 * full drive silently produced truncated videos and an editor that "fails to open").
 * The check only ever WARNS — a probe failure must never block recording.
 */

/** Warn when the recordings drive has less free space than this (≈30-60 min of video). */
export const LOW_DISK_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Free bytes available to this process on the volume containing `dir`, or null when
 * the probe fails (missing dir, disconnected drive, unsupported fs) — callers treat
 * null as "unknown", not as "low".
 */
export async function getFreeBytes(dir: string): Promise<number | null> {
	try {
		const stats = await fs.statfs(dir);
		const free = Number(stats.bavail) * Number(stats.bsize);
		return Number.isFinite(free) && free >= 0 ? free : null;
	} catch {
		return null;
	}
}

export function isLowDiskSpace(freeBytes: number | null): boolean {
	return freeBytes !== null && freeBytes < LOW_DISK_THRESHOLD_BYTES;
}
