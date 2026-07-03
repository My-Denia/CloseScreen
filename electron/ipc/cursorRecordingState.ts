import type { CursorRecordingData } from "../../src/native/contracts";

type PendingCursorRecordingData = {
	recordingId: number | null;
	data: CursorRecordingData;
};

function normalizeRecordingId(recordingId?: number): number | null {
	return typeof recordingId === "number" && Number.isFinite(recordingId) ? recordingId : null;
}

export function createCursorRecordingState() {
	let activeRecordingId: number | null = null;
	let pending: PendingCursorRecordingData | null = null;

	return {
		setActiveRecording(recordingId?: number) {
			activeRecordingId = normalizeRecordingId(recordingId);
		},
		setPending(data: CursorRecordingData) {
			pending = { recordingId: activeRecordingId, data };
			activeRecordingId = null;
		},
		getPendingData() {
			return pending?.data ?? null;
		},
		updatePendingData(update: (data: CursorRecordingData) => CursorRecordingData) {
			if (!pending) return;
			pending = { ...pending, data: update(pending.data) };
		},

		clearPending() {
			pending = null;
		},
		discardPending(recordingId: number) {
			const normalizedRecordingId = normalizeRecordingId(recordingId);
			if (
				normalizedRecordingId === null ||
				!pending ||
				pending.recordingId !== normalizedRecordingId
			) {
				return false;
			}
			pending = null;
			return true;
		},
		reset() {
			activeRecordingId = null;
			pending = null;
		},
		get activeRecordingId() {
			return activeRecordingId;
		},
		get pendingRecordingId() {
			return pending?.recordingId ?? null;
		},
	};
}
