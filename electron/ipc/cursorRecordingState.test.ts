import { describe, expect, it } from "vitest";
import type { CursorRecordingData } from "../../src/native/contracts";
import { createCursorRecordingState } from "./cursorRecordingState";

function recordingData(tag: number): CursorRecordingData {
	return {
		version: 2,
		provider: "native",
		samples: [
			{
				timeMs: tag,
				cx: 0.5,
				cy: 0.5,
				assetId: null,
				visible: true,
				cursorType: null,
				interactionType: "move",
			},
		],
		assets: [],
	};
}

describe("createCursorRecordingState", () => {
	it("discards pending cursor telemetry for the matching recording id", () => {
		const state = createCursorRecordingState();

		state.setActiveRecording(101);
		state.setPending(recordingData(101));

		expect(state.pendingRecordingId).toBe(101);
		expect(state.discardPending(101)).toBe(true);
		expect(state.pendingRecordingId).toBeNull();

		// A following store must not inherit samples from the discarded recording.
		expect(state.getPendingData()).toBeNull();
	});

	it("does not discard pending cursor telemetry for a different recording id", () => {
		const state = createCursorRecordingState();
		const data = recordingData(202);

		state.setActiveRecording(202);
		state.setPending(data);

		expect(state.discardPending(101)).toBe(false);
		expect(state.pendingRecordingId).toBe(202);
		expect(state.getPendingData()).toBe(data);
	});
});
