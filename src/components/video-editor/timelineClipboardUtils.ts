// In-memory clipboard for timeline elements (issue #29). Modeled after upstream
// openscreen PR #488/#489 (single-item clipboard; multi-select left as follow-up),
// adapted to this fork and with its review findings folded in: pasted annotation
// positions are clamped (never offset, so full-frame freehand blurs keep their
// bounds), pasted zooms become source:"manual", and pasted annotations drop their
// auto-caption link — same semantics as handleAnnotationDuplicate.
import type {
	AnnotationPosition,
	AnnotationRegion,
	AnnotationSize,
	HighlightRegion,
	SpeedRegion,
	TrimRegion,
	ZoomRegion,
} from "./types";

export type TimelineClipboardItem =
	| { kind: "zoom"; region: ZoomRegion }
	| { kind: "trim"; region: TrimRegion }
	| { kind: "speed"; region: SpeedRegion }
	| { kind: "annotation"; region: AnnotationRegion }
	| { kind: "blur"; region: AnnotationRegion }
	| { kind: "highlight"; region: HighlightRegion };

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Deep-clone an annotation/blur region so clipboard contents can't alias editor state. */
export function cloneAnnotationRegion(region: AnnotationRegion): AnnotationRegion {
	return {
		...region,
		position: { ...region.position },
		size: { ...region.size },
		style: { ...region.style },
		figureData: region.figureData ? { ...region.figureData } : undefined,
		blurData: region.blurData
			? {
					...region.blurData,
					freehandPoints: region.blurData.freehandPoints?.map((point) => ({ ...point })),
				}
			: undefined,
	};
}

/** True span intersection; touching endpoints (adjacency) is allowed. */
export function spansOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
	return startA < endB && endA > startB;
}

/**
 * Where a pasted element lands: at the playhead, keeping the source duration,
 * shifted back if it would run past the end of the video. Null when there is no
 * video to paste into.
 */
export function getPastedSpan(
	sourceStartMs: number,
	sourceEndMs: number,
	playheadMs: number,
	totalMs: number,
): { startMs: number; endMs: number } | null {
	if (totalMs <= 0) return null;
	const sourceDuration = Math.max(1, sourceEndMs - sourceStartMs);
	const pastedDuration = Math.min(sourceDuration, totalMs);
	const startMs = clamp(Math.round(playheadMs), 0, totalMs - pastedDuration);
	return { startMs, endMs: startMs + pastedDuration };
}

/**
 * Keep a pasted annotation fully on the canvas. Positions/sizes are percentages;
 * clamping (rather than offsetting) preserves full-frame regions like freehand
 * blurs at exactly {0,0,100,100}.
 */
export function getPastedAnnotationPosition(
	position: AnnotationPosition,
	size: AnnotationSize,
): AnnotationPosition {
	const maxX = Math.max(0, 100 - size.width);
	const maxY = Math.max(0, 100 - size.height);
	return {
		x: clamp(position.x, 0, maxX),
		y: clamp(position.y, 0, maxY),
	};
}

/**
 * Pasted zooms are the user's own: always source:"manual" so wand toggles never remove
 * them. While Auto-Focus All is on, every zoom must be cursor-following (the toggle
 * rewrites all regions and the settings UI locks the selector), so the paste applies the
 * global mode instead of the clipboard's — otherwise the source's focusMode is preserved,
 * matching the per-zoom choice the user copied.
 */
export function buildPastedZoomRegion(
	source: ZoomRegion,
	id: string,
	span: { startMs: number; endMs: number },
	opts?: { forceAutoFocus?: boolean },
): ZoomRegion {
	return {
		...source,
		id,
		startMs: span.startMs,
		endMs: span.endMs,
		focus: { ...source.focus },
		source: "manual",
		...(opts?.forceAutoFocus ? { focusMode: "auto" as const } : {}),
	};
}

/**
 * Pasted annotations/blurs drop the auto-caption link (mirrors
 * handleAnnotationDuplicate) so the copy is a plain user annotation that neither
 * syncs with nor gets regenerated away by the captioning flow.
 */
export function buildPastedAnnotationRegion(
	source: AnnotationRegion,
	id: string,
	zIndex: number,
	span: { startMs: number; endMs: number },
): AnnotationRegion {
	const { annotationSource: _stripCaptionLink, ...rest } = cloneAnnotationRegion(source);
	return {
		...rest,
		id,
		zIndex,
		startMs: span.startMs,
		endMs: span.endMs,
		position: getPastedAnnotationPosition(rest.position, rest.size),
	};
}

/**
 * Where a duplicated annotation lands: nudged 4% down-right so the copy is visible over
 * the original, then clamped to the canvas. Clamping matters for redaction — a full-frame
 * or edge blur (e.g. a freehand blur at {0,0,100,100}) must not be pushed off-canvas,
 * which would leave an unredacted strip until the user drags it back.
 */
export function getDuplicatedAnnotationPosition(
	position: AnnotationPosition,
	size: AnnotationSize,
): AnnotationPosition {
	const maxX = Math.max(0, 100 - size.width);
	const maxY = Math.max(0, 100 - size.height);
	return {
		x: clamp(position.x + 4, 0, maxX),
		y: clamp(position.y + 4, 0, maxY),
	};
}

/**
 * Duplicated annotations/blurs keep their original span and content, shift slightly on
 * the canvas, and drop auto-caption linkage so the duplicate is independently editable.
 */
export function buildDuplicatedAnnotationRegion(
	source: AnnotationRegion,
	id: string,
	zIndex: number,
): AnnotationRegion {
	const cloned = cloneAnnotationRegion(source);
	const { annotationSource: _stripCaptionLink, ...rest } = cloned;
	return {
		...rest,
		id,
		zIndex,
		position: getDuplicatedAnnotationPosition(source.position, rest.size),
	};
}
