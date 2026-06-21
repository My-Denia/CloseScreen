import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

interface ExportHooks {
	onBeforeExport?: (editorWindow: Page) => Promise<void>;
	onAfterExport?: (editorWindow: Page) => Promise<void>;
}

async function exportFromLoadedVideo(format: "gif" | "mp4", hooks?: ExportHooks): Promise<Buffer> {
	const outputPath = path.join(os.tmpdir(), `test-${format}-export-${Date.now()}.${format}`);
	let testVideoInRecordings = "";

	const app = await electron.launch({
		args: [
			MAIN_JS,
			// Required in CI sandbox environments (GitHub Actions, Docker, etc.)
			"--no-sandbox",
			// Force software WebGL in headless CI to avoid GPU framebuffer errors.
			"--enable-unsafe-swiftshader",
		],
		env: {
			...process.env,
			// Set HEADLESS=false to show windows while debugging.
			HEADLESS: process.env["HEADLESS"] ?? "true",
		},
	});
	const electronProcess = app.process();

	app.process().stdout?.on("data", (d) => process.stdout.write(`[electron] ${d}`));
	app.process().stderr?.on("data", (d) => process.stderr.write(`[electron] ${d}`));

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		await app.evaluate(({ ipcMain }, targetPath: string) => {
			ipcMain.removeHandler("pick-export-save-path");
			ipcMain.removeHandler("write-export-to-path");
			ipcMain.handle("pick-export-save-path", () => ({
				success: true,
				path: targetPath,
				canceled: false,
			}));
			ipcMain.handle(
				"write-export-to-path",
				(_event: Electron.IpcMainInvokeEvent, buffer: ArrayBuffer, filePath: string) => {
					if (filePath !== targetPath) {
						return {
							success: false,
							error: `Unexpected export path: ${filePath}`,
						};
					}
					(globalThis as Record<string, unknown>)["__testExportData"] =
						Buffer.from(buffer).toString("base64");
					return { success: true, path: filePath };
				},
			);
		}, outputPath);

		const userDataDir = await app.evaluate(({ app: electronApp }) => {
			return electronApp.getPath("userData");
		});
		const recordingsDir = path.join(userDataDir, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "test-sample.webm");
		fs.mkdirSync(recordingsDir, { recursive: true });
		fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

		await hudWindow.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			testVideoInRecordings,
		);
		try {
			await hudWindow.evaluate(() => window.electronAPI.switchToEditor());
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!/closed|destroyed|target page|target closed/i.test(error.message)
			) {
				throw error;
			}
		}

		const editorWindow = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});

		// WebCodecs may not be registered in the renderer on first load.
		await editorWindow.reload();
		await editorWindow.waitForLoadState("domcontentloaded");
		await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({
			timeout: 15_000,
		});

		if (hooks?.onBeforeExport) {
			await hooks.onBeforeExport(editorWindow);
		}

		await editorWindow.getByTestId("testId-export-panel-button").click();
		await editorWindow.getByTestId(`testId-${format}-format-button`).click();
		await editorWindow.getByTestId("testId-export-button").click();

		await expect
			.poll(
				() =>
					app.evaluate(() => Boolean((globalThis as Record<string, unknown>)["__testExportData"])),
				{ timeout: 90_000 },
			)
			.toBe(true);

		const base64 = await app.evaluate(
			() => (globalThis as Record<string, unknown>)["__testExportData"] as string,
		);
		fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));

		expect(fs.existsSync(outputPath), `${format.toUpperCase()} not found at ${outputPath}`).toBe(
			true,
		);
		const stats = fs.statSync(outputPath);
		expect(stats.size).toBeGreaterThan(1024);

		if (hooks?.onAfterExport) {
			await hooks.onAfterExport(editorWindow);
		}

		return fs.readFileSync(outputPath);
	} finally {
		await app
			.evaluate(({ app: electronApp }) => {
				electronApp.exit(0);
			})
			.catch(() => {
				// The process may already be gone after export completes.
			});
		if (electronProcess.pid) {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(electronProcess.pid), "/T", "/F"], {
					stdio: "ignore",
				});
			} else if (!electronProcess.killed) {
				electronProcess.kill("SIGKILL");
			}
		}
		if (fs.existsSync(outputPath)) {
			fs.unlinkSync(outputPath);
		}
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
}

test("exports an MP4 from a loaded video", async () => {
	const exported = await exportFromLoadedVideo("mp4");

	expect(exported.subarray(4, 8).toString("ascii")).toBe("ftyp");
});

test("exports a GIF from a loaded video", async () => {
	const exported = await exportFromLoadedVideo("gif");

	expect(exported.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a/);
});

/**
 * Measure how much real video content a preview-canvas screenshot shows.
 * A healthy preview renders the opaque, multi-colored video sprite; a regressed
 * preview (issue #20) is blank/transparent and collapses to ~one color.
 */
function analyzePreviewShot(buffer: Buffer): { opaqueFraction: number; distinctColors: number } {
	const png = PNG.sync.read(buffer);
	const { data, width, height } = png;
	const total = width * height;
	let opaque = 0;
	const colors = new Set<number>();
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] > 16) {
			opaque += 1;
			// Quantize to ~5 bits/channel so anti-aliasing noise doesn't inflate the count.
			colors.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
		}
	}
	return { opaqueFraction: total === 0 ? 0 : opaque / total, distinctColors: colors.size };
}

test("keeps the video visible in the editor preview after exporting (issue #20)", async () => {
	const shots: { before?: Buffer; after?: Buffer } = {};

	const captureStage = async (editorWindow: Page): Promise<Buffer> => {
		const stage = editorWindow.getByTestId("testId-preview-stage").locator("canvas").first();
		await expect(stage).toBeVisible({ timeout: 15_000 });
		return stage.screenshot();
	};

	await exportFromLoadedVideo("mp4", {
		onBeforeExport: async (editorWindow) => {
			shots.before = await captureStage(editorWindow);
		},
		onAfterExport: async (editorWindow) => {
			// Allow the post-export preview restore to re-upload the frame.
			await editorWindow.waitForTimeout(500);
			shots.after = await captureStage(editorWindow);
		},
	});

	expect(shots.before, "preview screenshot before export").toBeDefined();
	expect(shots.after, "preview screenshot after export").toBeDefined();

	// Sanity: the preview showed the video before exporting.
	const before = analyzePreviewShot(shots.before as Buffer);
	expect(before.opaqueFraction).toBeGreaterThan(0.3);
	expect(before.distinctColors).toBeGreaterThan(2);

	// Regression guard for #20: the video must still be visible after exporting,
	// not collapsed to a blank/transparent canvas (only the background remaining).
	const after = analyzePreviewShot(shots.after as Buffer);
	expect(after.opaqueFraction).toBeGreaterThan(0.3);
	expect(after.distinctColors).toBeGreaterThan(2);
});
