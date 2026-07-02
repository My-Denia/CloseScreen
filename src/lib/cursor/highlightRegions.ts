// Pure helpers for the time-ranged cursor highlight (issue #26). Both renderers — the
// preview's native-cursor DOM overlay and the exporter's canvas pass — call
// isHighlightActive with the frame's time to decide whether to draw the highlight at the
// cursor's already-projected position.
import type { HighlightRegion } from "@/components/video-editor/types";

/** True when `timeMs` falls inside any highlight region (start inclusive, end exclusive). */
export function isHighlightActive(
	regions: readonly HighlightRegion[] | undefined,
	timeMs: number,
): boolean {
	if (!regions || regions.length === 0) return false;
	for (const region of regions) {
		if (timeMs >= region.startMs && timeMs < region.endMs) return true;
	}
	return false;
}
