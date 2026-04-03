export const FRAME_DURATION_SEC = 1 / 60;

export function computeFrameStepTime(
	currentTime: number,
	duration: number,
	direction: "forward" | "backward",
): number {
	const delta = direction === "forward" ? FRAME_DURATION_SEC : -FRAME_DURATION_SEC;
	return Math.min(duration, Math.max(0, currentTime + delta));
}
