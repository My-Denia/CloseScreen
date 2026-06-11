import { describe, expect, it, vi } from "vitest";
import { openSourceSelectorWithPermissionRetry } from "./openSourceSelectorFlow";

describe("openSourceSelectorWithPermissionRetry", () => {
	it("returns immediately when the source selector opens", async () => {
		const openSourceSelector = vi.fn().mockResolvedValue({ opened: true });

		const result = await openSourceSelectorWithPermissionRetry({
			openSourceSelector,
		});

		expect(result).toEqual({ opened: true });
		expect(openSourceSelector).toHaveBeenCalledTimes(1);
	});

	it("returns the source selector result when it does not open", async () => {
		const openSourceSelector = vi.fn().mockResolvedValue({
			opened: false,
			reason: "unavailable",
		});

		const result = await openSourceSelectorWithPermissionRetry({
			openSourceSelector,
		});

		expect(result).toEqual({
			opened: false,
			reason: "unavailable",
		});
		expect(openSourceSelector).toHaveBeenCalledTimes(1);
	});
});
