import os from "node:os";
import { describe, expect, it } from "vitest";
import { getFreeBytes, isLowDiskSpace, LOW_DISK_THRESHOLD_BYTES } from "./diskSpace";

describe("getFreeBytes", () => {
	it("returns a non-negative number for an existing directory", async () => {
		const free = await getFreeBytes(os.tmpdir());
		expect(free).not.toBeNull();
		expect(free).toBeGreaterThanOrEqual(0);
	});

	it("returns null instead of throwing for a missing directory", async () => {
		const free = await getFreeBytes(`${os.tmpdir()}/closescreen-definitely-missing-${Date.now()}`);
		expect(free).toBeNull();
	});
});

describe("isLowDiskSpace", () => {
	it("is low strictly below the threshold", () => {
		expect(isLowDiskSpace(LOW_DISK_THRESHOLD_BYTES - 1)).toBe(true);
		expect(isLowDiskSpace(LOW_DISK_THRESHOLD_BYTES)).toBe(false);
	});

	it("treats an unknown probe (null) as not-low, never blocking recording", () => {
		expect(isLowDiskSpace(null)).toBe(false);
	});
});
