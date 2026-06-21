import { describe, expect, it, vi } from "vitest";
import {
	clampResumeTime,
	type RefreshableTextureSource,
	refreshVideoSourceFrame,
} from "./previewFrameRestore";

describe("clampResumeTime", () => {
	it("keeps a valid time within a known duration", () => {
		expect(clampResumeTime(3.2, 10)).toBe(3.2);
	});

	it("clamps a time past the end back to the duration", () => {
		expect(clampResumeTime(99, 10)).toBe(10);
	});

	it("falls back to 0 for negative or non-finite times", () => {
		expect(clampResumeTime(-1, 10)).toBe(0);
		expect(clampResumeTime(Number.NaN, 10)).toBe(0);
		expect(clampResumeTime(Number.POSITIVE_INFINITY, 10)).toBe(0);
	});

	it("passes the time through when duration is unknown or invalid", () => {
		expect(clampResumeTime(5, undefined)).toBe(5);
		expect(clampResumeTime(5, Number.NaN)).toBe(5);
		expect(clampResumeTime(5, 0)).toBe(5);
	});
});

describe("refreshVideoSourceFrame", () => {
	it("calls update() on a live source and reports success", () => {
		const update = vi.fn();
		const source: RefreshableTextureSource = { update, destroyed: false };
		expect(refreshVideoSourceFrame(source)).toBe(true);
		expect(update).toHaveBeenCalledTimes(1);
	});

	it("is a no-op when the source is null or undefined", () => {
		expect(refreshVideoSourceFrame(null)).toBe(false);
		expect(refreshVideoSourceFrame(undefined)).toBe(false);
	});

	it("does not touch a destroyed source", () => {
		const update = vi.fn();
		const source: RefreshableTextureSource = { update, destroyed: true };
		expect(refreshVideoSourceFrame(source)).toBe(false);
		expect(update).not.toHaveBeenCalled();
	});

	it("is a no-op when the source has no update method", () => {
		expect(refreshVideoSourceFrame({} as RefreshableTextureSource)).toBe(false);
	});
});
