import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	getWindowsNativeHelperCandidates,
	parseWindowsNativeBackend,
	resolveWindowsNativeHelperPair,
	type WindowsNativeHelperResolutionContext,
	WindowsNativeHelperResolutionError,
} from "./windowsNativeHelpers";

function context(
	executables: string[],
	overrides: Partial<WindowsNativeHelperResolutionContext> = {},
): WindowsNativeHelperResolutionContext {
	const available = new Set(executables.map((candidate) => path.normalize(candidate)));
	return {
		appPath: path.join("C:", "repo"),
		arch: "x64",
		env: {},
		isExecutable: async (candidate) => available.has(path.normalize(candidate)),
		isPackaged: false,
		platform: "win32",
		resourcesPath: path.join("C:", "app", "resources"),
		...overrides,
	};
}

function candidatesFor(
	backend: "rust" | "legacy",
	overrides: Partial<WindowsNativeHelperResolutionContext> = {},
) {
	const base = context([], overrides);
	return {
		capture: getWindowsNativeHelperCandidates(base, backend, "capture"),
		cursor: getWindowsNativeHelperCandidates(base, backend, "cursor"),
	};
}

describe("Windows native helper backend selection", () => {
	it("defaults to Rust and freezes the selected pair", async () => {
		const env: NodeJS.ProcessEnv = {};
		const candidates = candidatesFor("rust", { env });
		const pair = await resolveWindowsNativeHelperPair(
			context([candidates.capture[0], candidates.cursor[0]], { env }),
		);

		expect(pair).toMatchObject({
			requestedBackend: "rust",
			effectiveIdentity: "rust",
			capture: { source: "rust" },
			cursor: { source: "rust" },
		});
		env.CLOSESCREEN_WINDOWS_CAPTURE_BACKEND = "legacy";
		expect(pair.requestedBackend).toBe("rust");
	});

	it("selects the explicit legacy backend as one pair", async () => {
		const env = { CLOSESCREEN_WINDOWS_CAPTURE_BACKEND: "legacy" };
		const candidates = candidatesFor("legacy", { env });
		const pair = await resolveWindowsNativeHelperPair(
			context([candidates.capture[0], candidates.cursor[0]], { env }),
		);

		expect(pair).toMatchObject({
			requestedBackend: "legacy",
			effectiveIdentity: "legacy",
			capture: { source: "legacy" },
			cursor: { source: "legacy" },
		});
	});

	it.each([
		"",
		" ",
		"cpp",
		"RUST",
		" rust ",
	])("rejects the invalid explicit backend %j", (value) => {
		expect(() => parseWindowsNativeBackend(value)).toThrow(WindowsNativeHelperResolutionError);
	});

	it("preserves one diagnostic override and reports a mixed identity", async () => {
		const env = { CLOSESCREEN_WGC_CAPTURE_EXE: path.join("C:", "custom", "capture.exe") };
		const candidates = candidatesFor("rust", { env });
		const pair = await resolveWindowsNativeHelperPair(
			context([env.CLOSESCREEN_WGC_CAPTURE_EXE, candidates.cursor[0]], { env }),
		);

		expect(pair).toMatchObject({
			requestedBackend: "rust",
			effectiveIdentity: "mixed",
			capture: { source: "override", path: env.CLOSESCREEN_WGC_CAPTURE_EXE },
			cursor: { source: "rust" },
		});
	});

	it("preserves both diagnostic overrides and reports a custom identity", async () => {
		const env = {
			CLOSESCREEN_WGC_CAPTURE_EXE: path.join("C:", "custom", "capture.exe"),
			CLOSESCREEN_CURSOR_SAMPLER_EXE: path.join("C:", "custom", "cursor.exe"),
		};
		const pair = await resolveWindowsNativeHelperPair(
			context([env.CLOSESCREEN_WGC_CAPTURE_EXE, env.CLOSESCREEN_CURSOR_SAMPLER_EXE], { env }),
		);

		expect(pair).toMatchObject({
			effectiveIdentity: "custom",
			capture: { source: "override" },
			cursor: { source: "override" },
		});
	});

	it("uses the packaged resources layout", async () => {
		const packaged = {
			appPath: path.join("C:", "app", "resources", "app.asar"),
			isPackaged: true,
		};
		const base = context([], packaged);
		const capture = getWindowsNativeHelperCandidates(base, "rust", "capture").at(-1);
		const cursor = getWindowsNativeHelperCandidates(base, "rust", "cursor").at(-1);
		if (!capture || !cursor) throw new Error("Expected packaged helper candidates");
		const pair = await resolveWindowsNativeHelperPair(context([capture, cursor], packaged));

		expect(pair.capture.path).toContain(path.join("resources", "electron", "native", "bin"));
		expect(pair.cursor.path).toContain(path.join("resources", "electron", "native", "bin"));
	});

	it("fails explicitly when the selected pair is incomplete", async () => {
		const candidates = candidatesFor("rust");
		await expect(
			resolveWindowsNativeHelperPair(context([candidates.capture[0]])),
		).rejects.toMatchObject({ code: "missing-helper" });
	});

	it("rejects unsupported Windows ARM64 instead of probing an absent payload", async () => {
		await expect(
			resolveWindowsNativeHelperPair(context([], { arch: "arm64" })),
		).rejects.toMatchObject({ code: "unsupported-architecture" });
	});

	it("rejects non-Windows platforms", async () => {
		await expect(
			resolveWindowsNativeHelperPair(context([], { platform: "linux" })),
		).rejects.toMatchObject({ code: "unsupported-platform" });
	});
});
