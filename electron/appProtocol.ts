// Custom privileged `app://` scheme so the packaged renderer runs from a real, single-origin
// context instead of `file://`. That lets us enable `webSecurity` (the editor previously needed
// `webSecurity:false` because a `file://` page can't read a cross-`file://` video/image back off a
// canvas, and can't `fetch()` the caption model across `file://` dirs).
//
// One authority (`app://bundle`) serves everything so it's all same-origin:
//   app://bundle/<path>                 -> dist/ (renderer bundle + vite-copied public: wallpapers,
//                                          cursors, wasm, assets, index.html)
//   app://bundle/_res/<path>            -> shared asset dir (public in dev-unpacked, resources when
//                                          packaged) — the base handed to getAssetPath/captions
//   app://bundle/_res/caption-assets/*  -> the caption-assets dir (offline Whisper model + ORT wasm)
//   app://bundle/_media/<encoded-abs>   -> an approved local recording/import, streamed with Range
//                                          (validated by the SAME guard as the read-binary-file IPC)
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, net, protocol } from "electron";
import { resolveApprovedVideoPath } from "./ipc/handlers";

// dist-electron/ (where the bundled main lives) → app root. Matches windows.ts RENDERER_DIST so the
// dist path is correct both unpacked (repo/dist) and packaged (resources/app.asar/dist). app.getAppPath()
// is NOT reliable when Electron is launched with an explicit script path (e.g. the e2e harness).
const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const APP_SCHEME = "app";
export const APP_HOST = "bundle";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;
// Base URL handed to the renderer (preload) so getAssetPath() and the caption worker resolve assets
// against the same origin as the page. Mirrors the old `file://<assetdir>/` ASSET_BASE_URL_ARG.
export const APP_ASSET_BASE_URL = `${APP_ORIGIN}/_res/`;

const MEDIA_PREFIX = "/_media/";
const RES_PREFIX = "/_res/";
const CAPTION_SUBPATH = "caption-assets/";

// Renderer runs from `app://` with no remote content (default-src 'self'). External needs: Google
// Fonts (style/font), and — dev only — the HuggingFace/CDN caption fetch. worker-src/child-src
// blob:: the transcription worker + transformers/web-demuxer module workers. media/img blob:/data:.
//
// unsafe-eval: web-demuxer's emscripten-compiled FFmpeg (used by the exporter + the caption
// fallback, in a blob: Worker) uses eval()/new Function() for its JS glue and hangs without it.
// This is still a large security win over the previous `webSecurity:false` (which disabled CORS,
// mixed-content and canvas-taint protection wholesale) — sources stay restricted to 'self'.
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com data:",
	"img-src 'self' data: blob:",
	// data: — the exporter probes short generated clips via data:video URLs. blob: — decoded media.
	"media-src 'self' blob: data:",
	// data:/blob: — cursor theme assets are fetched as data: URLs; the caption/export stacks read
	// blob:. https — dev-only CDN fetch of the caption model (packaged loads it from app://).
	"connect-src 'self' data: blob: https://huggingface.co https://cdn.jsdelivr.net",
	"worker-src 'self' blob:",
	"child-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-src 'none'",
].join("; ");

function rendererDistRoot(): string {
	return path.join(APP_ROOT, "dist");
}

// Shared asset dir: public/ when run unpacked (electron .), resources/ when packaged (extraResources).
function resourceAssetRoot(): string {
	return app.isPackaged ? process.resourcesPath : path.join(APP_ROOT, "public");
}

function captionAssetsRoot(): string {
	return app.isPackaged
		? path.join(process.resourcesPath, "caption-assets")
		: path.join(APP_ROOT, "caption-assets");
}

// Resolve `rel` under `root`, refusing anything that escapes it (`..`, absolute rejoin).
function safeJoin(root: string, rel: string): string | null {
	const resolved = path.resolve(root, rel.replace(/^[/\\]+/, ""));
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return null;
	}
	return resolved;
}

function notFound(): Response {
	return new Response("Not found", { status: 404 });
}

function withCsp(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// Static bundle/asset files (small, no Range needed) via net.fetch of the file:// URL.
async function serveDiskFile(diskPath: string, csp: boolean): Promise<Response> {
	try {
		const response = await net.fetch(pathToFileURL(diskPath).toString());
		return csp ? withCsp(response) : response;
	} catch {
		return notFound();
	}
}

const VIDEO_MIME: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
	".ts": "video/mp2t",
};

// Stream a local recording with explicit HTTP Range support so `<video>` scrubbing works. net.fetch
// of a file:// URL does not reliably honor Range in Electron, so serve the byte range ourselves.
async function serveMedia(diskPath: string, request: Request): Promise<Response> {
	let size: number;
	try {
		size = (await fs.promises.stat(diskPath)).size;
	} catch {
		return notFound();
	}
	const mime = VIDEO_MIME[path.extname(diskPath).toLowerCase()] ?? "application/octet-stream";
	const range = request.headers.get("range");
	const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

	if (match) {
		let start = match[1] ? Number.parseInt(match[1], 10) : 0;
		let end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
		if (!Number.isFinite(start) || start < 0) start = 0;
		if (!Number.isFinite(end) || end >= size) end = size - 1;
		if (start > end || start >= size) {
			return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
		}
		const body = Readable.toWeb(
			fs.createReadStream(diskPath, { start, end }),
		) as unknown as ReadableStream<Uint8Array>;
		return new Response(body, {
			status: 206,
			headers: {
				"Content-Type": mime,
				"Content-Length": String(end - start + 1),
				"Content-Range": `bytes ${start}-${end}/${size}`,
				"Accept-Ranges": "bytes",
			},
		});
	}

	const body = Readable.toWeb(
		fs.createReadStream(diskPath),
	) as unknown as ReadableStream<Uint8Array>;
	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": mime,
			"Content-Length": String(size),
			"Accept-Ranges": "bytes",
		},
	});
}

// Register at module load (must run before app 'ready').
export function registerAppScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: APP_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				stream: true,
				corsEnabled: true,
			},
		},
	]);
}

// Register the request handler (must run after app 'ready').
export function registerAppProtocolHandler(): void {
	protocol.handle(APP_SCHEME, async (request) => {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return new Response("Bad request", { status: 400 });
		}
		const { pathname } = url;

		// Approved local media (recordings/imports), streamed with Range.
		if (pathname.startsWith(MEDIA_PREFIX)) {
			const rawPath = decodeURIComponent(pathname.slice(MEDIA_PREFIX.length));
			const approved = resolveApprovedVideoPath(rawPath);
			if (!approved) {
				return new Response("Forbidden", { status: 403 });
			}
			return serveMedia(approved, request);
		}

		// Shared assets: wallpapers/cursors from the resource dir; caption-assets from its own root.
		if (pathname.startsWith(RES_PREFIX)) {
			const rel = decodeURIComponent(pathname.slice(RES_PREFIX.length));
			let diskPath: string | null;
			if (rel.startsWith(CAPTION_SUBPATH)) {
				diskPath = safeJoin(captionAssetsRoot(), rel.slice(CAPTION_SUBPATH.length));
			} else {
				diskPath = safeJoin(resourceAssetRoot(), rel);
			}
			if (!diskPath) return notFound();
			return serveDiskFile(diskPath, true);
		}

		// Renderer bundle (dist): index.html, JS/CSS, and vite-copied public assets.
		const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname);
		const diskPath = safeJoin(rendererDistRoot(), rel);
		if (!diskPath) return notFound();
		return serveDiskFile(diskPath, true);
	});
}
