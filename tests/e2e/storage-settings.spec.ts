// E2E for the recordings storage folder (issue #23): opens the HUD storage panel,
// changes the folder through the REAL pick pipeline (only the OS folder dialog is
// stubbed), asserts the choice persists to userData/app-settings.json, and resets.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");

test("storage panel changes and resets the recordings folder end to end", async () => {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-e2e-storage-"));
	const customDir = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-e2e-custom-")),
		"my-recordings",
	);
	const settingsFile = path.join(userDataDir, "app-settings.json");
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

	try {
		const hudWindow = await app.firstWindow({ timeout: 60_000 });
		await hudWindow.waitForLoadState("domcontentloaded");

		// Only the OS folder picker is stubbed; pick-recordings-directory, validation,
		// persistence and status refresh all run for real.
		await app.evaluate(({ dialog }, pickedDir) => {
			dialog.showOpenDialog = async () =>
				({ canceled: false, filePaths: [pickedDir] }) as Electron.OpenDialogReturnValue;
		}, customDir);

		await hudWindow.getByTestId("hud-storage-button").click();
		const panel = hudWindow.getByTestId("hud-storage-panel");
		await expect(panel).toBeVisible({ timeout: 15_000 });
		await expect(panel).toHaveAttribute("data-hud-interactive", "true");

		// Fresh profile: the default userData/recordings dir, no Reset button.
		const currentPath = hudWindow.getByTestId("storage-current-path");
		await expect(currentPath).toContainText("recordings", { timeout: 15_000 });
		await expect(hudWindow.getByTestId("storage-reset")).toHaveCount(0);
		await expect(hudWindow.getByTestId("storage-info-line")).toContainText(
			"Applies to new recordings",
		);

		// Change the folder: real validation (mkdir + write probe) and persistence.
		await hudWindow.getByTestId("storage-browse").click();
		await expect(currentPath).toContainText("my-recordings", { timeout: 15_000 });
		await expect
			.poll(() => {
				try {
					const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
					return typeof parsed.recordingsDir === "string" &&
						path.resolve(parsed.recordingsDir) === path.resolve(customDir)
						? "persisted"
						: JSON.stringify(parsed);
				} catch (error) {
					return String(error);
				}
			})
			.toBe("persisted");
		expect(fs.existsSync(customDir)).toBe(true);

		// Reset restores the default and removes the persisted key.
		await hudWindow.getByTestId("storage-reset").click();
		await expect(currentPath).toContainText("recordings");
		await expect(currentPath).not.toContainText("my-recordings");
		await expect
			.poll(() => {
				try {
					return Object.hasOwn(JSON.parse(fs.readFileSync(settingsFile, "utf-8")), "recordingsDir");
				} catch (error) {
					return String(error);
				}
			})
			.toBe(false);
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
		for (const dir of [userDataDir, path.dirname(customDir)]) {
			if (fs.existsSync(dir)) {
				fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		}
	}
});
