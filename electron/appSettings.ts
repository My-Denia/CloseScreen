import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Main-process app settings, currently just the user-configurable recordings folder
 * (issue #23: recordings hardcoded to userData/recordings fill the C: drive with no
 * recourse). Persisted as JSON in userData/app-settings.json — separate from
 * shortcuts.json, and unknown keys round-trip so future settings can share the file.
 *
 * No runtime electron import: the userData path is injected by main.ts at startup so
 * unit tests can run this module against temp directories without mocking electron
 * (same reasoning as RecordingStreamRegistry's type-only electron import).
 */

const APP_SETTINGS_FILE_NAME = "app-settings.json";
const RECORDINGS_SUBDIR = "recordings";
const WRITE_PROBE_FILE_NAME = ".closescreen-write-probe";
/**
 * Startup availability check budget. A stored dir on a disconnected network drive can
 * block fs.stat for tens of seconds; past this budget we fall back to the default dir
 * for the session rather than stall first paint. The stored value is never erased by
 * an availability failure — the drive may simply be unplugged.
 */
const STARTUP_STAT_TIMEOUT_MS = 2_000;

export interface RecordingStorageInfo {
	/** Effective directory new recordings are written to. */
	dir: string;
	defaultDir: string;
	/** True when a custom dir is stored AND currently effective. */
	isCustom: boolean;
	/** True when a custom dir is stored but failed the startup availability check. */
	unavailable: boolean;
}

interface AppSettingsState {
	userDataDir: string;
	homeDir: string;
	settingsFilePath: string;
	/** Full parsed settings object; unknown keys are preserved on save. */
	raw: Record<string, unknown>;
	/** The persisted custom recordings dir (resolved), or null when unset/invalid. */
	storedRecordingsDir: string | null;
	/** Stored dir failed the startup availability check; default is in effect. */
	recordingsDirUnavailable: boolean;
	/** Serializes concurrent set/reset calls so JSON writes never interleave. */
	writeLock: Promise<unknown>;
}

let state: AppSettingsState | null = null;

function requireState(): AppSettingsState {
	if (!state) {
		throw new Error("App settings not initialized — call initAppSettings() first");
	}
	return state;
}

/** Windows paths are case-insensitive; compare canonicalized forms. */
function canonicalize(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isFilesystemRoot(p: string): boolean {
	const resolved = path.resolve(p);
	return path.parse(resolved).root === resolved;
}

async function statWithTimeout(dir: string, timeoutMs: number): Promise<boolean> {
	try {
		const stats = await Promise.race([
			fs.stat(dir),
			new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error("stat timeout")), timeoutMs).unref?.();
			}),
		]);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

/**
 * Validate a candidate recordings dir for storage. Returns an error string or null.
 * Scope guards matter beyond UX: the effective dir joins the auto-approved media read
 * scope (getAllowedRecordingDirs), so overly broad roots must be rejected here.
 */
function validateRecordingsDirShape(dir: string, s: AppSettingsState): string | null {
	if (typeof dir !== "string" || dir.trim() === "") {
		return "Storage folder path is empty.";
	}
	if (!path.isAbsolute(dir)) {
		return "Storage folder must be an absolute path.";
	}
	const canonical = canonicalize(dir);
	if (isFilesystemRoot(dir)) {
		return "Storage folder cannot be a drive root — pick or create a subfolder.";
	}
	if (canonical === canonicalize(s.homeDir)) {
		return "Storage folder cannot be your user profile folder — pick or create a subfolder.";
	}
	if (canonical === canonicalize(s.userDataDir)) {
		return "Storage folder cannot be the app data folder itself — pick or create a subfolder.";
	}
	return null;
}

function parseStoredSettings(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch (error) {
		console.error("Failed to parse app-settings.json, using defaults:", error);
	}
	return {};
}

/**
 * Load settings and check the stored custom dir's availability. Never throws and never
 * writes: a missing/corrupt file or an unreachable custom dir degrades to the default
 * recordings dir for this session, keeping recording functional.
 */
export async function initAppSettings(options: {
	userDataDir: string;
	homeDir?: string;
}): Promise<void> {
	const userDataDir = path.resolve(options.userDataDir);
	const next: AppSettingsState = {
		userDataDir,
		homeDir: options.homeDir ?? os.homedir(),
		settingsFilePath: path.join(userDataDir, APP_SETTINGS_FILE_NAME),
		raw: {},
		storedRecordingsDir: null,
		recordingsDirUnavailable: false,
		writeLock: Promise.resolve(),
	};

	let text: string | null = null;
	try {
		text = await fs.readFile(next.settingsFilePath, "utf-8");
	} catch {
		// Missing file is the normal first-run case.
	}
	if (text !== null) {
		next.raw = parseStoredSettings(text);
	}

	const stored = next.raw.recordingsDir;
	if (typeof stored === "string" && validateRecordingsDirShape(stored, next) === null) {
		const resolved = path.resolve(stored);
		next.storedRecordingsDir = resolved;
		// Existence only — no mkdir and no write probe at startup, so a dead network
		// path can't stall launch and no probe files are dropped on every boot. Write
		// failures at record time surface through the recording error paths.
		const available = await statWithTimeout(resolved, STARTUP_STAT_TIMEOUT_MS);
		if (!available) {
			next.recordingsDirUnavailable = true;
			console.error(
				`Custom recordings folder is unavailable, falling back to default: ${resolved}`,
			);
		}
	}

	state = next;
}

export function getDefaultRecordingsDir(): string {
	return path.join(requireState().userDataDir, RECORDINGS_SUBDIR);
}

/** Effective directory for NEW recordings (and their session manifests). */
export function getRecordingsDir(): string {
	const s = requireState();
	if (s.storedRecordingsDir && !s.recordingsDirUnavailable) {
		return s.storedRecordingsDir;
	}
	return getDefaultRecordingsDir();
}

/**
 * Directories whose media files auto-approve for reading (session/project loads).
 * Always includes the default dir so recordings made before a custom dir was set keep
 * loading, plus the stored custom dir even while unavailable — if the drive comes back
 * mid-session, its sessions resolve again without a restart.
 */
export function getAllowedRecordingDirs(): string[] {
	const s = requireState();
	const dirs = [getDefaultRecordingsDir()];
	if (s.storedRecordingsDir) {
		dirs.push(s.storedRecordingsDir);
	}
	const seen = new Set<string>();
	return dirs.filter((dir) => {
		const canonical = canonicalize(dir);
		if (seen.has(canonical)) return false;
		seen.add(canonical);
		return true;
	});
}

export function getRecordingStorageInfo(): RecordingStorageInfo {
	const s = requireState();
	return {
		dir: getRecordingsDir(),
		defaultDir: getDefaultRecordingsDir(),
		isCustom: Boolean(s.storedRecordingsDir) && !s.recordingsDirUnavailable,
		unavailable: Boolean(s.storedRecordingsDir) && s.recordingsDirUnavailable,
	};
}

async function persistSettings(s: AppSettingsState): Promise<void> {
	await fs.mkdir(path.dirname(s.settingsFilePath), { recursive: true });
	await fs.writeFile(s.settingsFilePath, `${JSON.stringify(s.raw, null, 2)}\n`, "utf-8");
}

/**
 * Set (dir) or reset (null) the custom recordings folder. Full validation runs here —
 * the one moment the user just picked a folder and expects a beat: shape guards, then
 * mkdir + write/unlink probe to catch read-only and ACL-blocked targets up front.
 * Callers gate against in-progress recordings before invoking (handlers own that state).
 */
export async function setRecordingsDir(
	dir: string | null,
): Promise<{ success: boolean; error?: string }> {
	const s = requireState();
	const run = s.writeLock.then(async (): Promise<{ success: boolean; error?: string }> => {
		let resolved: string | null = null;
		if (dir !== null) {
			const shapeError = validateRecordingsDirShape(dir, s);
			if (shapeError) {
				return { success: false, error: shapeError };
			}
			resolved = path.resolve(dir);
			try {
				await fs.mkdir(resolved, { recursive: true });
				// Unique name + exclusive create: a fixed probe name could overwrite (and
				// then delete) a user's own file in a pre-existing folder.
				const probePath = path.join(resolved, `${WRITE_PROBE_FILE_NAME}-${crypto.randomUUID()}`);
				await fs.writeFile(probePath, "probe", { encoding: "utf-8", flag: "wx" });
				await fs.unlink(probePath).catch(() => undefined);
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code ?? "")
						: "";
				return {
					success: false,
					error: code ? `Folder is not writable (${code}).` : "Folder is not writable.",
				};
			}
			// The lexical checks above can be defeated by a symlink/junction alias: a
			// picked folder that LINKS to a drive root or the profile would smuggle the
			// broad target into the auto-approved read scope. Guard and store the REAL
			// path instead (realpath also normalizes 8.3 short names on Windows).
			try {
				resolved = await fs.realpath(resolved);
			} catch {
				return { success: false, error: "Folder is not accessible." };
			}
			const realShapeError = validateRecordingsDirShape(resolved, s);
			if (realShapeError) {
				return { success: false, error: realShapeError };
			}
		}

		// Mutate in-memory state only together with a successful disk write: if the
		// settings file can't be written (full/read-only userData), the session must
		// keep the old effective dir — otherwise the UI reports a folder that will
		// silently revert on restart.
		const snapshot = {
			rawRecordingsDir: s.raw.recordingsDir,
			storedRecordingsDir: s.storedRecordingsDir,
			recordingsDirUnavailable: s.recordingsDirUnavailable,
		};
		if (resolved === null) {
			delete s.raw.recordingsDir;
			s.storedRecordingsDir = null;
		} else {
			s.raw.recordingsDir = resolved;
			s.storedRecordingsDir = resolved;
		}
		s.recordingsDirUnavailable = false;
		try {
			await persistSettings(s);
		} catch (error) {
			if (snapshot.rawRecordingsDir === undefined) {
				delete s.raw.recordingsDir;
			} else {
				s.raw.recordingsDir = snapshot.rawRecordingsDir;
			}
			s.storedRecordingsDir = snapshot.storedRecordingsDir;
			s.recordingsDirUnavailable = snapshot.recordingsDirUnavailable;
			return { success: false, error: `Failed to save settings: ${String(error)}` };
		}
		return { success: true };
	});
	// Chain regardless of outcome so one failed call can't wedge the lock.
	s.writeLock = run.catch(() => undefined);
	return run;
}

/** Test-only: drop module state so each test re-initializes cleanly. */
export function __resetAppSettingsForTest(): void {
	state = null;
}
