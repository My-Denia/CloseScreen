// Populates `caption-assets/` so the packaged app can transcribe offline (under file://)
// instead of fetching the Whisper model from HuggingFace and the onnxruntime wasm from a CDN.
//
//   caption-assets/
//     models/Xenova/whisper-tiny/...   ← downloaded from HuggingFace (config + quantized ONNX)
//     ort/ort-wasm-simd-threaded.asyncify.mjs                ← copied from onnxruntime-web/dist
//     ort/ort-wasm-simd-threaded.asyncify.wasm               ← copied from onnxruntime-web/dist
//
// Idempotent: existing non-empty files are left alone, so re-runs and CI cache hits are no-ops.
// `caption-assets/` is gitignored and shipped via electron-builder `extraResources`.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "caption-assets");
const MANIFEST_PATH = path.join(ROOT, "scripts", "caption-assets-manifest.json");
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const MODEL_ID = MANIFEST.model.id;
const MODEL_REVISION = MANIFEST.model.revision;
const HF_BASE = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}`;

// Small config/tokenizer/preprocessor files plus the quantized ONNX the ASR pipeline loads by
// default (encoder + merged decoder). Grab every metadata file so transformers never requests
// one we forgot to bundle.
const MODEL_FILES = [
	"config.json",
	"generation_config.json",
	"preprocessor_config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"added_tokens.json",
	"special_tokens_map.json",
	"normalizer.json",
	"merges.txt",
	"vocab.json",
	"quantize_config.json",
	"onnx/encoder_model_quantized.onnx",
	"onnx/decoder_model_merged_quantized.onnx",
];

async function exists(filePath) {
	try {
		const s = await stat(filePath);
		return s.isFile() && s.size > 0;
	} catch {
		return false;
	}
}

async function sha256(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

function expectedHash(assetKey) {
	const expected = MANIFEST.assets[assetKey];
	if (!/^[0-9a-f]{64}$/.test(expected ?? "")) {
		throw new Error(`Missing or invalid SHA-256 for ${assetKey} in ${MANIFEST_PATH}`);
	}
	return expected;
}

async function verifyHash(filePath, assetKey) {
	const expected = expectedHash(assetKey);
	const actual = await sha256(filePath);
	if (actual !== expected) {
		throw new Error(`SHA-256 mismatch for ${assetKey}: expected ${expected}, got ${actual}`);
	}
}

const MAX_ATTEMPTS = 6;
// HuggingFace rate-limits (429) when the parallel CI matrix builds all hit it at once; also retry the
// usual transient server errors.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt, retryAfter) {
	// Honor Retry-After when the server sends it (seconds or an HTTP date).
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	// Exponential backoff with jitter: ~2s, 4s, 8s, 16s, 32s, capped at 60s.
	return Math.min(60_000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url) {
	let lastErr;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetch(url, { headers: { "user-agent": "closescreen-build" } });
			if (res.ok && res.body) return res;
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				const wait = backoffMs(attempt, res.headers.get("retry-after"));
				console.log(
					`  … HTTP ${res.status}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`,
				);
				await sleep(wait);
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			const isHttp = err instanceof Error && err.message.startsWith("Failed to download");
			if (isHttp || attempt >= MAX_ATTEMPTS) throw err;
			// Network/DNS error: back off and retry.
			const wait = backoffMs(attempt, null);
			console.log(
				`  … ${err.message}, retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`,
			);
			await sleep(wait);
		}
	}
	throw lastErr;
}

async function download(url, dest, assetKey) {
	if (await exists(dest)) {
		try {
			await verifyHash(dest, assetKey);
			console.log(`  ✓ cached  ${path.relative(OUT, dest)}`);
			return;
		} catch {
			console.warn(`  ! replacing cached asset with invalid hash: ${assetKey}`);
			await rm(dest, { force: true });
		}
	}
	await mkdir(path.dirname(dest), { recursive: true });
	const res = await fetchWithRetry(url);
	const tmp = `${dest}.partial`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
	const { rename } = await import("node:fs/promises");
	await rename(tmp, dest);
	await verifyHash(dest, assetKey);
	const mb = ((await stat(dest)).size / 1_000_000).toFixed(1);
	console.log(`  ↓ ${path.relative(OUT, dest)} (${mb} MB)`);
}

// onnxruntime-web ships under @huggingface/transformers' own node_modules (it pins an exact dev
// build), so resolve the real dist dir instead of assuming a hoisted top-level install.
function resolveOrtDistDir() {
	const candidates = [
		path.join(
			ROOT,
			"node_modules",
			"@huggingface",
			"transformers",
			"node_modules",
			"onnxruntime-web",
			"dist",
		),
		path.join(ROOT, "node_modules", "onnxruntime-web", "dist"),
	];
	const found = candidates.find((dir) => existsSync(dir));
	if (!found) {
		throw new Error(
			`onnxruntime-web/dist not found (looked in: ${candidates.join(", ")}). ` +
				"Is @huggingface/transformers installed? Run npm ci first.",
		);
	}
	return found;
}

// onnxruntime-web's webgpu bundle (imported by @huggingface/transformers) loads the asyncify build.
// Under file:// with numThreads=1, ORT dynamically imports the .mjs GLUE MODULE from the wasmPaths
// prefix FIRST, and the glue then instantiates the sibling .wasm. If only the .wasm ships, backend
// init fails offline with "no available backend found" (Failed to fetch ...asyncify.mjs) and no
// captions are ever produced. Copy EVERY asyncify.* sibling rather than a hardcoded pair so an ORT
// version bump can't silently drop a required file. Assert both the glue and the wasm are present.
const ORT_ASYNCIFY_PREFIX = "ort-wasm-simd-threaded.asyncify.";

async function copyOrtWasm() {
	const distDir = resolveOrtDistDir();
	const names = (await readdir(distDir)).filter((n) => n.startsWith(ORT_ASYNCIFY_PREFIX));
	const hasGlue = names.some((n) => n.endsWith(".mjs"));
	const hasWasm = names.some((n) => n.endsWith(".wasm"));
	if (!hasGlue || !hasWasm) {
		throw new Error(
			`Expected ${ORT_ASYNCIFY_PREFIX}{mjs,wasm} in ${distDir}, found: ${names.join(", ") || "(none)"}. ` +
				"Is @huggingface/transformers installed? Run npm ci first.",
		);
	}
	const expectedNames = Object.keys(MANIFEST.assets)
		.filter((asset) => asset.startsWith("ort/"))
		.map((asset) => asset.slice("ort/".length))
		.sort();
	if (JSON.stringify(names.toSorted()) !== JSON.stringify(expectedNames)) {
		throw new Error(
			`ORT asset set does not match the manifest. Expected ${expectedNames.join(", ")}, found ${names.toSorted().join(", ")}`,
		);
	}
	const ortOut = path.join(OUT, "ort");
	await mkdir(ortOut, { recursive: true });
	for (const name of names) {
		const assetKey = `ort/${name}`;
		await verifyHash(path.join(distDir, name), assetKey);
		const dest = path.join(ortOut, name);
		if (await exists(dest)) {
			try {
				await verifyHash(dest, assetKey);
				console.log(`  ✓ cached  ort/${name}`);
				continue;
			} catch {
				await rm(dest, { force: true });
			}
		}
		await copyFile(path.join(distDir, name), dest);
		await verifyHash(dest, assetKey);
		console.log(`  + copied ort/${name}`);
	}
}

async function main() {
	if (!/^[0-9a-f]{40}$/.test(MODEL_REVISION)) {
		throw new Error("Caption model revision must be an immutable 40-character commit SHA.");
	}
	const modelAssetKeys = MODEL_FILES.map((rel) => `models/${MODEL_ID}/${rel}`);
	const manifestAssetKeys = Object.keys(MANIFEST.assets).toSorted();
	const requiredAssetKeys = [
		...modelAssetKeys,
		...manifestAssetKeys.filter((asset) => asset.startsWith("ort/")),
	].toSorted();
	if (JSON.stringify(manifestAssetKeys) !== JSON.stringify(requiredAssetKeys)) {
		throw new Error("Caption asset manifest contains missing or unexpected files.");
	}
	console.log(`Fetching caption assets → ${path.relative(ROOT, OUT)}/`);
	console.log("ONNX Runtime wasm:");
	await copyOrtWasm();
	console.log(`Whisper model (${MODEL_ID}):`);
	const modelDir = path.join(OUT, "models", ...MODEL_ID.split("/"));
	for (const rel of MODEL_FILES) {
		const assetKey = `models/${MODEL_ID}/${rel}`;
		await download(`${HF_BASE}/${rel}`, path.join(modelDir, rel), assetKey);
	}
	console.log("Caption assets ready.");
}

main().catch((err) => {
	console.error(`\nfetch-caption-model failed: ${err.message}`);
	process.exit(1);
});
