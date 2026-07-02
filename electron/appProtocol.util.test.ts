import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseByteRange, safeJoin } from "./appProtocol.util";

const ROOT = path.resolve(path.sep === "\\" ? "C:\\srv\\dist" : "/srv/dist");

describe("safeJoin", () => {
	it("resolves plain relative paths under the root", () => {
		expect(safeJoin(ROOT, "index.html")).toBe(path.join(ROOT, "index.html"));
		expect(safeJoin(ROOT, "assets/app.js")).toBe(path.join(ROOT, "assets", "app.js"));
	});

	it("accepts the root itself", () => {
		expect(safeJoin(ROOT, "")).toBe(ROOT);
	});

	it("strips leading slashes instead of jumping to the drive root", () => {
		expect(safeJoin(ROOT, "/index.html")).toBe(path.join(ROOT, "index.html"));
		expect(safeJoin(ROOT, "\\\\index.html")).toBe(path.join(ROOT, "index.html"));
	});

	it("rejects .. traversal", () => {
		expect(safeJoin(ROOT, "../secrets.txt")).toBeNull();
		expect(safeJoin(ROOT, "a/../../secrets.txt")).toBeNull();
		// Backslash traversal is only a separator on Windows; on posix it's a filename char.
		expect(safeJoin(ROOT, ["..", "secrets.txt"].join(path.sep))).toBeNull();
	});

	it("rejects absolute-path rejoins", () => {
		const outside = path.sep === "\\" ? "C:\\Windows\\System32\\config" : "/etc/passwd";
		expect(safeJoin(ROOT, outside)).toBeNull();
	});

	it("rejects sibling-directory prefix confusion (root + suffix)", () => {
		expect(safeJoin(ROOT, `..${path.sep}dist-evil${path.sep}x`)).toBeNull();
	});

	it("keeps traversal that stays inside the root", () => {
		expect(safeJoin(ROOT, "a/../b.txt")).toBe(path.join(ROOT, "b.txt"));
	});
});

describe("parseByteRange", () => {
	const SIZE = 1000;

	it("returns null without a Range header", () => {
		expect(parseByteRange(null, SIZE)).toBeNull();
	});

	it("parses a bounded range and clamps the end", () => {
		expect(parseByteRange("bytes=0-499", SIZE)).toEqual({ start: 0, end: 499 });
		expect(parseByteRange("bytes=500-9999", SIZE)).toEqual({ start: 500, end: SIZE - 1 });
	});

	it("parses an open-ended range", () => {
		expect(parseByteRange("bytes=200-", SIZE)).toEqual({ start: 200, end: SIZE - 1 });
	});

	it("parses a suffix range as the LAST N bytes (RFC 7233)", () => {
		expect(parseByteRange("bytes=-500", SIZE)).toEqual({ start: 500, end: SIZE - 1 });
		// Suffix longer than the file = whole file.
		expect(parseByteRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: SIZE - 1 });
	});

	it("honors only the first range of a multi-range request", () => {
		expect(parseByteRange("bytes=0-1,5-9", SIZE)).toEqual({ start: 0, end: 1 });
	});

	it("rejects out-of-bounds ranges with invalid (416)", () => {
		expect(parseByteRange(`bytes=${SIZE}-`, SIZE)).toBe("invalid");
		expect(parseByteRange("bytes=700-600", SIZE)).toBe("invalid");
		expect(parseByteRange("bytes=-0", SIZE)).toBe("invalid");
		expect(parseByteRange("bytes=-500", 0)).toBe("invalid");
	});

	it("ignores malformed or non-bytes ranges (200 full body)", () => {
		expect(parseByteRange("bytes=-", SIZE)).toBeNull();
		expect(parseByteRange("items=0-5", SIZE)).toBeNull();
		expect(parseByteRange("garbage", SIZE)).toBeNull();
	});
});
