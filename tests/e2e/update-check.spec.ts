// E2E for the update check (issues #17/#27): stubs the main-process IPC handler and
// asserts the HUD's startup notification renders with the release version and a
// Download action. Uses a fresh user-data-dir so dismissed-version / opt-out
// localStorage from a real profile can't suppress the toast.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");

test("startup update check surfaces a dismissable notification in the HUD", async () => {
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-e2e-update-"));
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

		// Replace the real GitHub query before the HUD's delayed startup check fires;
		// reload afterwards so the 3s timer restarts strictly after the stub is in place.
		await app.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler("check-for-updates");
			ipcMain.handle("check-for-updates", () => ({
				status: "update",
				currentVersion: "1.5.0-fork.1",
				latestVersion: "9.9.9-fork.9",
				url: "https://github.com/My-Denia/CloseScreen/releases/tag/v9.9.9-fork.9",
			}));
		});
		await hudWindow.reload();
		await hudWindow.waitForLoadState("domcontentloaded");

		await expect(hudWindow.getByText("CloseScreen 9.9.9-fork.9 is available")).toBeVisible({
			timeout: 15_000,
		});
		await expect(hudWindow.getByText("You're on 1.5.0-fork.1")).toBeVisible();
		await expect(hudWindow.getByRole("button", { name: "Download" })).toBeVisible();
		await expect(hudWindow.getByRole("button", { name: "Don't remind me again" })).toBeVisible();
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
		if (fs.existsSync(userDataDir)) {
			fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}
});
