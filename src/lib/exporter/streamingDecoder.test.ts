import { describe, expect, it, vi } from "vitest";
import {
	resolveDecoderConfig,
	shouldFailDecodeEndedEarly,
	validateDuration,
} from "./streamingDecoder";

describe("resolveDecoderConfig", () => {
	// Mirrors real Linux Electron probes: bare "vp9" is rejected, the full
	// "vp09.*" string is accepted (software-preferred).
	const linuxSupport = (config: VideoDecoderConfig) =>
		Promise.resolve({
			supported:
				/^vp09\.\d/.test(config.codec) ||
				/^av01\./.test(config.codec) ||
				config.codec === "vp8" ||
				config.codec.startsWith("avc1."),
			config,
		});

	it("expands bare vp09 to a full, supported vp09.* string (issue #8)", async () => {
		const resolved = await resolveDecoderConfig({ codec: "vp09" }, linuxSupport);
		expect(resolved.codec).toBe("vp09.00.10.08");
		expect(resolved.hardwareAcceleration).toBe("prefer-software");
	});

	it("expands bare vp9 the same way", async () => {
		const resolved = await resolveDecoderConfig({ codec: "vp9" }, linuxSupport);
		expect(resolved.codec).toBe("vp09.00.10.08");
	});

	it("builds the vp09 string from a VPCodecConfigurationRecord when present", async () => {
		// profile 0, level 31 (0x1f), 10-bit (0xA0 high nibble = 10)
		const description = new Uint8Array([0x00, 31, 0xa0]).buffer;
		const resolved = await resolveDecoderConfig({ codec: "vp09", description }, linuxSupport);
		expect(resolved.codec).toBe("vp09.00.31.10");
	});

	it("normalizes bare vp08 to vp8", async () => {
		const resolved = await resolveDecoderConfig({ codec: "vp08" }, linuxSupport);
		expect(resolved.codec).toBe("vp8");
	});

	it("normalizes bare avc1/h264 to a supported high-profile string", async () => {
		expect((await resolveDecoderConfig({ codec: "avc1" }, linuxSupport)).codec).toBe("avc1.640033");
		expect((await resolveDecoderConfig({ codec: "h264" }, linuxSupport)).codec).toBe("avc1.640033");
	});

	it("expands bare av01 to a full av01.* string", async () => {
		const resolved = await resolveDecoderConfig({ codec: "av01" }, linuxSupport);
		expect(resolved.codec).toBe("av01.0.01M.08");
		expect(resolved.hardwareAcceleration).toBe("prefer-software");
	});

	it("falls back to avc1.640033 when a specific H.264 profile string is unsupported", async () => {
		const support = vi.fn((config: VideoDecoderConfig) =>
			Promise.resolve({ supported: config.codec === "avc1.640033", config }),
		);
		const resolved = await resolveDecoderConfig({ codec: "avc1.4d4028" }, support);
		expect(resolved.codec).toBe("avc1.640033");
	});

	it("prefers software for AV1/VP9 but probes the default config as a fallback", async () => {
		const support = vi.fn((config: VideoDecoderConfig) =>
			Promise.resolve({
				// Only the non-prefer-software config is supported here.
				supported: /^vp09\.\d/.test(config.codec) && config.hardwareAcceleration === undefined,
				config,
			}),
		);
		const resolved = await resolveDecoderConfig({ codec: "vp09" }, support);
		expect(resolved.codec).toBe("vp09.00.10.08");
		expect(resolved.hardwareAcceleration).toBeUndefined();
	});

	it("throws a clear, codec-named error when nothing is supported (e.g. H.265)", async () => {
		const unsupported = () => Promise.resolve({ supported: false } as VideoDecoderSupport);
		await expect(resolveDecoderConfig({ codec: "hev1.1.6.L93.B0" }, unsupported)).rejects.toThrow(
			/hev1\.1\.6\.L93\.B0.*can't decode/,
		);
	});

	it("treats a throwing isConfigSupported as unsupported and tries the next candidate", async () => {
		const support = vi.fn((config: VideoDecoderConfig) => {
			if (config.hardwareAcceleration === "prefer-software") {
				throw new Error("malformed");
			}
			return Promise.resolve({ supported: /^vp09\.\d/.test(config.codec), config });
		});
		const resolved = await resolveDecoderConfig({ codec: "vp09" }, support);
		expect(resolved.codec).toBe("vp09.00.10.08");
		expect(resolved.hardwareAcceleration).toBeUndefined();
	});

	it("does not mutate the caller's config object", async () => {
		const input: VideoDecoderConfig = { codec: "vp09" };
		await resolveDecoderConfig(input, linuxSupport);
		expect(input.codec).toBe("vp09");
	});
});

describe("validateDuration", () => {
	it("returns scanned duration when container reports Infinity", () => {
		expect(validateDuration(Infinity, 15.3)).toBe(15.3);
	});

	it("returns scanned duration when container reports 0", () => {
		expect(validateDuration(0, 15.3)).toBe(15.3);
	});

	it("returns scanned duration when container reports NaN", () => {
		expect(validateDuration(NaN, 15.3)).toBe(15.3);
	});

	it("returns scanned duration when container is inflated beyond threshold", () => {
		expect(validateDuration(42, 15.3)).toBe(15.3);
	});

	it("returns container duration when values are close", () => {
		expect(validateDuration(15.5, 15.3)).toBe(15.5);
	});

	it("returns container duration when scanned is slightly higher", () => {
		// container < scanned (scanned overshoot from last frame duration)
		expect(validateDuration(15.0, 15.3)).toBe(15.0);
	});

	it("returns scanned duration when container under-reports beyond threshold", () => {
		expect(validateDuration(10, 15.3)).toBe(15.3);
	});

	it("returns container duration when scanned is zero (corrupted/empty file)", () => {
		expect(validateDuration(10, 0)).toBe(10);
	});

	it("returns 0 when both container is NaN and scanned is zero", () => {
		expect(validateDuration(NaN, 0)).toBe(0);
	});
});

describe("shouldFailDecodeEndedEarly", () => {
	it("does not fail once every segment has been satisfied", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 5.33,
				requiredEndSec: 6.498,
				streamDurationSec: 5.33,
			}),
		).toBe(false);
	});

	it("fails when decode stops far before the required end", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 5.33,
				requiredEndSec: 10,
				streamDurationSec: 5.33,
			}),
		).toBe(true);
	});

	it("fails when no frame could be decoded for a non-empty timeline", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: null,
				requiredEndSec: 1,
			}),
		).toBe(true);
	});

	it("fails when the decoder has not reached the reported stream end", () => {
		expect(
			shouldFailDecodeEndedEarly({
				cancelled: false,
				lastDecodedFrameSec: 4.9,
				requiredEndSec: 6.498,
				streamDurationSec: 5.33,
			}),
		).toBe(true);
	});
});
