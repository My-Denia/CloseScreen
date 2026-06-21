/**
 * Helpers for restoring the editor preview after an export.
 *
 * The preview renders the recording as a PixiJS sprite backed by a
 * {@link https://pixijs.download/release/docs/rendering.VideoSource.html VideoSource}
 * over a paused, hidden `<video>` element. While that source is paused, PixiJS
 * halts the texture's auto-update loop (it only re-uploads on play / seek /
 * an explicit `update()`), so the sprite just keeps showing the last frame it
 * uploaded to the GPU. After a long export the preview can be left showing a
 * stale or blank frame while only the (separately rendered, CSS) background
 * remains visible. These helpers let the editor seek the preview back to the
 * pre-export playhead and force the VideoSource to re-upload the current frame.
 */

/** Minimal shape of a PixiJS `TextureSource` we need to refresh a frame. */
export interface RefreshableTextureSource {
	destroyed?: boolean;
	update?: () => void;
}

/**
 * Clamp a saved playhead time to a valid position for the given duration.
 * Falls back to 0 for non-finite / negative inputs, and never exceeds a known
 * finite duration.
 */
export function clampResumeTime(time: number, duration: number | undefined): number {
	if (!Number.isFinite(time) || time < 0) {
		return 0;
	}
	if (
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration > 0 &&
		time > duration
	) {
		return duration;
	}
	return time;
}

/**
 * Force a PixiJS VideoSource to re-upload its current video frame.
 *
 * Uses the public `TextureSource.update()` API, which marks the source dirty so
 * the GL/GPU uploader re-reads the live `<video>` frame on the next render. This
 * recovers a paused preview whose texture was left stale after an export. Safe
 * to call when there is no source or it has been destroyed.
 *
 * @returns true if a refresh was requested, false if it was a no-op.
 */
export function refreshVideoSourceFrame(
	source: RefreshableTextureSource | null | undefined,
): boolean {
	if (!source || source.destroyed) {
		return false;
	}
	if (typeof source.update === "function") {
		source.update();
		return true;
	}
	return false;
}
