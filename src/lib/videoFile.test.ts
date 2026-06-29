import { describe, expect, it } from "vitest";
import { isVideoFile } from "./videoFile";

describe("isVideoFile", () => {
	it("accepts known video extensions regardless of MIME type", () => {
		expect(isVideoFile({ name: "clip.mp4", type: "" })).toBe(true);
		expect(isVideoFile({ name: "Recording.MOV", type: "" })).toBe(true);
		expect(isVideoFile({ name: "capture.mkv", type: "" })).toBe(true);
	});

	it("accepts files with a video/* MIME type even without a known extension", () => {
		expect(isVideoFile({ name: "weird-name", type: "video/mp4" })).toBe(true);
	});

	it("rejects project files, images and extension-less non-video files", () => {
		expect(isVideoFile({ name: "project.closescreen", type: "" })).toBe(false);
		expect(isVideoFile({ name: "image.png", type: "image/png" })).toBe(false);
		expect(isVideoFile({ name: "noext", type: "" })).toBe(false);
	});
});
