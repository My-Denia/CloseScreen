export interface CycleSelectableRegion {
	id: string;
	startMs: number;
	endMs: number;
	zIndex: number;
}

export function getNextOverlappingRegionId({
	regions,
	selectedId,
	currentTimeMs,
	backward = false,
}: {
	regions: CycleSelectableRegion[];
	selectedId?: string | null;
	currentTimeMs: number;
	backward?: boolean;
}): string | null {
	const overlapping = regions
		.filter((region) => currentTimeMs >= region.startMs && currentTimeMs <= region.endMs)
		.sort((a, b) => a.zIndex - b.zIndex);

	if (overlapping.length === 0) return null;
	if (!selectedId || !overlapping.some((region) => region.id === selectedId)) {
		return overlapping[0].id;
	}

	const currentIndex = overlapping.findIndex((region) => region.id === selectedId);
	const nextIndex = backward
		? (currentIndex - 1 + overlapping.length) % overlapping.length
		: (currentIndex + 1) % overlapping.length;
	return overlapping[nextIndex].id;
}
