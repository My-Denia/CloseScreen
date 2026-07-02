import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS, findConflict } from "./shortcuts";

describe("shortcut conflict detection", () => {
	it("reserves the timeline clipboard bindings (Ctrl+C / Ctrl+V)", () => {
		// TimelineEditor handles these keys directly (issue #29); if a configurable action
		// could claim them, the hard-coded handler would shadow it whenever an element is
		// selected / the clipboard is populated.
		expect(findConflict({ key: "c", ctrl: true }, "addZoom", DEFAULT_SHORTCUTS)).toEqual({
			type: "fixed",
			label: "Copy Selected Element",
		});
		expect(findConflict({ key: "v", ctrl: true }, "addZoom", DEFAULT_SHORTCUTS)).toEqual({
			type: "fixed",
			label: "Paste at Playhead",
		});
	});

	it("still reserves the pre-existing fixed bindings", () => {
		expect(findConflict({ key: "z", ctrl: true }, "addZoom", DEFAULT_SHORTCUTS)).toEqual({
			type: "fixed",
			label: "Undo",
		});
	});

	it("reports collisions with other configurable actions", () => {
		expect(findConflict({ key: "t" }, "addZoom", DEFAULT_SHORTCUTS)).toEqual({
			type: "configurable",
			action: "addTrim",
		});
	});

	it("allows unclaimed bindings", () => {
		expect(findConflict({ key: "g", ctrl: true }, "addZoom", DEFAULT_SHORTCUTS)).toBeNull();
	});
});
