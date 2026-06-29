/**
 * Return the final path segment (basename) of a filesystem path, handling both
 * POSIX ("/") and Windows ("\\") separators. Falls back to the full input when
 * there is no separator.
 *
 * Native save-dialog paths use the host OS separator (backslashes on Windows),
 * so a POSIX-only `split("/")` leaves the whole path intact on Windows.
 */
export function basename(filePath: string): string {
	return filePath.split(/[\\/]/).pop() || filePath;
}
