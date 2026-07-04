import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecordingRetentionPolicy } from "./appSettings";
import {
	cleanupRecordingsWithLock,
	createRecordingRetentionPlan,
	executeRecordingCleanupPlan,
	RECORDING_SESSION_SUFFIX,
} from "./recordingRetention";

const now = Date.UTC(2026, 0, 15);
const dayMs = 24 * 60 * 60 * 1000;
const keepForever: RecordingRetentionPolicy = { maxAgeDays: null, maxSizeBytes: null };
const keepSevenDays: RecordingRetentionPolicy = { maxAgeDays: 7, maxSizeBytes: null };
const keepFiveGb: RecordingRetentionPolicy = { maxAgeDays: null, maxSizeBytes: 5_368_709_120 };

let rootDir: string;
let recordingsDir: string;

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function writeSession(options: {
	name: string;
	createdAt: number;
	webcam?: boolean;
	webcamExtension?: ".mp4" | ".webm";
	cursor?: boolean;
	screenBytes?: number;
}): Promise<{
	manifestPath: string;
	screenPath: string;
	webcamPath?: string;
	cursorPath?: string;
	createdAt: number;
}> {
	const screenExtension = path.parse(options.name).ext === ".mp4" ? ".mp4" : ".webm";
	const screenName = `recording-${options.createdAt}${screenExtension}`;
	const screenPath = path.join(recordingsDir, screenName);
	await writeFile(screenPath, "screen", "utf-8");
	if (options.screenBytes !== undefined) {
		await truncate(screenPath, options.screenBytes);
	}

	let webcamPath: string | undefined;
	if (options.webcam) {
		webcamPath = path.join(
			recordingsDir,
			`${path.parse(screenName).name}-webcam${options.webcamExtension ?? ".webm"}`,
		);
		await writeFile(webcamPath, "webcam", "utf-8");
	}

	let cursorPath: string | undefined;
	if (options.cursor) {
		cursorPath = `${screenPath}.cursor.json`;
		await writeFile(
			cursorPath,
			JSON.stringify({
				recordingId: options.createdAt,
				version: 2,
				provider: "native",
				samples: [{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true }],
				assets: [],
			}),
			"utf-8",
		);
	}

	const manifestPath = path.join(
		recordingsDir,
		`${path.parse(screenName).name}${RECORDING_SESSION_SUFFIX}`,
	);
	await writeFile(
		manifestPath,
		JSON.stringify({
			screenVideoPath: screenPath,
			...(webcamPath ? { webcamVideoPath: webcamPath } : {}),
			createdAt: options.createdAt,
		}),
		"utf-8",
	);
	return { manifestPath, screenPath, webcamPath, cursorPath, createdAt: options.createdAt };
}

beforeEach(async () => {
	rootDir = await mkdtemp(path.join(os.tmpdir(), "closescreen-retention-"));
	recordingsDir = path.join(rootDir, "recordings");
	await mkdir(recordingsDir, { recursive: true });
});

afterEach(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

describe("createRecordingRetentionPlan", () => {
	it("handles a missing recordings directory as an empty plan", async () => {
		const missingDir = path.join(rootDir, "missing-recordings");
		const plan = await createRecordingRetentionPlan({
			recordingsDir: missingDir,
			policy: keepSevenDays,
			now,
		});

		expect(plan.recordingsDir).toBe(missingDir);
		expect(plan.totalBytes).toBe(0);
		expect(plan.candidates).toEqual([]);
		expect(plan.errors).toEqual([]);
	});

	it("keeps forever when both policy limits are disabled", async () => {
		await writeSession({ name: "recording-old.webm", createdAt: now - 30 * dayMs });

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepForever, now });

		expect(plan.sessionsValid).toBe(1);
		expect(plan.totalBytes).toBeGreaterThan(0);
		expect(plan.candidates).toEqual([]);
		expect(plan.reclaimableBytes).toBe(0);
	});

	it("ignores unknown user files without a session manifest", async () => {
		await writeFile(path.join(recordingsDir, "user-export.mp4"), "do not touch", "utf-8");
		const oldSession = await writeSession({
			name: "recording-old.webm",
			createdAt: now - 30 * dayMs,
		});

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.candidates.map((candidate) => candidate.manifestPath)).toEqual([
			oldSession.manifestPath,
		]);
		expect(
			plan.candidates.flatMap((candidate) => candidate.files.map((file) => file.path)),
		).not.toContain(path.join(recordingsDir, "user-export.mp4"));
	});

	it("selects sessions older than the age policy", async () => {
		const oldSession = await writeSession({
			name: "recording-old.webm",
			createdAt: now - 8 * dayMs,
		});
		await writeSession({ name: "recording-new.webm", createdAt: now - 2 * dayMs });

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.sessionsValid).toBe(2);
		expect(plan.candidates).toHaveLength(1);
		expect(plan.candidates[0].manifestPath).toBe(oldSession.manifestPath);
		expect(plan.candidates[0].reason).toBe("age");
	});

	it("selects the oldest retained sessions until the max-size policy is met", async () => {
		const oldest = await writeSession({
			name: "recording-1.webm",
			createdAt: now - 3 * dayMs,
			screenBytes: 3_221_225_472,
		});
		const middle = await writeSession({
			name: "recording-2.webm",
			createdAt: now - 2 * dayMs,
			screenBytes: 3_221_225_472,
		});
		await writeSession({
			name: "recording-3.webm",
			createdAt: now - dayMs,
			screenBytes: 3_221_225_472,
		});

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepFiveGb, now });

		expect(plan.candidates.map((candidate) => candidate.manifestPath)).toEqual([
			oldest.manifestPath,
			middle.manifestPath,
		]);
		expect(plan.candidates.every((candidate) => candidate.reason === "size")).toBe(true);
	});

	it("rejects a manifest whose name does not match the screen file", async () => {
		const screenPath = path.join(recordingsDir, "recording-real.webm");
		await writeFile(screenPath, "screen", "utf-8");
		await writeFile(
			path.join(recordingsDir, "recording-fake.session.json"),
			JSON.stringify({ screenVideoPath: screenPath, createdAt: now - 30 * dayMs }),
			"utf-8",
		);

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.candidates).toEqual([]);
		expect(plan.errors.map((error) => error.message).join("\n")).toMatch(/does not match/i);
	});

	it("rejects a session whose media path resolves outside the recordings directory", async () => {
		const outsideDir = path.join(rootDir, "outside");
		await mkdir(outsideDir);
		const outsideScreen = path.join(outsideDir, "recording-outside.webm");
		await writeFile(outsideScreen, "screen", "utf-8");
		await writeFile(
			path.join(recordingsDir, "recording-outside.session.json"),
			JSON.stringify({ screenVideoPath: outsideScreen, createdAt: now - 30 * dayMs }),
			"utf-8",
		);

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.candidates).toEqual([]);
		expect(plan.errors.map((error) => error.message).join("\n")).toMatch(/does not match|outside/i);
	});
	it("rejects a foreign manifest that does not use CloseScreen recording names", async () => {
		const screenPath = path.join(recordingsDir, "foreign.webm");
		const manifestPath = path.join(recordingsDir, "foreign.session.json");
		await writeFile(screenPath, "screen", "utf-8");
		await writeFile(
			manifestPath,
			JSON.stringify({ screenVideoPath: screenPath, createdAt: now - 30 * dayMs }),
			"utf-8",
		);

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.candidates).toEqual([]);
		expect(plan.errors.map((error) => error.message).join("\n")).toMatch(
			/CloseScreen recording name/i,
		);
	});
	it("rejects a webcam sidecar path that does not match the screen basename", async () => {
		const session = await writeSession({
			name: "recording-webcam-guard.webm",
			createdAt: now - 30 * dayMs,
		});
		const userFile = path.join(recordingsDir, "user-export.mp4");
		await writeFile(userFile, "do not delete", "utf-8");
		await writeFile(
			session.manifestPath,
			JSON.stringify({
				screenVideoPath: session.screenPath,
				webcamVideoPath: userFile,
				createdAt: session.createdAt,
			}),
			"utf-8",
		);

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.candidates).toEqual([]);
		expect(plan.errors.map((error) => error.message).join("\n")).toMatch(
			/webcam file does not match/i,
		);
		expect(await readFile(userFile, "utf-8")).toBe("do not delete");
	});

	it("accepts a native mp4 webcam sidecar with the expected basename", async () => {
		const session = await writeSession({
			name: "recording-native.mp4",
			createdAt: now - 30 * dayMs,
			webcam: true,
			webcamExtension: ".mp4",
		});

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.errors).toEqual([]);
		expect(plan.candidates.map((candidate) => candidate.manifestPath)).toEqual([
			session.manifestPath,
		]);
		expect(plan.candidates[0].files.map((file) => file.path)).toContain(session.webcamPath);
	});

	it("rejects a symlink or junction recordings directory", async () => {
		const realDir = path.join(rootDir, "real-recordings");
		const linkedDir = path.join(rootDir, "linked-recordings");
		await mkdir(realDir);
		await symlink(realDir, linkedDir, "junction");

		const plan = await createRecordingRetentionPlan({
			recordingsDir: linkedDir,
			policy: keepSevenDays,
			now,
		});

		expect(plan.candidates).toEqual([]);
		expect(plan.errors.map((error) => error.message).join("\n")).toMatch(
			/not a regular directory/i,
		);
	});

	it("excludes sessions protected by recording id or active media path", async () => {
		const byId = await writeSession({ name: "recording-id.webm", createdAt: now - 30 * dayMs });
		const byPath = await writeSession({ name: "recording-path.webm", createdAt: now - 29 * dayMs });
		const old = await writeSession({ name: "recording-old.webm", createdAt: now - 28 * dayMs });

		const plan = await createRecordingRetentionPlan({
			recordingsDir,
			policy: keepSevenDays,
			now,
			protectedCreatedAt: [byId.createdAt],
			protectedPaths: [byPath.screenPath],
		});

		expect(plan.sessionsProtected).toBe(2);
		expect(plan.candidates.map((candidate) => candidate.manifestPath)).toEqual([old.manifestPath]);
	});
	it("excludes sessions protected by a path resolved through a directory junction", async () => {
		const session = await writeSession({
			name: "recording-alias.webm",
			createdAt: now - 30 * dayMs,
		});
		const aliasDir = path.join(rootDir, "alias-recordings");
		await symlink(recordingsDir, aliasDir, "junction");

		const plan = await createRecordingRetentionPlan({
			recordingsDir,
			policy: keepSevenDays,
			now,
			protectedPaths: [path.join(aliasDir, path.basename(session.screenPath))],
		});

		expect(plan.sessionsProtected).toBe(1);
		expect(plan.candidates).toEqual([]);
	});

	it("rejects an unsafe cursor sidecar instead of deleting the session", async () => {
		const session = await writeSession({
			name: "recording-cursor.webm",
			createdAt: now - 30 * dayMs,
		});
		await mkdir(`${session.screenPath}.cursor.json`);

		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.candidates).toEqual([]);
		expect(plan.errors.map((error) => error.message).join("\n")).toMatch(
			/cursor file is not a regular file/i,
		);
	});
});

describe("executeRecordingCleanupPlan", () => {
	it("deletes only manifest-managed files after revalidation", async () => {
		const session = await writeSession({
			name: "recording-delete.webm",
			createdAt: now - 30 * dayMs,
			webcam: true,
			cursor: true,
		});
		const userFile = path.join(recordingsDir, "user-export.mp4");
		await writeFile(userFile, "do not touch", "utf-8");
		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		const result = await executeRecordingCleanupPlan(plan, { now });

		expect(result.success).toBe(true);
		expect(result.deletedFiles).toBe(4);
		expect(await pathExists(session.manifestPath)).toBe(false);
		expect(await pathExists(session.screenPath)).toBe(false);
		expect(await pathExists(session.webcamPath ?? "")).toBe(false);
		expect(await pathExists(session.cursorPath ?? "")).toBe(false);
		expect(await readFile(userFile, "utf-8")).toBe("do not touch");
	});

	it("rejects a stale plan when the manifest changes before execution", async () => {
		const session = await writeSession({
			name: "recording-stale.webm",
			createdAt: now - 30 * dayMs,
		});
		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });
		await writeFile(
			session.manifestPath,
			JSON.stringify({
				screenVideoPath: path.join(recordingsDir, "recording-other.webm"),
				createdAt: now - 30 * dayMs,
			}),
			"utf-8",
		);

		const result = await executeRecordingCleanupPlan(plan, { now });

		expect(result.success).toBe(false);
		expect(result.deletedFiles).toBe(0);
		expect(result.errors.map((error) => error.message).join("\n")).toMatch(/stale|changed/i);
		expect(await pathExists(session.screenPath)).toBe(true);
		expect(await pathExists(session.manifestPath)).toBe(true);
	});

	it("reports unlink errors without deleting the manifest", async () => {
		const session = await writeSession({
			name: "recording-error.webm",
			createdAt: now - 30 * dayMs,
		});
		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		const result = await executeRecordingCleanupPlan(plan, {
			now,
			unlinkFile: async (filePath) => {
				if (filePath === session.screenPath) {
					throw new Error("permission denied by test");
				}
				await rm(filePath, { force: true });
			},
		});

		expect(result.success).toBe(false);
		expect(result.deletedFiles).toBe(0);
		expect(result.errors.map((error) => error.message).join("\n")).toMatch(/permission denied/i);
		expect(await pathExists(session.screenPath)).toBe(true);
		expect(await pathExists(session.manifestPath)).toBe(true);
	});
	it("preserves an unrecognized regular cursor sidecar instead of deleting it", async () => {
		const session = await writeSession({
			name: "recording-cursor-user.webm",
			createdAt: now - 30 * dayMs,
		});
		const userCursorFile = `${session.screenPath}.cursor.json`;
		await writeFile(
			userCursorFile,
			JSON.stringify({ notes: ["not CloseScreen telemetry"] }),
			"utf-8",
		);
		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.errors).toEqual([]);
		expect(plan.candidates).toHaveLength(1);
		expect(plan.candidates[0].files.map((file) => file.path)).not.toContain(userCursorFile);

		const result = await executeRecordingCleanupPlan(plan, { now });

		expect(result.success).toBe(true);
		expect(result.deletedFiles).toBe(2);
		expect(await pathExists(session.screenPath)).toBe(false);
		expect(await pathExists(session.manifestPath)).toBe(false);
		expect(await readFile(userCursorFile, "utf-8")).toContain("not CloseScreen telemetry");
	});
	it("preserves schema-shaped cursor JSON without the matching recording id", async () => {
		const session = await writeSession({
			name: "recording-cursor-shaped.webm",
			createdAt: now - 30 * dayMs,
		});
		const cursorPath = `${session.screenPath}.cursor.json`;
		await writeFile(
			cursorPath,
			JSON.stringify({
				recordingId: session.createdAt + 1,
				version: 2,
				provider: "native",
				samples: [{ timeMs: 0, cx: 0.5, cy: 0.5, visible: true }],
				assets: [],
			}),
			"utf-8",
		);
		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		expect(plan.errors).toEqual([]);
		expect(plan.candidates).toHaveLength(1);
		expect(plan.candidates[0].files.map((file) => file.path)).not.toContain(cursorPath);

		const result = await executeRecordingCleanupPlan(plan, { now });

		expect(result.success).toBe(true);
		expect(result.deletedFiles).toBe(2);
		expect(await readFile(cursorPath, "utf-8")).toContain("recordingId");
	});
	it("deletes sidecars before the screen file so a failed screen unlink can be retried", async () => {
		const session = await writeSession({
			name: "recording-partial.webm",
			createdAt: now - 30 * dayMs,
			webcam: true,
			cursor: true,
		});
		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		const result = await executeRecordingCleanupPlan(plan, {
			now,
			unlinkFile: async (filePath) => {
				if (filePath === session.screenPath) {
					throw new Error("screen unlink blocked by test");
				}
				await rm(filePath, { force: true });
			},
		});

		expect(result.success).toBe(false);
		expect(result.deletedFiles).toBe(2);
		expect(await pathExists(session.webcamPath ?? "")).toBe(false);
		expect(await pathExists(session.cursorPath ?? "")).toBe(false);
		expect(await pathExists(session.screenPath)).toBe(true);
		expect(await pathExists(session.manifestPath)).toBe(true);

		const retryPlan = await createRecordingRetentionPlan({
			recordingsDir,
			policy: keepSevenDays,
			now,
		});
		expect(retryPlan.errors).toEqual([]);
		expect(retryPlan.candidates.map((candidate) => candidate.manifestPath)).toEqual([
			session.manifestPath,
		]);
	});

	it("reports skipped sessions when the recordings directory disappears before execution", async () => {
		await writeSession({
			name: "recording-disappears.webm",
			createdAt: now - 30 * dayMs,
		});
		const plan = await createRecordingRetentionPlan({ recordingsDir, policy: keepSevenDays, now });

		await rm(recordingsDir, { recursive: true, force: true });
		const result = await executeRecordingCleanupPlan(plan, { now });

		expect(result.success).toBe(false);
		expect(result.deletedFiles).toBe(0);
		expect(result.skippedSessions).toBe(1);
		expect(result.errors.map((error) => error.message).join("\n")).toMatch(/disappeared/i);
	});
});

describe("cleanupRecordingsWithLock", () => {
	it("deletes nothing when the authoritative storage lock is active", async () => {
		const session = await writeSession({
			name: "recording-locked.webm",
			createdAt: now - 30 * dayMs,
		});

		const result = await cleanupRecordingsWithLock({
			recordingsDir,
			policy: keepSevenDays,
			isLocked: () => true,
			now,
		});

		expect(result.success).toBe(false);
		expect(result.deletedFiles).toBe(0);
		expect(result.errors.map((error) => error.message).join("\n")).toMatch(
			/recording or finalizing/i,
		);
		expect(await pathExists(session.screenPath)).toBe(true);
		expect(await pathExists(session.manifestPath)).toBe(true);
	});
	it("stops before unlinking when the authoritative storage lock turns active", async () => {
		const session = await writeSession({
			name: "recording-lock-flip.webm",
			createdAt: now - 30 * dayMs,
		});
		let lockChecks = 0;

		const result = await cleanupRecordingsWithLock({
			recordingsDir,
			policy: keepSevenDays,
			isLocked: () => {
				lockChecks += 1;
				return lockChecks > 4;
			},
			now,
			unlinkFile: async () => {
				throw new Error("unlink should not run after lock flips");
			},
		});

		expect(result.success).toBe(false);
		expect(result.deletedFiles).toBe(0);
		expect(result.errors.map((error) => error.message).join("\n")).toMatch(
			/recording or finalizing/i,
		);
		expect(await pathExists(session.screenPath)).toBe(true);
		expect(await pathExists(session.manifestPath)).toBe(true);
	});
});
