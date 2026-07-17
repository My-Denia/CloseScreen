const DEFAULT_CHANNELS = 2;
const DEFAULT_SAMPLE_RATE = 48_000;
const DEFAULT_THRESHOLD = 200;

function clampFrame(value, frameCount) {
	return Math.max(0, Math.min(frameCount, Math.floor(value)));
}

export function analyzeAudibleSpan(
	pcm,
	startFrame,
	endFrame,
	{
		channels = DEFAULT_CHANNELS,
		sampleRate = DEFAULT_SAMPLE_RATE,
		threshold = DEFAULT_THRESHOLD,
		expectedFrequency = null,
		frequencyTolerance = null,
		validationCycles = 16,
	} = {},
) {
	if (!Buffer.isBuffer(pcm)) throw new TypeError("pcm must be a Buffer");
	if (!Number.isInteger(channels) || channels <= 0) {
		throw new RangeError("channels must be a positive integer");
	}
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new RangeError("sampleRate must be positive");
	}
	if (!Number.isFinite(threshold) || threshold <= 0) {
		throw new RangeError("threshold must be positive");
	}
	if (
		(expectedFrequency !== null || frequencyTolerance !== null) &&
		(!Number.isFinite(expectedFrequency) ||
			expectedFrequency <= 0 ||
			!Number.isFinite(frequencyTolerance) ||
			frequencyTolerance < 0)
	) {
		throw new RangeError("expectedFrequency and frequencyTolerance must be valid together");
	}
	if (!Number.isInteger(validationCycles) || validationCycles < 2) {
		throw new RangeError("validationCycles must be an integer of at least 2");
	}

	const bytesPerFrame = channels * 2;
	const frameCount = Math.floor(pcm.length / bytesPerFrame);
	const start = clampFrame(startFrame, frameCount);
	const end = Math.max(start, clampFrame(endFrame, frameCount));
	let firstAudible = null;
	let lastAudible = null;

	for (let frame = start; frame < end; frame++) {
		const sample = pcm.readInt16LE(frame * bytesPerFrame);
		if (Math.abs(sample) >= threshold) {
			if (firstAudible === null) firstAudible = frame;
			lastAudible = frame;
		}
	}

	if (firstAudible === null || lastAudible === null) {
		return {
			samples: 0,
			rms: 0,
			peak: 0,
			frequency: 0,
			validCrossings: 0,
			leadingBelowThresholdFrames: end - start,
			trailingBelowThresholdFrames: end - start,
			trailingWithoutValidToneFrames: end - start,
		};
	}

	let sumSquares = 0;
	let peak = 0;
	let armed = false;
	let previousSample = null;
	const crossingFrames = [];
	for (let frame = firstAudible; frame <= lastAudible; frame++) {
		const sample = pcm.readInt16LE(frame * bytesPerFrame);
		const absolute = Math.abs(sample);
		peak = Math.max(peak, absolute);
		sumSquares += sample * sample;

		if (sample <= -threshold) {
			armed = true;
		} else if (armed && sample >= threshold) {
			const crossingFrame =
				previousSample !== null && previousSample < threshold && sample !== previousSample
					? frame - 1 + (threshold - previousSample) / (sample - previousSample)
					: frame;
			crossingFrames.push(crossingFrame);
			armed = false;
		}
		previousSample = sample;
	}

	const samples = lastAudible - firstAudible + 1;
	const validCrossings = crossingFrames.length;
	const firstCrossingFrame = crossingFrames[0] ?? null;
	const lastCrossingFrame = crossingFrames.at(-1) ?? null;
	const crossingSpanFrames =
		firstCrossingFrame === null || lastCrossingFrame === null
			? 0
			: lastCrossingFrame - firstCrossingFrame;
	const frequency =
		validCrossings >= 2 && crossingSpanFrames > 0
			? ((validCrossings - 1) * sampleRate) / crossingSpanFrames
			: 0;
	let lastValidToneCrossingFrame = expectedFrequency === null ? lastCrossingFrame : null;
	if (expectedFrequency !== null) {
		for (let index = validationCycles; index < crossingFrames.length; index++) {
			const spanFrames = crossingFrames[index] - crossingFrames[index - validationCycles];
			const localFrequency = (validationCycles * sampleRate) / spanFrames;
			if (Math.abs(localFrequency - expectedFrequency) <= frequencyTolerance) {
				lastValidToneCrossingFrame = crossingFrames[index];
			}
		}
	}

	return {
		samples,
		rms: Math.sqrt(sumSquares / samples),
		peak,
		frequency,
		validCrossings,
		leadingBelowThresholdFrames: firstAudible - start,
		trailingBelowThresholdFrames: end - lastAudible - 1,
		trailingWithoutValidToneFrames:
			lastValidToneCrossingFrame === null ? end - start : end - lastValidToneCrossingFrame - 1,
	};
}
