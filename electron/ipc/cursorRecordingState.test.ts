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

function stamp(state: ReturnType<typeof createCursorRecordingState>, id: number, tag = id) {
	state.setActiveRecording(id);
	state.setPending(recordingData(tag));
}

describe("createCursorRecordingState", () => {
	it("discards pending cursor telemetry for the matching recording id", () => {
		const state = createCursorRecordingState();
		stamp(state, 101);

		expect(state.hasPending(101)).toBe(true);
		expect(state.discardPending(101)).toBe(true);
		expect(state.hasPending(101)).toBe(false);
		// A following store must not inherit samples from the discarded recording.
		expect(state.getPendingData(101)).toBeNull();
	});

	it("does not discard pending cursor telemetry for a different recording id", () => {
		const state = createCursorRecordingState();
		const data = recordingData(202);
		state.setActiveRecording(202);
		state.setPending(data);

		expect(state.discardPending(101)).toBe(false);
		expect(state.getPendingData(202)).toBe(data);
	});

	// The bug this module fixes: overlapping browser recordings clobbering one slot.
	it("keeps each recording's batch when a second recording overlaps the first's store", () => {
		const state = createCursorRecordingState();
		const dataA = recordingData(1);
		const dataB = recordingData(2);

		// Stop A (batch pending), then a full start+stop of B before A's store runs.
		state.setActiveRecording(1);
		state.setPending(dataA);
		state.setActiveRecording(2); // B starts — must NOT wipe A's batch
		state.setPending(dataB);

		expect(state.getPendingData(1)).toBe(dataA);
		expect(state.getPendingData(2)).toBe(dataB);

		// A's store consumes only A; B survives for its own store.
		state.clearPending(1);
		expect(state.getPendingData(1)).toBeNull();
		expect(state.getPendingData(2)).toBe(dataB);
	});

	it("discards exactly one recording's batch, leaving an overlapping one intact", () => {
		const state = createCursorRecordingState();
		stamp(state, 1);
		stamp(state, 2);

		expect(state.discardPending(1)).toBe(true);
		expect(state.hasPending(1)).toBe(false);
		expect(state.hasPending(2)).toBe(true);
	});

	it("updates only the targeted recording's batch (native shift/compact path)", () => {
		const state = createCursorRecordingState();
		stamp(state, 1, 10);
		stamp(state, 2, 20);

		state.updatePendingData(2, (data) => ({
			...data,
			samples: data.samples.map((s) => ({ ...s, timeMs: s.timeMs + 5 })),
		}));

		expect(state.getPendingData(1)?.samples[0].timeMs).toBe(10);
		expect(state.getPendingData(2)?.samples[0].timeMs).toBe(25);
	});

	it("drops a batch with no active recording id (cannot be looked up later)", () => {
		const state = createCursorRecordingState();
		state.setPending(recordingData(1)); // no setActiveRecording first
		expect(state.getPendingData(1)).toBeNull();
	});

	it("clearActiveRecording drops only the marker, not other batches", () => {
		const state = createCursorRecordingState();
		stamp(state, 1);
		state.setActiveRecording(2);
		state.clearActiveRecording();

		expect(state.activeRecordingId).toBeNull();
		expect(state.hasPending(1)).toBe(true); // an earlier recording's batch survives
		state.setPending(recordingData(2)); // no active id → dropped
		expect(state.hasPending(2)).toBe(false);
	});

	it("bounds accumulation, evicting the oldest un-consumed batch", () => {
		const state = createCursorRecordingState();
		for (let id = 1; id <= 10; id++) stamp(state, id);

		// Cap is 8; the two oldest (1, 2) were evicted, newest retained.
		expect(state.hasPending(1)).toBe(false);
		expect(state.hasPending(2)).toBe(false);
		expect(state.hasPending(3)).toBe(true);
		expect(state.hasPending(10)).toBe(true);
	});
});
