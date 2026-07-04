import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetAppSettingsForTest,
	DEFAULT_RECORDING_RETENTION_POLICY,
	getAllowedRecordingDirs,
	getDefaultRecordingsDir,
	getRecordingRetentionPolicy,
	getRecordingStorageInfo,
	getRecordingsDir,
	initAppSettings,
	RECORDING_RETENTION_MAX_SIZE_BYTES,
	setRecordingRetentionPolicy,
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

	it("rejects a persisted junction/symlink alias of a guarded location at startup", async () => {
		// A settings file written before the realpath guard existed (or restored from
		// another machine) must not smuggle a guarded root into the read scope.
		await mkdir(homeDir, { recursive: true });
		const linkPath = path.join(userDataDir, "sneaky-persisted");
		await symlink(homeDir, linkPath, "junction");
		await writeFile(settingsPath(), JSON.stringify({ recordingsDir: linkPath }), "utf-8");

		await initFresh();
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
		expect(getAllowedRecordingDirs()).toEqual([getDefaultRecordingsDir()]);
		expect(getRecordingStorageInfo()).toMatchObject({ isCustom: false, unavailable: false });
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

	it("rejects a junction/symlink alias of a guarded location (realpath check)", async () => {
		// A directory link laundering the profile folder through an innocent-looking
		// path must not smuggle it into the auto-approved read scope.
		await mkdir(homeDir, { recursive: true });
		const linkPath = path.join(userDataDir, "innocent-looking-folder");
		await symlink(homeDir, linkPath, "junction");

		const result = await setRecordingsDir(linkPath);
		expect(result.success).toBe(false);
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
		expect(getAllowedRecordingDirs()).toEqual([getDefaultRecordingsDir()]);
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

	it("never clobbers a user's file that shares the probe name prefix", async () => {
		await mkdir(customDir, { recursive: true });
		const userFile = path.join(customDir, ".closescreen-write-probe");
		await writeFile(userFile, "user data", "utf-8");

		expect((await setRecordingsDir(customDir)).success).toBe(true);
		expect(await readFile(userFile, "utf-8")).toBe("user data");
	});

	it("keeps the old effective dir when persisting the new choice fails", async () => {
		// A directory squatting on the settings-file path makes writeFile fail, so
		// the in-memory state must roll back — otherwise the session records into a
		// folder that silently reverts on restart.
		await rm(settingsPath(), { force: true });
		await mkdir(settingsPath(), { recursive: true });

		const result = await setRecordingsDir(customDir);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/Failed to save settings/);
		expect(getRecordingsDir()).toBe(getDefaultRecordingsDir());
		expect(getRecordingStorageInfo()).toMatchObject({ isCustom: false });
		expect(getAllowedRecordingDirs()).toEqual([getDefaultRecordingsDir()]);
	});

	it("keeps the custom dir when persisting a reset fails", async () => {
		expect((await setRecordingsDir(customDir)).success).toBe(true);
		await rm(settingsPath(), { force: true });
		await mkdir(settingsPath(), { recursive: true });

		const result = await setRecordingsDir(null);
		expect(result.success).toBe(false);
		expect(getRecordingsDir()).toBe(customDir);
		expect(getAllowedRecordingDirs()).toContain(customDir);
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

describe("recording retention policy", () => {
	it("defaults to keep forever when no policy is stored", () => {
		expect(getRecordingRetentionPolicy()).toEqual(DEFAULT_RECORDING_RETENTION_POLICY);
	});

	it("falls back to keep forever for invalid persisted values", async () => {
		await writeFile(
			settingsPath(),
			JSON.stringify({
				recordingRetentionPolicy: { maxAgeDays: 3, maxSizeBytes: "not-a-size" },
			}),
			"utf-8",
		);

		await initFresh();

		expect(getRecordingRetentionPolicy()).toEqual(DEFAULT_RECORDING_RETENTION_POLICY);
	});

	it("persists a valid cleanup policy and reloads it", async () => {
		const policy = { maxAgeDays: 30, maxSizeBytes: RECORDING_RETENTION_MAX_SIZE_BYTES[1] } as const;

		const result = await setRecordingRetentionPolicy(policy);

		expect(result).toEqual({ success: true, policy });
		expect(getRecordingRetentionPolicy()).toEqual(policy);
		await initFresh();
		expect(getRecordingRetentionPolicy()).toEqual(policy);
	});

	it("preserves unknown settings keys when saving the cleanup policy", async () => {
		await writeFile(settingsPath(), JSON.stringify({ futureSetting: 42 }), "utf-8");
		await initFresh();

		await setRecordingRetentionPolicy({ maxAgeDays: 14, maxSizeBytes: null });

		const persisted = JSON.parse(await readFile(settingsPath(), "utf-8"));
		expect(persisted.futureSetting).toBe(42);
		expect(persisted.recordingRetentionPolicy).toEqual({ maxAgeDays: 14, maxSizeBytes: null });
	});

	it("rejects invalid setter values without changing the effective policy", async () => {
		const validPolicy = { maxAgeDays: 7, maxSizeBytes: null } as const;
		expect((await setRecordingRetentionPolicy(validPolicy)).success).toBe(true);

		const invalidPolicy = { maxAgeDays: 2, maxSizeBytes: null } as unknown as Parameters<
			typeof setRecordingRetentionPolicy
		>[0];
		const result = await setRecordingRetentionPolicy(invalidPolicy);

		expect(result.success).toBe(false);
		expect(getRecordingRetentionPolicy()).toEqual(validPolicy);
	});
});
