const VIDEO_FILE_EXTENSIONS = new Set([
	".webm",
	".mp4",
	".mov",
	".avi",
	".mkv",
	".m4v",
	".wmv",
	".flv",
	".ts",
]);

/**
 * Whether a dropped or selected file looks like an importable video, by a
 * "video/*" MIME type or by extension. Mirrors the main process's accepted
 * import extensions (electron/ipc/handlers.ts ALLOWED_IMPORT_VIDEO_EXTENSIONS);
 * kept renderer-local to avoid a cross-process import.
 */
export function isVideoFile(file: { name: string; type: string }): boolean {
	if (file.type.startsWith("video/")) {
		return true;
	}
	const dot = file.name.lastIndexOf(".");
	if (dot < 0) {
		return false;
	}
	return VIDEO_FILE_EXTENSIONS.has(file.name.slice(dot).toLowerCase());
}
