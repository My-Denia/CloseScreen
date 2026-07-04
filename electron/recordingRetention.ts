import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRecordingSession, type RecordingSession } from "../src/lib/recordingSession";
import type { RecordingRetentionPolicy } from "./appSettings";

export const RECORDING_SESSION_SUFFIX = ".session.json";
export const CURSOR_TELEMETRY_SUFFIX = ".cursor.json";
const RECORDING_FILE_PREFIX = "recording-";
const WEBCAM_SIDECAR_SUFFIX = "-webcam";
const ALLOWED_SCREEN_RECORDING_EXTENSIONS = new Set([".mp4", ".webm"]);
const ALLOWED_WEBCAM_SIDECAR_EXTENSIONS = new Set([".mp4", ".webm"]);

export type ManagedRecordingFileLabel = "manifest" | "screen" | "webcam" | "cursor";
export type RecordingRetentionReason = "age" | "size";

export interface RecordingRetentionError {
	path?: string;
	code?: string;
	message: string;
}

export interface ManagedRecordingFile {
	path: string;
	realPath: string;
	label: ManagedRecordingFileLabel;
	bytes: number;
	mtimeMs: number;
}

export interface RecordingRetentionCandidate {
	manifestPath: string;
	createdAt: number;
	reason: RecordingRetentionReason;
	bytes: number;
	files: ManagedRecordingFile[];
}

export interface RecordingRetentionPlan {
	recordingsDir: string;
	recordingsDirRealPath: string | null;
	policy: RecordingRetentionPolicy;
	generatedAt: number;
	protectedCreatedAt: number[];
	protectedPaths: string[];
	totalBytes: number;
	reclaimableBytes: number;
	sessionsScanned: number;
	sessionsValid: number;
	sessionsProtected: number;
	sessionsEligible: number;
	candidates: RecordingRetentionCandidate[];
	errors: RecordingRetentionError[];
}

export interface RecordingRetentionStatus {
	recordingsDir: string;
	policy: RecordingRetentionPolicy;
	totalBytes: number;
	reclaimableBytes: number;
	sessionsScanned: number;
	sessionsValid: number;
	sessionsProtected: number;
	sessionsEligible: number;
	errors: RecordingRetentionError[];
}

export interface RecordingCleanupResult {
	success: boolean;
	deletedFiles: number;
	deletedBytes: number;
	skippedSessions: number;
	errors: RecordingRetentionError[];
	status: RecordingRetentionStatus;
}

export interface RecordingRetentionProtectedState {
	createdAt?: number | null;
	screenVideoPath?: string | null;
	webcamVideoPath?: string | null;
	protectedCreatedAt?: readonly number[];
	protectedPaths?: readonly string[];
}

export interface CreateRecordingRetentionPlanOptions extends RecordingRetentionProtectedState {
	recordingsDir: string;
	policy: RecordingRetentionPolicy;
	now?: number;
}

export interface ExecuteRecordingCleanupPlanOptions {
	unlinkFile?: (filePath: string) => Promise<void>;
	shouldContinue?: () => boolean;
	now?: number;
}

interface SessionEntry {
	manifestPath: string;
	createdAt: number;
	bytes: number;
	files: ManagedRecordingFile[];
	protected: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function canonicalize(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathWithinDirByRealPath(fileRealPath: string, dirRealPath: string): boolean {
	const relative = path.relative(canonicalize(dirRealPath), canonicalize(fileRealPath));
	return (
		relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code ?? "") || undefined
		: undefined;
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

function retentionError(
	message: string,
	filePath?: string,
	error?: unknown,
): RecordingRetentionError {
	return {
		message: error ? `${message}: ${describeError(error)}` : message,
		...(filePath ? { path: filePath } : {}),
		...(error ? { code: errorCode(error) } : {}),
	};
}

function normalizeProtectedCreatedAt(options: RecordingRetentionProtectedState): number[] {
	const values = [options.createdAt, ...(options.protectedCreatedAt ?? [])];
	return values.filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value),
	);
}

function normalizeProtectedPaths(options: RecordingRetentionProtectedState): string[] {
	const values = [
		options.screenVideoPath,
		options.webcamVideoPath,
		...(options.protectedPaths ?? []),
	];
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const value of values) {
		if (typeof value !== "string" || value.trim() === "" || !path.isAbsolute(value)) {
			continue;
		}
		const resolved = path.resolve(value);
		const key = canonicalize(resolved);
		if (!seen.has(key)) {
			seen.add(key);
			paths.push(resolved);
		}
	}
	return paths;
}

async function resolveProtectedPaths(options: RecordingRetentionProtectedState): Promise<string[]> {
	const paths = normalizeProtectedPaths(options);
	const seen = new Set(paths.map((filePath) => canonicalize(filePath)));
	for (const filePath of paths) {
		try {
			const realPath = await fs.realpath(filePath);
			const key = canonicalize(realPath);
			if (!seen.has(key)) {
				seen.add(key);
				paths.push(realPath);
			}
		} catch {
			// A protected in-flight path may disappear before cleanup preview; keep its
			// lexical form and let the authoritative lock gate handle active writes.
		}
	}
	return paths;
}

async function getRecordingsDirRealPath(recordingsDir: string): Promise<{
	realPath: string | null;
	missing: boolean;
	error?: RecordingRetentionError;
}> {
	if (!path.isAbsolute(recordingsDir)) {
		return {
			realPath: null,
			missing: false,
			error: retentionError("Recordings directory must be absolute", recordingsDir),
		};
	}

	try {
		const stats = await fs.lstat(recordingsDir);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			return {
				realPath: null,
				missing: false,
				error: retentionError("Recordings directory is not a regular directory", recordingsDir),
			};
		}
		return { realPath: await fs.realpath(recordingsDir), missing: false };
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { realPath: null, missing: true };
		}
		return {
			realPath: null,
			missing: false,
			error: retentionError("Unable to inspect recordings directory", recordingsDir, error),
		};
	}
}

async function readSafeManagedFile(
	filePath: string,
	recordingsDirRealPath: string,
	label: ManagedRecordingFileLabel,
): Promise<{
	file: ManagedRecordingFile | null;
	missing: boolean;
	error?: RecordingRetentionError;
}> {
	if (!path.isAbsolute(filePath)) {
		return {
			file: null,
			missing: false,
			error: retentionError(`${label} path must be absolute`, filePath),
		};
	}

	const resolved = path.resolve(filePath);
	let stats: Stats;
	try {
		stats = await fs.lstat(resolved);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			return { file: null, missing: true };
		}
		return {
			file: null,
			missing: false,
			error: retentionError(`Unable to inspect ${label} file`, resolved, error),
		};
	}

	if (stats.isSymbolicLink() || !stats.isFile()) {
		return {
			file: null,
			missing: false,
			error: retentionError(`${label} file is not a regular file`, resolved),
		};
	}

	let realPath: string;
	try {
		realPath = await fs.realpath(resolved);
	} catch (error) {
		return {
			file: null,
			missing: false,
			error: retentionError(`Unable to resolve ${label} file`, resolved, error),
		};
	}

	if (!isPathWithinDirByRealPath(realPath, recordingsDirRealPath)) {
		return {
			file: null,
			missing: false,
			error: retentionError(`${label} file resolves outside the recordings directory`, resolved),
		};
	}

	return {
		file: {
			path: resolved,
			realPath,
			label,
			bytes: stats.size,
			mtimeMs: stats.mtimeMs,
		},
		missing: false,
	};
}

function getSessionManifestPathForScreen(screenVideoPath: string): string {
	const parsed = path.parse(screenVideoPath);
	return path.join(parsed.dir, `${parsed.name}${RECORDING_SESSION_SUFFIX}`);
}

function isExpectedWebcamSidecarPath(screenVideoPath: string, webcamVideoPath: string): boolean {
	const screen = path.parse(screenVideoPath);
	const webcam = path.parse(webcamVideoPath);
	return (
		pathsMatch(webcam.dir, screen.dir) &&
		webcam.name === `${screen.name}${WEBCAM_SIDECAR_SUFFIX}` &&
		ALLOWED_WEBCAM_SIDECAR_EXTENSIONS.has(webcam.ext.toLowerCase())
	);
}

function isExpectedScreenRecordingPath(screenVideoPath: string, createdAt: number): boolean {
	const screen = path.parse(screenVideoPath);
	return (
		screen.name === `${RECORDING_FILE_PREFIX}${createdAt}` &&
		ALLOWED_SCREEN_RECORDING_EXTENSIONS.has(screen.ext.toLowerCase())
	);
}

function isCursorTelemetrySample(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const sample = value as { timeMs?: unknown; cx?: unknown; cy?: unknown };
	return (
		typeof sample.timeMs === "number" &&
		Number.isFinite(sample.timeMs) &&
		typeof sample.cx === "number" &&
		Number.isFinite(sample.cx) &&
		sample.cx >= 0 &&
		sample.cx <= 1 &&
		typeof sample.cy === "number" &&
		Number.isFinite(sample.cy) &&
		sample.cy >= 0 &&
		sample.cy <= 1
	);
}

function isCloseScreenCursorTelemetrySidecar(value: unknown, createdAt: number): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const data = value as {
		recordingId?: unknown;
		version?: unknown;
		provider?: unknown;
		samples?: unknown;
		assets?: unknown;
	};
	return (
		data.recordingId === createdAt &&
		data.version === 2 &&
		(data.provider === "native" || data.provider === "none") &&
		Array.isArray(data.samples) &&
		data.samples.length > 0 &&
		data.samples.every(isCursorTelemetrySample) &&
		Array.isArray(data.assets)
	);
}

async function isValidCursorTelemetrySidecar(
	filePath: string,
	createdAt: number,
): Promise<boolean> {
	try {
		return isCloseScreenCursorTelemetrySidecar(
			JSON.parse(await fs.readFile(filePath, "utf-8")),
			createdAt,
		);
	} catch {
		return false;
	}
}

function pathsMatch(left: string, right: string): boolean {
	return canonicalize(left) === canonicalize(right);
}

function isProtectedSession(
	session: RecordingSession,
	files: readonly ManagedRecordingFile[],
	protectedCreatedAt: readonly number[],
	protectedPaths: readonly string[],
): boolean {
	if (protectedCreatedAt.includes(session.createdAt)) {
		return true;
	}
	const sessionPaths = [
		session.screenVideoPath,
		session.webcamVideoPath,
		...files.flatMap((file) => [file.path, file.realPath]),
	].filter((value): value is string => typeof value === "string" && value.trim() !== "");
	return sessionPaths.some((sessionPath) =>
		protectedPaths.some((protectedPath) => pathsMatch(sessionPath, protectedPath)),
	);
}

async function readSessionEntry(
	manifestPath: string,
	recordingsDirRealPath: string,
	protectedCreatedAt: readonly number[],
	protectedPaths: readonly string[],
): Promise<{ entry: SessionEntry | null; error?: RecordingRetentionError }> {
	const manifest = await readSafeManagedFile(manifestPath, recordingsDirRealPath, "manifest");
	if (!manifest.file) {
		return { entry: null, error: manifest.error };
	}

	let session: RecordingSession | null = null;
	try {
		const content = await fs.readFile(manifest.file.path, "utf-8");
		session = normalizeRecordingSession(JSON.parse(content));
	} catch (error) {
		return {
			entry: null,
			error: retentionError(
				"Unable to parse recording session manifest",
				manifest.file.path,
				error,
			),
		};
	}
	if (!session) {
		return {
			entry: null,
			error: retentionError("Recording session manifest is invalid", manifest.file.path),
		};
	}

	if (!path.isAbsolute(session.screenVideoPath)) {
		return {
			entry: null,
			error: retentionError("Recording session screen path must be absolute", manifest.file.path),
		};
	}

	const expectedManifestPath = getSessionManifestPathForScreen(session.screenVideoPath);
	if (!pathsMatch(expectedManifestPath, manifest.file.path)) {
		return {
			entry: null,
			error: retentionError(
				"Recording session manifest does not match its screen file",
				manifest.file.path,
			),
		};
	}

	if (!isExpectedScreenRecordingPath(session.screenVideoPath, session.createdAt)) {
		return {
			entry: null,
			error: retentionError(
				"Recording session screen file does not match the CloseScreen recording name",
				manifest.file.path,
			),
		};
	}

	const screen = await readSafeManagedFile(
		session.screenVideoPath,
		recordingsDirRealPath,
		"screen",
	);
	if (!screen.file) {
		return {
			entry: null,
			error:
				screen.error ??
				retentionError("Recording session screen file is missing", session.screenVideoPath),
		};
	}

	const files = [manifest.file, screen.file];
	if (session.webcamVideoPath) {
		if (!path.isAbsolute(session.webcamVideoPath)) {
			return {
				entry: null,
				error: retentionError("Recording session webcam path must be absolute", manifest.file.path),
			};
		}
		if (!isExpectedWebcamSidecarPath(screen.file.path, session.webcamVideoPath)) {
			return {
				entry: null,
				error: retentionError(
					"Recording session webcam file does not match the expected sidecar name",
					manifest.file.path,
				),
			};
		}
		const webcam = await readSafeManagedFile(
			session.webcamVideoPath,
			recordingsDirRealPath,
			"webcam",
		);
		if (webcam.file) {
			files.push(webcam.file);
		} else if (webcam.error) {
			return { entry: null, error: webcam.error };
		}
	}

	const cursorPath = `${screen.file.path}${CURSOR_TELEMETRY_SUFFIX}`;
	const cursor = await readSafeManagedFile(cursorPath, recordingsDirRealPath, "cursor");
	if (cursor.file) {
		if (await isValidCursorTelemetrySidecar(cursor.file.path, session.createdAt)) {
			files.push(cursor.file);
		}
	} else if (cursor.error) {
		return { entry: null, error: cursor.error };
	}

	const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
	return {
		entry: {
			manifestPath: manifest.file.path,
			createdAt: session.createdAt,
			bytes,
			files,
			protected: isProtectedSession(session, files, protectedCreatedAt, protectedPaths),
		},
	};
}

function emptyPlan(
	options: CreateRecordingRetentionPlanOptions,
	errors: RecordingRetentionError[] = [],
): RecordingRetentionPlan {
	return {
		recordingsDir: path.resolve(options.recordingsDir),
		recordingsDirRealPath: null,
		policy: options.policy,
		generatedAt: options.now ?? Date.now(),
		protectedCreatedAt: normalizeProtectedCreatedAt(options),
		protectedPaths: normalizeProtectedPaths(options),
		totalBytes: 0,
		reclaimableBytes: 0,
		sessionsScanned: 0,
		sessionsValid: 0,
		sessionsProtected: 0,
		sessionsEligible: 0,
		candidates: [],
		errors,
	};
}

function selectCandidates(
	sessions: SessionEntry[],
	policy: RecordingRetentionPolicy,
	now: number,
): RecordingRetentionCandidate[] {
	if (policy.maxAgeDays === null && policy.maxSizeBytes === null) {
		return [];
	}

	const candidateByManifest = new Map<string, RecordingRetentionCandidate>();
	const unprotected = sessions.filter((session) => !session.protected);

	if (policy.maxAgeDays !== null) {
		const cutoff = now - policy.maxAgeDays * DAY_MS;
		for (const session of unprotected) {
			if (session.createdAt < cutoff) {
				candidateByManifest.set(session.manifestPath, {
					manifestPath: session.manifestPath,
					createdAt: session.createdAt,
					reason: "age",
					bytes: session.bytes,
					files: session.files,
				});
			}
		}
	}

	if (policy.maxSizeBytes !== null) {
		let retainedBytes = sessions.reduce((sum, session) => {
			return candidateByManifest.has(session.manifestPath) ? sum : sum + session.bytes;
		}, 0);
		const oldestRetained = unprotected
			.filter((session) => !candidateByManifest.has(session.manifestPath))
			.sort((a, b) => a.createdAt - b.createdAt);
		for (const session of oldestRetained) {
			if (retainedBytes <= policy.maxSizeBytes) {
				break;
			}
			candidateByManifest.set(session.manifestPath, {
				manifestPath: session.manifestPath,
				createdAt: session.createdAt,
				reason: "size",
				bytes: session.bytes,
				files: session.files,
			});
			retainedBytes -= session.bytes;
		}
	}

	return [...candidateByManifest.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function summarizeRecordingRetentionPlan(
	plan: RecordingRetentionPlan,
): RecordingRetentionStatus {
	return {
		recordingsDir: plan.recordingsDir,
		policy: plan.policy,
		totalBytes: plan.totalBytes,
		reclaimableBytes: plan.reclaimableBytes,
		sessionsScanned: plan.sessionsScanned,
		sessionsValid: plan.sessionsValid,
		sessionsProtected: plan.sessionsProtected,
		sessionsEligible: plan.sessionsEligible,
		errors: plan.errors,
	};
}

export async function createRecordingRetentionPlan(
	options: CreateRecordingRetentionPlanOptions,
): Promise<RecordingRetentionPlan> {
	const now = options.now ?? Date.now();
	const resolvedDir = path.resolve(options.recordingsDir);
	const protectedCreatedAt = normalizeProtectedCreatedAt(options);
	const protectedPaths = await resolveProtectedPaths(options);
	const dir = await getRecordingsDirRealPath(resolvedDir);
	if (dir.missing) {
		return emptyPlan({ ...options, recordingsDir: resolvedDir, now });
	}
	if (!dir.realPath) {
		return emptyPlan(
			{ ...options, recordingsDir: resolvedDir, now },
			dir.error
				? [dir.error]
				: [retentionError("Recordings directory is unavailable", resolvedDir)],
		);
	}

	let entries: Dirent[];
	try {
		entries = await fs.readdir(resolvedDir, { withFileTypes: true });
	} catch (error) {
		return emptyPlan({ ...options, recordingsDir: resolvedDir, now }, [
			retentionError("Unable to read recordings directory", resolvedDir, error),
		]);
	}

	const errors: RecordingRetentionError[] = [];
	const sessions: SessionEntry[] = [];
	let sessionsScanned = 0;
	for (const entry of entries) {
		if (!entry.name.endsWith(RECORDING_SESSION_SUFFIX)) {
			continue;
		}
		sessionsScanned += 1;
		const manifestPath = path.join(resolvedDir, entry.name);
		if (!entry.isFile()) {
			errors.push(retentionError("Recording session manifest is not a regular file", manifestPath));
			continue;
		}
		const result = await readSessionEntry(
			manifestPath,
			dir.realPath,
			protectedCreatedAt,
			protectedPaths,
		);
		if (result.entry) {
			sessions.push(result.entry);
		} else if (result.error) {
			errors.push(result.error);
		}
	}

	const candidates = selectCandidates(sessions, options.policy, now);
	return {
		recordingsDir: resolvedDir,
		recordingsDirRealPath: dir.realPath,
		policy: options.policy,
		generatedAt: now,
		protectedCreatedAt,
		protectedPaths,
		totalBytes: sessions.reduce((sum, session) => sum + session.bytes, 0),
		reclaimableBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
		sessionsScanned,
		sessionsValid: sessions.length,
		sessionsProtected: sessions.filter((session) => session.protected).length,
		sessionsEligible: candidates.length,
		candidates,
		errors,
	};
}

function fileFingerprint(file: ManagedRecordingFile): string {
	return [
		file.label,
		canonicalize(file.path),
		canonicalize(file.realPath),
		file.bytes,
		file.mtimeMs,
	].join("|");
}

function candidateFingerprint(candidate: RecordingRetentionCandidate): string {
	return candidate.files.map(fileFingerprint).sort().join("\n");
}

async function validateFileBeforeUnlink(
	file: ManagedRecordingFile,
	recordingsDirRealPath: string,
): Promise<RecordingRetentionError | null> {
	const current = await readSafeManagedFile(file.path, recordingsDirRealPath, file.label);
	if (!current.file) {
		return (
			current.error ?? retentionError(`${file.label} file disappeared before cleanup`, file.path)
		);
	}
	if (fileFingerprint(current.file) !== fileFingerprint(file)) {
		return retentionError(`${file.label} file changed after cleanup planning`, file.path);
	}
	return null;
}

async function unlinkCandidateFiles(
	candidate: RecordingRetentionCandidate,
	recordingsDirRealPath: string,
	unlinkFile: (filePath: string) => Promise<void>,
	shouldContinue: () => boolean,
): Promise<{ deletedFiles: number; deletedBytes: number; errors: RecordingRetentionError[] }> {
	const errors: RecordingRetentionError[] = [];
	let deletedFiles = 0;
	let deletedBytes = 0;
	const mediaFiles = candidate.files
		.filter((file) => file.label !== "manifest")
		.sort((a, b) => {
			const order: Record<ManagedRecordingFileLabel, number> = {
				webcam: 0,
				cursor: 1,
				screen: 2,
				manifest: 3,
			};
			return order[a.label] - order[b.label];
		});
	const manifest = candidate.files.find((file) => file.label === "manifest");

	for (const file of mediaFiles) {
		if (!shouldContinue()) {
			errors.push(
				retentionError("Recording cleanup stopped because recording or finalizing started"),
			);
			break;
		}
		const validationError = await validateFileBeforeUnlink(file, recordingsDirRealPath);
		if (validationError) {
			errors.push(validationError);
			break;
		}
		if (!shouldContinue()) {
			errors.push(
				retentionError("Recording cleanup stopped because recording or finalizing started"),
			);
			break;
		}
		try {
			await unlinkFile(file.path);
			deletedFiles += 1;
			deletedBytes += file.bytes;
		} catch (error) {
			errors.push(retentionError(`Failed to delete ${file.label} file`, file.path, error));
			break;
		}
	}

	if (errors.length === 0 && manifest) {
		if (!shouldContinue()) {
			errors.push(
				retentionError("Recording cleanup stopped because recording or finalizing started"),
			);
			return { deletedFiles, deletedBytes, errors };
		}
		const validationError = await validateFileBeforeUnlink(manifest, recordingsDirRealPath);
		if (validationError) {
			errors.push(validationError);
		} else if (!shouldContinue()) {
			errors.push(
				retentionError("Recording cleanup stopped because recording or finalizing started"),
			);
		} else {
			try {
				await unlinkFile(manifest.path);
				deletedFiles += 1;
				deletedBytes += manifest.bytes;
			} catch (error) {
				errors.push(
					retentionError("Failed to delete recording session manifest", manifest.path, error),
				);
			}
		}
	}

	return { deletedFiles, deletedBytes, errors };
}

export async function executeRecordingCleanupPlan(
	plan: RecordingRetentionPlan,
	options: ExecuteRecordingCleanupPlanOptions = {},
): Promise<RecordingCleanupResult> {
	const unlinkFile = options.unlinkFile ?? ((filePath: string) => fs.unlink(filePath));
	const shouldContinue = options.shouldContinue ?? (() => true);
	const freshPlan = await createRecordingRetentionPlan({
		recordingsDir: plan.recordingsDir,
		policy: plan.policy,
		now: options.now,
		protectedCreatedAt: plan.protectedCreatedAt,
		protectedPaths: plan.protectedPaths,
	});
	const freshByManifest = new Map(
		freshPlan.candidates.map((candidate) => [canonicalize(candidate.manifestPath), candidate]),
	);
	const errors = [...freshPlan.errors];
	let deletedFiles = 0;
	let deletedBytes = 0;
	let skippedSessions = 0;

	if (!freshPlan.recordingsDirRealPath) {
		if (plan.candidates.length > 0 && errors.length === 0) {
			errors.push(
				retentionError("Recordings directory disappeared before cleanup", plan.recordingsDir),
			);
		}
		return {
			success: errors.length === 0,
			deletedFiles,
			deletedBytes,
			skippedSessions: plan.candidates.length,
			errors,
			status: summarizeRecordingRetentionPlan(freshPlan),
		};
	}

	for (let index = 0; index < plan.candidates.length; index += 1) {
		const candidate = plan.candidates[index];
		if (!shouldContinue()) {
			skippedSessions += plan.candidates.length - index;
			errors.push(
				retentionError("Recording cleanup stopped because recording or finalizing started"),
			);
			break;
		}
		const freshCandidate = freshByManifest.get(canonicalize(candidate.manifestPath));
		if (!freshCandidate) {
			skippedSessions += 1;
			errors.push(
				retentionError("Recording cleanup plan is stale for this session", candidate.manifestPath),
			);
			continue;
		}
		if (candidateFingerprint(candidate) !== candidateFingerprint(freshCandidate)) {
			skippedSessions += 1;
			errors.push(
				retentionError("Recording cleanup plan changed before execution", candidate.manifestPath),
			);
			continue;
		}

		const result = await unlinkCandidateFiles(
			freshCandidate,
			freshPlan.recordingsDirRealPath,
			unlinkFile,
			shouldContinue,
		);
		deletedFiles += result.deletedFiles;
		deletedBytes += result.deletedBytes;
		if (result.errors.length > 0) {
			skippedSessions += 1;
			errors.push(...result.errors);
		}
	}

	const statusPlan = await createRecordingRetentionPlan({
		recordingsDir: plan.recordingsDir,
		policy: plan.policy,
		now: options.now,
		protectedCreatedAt: plan.protectedCreatedAt,
		protectedPaths: plan.protectedPaths,
	});
	return {
		success: errors.length === 0,
		deletedFiles,
		deletedBytes,
		skippedSessions,
		errors,
		status: summarizeRecordingRetentionPlan(statusPlan),
	};
}

export async function cleanupRecordingsWithLock(options: {
	recordingsDir: string;
	policy: RecordingRetentionPolicy;
	isLocked: () => boolean;
	protectedState?: RecordingRetentionProtectedState;
	now?: number;
	unlinkFile?: (filePath: string) => Promise<void>;
}): Promise<RecordingCleanupResult> {
	const protectedState = options.protectedState ?? {};
	const makeLockedResult = async (): Promise<RecordingCleanupResult> => {
		const lockedPlan = await createRecordingRetentionPlan({
			recordingsDir: options.recordingsDir,
			policy: options.policy,
			now: options.now,
			...protectedState,
		});
		return {
			success: false,
			deletedFiles: 0,
			deletedBytes: 0,
			skippedSessions: lockedPlan.candidates.length,
			errors: [retentionError("Cannot clean up recordings while recording or finalizing")],
			status: summarizeRecordingRetentionPlan(lockedPlan),
		};
	};

	if (options.isLocked()) {
		return makeLockedResult();
	}

	const plan = await createRecordingRetentionPlan({
		recordingsDir: options.recordingsDir,
		policy: options.policy,
		now: options.now,
		...protectedState,
	});
	if (options.isLocked()) {
		return makeLockedResult();
	}
	return executeRecordingCleanupPlan(plan, {
		now: options.now,
		unlinkFile: options.unlinkFile,
		shouldContinue: () => !options.isLocked(),
	});
}
