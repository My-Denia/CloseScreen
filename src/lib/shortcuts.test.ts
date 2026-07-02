import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS, findConflict, mergeWithDefaults } from "./shortcuts";

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

describe("mergeWithDefaults", () => {
	it("remaps saved bindings that now collide with a fixed shortcut back to the default", () => {
		// A config saved before Ctrl+C/V were reserved could carry them; on load the binding
		// must fall back to the action's default instead of being shadowed by the clipboard
		// handler and displayed as a duplicate claim.
		const merged = mergeWithDefaults({
			addZoom: { key: "c", ctrl: true },
			deleteSelected: { key: "v", ctrl: true },
		});
		expect(merged.addZoom).toEqual(DEFAULT_SHORTCUTS.addZoom);
		expect(merged.deleteSelected).toEqual(DEFAULT_SHORTCUTS.deleteSelected);
	});

	it("keeps legitimate saved bindings and defaults for missing actions", () => {
		const merged = mergeWithDefaults({ addZoom: { key: "g", ctrl: true } });
		expect(merged.addZoom).toEqual({ key: "g", ctrl: true });
		expect(merged.addTrim).toEqual(DEFAULT_SHORTCUTS.addTrim);
	});
});
