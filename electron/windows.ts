import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, ipcMain, screen, shell } from "electron";
import { APP_ASSET_BASE_URL, APP_INDEX_URL, APP_ORIGIN } from "./appProtocol";
import { isAllowedExternalUrl } from "./ipc/externalUrl";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const HEADLESS = process.env["HEADLESS"] === "true";

// Asset base URL handed to the renderer (getAssetPath + caption worker resolve against it). Dev is
// served by Vite over http where getAssetPath uses relative paths, so this is only consulted in the
// packaged/unpacked build, where it points at the app:// resource route (same origin as the page).
const ASSET_BASE_URL_ARG = `--asset-base-url=${APP_ASSET_BASE_URL}`;

// Renderer-controllable navigation targets that stay in-app: the app:// bundle (packaged/unpacked)
// or the Vite dev server (dev). Everything else is treated as an external navigation.
function isInternalUrl(url: string): boolean {
	if (VITE_DEV_SERVER_URL && url.startsWith(VITE_DEV_SERVER_URL)) return true;
	return url.startsWith(`${APP_ORIGIN}/`) || url === APP_ORIGIN;
}

// Harden every window: block navigating the frame away from the app, and never let the renderer
// spawn new Electron windows. Web/mail links go to the OS browser via the same scheme allowlist as
// the open-external-url IPC; anything else is dropped.
function applyWindowSecurity(win: BrowserWindow): void {
	win.webContents.on("will-navigate", (event, url) => {
		if (isInternalUrl(url)) return;
		event.preventDefault();
		if (isAllowedExternalUrl(url)) {
			void shell.openExternal(url);
		}
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (isAllowedExternalUrl(url)) {
			void shell.openExternal(url);
		}
		return { action: "deny" };
	});
}

// Load a renderer window from the Vite HMR server in dev, or the app:// bundle otherwise.
function loadRendererWindow(win: BrowserWindow, windowType: string): void {
	applyWindowSecurity(win);
	const base = VITE_DEV_SERVER_URL ?? APP_INDEX_URL;
	win.loadURL(`${base}?windowType=${windowType}`);
}

let hudOverlayWindow: BrowserWindow | null = null;

ipcMain.on("hud-overlay-hide", () => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.minimize();
	}
});

ipcMain.on("hud-overlay-ignore-mouse-events", (_event, ignore: boolean) => {
	if (hudOverlayWindow && !hudOverlayWindow.isDestroyed()) {
		hudOverlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
	}
});

ipcMain.on("hud-overlay-move-by", (_event, deltaX: number, deltaY: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!Number.isFinite(deltaX) ||
		!Number.isFinite(deltaY)
	) {
		return;
	}

	const [x, y] = hudOverlayWindow.getPosition();
	hudOverlayWindow.setPosition(Math.round(x + deltaX), Math.round(y + deltaY), false);
});

// Resize the HUD to fit its rendered content. Anchored by its bottom-centre so it
// stays where the user dragged it while only growing/shrinking, which lets the
// vertical tray layout grow tall instead of scrolling inside a fixed window.
ipcMain.on("hud-overlay-set-size", (_event, width: number, height: number) => {
	if (
		!hudOverlayWindow ||
		hudOverlayWindow.isDestroyed() ||
		!Number.isFinite(width) ||
		!Number.isFinite(height)
	) {
		return;
	}

	const bounds = hudOverlayWindow.getBounds();

	// Clamp to the work area of the display the HUD sits on; on a short screen the
	// vertical layout can exceed the display, where the bar's own overflow scroll takes over.
	const { workArea } = screen.getDisplayMatching(bounds);
	const nextWidth = Math.min(workArea.width, Math.max(1, Math.round(width)));
	const nextHeight = Math.min(workArea.height, Math.max(1, Math.round(height)));

	if (bounds.width === nextWidth && bounds.height === nextHeight) {
		return;
	}

	const centerX = bounds.x + bounds.width / 2;
	const bottomY = bounds.y + bounds.height;

	hudOverlayWindow.setBounds({
		x: Math.round(centerX - nextWidth / 2),
		y: Math.round(bottomY - nextHeight),
		width: nextWidth,
		height: nextHeight,
	});
});

/**
 * Frameless transparent HUD overlay, always-on-top, centred at the bottom of the
 * primary display.
 */
export function createHudOverlayWindow(): BrowserWindow {
	const primaryDisplay = screen.getPrimaryDisplay();
	const { workArea } = primaryDisplay;

	const windowWidth = 600;
	const windowHeight = 160;

	const x = Math.floor(workArea.x + (workArea.width - windowWidth) / 2);
	const y = Math.floor(workArea.y + workArea.height - windowHeight - 5);

	const win = new BrowserWindow({
		width: windowWidth,
		height: windowHeight,
		// Min/max are intentionally loose: the renderer resizes to fit content via
		// "hud-overlay-set-size" (above), needed for the vertical tray to grow taller.
		minWidth: 120,
		minHeight: 80,
		x: x,
		y: y,
		frame: false,
		transparent: true,
		// Fully-transparent ARGB backing keeps the HUD content visually unframed.
		backgroundColor: "#00000000",
		// The HUD bar provides its own rounding and the window itself must be invisible.
		roundedCorners: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		hasShadow: false,
		show: false, // shown via ready-to-show to avoid black rectangle flash
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});
	win.setIgnoreMouseEvents(true, { forward: true });

	// Show only once painted to avoid the black rectangle flash when a transparent
	// window is shown before its first paint.
	win.once("ready-to-show", () => {
		if (!HEADLESS) win.show();
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	hudOverlayWindow = win;

	win.on("closed", () => {
		if (hudOverlayWindow === win) {
			hudOverlayWindow = null;
		}
	});

	loadRendererWindow(win, "hud-overlay");

	return win;
}

/**
 * Main editor window. Starts maximised, is not always-on-top, and appears in
 * the taskbar.
 */
export function createEditorWindow(): BrowserWindow {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		transparent: false,
		resizable: true,
		alwaysOnTop: false,
		skipTaskbar: false,
		title: "CloseScreen",
		backgroundColor: "#09090b",
		show: false, // shown via ready-to-show to avoid white flash on first load
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			// Dev only: the Vite HMR page is http://localhost while the preview video is a file://
			// URL, so canvas reads (blur/background extraction) need webSecurity off. The packaged
			// app serves everything same-origin over app://, so it keeps webSecurity ON (default).
			...(VITE_DEV_SERVER_URL ? { webSecurity: false } : {}),
			backgroundThrottling: false,
		},
	});

	win.maximize();

	// Show only once painted to avoid a white flash on cold Vite start.
	win.once("ready-to-show", () => {
		if (!HEADLESS) win.show();
	});

	// Inject dark background before any React paint so the sub-titlebar area never
	// flashes white on a cold Vite load.
	win.webContents.on("dom-ready", () => {
		win.webContents.insertCSS("html, body, #root { background: #09090b !important; }").catch(() => {
			// Best-effort cosmetic; ignore if the page is mid-teardown.
		});
	});

	win.webContents.on("did-finish-load", () => {
		win?.webContents.send("main-process-message", new Date().toLocaleString());
	});

	loadRendererWindow(win, "editor");

	return win;
}

/**
 * Floating source-selector window for picking a screen or window to record.
 * Frameless and transparent.
 */
export function createSourceSelectorWindow(): BrowserWindow {
	const { width, height } = screen.getPrimaryDisplay().workAreaSize;

	const win = new BrowserWindow({
		width: 620,
		height: 420,
		minHeight: 350,
		maxHeight: 500,
		x: Math.round((width - 620) / 2),
		y: Math.round((height - 420) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		transparent: true,
		backgroundColor: "#00000000",
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
		},
	});

	loadRendererWindow(win, "source-selector");

	return win;
}

/**
 * Centered transparent countdown overlay that sits above the HUD during
 * recording pre-roll.
 */
export function createCountdownOverlayWindow(): BrowserWindow {
	const { workArea } = screen.getPrimaryDisplay();
	const overlayWidth = 420;
	const overlayHeight = 260;

	const win = new BrowserWindow({
		width: overlayWidth,
		height: overlayHeight,
		minWidth: overlayWidth,
		maxWidth: overlayWidth,
		minHeight: overlayHeight,
		maxHeight: overlayHeight,
		x: Math.round(workArea.x + (workArea.width - overlayWidth) / 2),
		y: Math.round(workArea.y + (workArea.height - overlayHeight) / 2),
		frame: false,
		resizable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		focusable: false,
		transparent: true,
		backgroundColor: "#00000000",
		hasShadow: false,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			additionalArguments: [ASSET_BASE_URL_ARG],
			nodeIntegration: false,
			contextIsolation: true,
			backgroundThrottling: false,
		},
	});

	win.setIgnoreMouseEvents(true);

	loadRendererWindow(win, "countdown-overlay");

	return win;
}
