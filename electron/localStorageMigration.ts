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
// Must match the exact localStorage keys the renderer writes — note the i18n keys are hyphenated
// while the others use underscores. A mismatch silently strands that setting (readKeys finds
// nothing, then we flag done), so these are pinned to their source-of-truth modules:
const MIGRATION_KEYS = [
	"closescreen_user_preferences", // src/lib/userPreferences.ts (PREFS_KEY)
	"closescreen_custom_fonts", // src/lib/customFonts.ts (STORAGE_KEY)
	"closescreen-locale", // src/i18n/config.ts (LOCALE_STORAGE_KEY)
	"closescreen-system-language-prompt-seen", // src/contexts/I18nContext.tsx
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

// Every hidden probe window we've opened. withHiddenWindow's own finally closes a window on the
// happy path, but if loadURL() truly hangs that finally never runs and the window leaks — and a
// leaked hidden window keeps the app alive (it still counts toward window-all-closed). So the
// migration cleanup force-closes anything left here when it finishes OR when the timeout fires.
const openProbeWindows = new Set<BrowserWindow>();

function destroyAllProbeWindows(): void {
	for (const win of openProbeWindows) {
		if (!win.isDestroyed()) win.destroy();
	}
	openProbeWindows.clear();
}

async function withHiddenWindow<T>(
	url: string,
	fn: (win: BrowserWindow) => Promise<T>,
): Promise<T> {
	const win = new BrowserWindow({
		show: false,
		webPreferences: { nodeIntegration: false, contextIsolation: true },
	});
	openProbeWindows.add(win);
	try {
		await win.loadURL(url);
		return await fn(win);
	} finally {
		openProbeWindows.delete(win);
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
	const work = (async () => {
		const probe = path.join(rendererDist, PROBE_PAGE);
		if (!fs.existsSync(probe)) return;
		const legacy = await withHiddenWindow(pathToFileURL(probe).toString(), readKeys).catch(
			() => ({}) as Record<string, string>,
		);
		if (Object.keys(legacy).length > 0) {
			await withHiddenWindow(`${APP_ORIGIN}/${PROBE_PAGE}`, (win) => writeKeys(win, legacy));
			outcome = "migrated";
		}
	})();
	// If the timeout wins the race, `work` keeps running and may reject later (e.g. when cleanup
	// destroys the window it was awaiting). Swallow that so it never becomes an unhandled rejection.
	work.catch(() => undefined);
	try {
		await withTimeout(work, MIGRATION_TIMEOUT_MS);
	} catch {
		// Best-effort (incl. timeout): fall through and mark done so we don't retry / block startup.
	} finally {
		// A timed-out/hung load leaves its hidden window open; force-close everything we opened. This
		// runs while migrationRunning is still true, so the window-all-closed guard suppresses these
		// probe-window closes (a probe closing is never "the user finishing").
		destroyAllProbeWindows();
		migrationRunning = false;
		// If the user closed the last *real* window while migration was running, that window-all-closed
		// was suppressed and nothing will re-fire it. Now that we've stopped suppressing, honor the
		// same "closing the last window quits" policy (mirrors main.ts's window-all-closed handler).
		if (BrowserWindow.getAllWindows().length === 0) app.quit();
	}

	try {
		fs.writeFileSync(flagPath(), outcome);
	} catch {
		// If we can't persist the flag, a future run just retries — still harmless.
	}
}
