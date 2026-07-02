import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetAppSettingsForTest,
	getAllowedRecordingDirs,
	getDefaultRecordingsDir,
	getRecordingStorageInfo,
	getRecordingsDir,
	initAppSettings,
	setRecordingsDir,
} from "./appSettings";

// Real temp directories instead of an electron mock: the module takes the userData
// path via initAppSettings, so tests exercise the actual fs read/write/validate code.
let userDataDir: string;
let customDir: string;
let homeDir: string;

const settingsPath = () => path.join(userDataDir, "app-settings.json");

async function initFresh() {
	__resetAppSettingsForTest();
	await initAppSettings({ userDataDir, homeDir });
}

beforeEach(async () => {
	const base = await mkdtemp(path.join(os.tmpdir(), "closescreen-settings-"));
	userDataDir = path.join(base, "userData");
	customDir = path.join(base, "custom-recordings");
	homeDir = path.join(base, "home");
	await mkdir(userDataDir, { recursive: true });
	await initFresh();
});

afterEach(async () => {
	__resetAppSettingsForTest();
	await rm(path.dirname(userDataDir), { recursive: true, force: true });
});

describe("initAppSettings", () => {
	it("defaults to userData/recordings when no settings file exists", () => {
		expect(getRecordingsDir()).toBe(path.join(userDataDir, "recordings"));
		expect(getRecordingStorageInfo()).toMatchObject({ isCustom: false, unavailable: false });
	});

	it("treats invalid JSON as empty settings instead of crashing", async () => {
		await writeFile(settingsPath(), "{not json", "utf-8");
		await initFresh();
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
	});

	it("ignores a non-string or relative stored recordingsDir", async () => {
		await writeFile(settingsPath(), JSON.stringify({ recordingsDir: "relative/dir" }), "utf-8");
		await initFresh();
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
	});

	it("falls back to default when the stored dir has vanished, without erasing it", async () => {
		await writeFile(settingsPath(), JSON.stringify({ recordingsDir: customDir }), "utf-8");
		await initFresh(); // customDir was never created on disk
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
		expect(getRecordingStorageInfo()).toMatchObject({ isCustom: false, unavailable: true });
		// The stored value survives on disk — the drive may just be unplugged.
		const persisted = JSON.parse(await readFile(settingsPath(), "utf-8"));
		expect(persisted.recordingsDir).toBe(customDir);
		// And it stays in the read-approval scope for when it comes back.
		expect(getAllowedRecordingDirs()).toContain(customDir);
	});
});

describe("setRecordingsDir", () => {
	it("persists a valid custom dir and makes it effective after reload", async () => {
		const result = await setRecordingsDir(customDir);
		expect(result).toEqual({ success: true });
		expect(getRecordingsDir()).toBe(customDir);
		expect(getRecordingStorageInfo()).toMatchObject({ isCustom: true, unavailable: false });

		await initFresh();
		expect(getRecordingsDir()).toBe(customDir);
	});

	it("reset (null) removes the key and restores the default", async () => {
		await setRecordingsDir(customDir);
		const result = await setRecordingsDir(null);
		expect(result).toEqual({ success: true });
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
		const persisted = JSON.parse(await readFile(settingsPath(), "utf-8"));
		expect(persisted).not.toHaveProperty("recordingsDir");
	});

	it("preserves unknown settings keys across writes", async () => {
		await writeFile(settingsPath(), JSON.stringify({ futureSetting: 42 }), "utf-8");
		await initFresh();
		await setRecordingsDir(customDir);
		const persisted = JSON.parse(await readFile(settingsPath(), "utf-8"));
		expect(persisted.futureSetting).toBe(42);
		expect(persisted.recordingsDir).toBe(customDir);
	});

	it("rejects relative paths", async () => {
		const result = await setRecordingsDir("relative/dir");
		expect(result.success).toBe(false);
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
	});

	it("rejects drive/filesystem roots", async () => {
		const root = path.parse(path.resolve(userDataDir)).root;
		const result = await setRecordingsDir(root);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/drive root/i);
	});

	it("rejects the user profile folder and the app data folder themselves", async () => {
		expect((await setRecordingsDir(homeDir)).success).toBe(false);
		expect((await setRecordingsDir(userDataDir)).success).toBe(false);
	});

	it("rejects a target that cannot be created", async () => {
		// A file where a parent directory must go makes mkdir fail (ENOTDIR/EEXIST).
		const blockerFile = path.join(userDataDir, "blocker");
		await writeFile(blockerFile, "x", "utf-8");
		const result = await setRecordingsDir(path.join(blockerFile, "sub"));
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not writable/i);
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
	});
});

describe("getAllowedRecordingDirs", () => {
	it("always includes the default dir, plus the custom dir, deduped", async () => {
		expect(getAllowedRecordingDirs()).toEqual([getDefaultRecordingsDir()]);
		await setRecordingsDir(customDir);
		expect(getAllowedRecordingDirs()).toEqual([getDefaultRecordingsDir(), customDir]);
		// Selecting the default explicitly must not double it up.
		await setRecordingsDir(getDefaultRecordingsDir());
		expect(getAllowedRecordingDirs()).toEqual([getDefaultRecordingsDir()]);
	});
});
