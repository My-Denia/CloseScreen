import { describe, expect, it } from "vitest";
import {
	compareVersions,
	isNewerVersion,
	parseVersion,
	pickLatestRelease,
} from "./updateCheck.util";

describe("parseVersion", () => {
	it("parses bare and fork-suffixed versions, with or without a leading v", () => {
		expect(parseVersion("1.5.0")).toEqual({ base: [1, 5, 0], fork: 0 });
		expect(parseVersion("v1.5.0-fork.3")).toEqual({ base: [1, 5, 0], fork: 3 });
		expect(parseVersion(" 2.10.1-fork.12 ")).toEqual({ base: [2, 10, 1], fork: 12 });
	});

	it("rejects anything outside the fork's scheme", () => {
		expect(parseVersion("1.5")).toBeNull();
		expect(parseVersion("1.5.0-beta.1")).toBeNull();
		expect(parseVersion("1.5.0-fork")).toBeNull();
		expect(parseVersion("latest")).toBeNull();
		expect(parseVersion("")).toBeNull();
	});
});

describe("version ordering", () => {
	it("orders by base semver first", () => {
		expect(isNewerVersion("1.5.1", "1.5.0-fork.9")).toBe(true);
		expect(isNewerVersion("1.6.0-fork.1", "1.5.9-fork.4")).toBe(true);
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
		expect(isNewerVersion("1.4.9-fork.9", "1.5.0")).toBe(false);
	});

	it("treats -fork.N as AFTER its base (fork releases succeed the upstream base)", () => {
		expect(isNewerVersion("1.5.0-fork.1", "1.5.0")).toBe(true);
		expect(isNewerVersion("1.5.0-fork.2", "1.5.0-fork.1")).toBe(true);
		expect(isNewerVersion("1.5.0", "1.5.0-fork.1")).toBe(false);
		expect(isNewerVersion("1.5.0-fork.1", "1.5.0-fork.1")).toBe(false);
	});

	it("never reports an update for unparseable versions", () => {
		expect(isNewerVersion("1.6.0-beta.1", "1.5.0")).toBe(false);
		expect(isNewerVersion("1.6.0", "garbage")).toBe(false);
	});

	it("compareVersions is a total order over parsed versions", () => {
		const a = parseVersion("1.5.0-fork.1");
		const b = parseVersion("1.5.0-fork.2");
		if (!a || !b) throw new Error("fixture parse failed");
		expect(compareVersions(a, b)).toBeLessThan(0);
		expect(compareVersions(b, a)).toBeGreaterThan(0);
		expect(compareVersions(a, a)).toBe(0);
	});
});

describe("pickLatestRelease", () => {
	const release = (tag: string, extra: Record<string, unknown> = {}) => ({
		tag_name: tag,
		html_url: `https://github.com/My-Denia/CloseScreen/releases/tag/${tag}`,
		...extra,
	});

	it("picks the newest parseable non-draft release, including prereleases", () => {
		const picked = pickLatestRelease([
			release("v1.5.0-fork.1", { prerelease: true }),
			release("v1.5.0-fork.3", { prerelease: true }),
			release("v1.5.0-fork.2"),
		]);
		expect(picked).toEqual({
			version: "1.5.0-fork.3",
			htmlUrl: "https://github.com/My-Denia/CloseScreen/releases/tag/v1.5.0-fork.3",
		});
	});

	it("skips drafts, malformed entries, and foreign tag schemes", () => {
		const picked = pickLatestRelease([
			release("v9.9.9", { draft: true }),
			release("nightly-2026-07-01"),
			{ tag_name: 42, html_url: "https://example.com" },
			null,
			release("v1.5.0-fork.1"),
		]);
		expect(picked?.version).toBe("1.5.0-fork.1");
	});

	it("returns null for empty or non-array payloads", () => {
		expect(pickLatestRelease([])).toBeNull();
		expect(pickLatestRelease({ message: "rate limited" })).toBeNull();
		expect(pickLatestRelease(undefined)).toBeNull();
	});
});
