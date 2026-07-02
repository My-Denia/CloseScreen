// One-time carry-over of renderer settings from the old file:// origin to the new app:// origin.
//
// Before the app:// scheme (see appProtocol.ts) the packaged renderer loaded from
// file://…/dist/index.html, so localStorage — where user preferences, custom fonts and locale live
// (src/lib/userPreferences.ts, src/lib/customFonts.ts, src/contexts/I18nContext.tsx) — was keyed to
// the file:// origin. Because localStorage is origin-scoped, switching the packaged load to app://
// would strand that data and existing users would see defaults after upgrading.
//
// localStorage can't be read across origins from JS, so we do it in the main process via two hidden
// windows: read the known keys from a static page at the file:// origin, then write them into the
// app:// origin (only keys not already present there). A static probe page (public/__ls-migrate.html)
// is used instead of index.html so the SPA never boots during migration. Best-effort and guarded: a
// flag file makes it run at most once, and any failure degrades to the pre-existing "defaults on
// upgrade" behavior — it can never make things worse.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow } from "electron";
import { APP_ORIGIN } from "./appProtocol";

const PROBE_PAGE = "__ls-migrate.html";
const MIGRATION_KEYS = [
	"closescreen_user_preferences",
	"closescreen_custom_fonts",
	"closescreen_locale",
	"closescreen_system_language_prompt_seen",
];

// Hard cap so the migration can NEVER block app startup, even if a hidden window's load hangs.
const MIGRATION_TIMEOUT_MS = 8_000;

// True only while the transient probe windows are open. The window-all-closed handler consults this
// so destroying a probe window (before the real window exists) can't trigger app.quit().
let migrationRunning = false;
export function isLocalStorageMigrationRunning(): boolean {
	return migrationRunning;
}

function flagPath(): string {
	return path.join(app.getPath("userData"), ".origin-localstorage-migrated");
}

// Chromium writes localStorage under <userData>/Local Storage/. Its absence means there is no prior
// install to migrate from (fresh install, or a test's throwaway user-data-dir) — so we skip entirely
// and never open a probe window, avoiding any startup window-ordering side effects.
function hasPriorLocalStorage(): boolean {
	try {
		return fs.existsSync(path.join(app.getPath("userData"), "Local Storage"));
	} catch {
		return false;
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error("migration timeout")), ms)),
	]);
}

async function withHiddenWindow<T>(
	url: string,
	fn: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
	const win = new BrowserWindow({
		show: false,
		webPreferences: { nodeIntegration: false, contextIsolation: true },
	});
	try {
		await win.loadURL(url);
		return await fn(win);
	} finally {
		if (!win.isDestroyed()) win.destroy();
	}
}

async function readKeys(win: BrowserWindow): Promise<Record<string, string>> {
	return win.webContents.executeJavaScript(
		`(() => { const o = {}; for (const k of ${JSON.stringify(MIGRATION_KEYS)}) {` +
			` try { const v = localStorage.getItem(k); if (v !== null) o[k] = v; } catch {} } return o; })()`,
	);
}

async function writeKeys(win: BrowserWindow, data: Record<string, string>): Promise<void> {
	await win.webContents.executeJavaScript(
		`(() => { const d = ${JSON.stringify(data)};` +
			` for (const k of Object.keys(d)) { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, d[k]); } catch {} } })()`,
	);
}

/**
 * Migrate legacy file://-origin localStorage into the app:// origin. No-op in dev (Vite http origin),
 * when already run, or when there is nothing to carry over. `rendererDist` is the dist directory
 * whose index.html the old build served over file://.
 */
export async function migrateLegacyLocalStorage(rendererDist: string): Promise<void> {
	if (process.env.VITE_DEV_SERVER_URL) return;
	try {
		if (fs.existsSync(flagPath())) return;
	} catch {
		return;
	}
	// No prior localStorage on disk ⇒ nothing to migrate; skip without opening any window.
	if (!hasPriorLocalStorage()) {
		try {
			fs.writeFileSync(flagPath(), "no-prior-store");
		} catch {
			// Flag is an optimization; a failed write just means we re-check next launch.
		}
		return;
	}

	let outcome = "nodata";
	migrationRunning = true;
	try {
		await withTimeout(
			(async () => {
				const probe = path.join(rendererDist, PROBE_PAGE);
				if (!fs.existsSync(probe)) return;
				const legacy = await withHiddenWindow(pathToFileURL(probe).toString(), readKeys).catch(
					() => ({}) as Record<string, string>,
				);
				if (Object.keys(legacy).length > 0) {
					await withHiddenWindow(`${APP_ORIGIN}/${PROBE_PAGE}`, (win) => writeKeys(win, legacy));
					outcome = "migrated";
				}
			})(),
			MIGRATION_TIMEOUT_MS,
		);
	} catch {
		// Best-effort (incl. timeout): fall through and mark done so we don't retry / block startup.
	} finally {
		migrationRunning = false;
	}

	try {
		fs.writeFileSync(flagPath(), outcome);
	} catch {
		// If we can't persist the flag, a future run just retries — still harmless.
	}
}
