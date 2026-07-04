import { describe, expect, it } from "vitest";
import { BLUR_REGIONS_ENABLED } from "./featureFlags";

describe("video editor feature flags", () => {
	it("enables blur region entry points", () => {
		expect(BLUR_REGIONS_ENABLED).toBe(true);
	});
});
