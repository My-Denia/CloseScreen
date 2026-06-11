export type OpenSourceSelectorResult = {
	opened: boolean;
	reason?: string;
};

type OpenSourceSelectorFlowOptions = {
	openSourceSelector: () => Promise<OpenSourceSelectorResult>;
};

export async function openSourceSelectorWithPermissionRetry({
	openSourceSelector,
}: OpenSourceSelectorFlowOptions): Promise<OpenSourceSelectorResult> {
	return openSourceSelector();
}
