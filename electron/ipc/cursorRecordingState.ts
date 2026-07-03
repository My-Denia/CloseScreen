import type { CursorRecordingData } from "../../src/native/contracts";

/**
 * Holds cursor-telemetry batches between a recording's stop (when the sampler is
 * drained) and its store (when the `.cursor.json` sidecar is written beside the
 * finished video).
 *
 * Batches are keyed by recordingId, NOT kept in a single slot: a browser recording
 * reports `recording=false` and drains its buffered blob before its store runs, so
 * a rapid stop-A / start-B / stop-B can otherwise clobber A's cursor batch with B's
 * (or wipe it at B's start) before A's store writes it. Per-id keying keeps each
 * recording's batch until its own store or discard consumes it, and lets
 * `discardPending(id)` drop exactly the discarded recording's batch.
 */

// Batches are consumed by exactly one store/discard call, so at most a couple are
// ever pending. This cap only bounds a pathological leak (e.g. a finalize that
// fails before writing) — the oldest batch is evicted first.
const MAX_PENDING_BATCHES = 8;

function normalizeRecordingId(recordingId?: number): number | null {
	return typeof recordingId === "number" && Number.isFinite(recordingId) ? recordingId : null;
}

export function createCursorRecordingState() {
	let activeRecordingId: number | null = null;
	// Insertion-ordered so eviction drops the oldest un-consumed batch first.
	const pending = new Map<number, CursorRecordingData>();

	function evictOverflow() {
		while (pending.size > MAX_PENDING_BATCHES) {
			const oldest = pending.keys().next().value;
			if (oldest === undefined) break;
			pending.delete(oldest);
			console.warn(`[cursor-telemetry] evicted stale pending batch for recording ${oldest}`);
		}
	}

	return {
		/** Mark which recording the next `setPending` batch belongs to. */
		setActiveRecording(recordingId?: number) {
			activeRecordingId = normalizeRecordingId(recordingId);
		},
		/** Clear only the active marker (e.g. a sampler that failed to stop). Other
		 * recordings' pending batches are untouched. */
		clearActiveRecording() {
			activeRecordingId = null;
		},
		/** Stamp the just-stopped sampler's data under the active recordingId. A batch
		 * with no active id is dropped — it could never be looked up at store time. */
		setPending(data: CursorRecordingData) {
			const recordingId = activeRecordingId;
			activeRecordingId = null;
			if (recordingId === null) {
				return;
			}
			pending.set(recordingId, data);
			evictOverflow();
		},
		getPendingData(recordingId: number) {
			const id = normalizeRecordingId(recordingId);
			return id === null ? null : (pending.get(id) ?? null);
		},
		updatePendingData(
			recordingId: number,
			update: (data: CursorRecordingData) => CursorRecordingData,
		) {
			const id = normalizeRecordingId(recordingId);
			if (id === null) return;
			const data = pending.get(id);
			if (!data) return;
			pending.set(id, update(data));
		},
		/** Drop one recording's pending batch (after writing it, or on discard). */
		clearPending(recordingId: number) {
			const id = normalizeRecordingId(recordingId);
			if (id !== null) {
				pending.delete(id);
			}
		},
		/** Discard on request from the renderer; true iff a batch was actually dropped. */
		discardPending(recordingId: number) {
			const id = normalizeRecordingId(recordingId);
			if (id === null || !pending.has(id)) {
				return false;
			}
			pending.delete(id);
			return true;
		},
		hasPending(recordingId: number) {
			const id = normalizeRecordingId(recordingId);
			return id === null ? false : pending.has(id);
		},
		get activeRecordingId() {
			return activeRecordingId;
		},
	};
}
