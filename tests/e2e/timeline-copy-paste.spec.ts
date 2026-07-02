// E2E for issue #29: copy/paste of timeline elements. Drives the real editor with the
// fixture video and exercises the three interesting paths in one session:
//   1. Ctrl+C copies the selected zoom ("Copied!" toast).
//   2. Ctrl+V onto the same span is rejected (zooms must not overlap) with the same
//      error toast as manual placement, and no element is added.
//   3. After deleting the zoom, Ctrl+V pastes it back at the playhead ("Pasted!").
//   4. Annotations may overlap, so copy+paste yields a second annotation in place.
//
// Timeline items don't render a per-item text label (zoom items show icon + scale), so
// items are counted via their resize handles: every timeline Item renders exactly one
// `title="Resize left"` end cap (see timeline/Item.tsx).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");

test("copies and pastes timeline elements with Ctrl+C / Ctrl+V", async () => {
	let testVideoInRecordings = "";
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			// Pin the renderer to English so the system-language prompt never appears and
			// toast/label assertions are stable regardless of the host machine's locale.
			"--lang=en-US",
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

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		const userDataDir = await app.evaluate(({ app: electronApp }) =>
			electronApp.getPath("userData"),
		);
		const recordingsDir = path.join(userDataDir, "recordings");
		testVideoInRecordings = path.join(recordingsDir, "test-copy-paste.webm");
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

		// The add-element handlers no-op while the video duration is still 0, so wait for
		// the media metadata before driving the keyboard.
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

		// One "Resize left" end cap per timeline item, regardless of variant (see timeline/Item.tsx).
		const timelineItems = editorWindow.locator('[title="Resize left"]');

		// Add a zoom at the playhead (shortcut "z"); it is created selected.
		await editorWindow.keyboard.press("z");
		await expect(timelineItems).toHaveCount(1);

		// Copy it.
		await editorWindow.keyboard.press("Control+c");
		await expect(editorWindow.getByText("Copied!")).toBeVisible();

		// Pasting onto the same span must be rejected — zooms may not overlap.
		await editorWindow.keyboard.press("Control+v");
		await expect(editorWindow.getByText("Cannot place zoom here")).toBeVisible();
		await expect(timelineItems).toHaveCount(1);

		// Delete the original, then paste the clipboard copy back at the playhead.
		await editorWindow.keyboard.press("Delete");
		await expect(timelineItems).toHaveCount(0);
		await editorWindow.keyboard.press("Control+v");
		await expect(editorWindow.getByText("Pasted!")).toBeVisible();
		await expect(timelineItems).toHaveCount(1);

		// Annotations may overlap: copy+paste in place yields a second timeline item at the
		// same span. (A span-constrained kind would have been rejected here, as proven above,
		// so the third item existing at all demonstrates the annotation overlap path.)
		await editorWindow.keyboard.press("a");
		await expect(timelineItems).toHaveCount(2);
		await editorWindow.keyboard.press("Control+c");
		await editorWindow.keyboard.press("Control+v");
		await expect(timelineItems).toHaveCount(3);
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
		}
		if (testVideoInRecordings && fs.existsSync(testVideoInRecordings)) {
			fs.unlinkSync(testVideoInRecordings);
		}
	}
});
