import { getAssetPath } from "@/lib/assetPath";

export const WALLPAPER_COUNT = 18;

export const WALLPAPER_PATHS: readonly string[] = Array.from(
	{ length: WALLPAPER_COUNT },
	(_, i) => `/wallpapers/wallpaper${i + 1}.jpg`,
);

export const DEFAULT_WALLPAPER = WALLPAPER_PATHS[0];

export type WallpaperClassification =
	| { kind: "color"; value: string }
	| { kind: "gradient"; value: string }
	| { kind: "image"; path: string };

const GRADIENT_RE = /^(repeating-)?(linear|radial|conic)-gradient\(/;
const COLOR_FUNC_RE = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/;
const IMAGE_URL_RE = /^(\/|https?:\/\/|file:\/\/|data:)/;

export function classifyWallpaper(value: string): WallpaperClassification {
	const trimmed = value.trim();
	if (trimmed === "") {
		return { kind: "color", value: "#000000" };
	}
	if (trimmed.startsWith("#") || COLOR_FUNC_RE.test(trimmed)) {
		return { kind: "color", value: trimmed };
	}
	if (GRADIENT_RE.test(trimmed)) {
		return { kind: "gradient", value: trimmed };
	}
	if (IMAGE_URL_RE.test(trimmed)) {
		return { kind: "image", path: trimmed };
	}
	return { kind: "color", value: trimmed };
}

const ALLOWED_IMAGE_PREFIX = "/wallpapers/";

export class UnsafeImagePrefixError extends Error {
	constructor(prefix: string) {
		super(`Image wallpaper path must live under ${prefix}`);
		this.name = "UnsafeImagePrefixError";
	}
}

export function resolveImageWallpaperUrl(imagePath: string): string {
	// data: images are same-origin under the packaged CSP; pass them straight through.
	if (imagePath.startsWith("data:")) {
		return imagePath;
	}
	// http(s)/file images can't load under the packaged CSP (img-src 'self' data: blob:) and would
	// silently blank the background + crash export. Project load migrates persisted values to the
	// default (normalizeWallpaperValue), so this only guards a value set at runtime — surface it as a
	// handled BackgroundLoadError instead of returning a URL the browser will refuse.
	if (
		imagePath.startsWith("http://") ||
		imagePath.startsWith("https://") ||
		imagePath.startsWith("file://")
	) {
		throw new BackgroundLoadError(imagePath, new UnsafeImagePrefixError(ALLOWED_IMAGE_PREFIX));
	}
	const withLeadingSlash = imagePath.startsWith("/") ? imagePath : `/${imagePath}`;
	if (!withLeadingSlash.startsWith(ALLOWED_IMAGE_PREFIX)) {
		throw new BackgroundLoadError(imagePath, new UnsafeImagePrefixError(ALLOWED_IMAGE_PREFIX));
	}
	try {
		return getAssetPath(withLeadingSlash.slice(1));
	} catch (cause) {
		if (cause instanceof BackgroundLoadError) throw cause;
		throw new BackgroundLoadError(imagePath, cause);
	}
}

export class BackgroundLoadError extends Error {
	readonly url: string;
	readonly cause?: unknown;

	constructor(url: string, cause?: unknown) {
		super(`Failed to load background image: ${displayBasename(url)}`);
		this.name = "BackgroundLoadError";
		this.url = url;
		this.cause = cause;
	}

	get displayUrl(): string {
		return displayBasename(this.url);
	}
}

function displayBasename(url: string): string {
	if (url.startsWith("data:")) {
		return "data:…";
	}
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split("/").filter(Boolean).pop();
		return last ? decodeURIComponent(last) : "(unknown)";
	} catch {
		const last = url.split("/").filter(Boolean).pop();
		return last ?? "(unknown)";
	}
}
