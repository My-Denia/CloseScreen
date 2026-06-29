import { describe, expect, it } from "vitest";
import { basename } from "./pathBasename";

describe("basename", () => {
	it("returns the final segment of a POSIX path", () => {
		expect(basename("/home/user/Videos/clip.mp4")).toBe("clip.mp4");
	});

	it("returns the final segment of a Windows path", () => {
		expect(basename("C:\\Users\\me\\Videos\\clip.mp4")).toBe("clip.mp4");
	});

	it("handles mixed separators", () => {
		expect(basename("C:/Users/me\\Videos\\clip.gif")).toBe("clip.gif");
	});

	it("returns the input unchanged when there is no separator", () => {
		expect(basename("clip.mp4")).toBe("clip.mp4");
	});
});
