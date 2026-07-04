import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ElectronApplication,
	_electron as electron,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");
const EXPORT_DIR = path.join(ROOT, "goal-runs", "enable-blur", "exports");
const BLUR_DELTA_THRESHOLD = 12;
const CONTROL_DELTA_THRESHOLD = 8;

test.setTimeout(360_000);

async function loadFixtureInEditor(app: ElectronApplication) {
	const hudWindow = await app.firstWindow({ timeout: 60_000 });
	await hudWindow.waitForLoadState("domcontentloaded");

	const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
	const recordingsDir = path.join(userDataDir, "recordings");
	const testVideoInRecordings = path.join(recordingsDir, "blur-redaction-sample.webm");
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
	await editorWindow.reload();
	await editorWindow.waitForLoadState("domcontentloaded");
	await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({ timeout: 15_000 });
	await expect
		.poll(
			() =>
				editorWindow.evaluate(() => {
					const video = document.querySelector("video");
					return video && Number.isFinite(video.duration) ? video.duration : 0;
				}),
			{ timeout: 15_000 },
		)
		.toBeGreaterThan(0);

	return { editorWindow, testVideoInRecordings };
}

async function installExportHooks(app: ElectronApplication, targetPath: string) {
	await app.evaluate(({ ipcMain }, exportTargetPath: string) => {
		ipcMain.removeHandler("pick-export-save-path");
		ipcMain.removeHandler("write-export-to-path");
		ipcMain.handle("pick-export-save-path", () => ({
			success: true,
			path: exportTargetPath,
			canceled: false,
		}));
		ipcMain.handle(
			"write-export-to-path",
			(_event: Electron.IpcMainInvokeEvent, buffer: ArrayBuffer, filePath: string) => {
				if (filePath !== exportTargetPath) {
					return {
						success: false,
						error: `Unexpected export path: ${filePath}`,
					};
				}
				(globalThis as Record<string, unknown>)["__blurExportData"] =
					Buffer.from(buffer).toString("base64");
				return { success: true, path: filePath };
			},
		);
	}, targetPath);
}

async function exportFormat(
	app: ElectronApplication,
	editorWindow: Page,
	format: "mp4" | "gif",
	outputPath: string,
) {
	await installExportHooks(app, outputPath);
	await app.evaluate(() => {
		delete (globalThis as Record<string, unknown>)["__blurExportData"];
	});

	await editorWindow.getByTestId("testId-export-panel-button").click();
	await editorWindow.getByTestId(`testId-${format}-format-button`).click();
	await editorWindow.getByTestId("testId-export-button").click();

	await expect
		.poll(
			() =>
				app.evaluate(() => Boolean((globalThis as Record<string, unknown>)["__blurExportData"])),
			{ timeout: 120_000 },
		)
		.toBe(true);

	const base64 = await app.evaluate(
		() => (globalThis as Record<string, unknown>)["__blurExportData"] as string,
	);
	fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
	const stats = fs.statSync(outputPath);
	expect(stats.size, `${format.toUpperCase()} export should not be empty`).toBeGreaterThan(1024);
}

function keepArtifact(sourcePath: string, artifactPath: string) {
	fs.copyFileSync(sourcePath, artifactPath);
}

function extractFrame(inputPath: string, outputPath: string) {
	const result = spawnSync(
		"ffmpeg",
		["-y", "-ss", "0.5", "-i", inputPath, "-frames:v", "1", outputPath],
		{ encoding: "utf8" },
	);
	expect(result.status, `ffmpeg failed for ${inputPath}: ${result.stderr}`).toBe(0);
	expect(fs.existsSync(outputPath), `missing extracted frame ${outputPath}`).toBe(true);
	return PNG.sync.read(fs.readFileSync(outputPath));
}

function sampleDelta(
	baseline: PNG,
	blurred: PNG,
	rect: { x: number; y: number; width: number; height: number },
) {
	expect(blurred.width).toBe(baseline.width);
	expect(blurred.height).toBe(baseline.height);

	let total = 0;
	let count = 0;
	for (let y = rect.y; y < rect.y + rect.height; y++) {
		for (let x = rect.x; x < rect.x + rect.width; x++) {
			const offset = (y * baseline.width + x) * 4;
			total += Math.abs(baseline.data[offset] - blurred.data[offset]);
			total += Math.abs(baseline.data[offset + 1] - blurred.data[offset + 1]);
			total += Math.abs(baseline.data[offset + 2] - blurred.data[offset + 2]);
			count += 3;
		}
	}
	return total / count;
}

function rectFromPercent(png: PNG, x: number, y: number, width: number, height: number) {
	return {
		x: Math.round(png.width * x),
		y: Math.round(png.height * y),
		width: Math.max(4, Math.round(png.width * width)),
		height: Math.max(4, Math.round(png.height * height)),
	};
}

function assertBlurredExport(format: "mp4" | "gif", baselinePath: string, blurredPath: string) {
	const blurredBytes = fs.readFileSync(blurredPath);
	if (format === "mp4") {
		expect(blurredBytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
	} else {
		expect(blurredBytes.subarray(0, 6).toString("ascii")).toMatch(/^GIF8[79]a/);
	}

	const baselineFrame = extractFrame(
		baselinePath,
		path.join(EXPORT_DIR, `baseline-${format}-frame.png`),
	);
	const blurredFrame = extractFrame(
		blurredPath,
		path.join(EXPORT_DIR, `blurred-${format}-frame.png`),
	);
	const blurRect = rectFromPercent(blurredFrame, 0.6, 0.58, 0.08, 0.08);
	const controlRect = rectFromPercent(blurredFrame, 0.08, 0.08, 0.08, 0.08);

	const blurDelta = sampleDelta(baselineFrame, blurredFrame, blurRect);
	const controlDelta = sampleDelta(baselineFrame, blurredFrame, controlRect);

	expect(blurDelta, `${format} blur-region delta`).toBeGreaterThanOrEqual(BLUR_DELTA_THRESHOLD);
	expect(controlDelta, `${format} control-region delta`).toBeLessThanOrEqual(
		CONTROL_DELTA_THRESHOLD,
	);
}

test("enables blur UI, cycles overlapping blurs, duplicates, and exports blurred MP4/GIF in the built app", async () => {
	fs.mkdirSync(EXPORT_DIR, { recursive: true });
	const stamp = Date.now();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-blur-e2e-"));
	const tempPaths = {
		baselineMp4: path.join(tempDir, `baseline-${stamp}.mp4`),
		baselineGif: path.join(tempDir, `baseline-${stamp}.gif`),
		blurredMp4: path.join(tempDir, `blurred-${stamp}.mp4`),
		blurredGif: path.join(tempDir, `blurred-${stamp}.gif`),
	};
	const artifactPaths = {
		baselineMp4: path.join(EXPORT_DIR, `baseline-${stamp}.mp4`),
		baselineGif: path.join(EXPORT_DIR, `baseline-${stamp}.gif`),
		blurredMp4: path.join(EXPORT_DIR, `blurred-${stamp}.mp4`),
		blurredGif: path.join(EXPORT_DIR, `blurred-${stamp}.gif`),
	};

	const app = await electron.launch({
		args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader", "--lang=en-US"],
		env: {
			...process.env,
			HEADLESS: "false",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
		},
	});
	const electronProcess = app.process();
	app.process().stdout?.on("data", (d) => process.stdout.write(`[electron] ${d}`));
	app.process().stderr?.on("data", (d) => process.stderr.write(`[electron] ${d}`));

	let testVideoInRecordings = "";
	try {
		const loaded = await loadFixtureInEditor(app);
		const editorWindow = loaded.editorWindow;
		testVideoInRecordings = loaded.testVideoInRecordings;
		editorWindow.on("console", (message) => {
			console.log(`[renderer:${message.type()}] ${message.text()}`);
		});
		editorWindow.on("pageerror", (error) => {
			console.error(`[renderer:pageerror] ${error.message}`);
		});

		await expect(editorWindow.locator('[data-timeline-row-id="row-blur"]')).toBeVisible();
		await expect(editorWindow.getByTestId("timeline-add-blur-button")).toBeVisible();

		await exportFormat(app, editorWindow, "mp4", tempPaths.baselineMp4);
		keepArtifact(tempPaths.baselineMp4, artifactPaths.baselineMp4);
		await exportFormat(app, editorWindow, "gif", tempPaths.baselineGif);
		keepArtifact(tempPaths.baselineGif, artifactPaths.baselineGif);

		await editorWindow.getByTestId("keyboard-shortcuts-help").hover();
		await expect(editorWindow.getByText("Add Blur").first()).toBeVisible();
		await editorWindow.getByTestId("keyboard-shortcuts-config-button").click();
		await expect(editorWindow.getByTestId("shortcut-action-addBlur")).toContainText("Add Blur");
		await editorWindow.keyboard.press("Escape");

		const blurItems = editorWindow.locator('[data-timeline-item-variant="blur"]');
		await editorWindow.getByTestId("timeline-add-blur-button").click();
		await expect(blurItems).toHaveCount(1);
		await expect(editorWindow.getByTestId("blur-settings-panel")).toBeVisible();

		await editorWindow.keyboard.press("b");
		await expect(blurItems).toHaveCount(2);

		await editorWindow.keyboard.press("Tab");
		await expect(
			editorWindow.locator('[data-timeline-item-variant="blur"][data-selected="true"]'),
		).toContainText("Blur 1");
		await editorWindow.keyboard.press("Shift+Tab");
		await expect(
			editorWindow.locator('[data-timeline-item-variant="blur"][data-selected="true"]'),
		).toContainText("Blur 2");
		await editorWindow.keyboard.press("Tab");
		await expect(
			editorWindow.locator('[data-timeline-item-variant="blur"][data-selected="true"]'),
		).toContainText("Blur 1");

		await editorWindow.getByTestId("blur-duplicate-button").click();
		await expect(blurItems).toHaveCount(3);
		await expect(
			editorWindow.locator('[data-timeline-item-variant="blur"][data-selected="true"]'),
		).toContainText("Blur 3");
		await editorWindow.getByTestId("timeline-editor-surface").click({ position: { x: 8, y: 8 } });
		await expect(editorWindow.getByTestId("testId-export-panel-button")).toBeVisible();

		await exportFormat(app, editorWindow, "mp4", tempPaths.blurredMp4);
		keepArtifact(tempPaths.blurredMp4, artifactPaths.blurredMp4);
		await exportFormat(app, editorWindow, "gif", tempPaths.blurredGif);
		keepArtifact(tempPaths.blurredGif, artifactPaths.blurredGif);

		assertBlurredExport("mp4", artifactPaths.baselineMp4, artifactPaths.blurredMp4);
		assertBlurredExport("gif", artifactPaths.baselineGif, artifactPaths.blurredGif);
	} finally {
		await app
			.evaluate(({ app: electronApp }) => {
				electronApp.exit(0);
			})
			.catch(() => undefined);
		if (electronProcess.pid) {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(electronProcess.pid), "/T", "/F"], {
					stdio: "ignore",
				});
			} else if (!electronProcess.killed) {
				electronProcess.kill("SIGKILL");
			}
		}
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
});
