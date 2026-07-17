// @vitest-environment node

import { describe, expect, it } from "vitest";
import { analyzeAudibleSpan } from "../../scripts/windows-native-audio-analysis.mjs";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const WINDOW_FRAMES = SAMPLE_RATE / 4;
const TONE_HZ = 997;
const TONE_TOLERANCE_HZ = 10;
const AAC_FRAME_SAMPLES = 1024;
const MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES =
	AAC_FRAME_SAMPLES + Math.ceil(SAMPLE_RATE / (TONE_HZ - TONE_TOLERANCE_HZ));
const PHASES = [0, Math.PI / 7, Math.PI / 2, Math.PI];

function toneWindow({
	frequency = TONE_HZ,
	phase = 0,
	trailingFrames = 0,
	tailAmplitude = 0,
	tailFrequency = 7000,
	tailSample = null,
	tailContinuesPhase = false,
} = {}) {
	const pcm = Buffer.alloc(WINDOW_FRAMES * CHANNELS * 2);
	const toneFrames = WINDOW_FRAMES - trailingFrames;
	const tailPhase = tailContinuesPhase
		? (2 * Math.PI * frequency * toneFrames) / SAMPLE_RATE + phase
		: 0;
	for (let frame = 0; frame < WINDOW_FRAMES; frame++) {
		const sample =
			frame < toneFrames
				? Math.round(8000 * Math.sin((2 * Math.PI * frequency * frame) / SAMPLE_RATE + phase))
				: (tailSample ??
					Math.round(
						tailAmplitude *
							Math.sin(
								(2 * Math.PI * tailFrequency * (frame - toneFrames)) / SAMPLE_RATE + tailPhase,
							),
					));
		for (let channel = 0; channel < CHANNELS; channel++) {
			pcm.writeInt16LE(sample, (frame * CHANNELS + channel) * 2);
		}
	}
	return pcm;
}

function analyze(pcm) {
	return analyzeAudibleSpan(pcm, 0, WINDOW_FRAMES, {
		channels: CHANNELS,
		sampleRate: SAMPLE_RATE,
		threshold: 200,
		expectedFrequency: TONE_HZ,
		frequencyTolerance: TONE_TOLERANCE_HZ,
	});
}

describe("Windows native parity audio analysis", () => {
	it.each([
		{ phase: 0, trailingFrames: 377 },
		{ phase: Math.PI / 7, trailingFrames: 377 },
		{ phase: Math.PI / 2, trailingFrames: 921 },
		{ phase: Math.PI, trailingFrames: 921 },
	])("keeps 997 Hz stable across phase and AAC tail padding: %o", (options) => {
		const result = analyze(toneWindow(options));

		expect(Math.abs(result.frequency - TONE_HZ)).toBeLessThanOrEqual(1);
		expect(result.trailingBelowThresholdFrames).toBeLessThanOrEqual(AAC_FRAME_SAMPLES);
		expect(result.trailingWithoutValidToneFrames).toBeLessThanOrEqual(
			MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES,
		);
	});

	it("ignores sub-threshold high-frequency tail ringing", () => {
		const result = analyze(toneWindow({ trailingFrames: 921, tailAmplitude: 150 }));

		expect(Math.abs(result.frequency - TONE_HZ)).toBeLessThanOrEqual(1);
		expect(result.trailingBelowThresholdFrames).toBeLessThanOrEqual(AAC_FRAME_SAMPLES);
		expect(result.trailingWithoutValidToneFrames).toBeLessThanOrEqual(
			MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES,
		);
	});

	it("still rejects a genuinely wrong tone", () => {
		const result = analyze(toneWindow({ frequency: 1020, trailingFrames: 377 }));

		expect(Math.abs(result.frequency - TONE_HZ)).toBeGreaterThan(TONE_TOLERANCE_HZ);
	});

	it("reports more than one AAC frame of missing trailing tone", () => {
		const result = analyze(toneWindow({ trailingFrames: AAC_FRAME_SAMPLES + 100 }));

		expect(result.trailingBelowThresholdFrames).toBeGreaterThan(AAC_FRAME_SAMPLES);
	});

	it("reports an above-threshold stuck tail after the last valid tone cycle", () => {
		const result = analyze(toneWindow({ trailingFrames: 2000, tailSample: 1000 }));

		// Whole-span frequency alone looks valid; the tone-cycle tail gate must reject it.
		expect(result.frequencyMatchesExpected).toBe(true);
		expect(result.trailingBelowThresholdFrames).toBe(0);
		expect(result.trailingWithoutValidToneFrames).toBeGreaterThan(
			MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES,
		);
	});

	it.each([
		1600, 2000,
	])("rejects a %i-frame out-of-band phase-continuous tail", (trailingFrames) => {
		const result = analyze(
			toneWindow({
				trailingFrames,
				tailAmplitude: 8000,
				tailFrequency: 1008,
				tailContinuesPhase: true,
			}),
		);

		// The whole 250 ms average remains in tolerance, so the local tail gate must reject it.
		expect(Math.abs(result.frequency - TONE_HZ)).toBeLessThanOrEqual(TONE_TOLERANCE_HZ);
		expect(result.trailingBelowThresholdFrames).toBe(0);
		expect(result.trailingWithoutValidToneFrames).toBeGreaterThan(
			MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES,
		);
	});

	it.each(
		[987, 1007].flatMap((frequency) => PHASES.map((phase) => ({ frequency, phase }))),
	)("accepts inclusive tone boundary: %o", ({ frequency, phase }) => {
		const result = analyze(toneWindow({ frequency, phase, trailingFrames: 921 }));

		expect(result.frequencyMatchesExpected).toBe(true);
		expect(result.trailingWithoutValidToneFrames).toBeLessThanOrEqual(
			MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES,
		);
	});

	it.each(
		[986.9, 1007.1].flatMap((frequency) => PHASES.map((phase) => ({ frequency, phase }))),
	)("rejects adjacent out-of-band tone: %o", ({ frequency, phase }) => {
		const result = analyze(toneWindow({ frequency, phase }));

		expect(result.frequencyMatchesExpected).toBe(false);
		expect(result.trailingWithoutValidToneFrames).toBeGreaterThan(
			MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES,
		);
	});

	it.each([
		Buffer.alloc(0),
		Buffer.alloc(WINDOW_FRAMES * CHANNELS * 2),
	])("does not turn metadata-only or silent PCM into tone evidence", (pcm) => {
		const result = analyzeAudibleSpan(pcm, 0, WINDOW_FRAMES, {
			channels: CHANNELS,
			sampleRate: SAMPLE_RATE,
			threshold: 200,
		});

		expect(result.samples).toBe(0);
		expect(result.frequency).toBe(0);
		expect(result.peak).toBe(0);
	});
});
