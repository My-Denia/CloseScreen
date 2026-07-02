// Pure logic for the update check (no electron imports so vitest can load it directly;
// same split as appProtocol.util.ts). See updateCheck.ts for the IPC/network side.
//
// Version scheme: this fork tags releases `vX.Y.Z-fork.N` on top of upstream's X.Y.Z.
// Ordering is base semver first, then the fork number, with a bare X.Y.Z counting as
// fork 0 — deliberately unlike semver's prerelease rule (which would sort -fork.N
// BEFORE the base), because fork releases succeed the upstream base they build on.
export interface ParsedVersion {
	base: [number, number, number];
	fork: number;
}

export interface ReleaseInfo {
	version: string;
	htmlUrl: string;
}

/** Parse `X.Y.Z` or `X.Y.Z-fork.N` (leading `v` allowed). Null for anything else. */
export function parseVersion(value: string): ParsedVersion | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-fork\.(\d+))?$/.exec(value.trim());
	if (!match) return null;
	return {
		base: [Number(match[1]), Number(match[2]), Number(match[3])],
		fork: match[4] === undefined ? 0 : Number(match[4]),
	};
}

/** Positive when a > b, negative when a < b, 0 when equal. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
	for (let i = 0; i < 3; i++) {
		if (a.base[i] !== b.base[i]) return a.base[i] - b.base[i];
	}
	return a.fork - b.fork;
}

export function isNewerVersion(candidate: string, current: string): boolean {
	const parsedCandidate = parseVersion(candidate);
	const parsedCurrent = parseVersion(current);
	if (!parsedCandidate || !parsedCurrent) return false;
	return compareVersions(parsedCandidate, parsedCurrent) > 0;
}

interface RawRelease {
	tag_name?: unknown;
	html_url?: unknown;
	draft?: unknown;
}

/**
 * Newest parseable, non-draft release from a GitHub releases-list response.
 * Prereleases are included on purpose: this fork publishes releases as prereleases,
 * which the /releases/latest endpoint would exclude.
 */
export function pickLatestRelease(payload: unknown): ReleaseInfo | null {
	if (!Array.isArray(payload)) return null;
	let best: { parsed: ParsedVersion; info: ReleaseInfo } | null = null;
	for (const raw of payload as RawRelease[]) {
		if (!raw || typeof raw !== "object") continue;
		if (raw.draft === true) continue;
		if (typeof raw.tag_name !== "string" || typeof raw.html_url !== "string") continue;
		const parsed = parseVersion(raw.tag_name);
		if (!parsed) continue;
		if (best === null || compareVersions(parsed, best.parsed) > 0) {
			best = { parsed, info: { version: raw.tag_name.replace(/^v/, ""), htmlUrl: raw.html_url } };
		}
	}
	return best?.info ?? null;
}
