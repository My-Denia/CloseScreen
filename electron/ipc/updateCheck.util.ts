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
	prerelease?: unknown;
}

export interface PickLatestReleaseOptions {
	includePrereleases?: boolean;
}

function parseReleaseCandidate(
	raw: unknown,
	options: PickLatestReleaseOptions,
): { parsed: ParsedVersion; info: ReleaseInfo } | null {
	if (!raw || typeof raw !== "object") return null;
	const release = raw as RawRelease;
	if (release.draft === true) return null;
	if (options.includePrereleases !== true && release.prerelease === true) return null;
	if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") return null;
	const parsed = parseVersion(release.tag_name);
	if (!parsed) return null;
	return {
		parsed,
		info: { version: release.tag_name.replace(/^v/, ""), htmlUrl: release.html_url },
	};
}

/**
 * Newest parseable, non-draft release from a GitHub releases-list response.
 * Prereleases are skipped by default so automatic checks follow the stable release channel.
 * Callers that expose an explicit prerelease opt-in can include them.
 */
export function pickLatestRelease(
	payload: unknown,
	options: PickLatestReleaseOptions = {},
): ReleaseInfo | null {
	if (!Array.isArray(payload)) return null;
	let best: { parsed: ParsedVersion; info: ReleaseInfo } | null = null;
	for (const raw of payload) {
		const candidate = parseReleaseCandidate(raw, options);
		if (!candidate) continue;
		if (best === null || compareVersions(candidate.parsed, best.parsed) > 0) {
			best = candidate;
		}
	}
	return best?.info ?? null;
}
