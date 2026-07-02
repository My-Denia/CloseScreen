// E2E for issue #26: time-ranged cursor highlight. Loads a project whose media declares
// an editable-overlay cursor recording (with the native bridge stubbed to supply
// synthetic cursor samples, the same pattern as windows-native-checklist.spec.ts), so
// the highlight timeline row is available; then exercises add / copy / conflict-reject /
// delete / paste for the new region kind.
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { NATIVE_BRIDGE_CHANNEL, NATIVE_BRIDGE_VERSION } from "../../src/native/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

test.describe("cursor highlight timeline row", () => {
	test.skip(process.platform !== "win32", "Editable cursor recordings are Windows-only.");

	test("adds, copies, and pastes highlight regions", async () => {
		const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-e2e-highlight-"));
		const app = await electron.launch({
			args: [
				MAIN_JS,
				"--no-sandbox",
				"--enable-unsafe-swiftshader",
				"--lang=en-US",
				`--user-data-dir=${userDataDir}`,
			],
			env: {
				...process.env,
				HEADLESS: process.env["HEADLESS"] ?? "true",
				LANG: "en_US.UTF-8",
				LC_ALL: "en_US.UTF-8",
				LANGUAGE: "en_US",
			},
		});
		const electronProcess = app.process();
		app.process().stderr?.on("data", (d) => process.stderr.write(`[electron] ${d}`));
		let testVideoInRecordings = "";

		try {
			const hudWindow = await app.firstWindow({ timeout: 60_000 });
			await hudWindow.waitForLoadState("domcontentloaded");

			const userData = await app.evaluate(({ app: electronApp }) =>
				electronApp.getPath("userData"),
			);
			const recordingsDir = path.join(userData, "recordings");
			testVideoInRecordings = path.join(recordingsDir, "highlight-sample.webm");
			fs.mkdirSync(recordingsDir, { recursive: true });
			fs.copyFileSync(TEST_VIDEO, testVideoInRecordings);

			// Project declares an editable-overlay cursor recording; the bridge stub supplies
			// synthetic samples so hasEditableCursorRecording turns true in the editor.
			const project = {
				version: 2,
				media: {
					screenVideoPath: testVideoInRecordings,
					cursorCaptureMode: "editable-overlay",
				},
				editor: {},
			};
			await app.evaluate(
				({ ipcMain }, payload) => {
					ipcMain.removeHandler(payload.nativeBridgeChannel);
					let projectLoaded = false;
					ipcMain.handle(payload.nativeBridgeChannel, (_event, request) => {
						const success = (data: unknown) => ({
							ok: true,
							data,
							meta: {
								version: payload.nativeBridgeVersion,
								requestId: request.requestId ?? "highlight-e2e",
								timestampMs: Date.now(),
							},
						});
						if (request.domain === "project" && request.action === "loadProjectFile") {
							projectLoaded = true;
							return success({ success: true, path: null, project: payload.project });
						}
						if (request.domain === "project" && request.action === "loadCurrentProjectFile") {
							return success({ success: false, canceled: true });
						}
						if (request.domain === "project" && request.action === "getCurrentVideoPath") {
							return success(
								projectLoaded ? { success: true, path: payload.videoPath } : { success: false },
							);
						}
						if (request.domain === "system" && request.action === "getPlatform") {
							return success("win32");
						}
						if (request.domain === "system" && request.action === "getAssetBasePath") {
							return success(null);
						}
						if (request.domain === "cursor" && request.action === "getRecordingData") {
							return success({
								version: 2,
								provider: "none",
								samples: [
									{ timeMs: 0, cx: 0.3, cy: 0.3 },
									{ timeMs: 1000, cx: 0.6, cy: 0.5 },
									{ timeMs: 2000, cx: 0.4, cy: 0.7 },
								],
								assets: [],
							});
						}
						if (request.domain === "cursor" && request.action === "getTelemetry") {
							return success([]);
						}
						return {
							ok: false,
							error: {
								code: "UNSUPPORTED_ACTION",
								message: `Unexpected native bridge request in test: ${request.domain}.${request.action}`,
								retryable: false,
							},
							meta: {
								version: payload.nativeBridgeVersion,
								requestId: request.requestId ?? "highlight-e2e",
								timestampMs: Date.now(),
							},
						};
					});
				},
				{
					project,
					videoPath: testVideoInRecordings,
					nativeBridgeChannel: NATIVE_BRIDGE_CHANNEL,
					nativeBridgeVersion: NATIVE_BRIDGE_VERSION,
				},
			);

			await hudWindow.getByTestId("launch-open-studio-button").click();
			const editorWindow = await app.waitForEvent("window", {
				predicate: (w) => w.url().includes("windowType=editor"),
				timeout: 15_000,
			});
			await editorWindow.waitForLoadState("domcontentloaded");
			await editorWindow.getByTestId("editor-empty-load-project-button").click();
			await expect(editorWindow.getByText("Loading video...")).not.toBeVisible({
				timeout: 20_000,
			});
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

			// The highlight row is gated on the editable cursor recording — its add button
			// only exists when the gate is open.
			await expect(editorWindow.getByTestId("timeline-add-highlight-button")).toBeVisible({
				timeout: 15_000,
			});

			const timelineItems = editorWindow.locator('[title="Resize left"]');
			await expect(timelineItems).toHaveCount(0);

			// Add via the keyboard shortcut (h), then copy / conflict-reject / delete / paste.
			await editorWindow.keyboard.press("h");
			await expect(timelineItems).toHaveCount(1);

			await editorWindow.keyboard.press("Control+c");
			await expect(editorWindow.getByText("Copied!")).toBeVisible();

			await editorWindow.keyboard.press("Control+v");
			await expect(editorWindow.getByText("Cannot place highlight here")).toBeVisible();
			await expect(timelineItems).toHaveCount(1);

			await editorWindow.keyboard.press("Delete");
			await expect(timelineItems).toHaveCount(0);
			await editorWindow.keyboard.press("Control+v");
			await expect(editorWindow.getByText("Pasted!")).toBeVisible();
			await expect(timelineItems).toHaveCount(1);
		} finally {
			await app
				.evaluate(({ app: electronApp }) => {
					electronApp.exit(0);
				})
				.catch(() => {
					// The process may already be gone.
				});
			if (electronProcess.pid) {
				if (process.platform === "win32") {
					spawnSync("taskkill", ["/PID", String(electronProcess.pid), "/T", "/F"], {
						stdio: "ignore",
					});
				} else if (!electronProcess.killed) {
					electronProcess.kill("SIGKILL");
				}
				await Promise.race([
					once(electronProcess, "close"),
					new Promise<void>((r) => setTimeout(r, 5_000)),
				]);
			}
			if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
				fs.unlinkSync(testVideoInRecordings);
			}
			try {
				fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
			} catch {
				// Best-effort: the dir lives under the OS temp root; a transient lock on a
				// Chromium cache file must not fail the test.
			}
		}
	});
});
