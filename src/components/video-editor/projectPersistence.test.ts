import { describe, expect, it } from "vitest";
import {
	createProjectData,
	createProjectSnapshot,
	hasProjectUnsavedChanges,
	normalizeProjectEditor,
	PROJECT_VERSION,
	resolveProjectMedia,
	toMediaSrc,
	validateProjectData,
} from "./projectPersistence";

describe("projectPersistence media compatibility", () => {
	it("accepts legacy projects with a single videoPath", () => {
		const project = {
			version: 1,
			videoPath: "/tmp/screen.webm",
			editor: {},
		};

		expect(validateProjectData(project)).toBe(true);
		expect(resolveProjectMedia(project)).toEqual({
			screenVideoPath: "/tmp/screen.webm",
		});
	});

	it("creates version 2 projects with explicit media", () => {
		const project = createProjectData(
			{
				screenVideoPath: "/tmp/screen.webm",
				webcamVideoPath: "/tmp/webcam.webm",
			},
			{
				wallpaper: "/wallpapers/wallpaper1.jpg",
				shadowIntensity: 0,
				showBlur: false,
				motionBlurAmount: 0,
				borderRadius: 0,
				padding: 50,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
				zoomRegions: [],
				trimRegions: [],
				speedRegions: [],
				annotationRegions: [],
				aspectRatio: "16:9",
				webcamLayoutPreset: "picture-in-picture",
				webcamMaskShape: "circle",
				webcamMirrored: true,
				webcamSizePreset: 25,
				webcamPosition: null,
				exportQuality: "good",
				exportFormat: "mp4",
				gifFrameRate: 15,
				gifLoop: true,
				gifSizePreset: "medium",
			},
		);

		expect(project.version).toBe(PROJECT_VERSION);
		expect(project.media).toEqual({
			screenVideoPath: "/tmp/screen.webm",
			webcamVideoPath: "/tmp/webcam.webm",
		});
		expect(validateProjectData(project)).toBe(true);
	});

	it("normalizes webcam mask shape values safely", () => {
		expect(normalizeProjectEditor({ webcamMaskShape: "rounded" }).webcamMaskShape).toBe("rounded");
		expect(
			normalizeProjectEditor({ webcamMaskShape: "not-a-real-shape" as never }).webcamMaskShape,
		).toBe("rectangle");
	});

	it("normalizes webcam mirroring safely", () => {
		expect(normalizeProjectEditor({ webcamMirrored: true }).webcamMirrored).toBe(true);
		expect(normalizeProjectEditor({ webcamMirrored: false }).webcamMirrored).toBe(false);
		expect(normalizeProjectEditor({ webcamMirrored: "yes" as never }).webcamMirrored).toBe(false);
	});

	it("normalizes blur region type and mosaic block size safely", () => {
		const editor = normalizeProjectEditor({
			annotationRegions: [
				{
					id: "annotation-1",
					startMs: 0,
					endMs: 500,
					type: "blur",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
					},
					zIndex: 1,
					blurData: {
						type: "mosaic",
						shape: "rectangle",
						color: "black",
						intensity: 999,
						blockSize: 999,
					},
				},
				{
					id: "annotation-2",
					startMs: 0,
					endMs: 500,
					type: "blur",
					content: "",
					position: { x: 10, y: 10 },
					size: { width: 20, height: 20 },
					style: {
						color: "#fff",
						backgroundColor: "transparent",
						fontSize: 32,
						fontFamily: "Inter",
						fontWeight: "bold",
						fontStyle: "normal",
						textDecoration: "none",
						textAlign: "center",
					},
					zIndex: 2,
					blurData: {
						type: "invalid" as never,
						shape: "rectangle",
						color: "invalid" as never,
						intensity: 10,
						blockSize: 0,
					},
				},
			],
		});

		expect(editor.annotationRegions[0].blurData?.type).toBe("mosaic");
		expect(editor.annotationRegions[0].blurData?.color).toBe("black");
		expect(editor.annotationRegions[0].blurData?.intensity).toBe(40);
		expect(editor.annotationRegions[0].blurData?.blockSize).toBe(48);
		expect(editor.annotationRegions[1].blurData?.type).toBe("mosaic");
		expect(editor.annotationRegions[1].blurData?.color).toBe("white");
		expect(editor.annotationRegions[1].blurData?.blockSize).toBe(4);
	});

	it("accepts the dual frame webcam layout preset", () => {
		expect(normalizeProjectEditor({ webcamLayoutPreset: "dual-frame" }).webcamLayoutPreset).toBe(
			"dual-frame",
		);
	});

	it("falls back from dual frame to picture in picture for portrait aspect ratios", () => {
		expect(
			normalizeProjectEditor({
				aspectRatio: "9:16",
				webcamLayoutPreset: "dual-frame",
			}).webcamLayoutPreset,
		).toBe("picture-in-picture");
	});

	it("clears webcamPosition when the normalized preset is not picture in picture", () => {
		expect(
			normalizeProjectEditor({
				webcamLayoutPreset: "dual-frame",
				webcamPosition: { cx: 0.2, cy: 0.8 },
			}).webcamPosition,
		).toBeNull();
	});
});

it("creates stable snapshots for identical project state", () => {
	const media = {
		screenVideoPath: "/tmp/screen.webm",
		webcamVideoPath: "/tmp/webcam.webm",
	};
	const editor = normalizeProjectEditor({
		wallpaper: "/wallpapers/wallpaper1.jpg",
		shadowIntensity: 0,
		showBlur: false,
		motionBlurAmount: 0,
		borderRadius: 0,
		padding: 50,
		cropRegion: { x: 0, y: 0, width: 1, height: 1 },
		zoomRegions: [],
		trimRegions: [],
		speedRegions: [],
		annotationRegions: [],
		aspectRatio: "16:9",
		webcamLayoutPreset: "picture-in-picture",
		webcamMaskShape: "circle",
		exportQuality: "good",
		exportFormat: "mp4",
		gifFrameRate: 15,
		gifLoop: true,
		gifSizePreset: "medium",
	});

	expect(createProjectSnapshot(media, editor)).toBe(createProjectSnapshot(media, editor));
});

it("detects unsaved changes from differing snapshots", () => {
	expect(hasProjectUnsavedChanges(null, null)).toBe(false);
	expect(hasProjectUnsavedChanges("same", "same")).toBe(false);
	expect(hasProjectUnsavedChanges("current", "baseline")).toBe(true);
});

describe("cursor highlight normalization (issue #26)", () => {
	it("defaults highlight regions and style for pre-#26 projects", () => {
		const normalized = normalizeProjectEditor({});
		expect(normalized.highlightRegions).toEqual([]);
		expect(normalized.cursorHighlight).toEqual({
			style: "ring",
			sizePx: 28,
			color: "#FFD700",
			opacity: 0.55,
		});
	});

	it("keeps valid highlight regions and repairs malformed ones", () => {
		const normalized = normalizeProjectEditor({
			highlightRegions: [
				{ id: "highlight-1", startMs: 100, endMs: 900 },
				{ id: "highlight-2", startMs: 500.4, endMs: Number.NaN },
				{ id: 42, startMs: 0, endMs: 100 },
				null,
			],
		} as never);
		expect(normalized.highlightRegions).toEqual([
			{ id: "highlight-1", startMs: 100, endMs: 900 },
			// NaN end falls back to start + 1000; fractional start rounds.
			{ id: "highlight-2", startMs: 500, endMs: 1500 },
		]);
	});

	it("clamps and validates the highlight style", () => {
		const normalized = normalizeProjectEditor({
			cursorHighlight: { style: "dot", sizePx: 500, color: "not-a-color", opacity: 3 },
		} as never);
		expect(normalized.cursorHighlight).toEqual({
			style: "dot",
			sizePx: 80, // clamped to CURSOR_HIGHLIGHT_SIZE_RANGE.max
			color: "#FFD700", // invalid color falls back to the default
			opacity: 1,
		});
	});

	it("round-trips highlight state through a project snapshot", () => {
		const editor = normalizeProjectEditor({
			highlightRegions: [{ id: "highlight-1", startMs: 250, endMs: 1250 }],
			cursorHighlight: { style: "dot", sizePx: 40, color: "#00FF00", opacity: 0.8 },
		} as never);
		const reparsed = JSON.parse(createProjectSnapshot(null, editor));
		expect(reparsed.editor.highlightRegions).toEqual([
			{ id: "highlight-1", startMs: 250, endMs: 1250 },
		]);
		expect(reparsed.editor.cursorHighlight).toEqual({
			style: "dot",
			sizePx: 40,
			color: "#00FF00",
			opacity: 0.8,
		});
	});
});

describe("wallpaper legacy normalization", () => {
	it("rewrites pre-fix packaged paths (resources/assets/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/closescreen/resources/assets/wallpapers/wallpaper5.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper5.jpg");
	});

	it("rewrites new packaged layout (resources/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/closescreen/resources/wallpapers/wallpaper3.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper3.jpg");
	});

	it("rewrites unpackaged dev layout (public/wallpapers/…)", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///home/user/project/public/wallpapers/wallpaper1.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
	});

	it("rewrites Windows-style file URLs with drive letter", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///C:/Users/me/closescreen/resources/wallpapers/wallpaper2.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper2.jpg");
	});

	it("leaves canonical relative paths untouched", () => {
		const normalized = normalizeProjectEditor({ wallpaper: "/wallpapers/wallpaper2.jpg" });
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper2.jpg");
	});

	it("leaves data URIs untouched", () => {
		const dataUri = "data:image/png;base64,AAA";
		expect(normalizeProjectEditor({ wallpaper: dataUri }).wallpaper).toBe(dataUri);
	});

	it("leaves colors and gradients untouched", () => {
		expect(normalizeProjectEditor({ wallpaper: "#1a1a2e" }).wallpaper).toBe("#1a1a2e");
		expect(
			normalizeProjectEditor({ wallpaper: "linear-gradient(90deg, red, blue)" }).wallpaper,
		).toBe("linear-gradient(90deg, red, blue)");
	});

	it("falls back to default for CSP-unservable image URLs (file://, http(s)://)", () => {
		// The packaged CSP (img-src 'self' data: blob:) can't load these; the app never produces
		// them, so a legacy/hand-edited value is reset to the default rather than left to render
		// blank and crash export.
		expect(
			normalizeProjectEditor({ wallpaper: "file:///home/user/Pictures/custom.jpg" }).wallpaper,
		).toBe("/wallpapers/wallpaper1.jpg");
		expect(normalizeProjectEditor({ wallpaper: "https://example.com/bg.jpg" }).wallpaper).toBe(
			"/wallpapers/wallpaper1.jpg",
		);
	});

	it("falls back to default for bundled paths outside WALLPAPER_PATHS", () => {
		const normalized = normalizeProjectEditor({
			wallpaper: "file:///opt/closescreen/resources/wallpapers/wallpaper99.jpg",
		});
		expect(normalized.wallpaper).toBe("/wallpapers/wallpaper1.jpg");
	});
});

describe("toMediaSrc", () => {
	const setProtocol = (protocol: string) => {
		const original = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...original, protocol },
		});
		return () => {
			Object.defineProperty(window, "location", { configurable: true, value: original });
		};
	};

	it("returns undefined for empty input", () => {
		expect(toMediaSrc(null)).toBeUndefined();
		expect(toMediaSrc(undefined)).toBeUndefined();
		expect(toMediaSrc("")).toBeUndefined();
	});

	it("passes file:// URLs through unchanged on non-app pages (dev)", () => {
		// jsdom default protocol is http:
		expect(toMediaSrc("file:///C:/rec/video.mp4")).toBe("file:///C:/rec/video.mp4");
	});

	it("maps file:// URLs to app://_media when the page runs on app://", () => {
		const restore = setProtocol("app:");
		try {
			expect(toMediaSrc("file:///C:/rec/my%20video.mp4")).toBe(
				`app://bundle/_media/${encodeURIComponent("C:/rec/my video.mp4")}`,
			);
		} finally {
			restore();
		}
	});

	it("maps plain paths to app://_media when the page runs on app://", () => {
		const restore = setProtocol("app:");
		try {
			expect(toMediaSrc("C:\rec\video.mp4")).toBe(
				`app://bundle/_media/${encodeURIComponent("C:\rec\video.mp4")}`,
			);
		} finally {
			restore();
		}
	});
});
