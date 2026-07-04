import path from "node:path";

const ALLOWED_EXPORT_EXTENSIONS = new Set([".gif", ".mp4"]);
export const EXPORT_PATH_APPROVAL_TTL_MS = 6 * 60 * 60 * 1000;

function canonicalize(filePath: string): string {
	return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

export function normalizeExportPath(filePath: unknown): string | null {
	if (typeof filePath !== "string") {
		return null;
	}

	if (!filePath || !path.isAbsolute(filePath)) {
		return null;
	}

	const normalizedPath = path.normalize(filePath);
	if (!ALLOWED_EXPORT_EXTENSIONS.has(path.extname(normalizedPath).toLowerCase())) {
		return null;
	}

	return normalizedPath;
}

export class ExportPathApprovals {
	private readonly approvedPaths = new Map<string, number>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly ttlMs: number = EXPORT_PATH_APPROVAL_TTL_MS,
	) {}

	approve(filePath: unknown): string | null {
		const normalizedPath = normalizeExportPath(filePath);
		if (!normalizedPath) {
			return null;
		}

		this.approvedPaths.set(canonicalize(normalizedPath), this.now() + this.ttlMs);
		return normalizedPath;
	}

	consume(filePath: unknown): string | null {
		const normalizedPath = normalizeExportPath(filePath);
		if (!normalizedPath) {
			return null;
		}

		const key = canonicalize(normalizedPath);
		const expiresAt = this.approvedPaths.get(key);
		if (expiresAt === undefined) {
			return null;
		}

		if (expiresAt <= this.now()) {
			this.approvedPaths.delete(key);
			return null;
		}

		this.approvedPaths.delete(key);
		return normalizedPath;
	}

	discard(filePath: unknown): boolean {
		const normalizedPath = normalizeExportPath(filePath);
		if (!normalizedPath) {
			return false;
		}

		return this.approvedPaths.delete(canonicalize(normalizedPath));
	}
}
