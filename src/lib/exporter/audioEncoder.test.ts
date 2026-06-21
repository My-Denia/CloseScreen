import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebDemuxer } from "web-demuxer";
import {
	AudioProcessor,
	buildAacCodecString,
	downmixPlanarChannelsForExport,
	normalizeAudioDecoderConfig,
} from "./audioEncoder";

describe("normalizeAudioDecoderConfig", () => {
	it("expands the bare 'mp4a' tag into a WebCodecs AAC string when an ASC is present (issue #7)", () => {
		// AudioSpecificConfig byte 0 = 0x12 = 0b00010_010: top 5 bits = object type 2 (AAC-LC).
		const description = new Uint8Array([0x12, 0x10]).buffer;
		const config: AudioDecoderConfig = {
			codec: "mp4a",
			description,
			sampleRate: 48000,
			numberOfChannels: 2,
		};
		expect(normalizeAudioDecoderConfig(config).codec).toBe("mp4a.40.2");
	});

	it("derives the AAC object type from the AudioSpecificConfig description", () => {
		// byte 0 = 0b00101_000: top 5 bits = object type 5 (HE-AAC/SBR).
		const description = new Uint8Array([0x28, 0x00]).buffer;
		const config: AudioDecoderConfig = { codec: "mp4a", description };
		expect(normalizeAudioDecoderConfig(config).codec).toBe("mp4a.40.5");
	});

	it("preserves a non-LC object type (xHE-AAC/USAC) instead of down-mapping it to LC", () => {
		// Escape-coded ASC for object type 42: byte0=0xF9, byte1=0x40 => 32 + 10 = 42.
		expect(buildAacCodecString(new Uint8Array([0xf9, 0x40]).buffer)).toBe("mp4a.40.42");
	});

	it("leaves the bare 'mp4a' tag untouched when there is no AudioSpecificConfig", () => {
		// Without an ASC, WebCodecs would treat the config as ADTS; keep it bare so
		// isConfigSupported rejects it and the track is cleanly skipped rather than mis-decoded.
		const config: AudioDecoderConfig = { codec: "mp4a", sampleRate: 48000, numberOfChannels: 2 };
		expect(normalizeAudioDecoderConfig(config).codec).toBe("mp4a");
	});

	it("falls back to AAC-LC for a malformed (out-of-range) object type", () => {
		// byte 0 = 0x00: object type 0, outside the valid MPEG-4 range.
		expect(buildAacCodecString(new Uint8Array([0x00]).buffer)).toBe("mp4a.40.2");
		expect(buildAacCodecString()).toBe("mp4a.40.2");
	});

	it("leaves already-qualified and valid bare codecs untouched", () => {
		expect(normalizeAudioDecoderConfig({ codec: "mp4a.40.2" }).codec).toBe("mp4a.40.2");
		expect(normalizeAudioDecoderConfig({ codec: "opus" }).codec).toBe("opus");
		expect(normalizeAudioDecoderConfig({ codec: "mp3" }).codec).toBe("mp3");
	});

	it("does not mutate the caller's config object", () => {
		const input: AudioDecoderConfig = {
			codec: "mp4a",
			description: new Uint8Array([0x12, 0x10]).buffer,
		};
		normalizeAudioDecoderConfig(input);
		expect(input.codec).toBe("mp4a");
	});
});

describe("AudioProcessor.selectSupportedExportCodecForSource", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("selects Opus for an AAC source on Linux Electron (bare mp4a rejected, no AAC encoder)", async () => {
		// Mirrors the real Linux Electron probe: bare "mp4a" decode is rejected, the full
		// "mp4a.40.2" string decodes, and only Opus can be encoded.
		const decoderSupport = vi.fn(async (config: AudioDecoderConfig) => ({
			config,
			supported: config.codec === "mp4a.40.2",
		}));
		const encoderSupport = vi.fn(async (config: AudioEncoderConfig) => ({
			config,
			supported: config.codec === "opus",
		}));
		vi.stubGlobal("AudioDecoder", { isConfigSupported: decoderSupport });
		vi.stubGlobal("AudioEncoder", { isConfigSupported: encoderSupport });

		const demuxer = {
			getDecoderConfig: vi.fn(async () => ({
				codec: "mp4a",
				description: new Uint8Array([0x12, 0x10]).buffer, // AAC-LC AudioSpecificConfig
				sampleRate: 48000,
				numberOfChannels: 2,
			})),
		} as unknown as WebDemuxer;

		const codec = await AudioProcessor.selectSupportedExportCodecForSource(demuxer);

		expect(codec).toMatchObject({ encoderCodec: "opus", muxerCodec: "opus" });
		// The decode probe must run against the normalized string, never the bare tag.
		expect(decoderSupport).toHaveBeenCalledWith(expect.objectContaining({ codec: "mp4a.40.2" }));
		expect(decoderSupport).not.toHaveBeenCalledWith(expect.objectContaining({ codec: "mp4a" }));
	});

	it("returns null only when the source truly cannot be decoded", async () => {
		vi.stubGlobal("AudioDecoder", {
			isConfigSupported: vi.fn(async (config: AudioDecoderConfig) => ({
				config,
				supported: false,
			})),
		});
		const demuxer = {
			getDecoderConfig: vi.fn(async () => ({
				codec: "ac-3",
				sampleRate: 48000,
				numberOfChannels: 6,
			})),
		} as unknown as WebDemuxer;

		expect(await AudioProcessor.selectSupportedExportCodecForSource(demuxer)).toBeNull();
	});
});

describe("AudioProcessor.selectSupportedExportCodec", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("falls back to stereo when the source channel count cannot be encoded", async () => {
		const isConfigSupported = vi.fn(async (config: AudioEncoderConfig) => ({
			config,
			supported:
				config.codec === "mp4a.40.2" &&
				config.sampleRate === 44100 &&
				config.numberOfChannels === 2,
		}));
		vi.stubGlobal("AudioEncoder", { isConfigSupported });

		const codec = await AudioProcessor.selectSupportedExportCodec(44100, 8);

		expect(codec).toMatchObject({
			encoderCodec: "mp4a.40.2",
			muxerCodec: "aac",
			sampleRate: 44100,
			numberOfChannels: 2,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 8,
			bitrate: 128000,
		});
		expect(isConfigSupported).toHaveBeenCalledWith({
			codec: "mp4a.40.2",
			sampleRate: 44100,
			numberOfChannels: 2,
			bitrate: 128000,
		});
	});
});

describe("downmixPlanarChannelsForExport", () => {
	it("preserves non-front Windows system audio channels when exporting stereo", () => {
		const sourcePlanes = Array.from({ length: 8 }, (_, channel) => {
			const plane = new Float32Array(2);
			if (channel === 2) {
				plane[0] = 0.8;
				plane[1] = 0.4;
			}
			if (channel === 6) {
				plane[0] = 0.2;
				plane[1] = 0.1;
			}
			return plane;
		});

		const stereo = downmixPlanarChannelsForExport(sourcePlanes, 2);

		expect(stereo[0]).toBeGreaterThan(0);
		expect(stereo[1]).toBeGreaterThan(0);
		expect(stereo[2]).toBeGreaterThan(0);
		expect(stereo[3]).toBeGreaterThan(0);
	});

	it("duplicates mono microphone audio when exporting stereo", () => {
		const mono = new Float32Array([0.25, -0.5]);

		const stereo = downmixPlanarChannelsForExport([mono], 2);

		expect(Array.from(stereo)).toEqual([0.25, -0.5, 0.25, -0.5]);
	});
});
