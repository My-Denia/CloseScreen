// Lightweight update check against this fork's GitHub Releases (issues #17/#27).
// Runs in the MAIN process: the packaged renderer's CSP is `connect-src 'self'`
// (appProtocol.ts), so api.github.com is only reachable from here. No auto-update —
// the renderer just gets "a newer release exists" plus its URL and shows a toast.
// Adapted from upstream openscreen PR #528, whose renderer-side fetch and
// hyphen-rejecting comparator don't fit this fork; pure logic lives in
// updateCheck.util.ts so it stays unit-testable without electron.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, ipcMain, net } from "electron";
import { isNewerVersion, pickLatestRelease, type ReleaseInfo } from "./updateCheck.util";

// The bundled main lives in dist-electron/, so the app's own package.json sits one level
// up — both unpacked (repo root) and packaged (app.asar root). Read the version from
// there instead of app.getVersion(): when Electron is launched with an explicit script
// path (dev, e2e harness) getVersion() reports ELECTRON's version (e.g. "41.2.1"), the
// same pitfall appProtocol.ts documents for app.getAppPath().
const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function appVersion(): string {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as {
			version?: unknown;
		};
		if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
	} catch {
		// Fall through to Electron's own resolution.
	}
	return app.getVersion();
}

export const GITHUB_REPO = "My-Denia/CloseScreen";
// The releases LIST, not /releases/latest: fork releases are published as prereleases,
// which /latest excludes.
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`;
const FETCH_TIMEOUT_MS = 10_000;

export type UpdateCheckResult =
	| { status: "update"; currentVersion: string; latestVersion: string; url: string }
	| { status: "upToDate"; currentVersion: string }
	| { status: "error"; currentVersion: string };

async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
	try {
		const response = await net.fetch(RELEASES_API, {
			headers: {
				Accept: "application/vnd.github+json",
				// GitHub's API requires a User-Agent; identify without any per-user data.
				"User-Agent": `CloseScreen/${appVersion()}`,
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return pickLatestRelease(await response.json());
	} catch {
		// Offline, timeout, DNS, rate limit — all degrade to "couldn't check".
		return null;
	}
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
	const currentVersion = appVersion();
	const release = await fetchLatestRelease();
	if (!release) return { status: "error", currentVersion };
	if (isNewerVersion(release.version, currentVersion)) {
		return {
			status: "update",
			currentVersion,
			latestVersion: release.version,
			url: release.htmlUrl,
		};
	}
	return { status: "upToDate", currentVersion };
}

export function registerUpdateCheckHandler(): void {
	ipcMain.handle("check-for-updates", () => checkForUpdates());
}
