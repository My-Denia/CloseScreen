/**
 * Translate a Node filesystem error into an actionable, user-facing reason for a failed
 * export save.
 *
 * The `write-export-to-path` handler previously returned a single generic
 * "Failed to save exported video" string and stashed the real OS error in a field the
 * renderer never read, so every save failure looked identical and was undiagnosable
 * (issue #3 / upstream #686). The raw error is still logged and returned in `error`;
 * this produces the message the user actually sees.
 */
export function describeSaveError(error: unknown): string {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";

	switch (code) {
		case "EACCES":
		case "EPERM":
			return "Permission denied. The folder may be blocked by Controlled Folder Access (Windows ransomware protection) or you may lack write access — try saving to a different folder such as Downloads.";
		case "ENOSPC":
			return "Not enough free disk space to save the video.";
		case "EBUSY":
		case "ETXTBSY":
			return "The file is in use by another program. Close it (or any media player previewing it) and try again.";
		case "EROFS":
			return "That location is read-only. Choose a writable folder.";
		case "ENOENT":
			return "That folder no longer exists. Choose another location.";
		case "ENAMETOOLONG":
			return "The file path is too long. Choose a shorter folder or file name.";
		case "EISDIR":
			return "That path is a folder, not a file. Choose a file name.";
		case "EMFILE":
		case "ENFILE":
			return "Too many files are open. Close some applications and try again.";
		default:
			return code ? `Failed to save exported video (${code}).` : "Failed to save exported video.";
	}
}
