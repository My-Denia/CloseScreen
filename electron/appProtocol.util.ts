// Pure helpers for the app:// protocol handler (electron/appProtocol.ts), kept free of electron
// imports so they can be unit-tested directly.
import path from "node:path";

/**
 * Resolve `rel` under `root`, refusing anything that escapes it: `..` traversal, absolute-path
 * rejoins (`C:\x`, `/x`), and drive-relative forms. Returns null when containment fails.
 */
export function safeJoin(root: string, rel: string): string | null {
	const resolved = path.resolve(root, rel.replace(/^[/\\]+/, ""));
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return null;
	}
	return resolved;
}

/** Decoded byte range; `null` = serve the full file (no/ignorable Range); `"invalid"` = 416. */
export type ByteRange = { start: number; end: number } | null | "invalid";

/**
 * Parse an HTTP Range header against a file of `size` bytes (RFC 7233 single-range subset).
 * - `bytes=A-B` / `bytes=A-`: first-byte-pos range, end clamped to size-1.
 * - `bytes=-N`: SUFFIX range = the last N bytes (start = size-N), per the RFC.
 * - Multi-range (`bytes=A-B,C-D`): only the first range is honored (Chromium's media stack never
 *   sends multi-range; the 206 response self-describes via Content-Range).
 * - Non-`bytes` units, `bytes=-`, and unparseable values → null (serve 200 full body).
 * - Out-of-bounds / empty suffix → "invalid" (416).
 */
export function parseByteRange(rangeHeader: string | null, size: number): ByteRange {
	if (!rangeHeader) return null;
	const match = /^\s*bytes\s*=\s*(\d*)-(\d*)/i.exec(rangeHeader);
	if (!match) return null;
	const [, startRaw, endRaw] = match;

	if (startRaw === "" && endRaw === "") return null;

	if (startRaw === "") {
		// Suffix range: the LAST `endRaw` bytes.
		const suffixLen = Number.parseInt(endRaw, 10);
		if (!Number.isFinite(suffixLen) || suffixLen <= 0 || size <= 0) return "invalid";
		return { start: Math.max(0, size - suffixLen), end: size - 1 };
	}

	const start = Number.parseInt(startRaw, 10);
	let end = endRaw === "" ? size - 1 : Number.parseInt(endRaw, 10);
	if (!Number.isFinite(start) || start < 0) return "invalid";
	if (!Number.isFinite(end) || end >= size) end = size - 1;
	if (start > end || start >= size) return "invalid";
	return { start, end };
}
