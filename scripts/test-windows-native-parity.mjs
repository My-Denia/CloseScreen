// Behavioral parity harness: runs the C++ wgc-capture.exe and the Rust port
// back-to-back with identical configs and diffs what the Electron side can
// observe — the ordered stdout line sequence (JSON events + legacy text),
// exit codes, and ffprobe stream metadata of the outputs. Volatile values
// (paths, durations) are normalized. stdout and stderr are compared as
// separate ordered streams; cross-pipe interleaving is not part of the
// contract.
//
// Usage: node scripts/test-windows-native-parity.mjs
//   CPP exe:  electron/native/bin/win32-x64/wgc-capture.exe (or CLOSESCREEN_PARITY_CPP_EXE)
//   Rust exe: electron/native/rust/target/dist/wgc-capture.exe (or CLOSESCREEN_PARITY_RUST_EXE)

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const CPP_EXE =
	process.env.CLOSESCREEN_PARITY_CPP_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture.exe");
const RUST_EXE =
	process.env.CLOSESCREEN_PARITY_RUST_EXE ??
	path.join(ROOT, "electron", "native", "rust", "target", "dist", "wgc-capture.exe");

const RECORD_MS = 4000;
const failures = [];

function assertEqual(label, cpp, rust) {
	const a = JSON.stringify(cpp);
	const b = JSON.stringify(rust);
	if (a !== b) {
		failures.push(`${label}:\n  cpp:  ${a}\n  rust: ${b}`);
	}
}

function runCapture(exe, config, { stopAfterStartedMs }) {
	return new Promise((resolve, reject) => {
		const child = spawn(exe, [JSON.stringify(config)], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let stopSent = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (!stopSent && stopAfterStartedMs !== null && stdout.includes("Recording started")) {
				stopSent = true;
				setTimeout(() => {
					try {
						child.stdin.write("stop\n");
					} catch {}
				}, stopAfterStartedMs);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		const killer = setTimeout(() => child.kill(), 30_000);
		child.once("exit", (code) => {
			clearTimeout(killer);
			resolve({ code, stdout, stderr });
		});
	});
}

// Normalizes one stdout line to its comparable shape: JSON lines become
// `event/sorted-key-list` (values dropped where volatile), text lines have
// paths stripped.
function normalizeStdoutLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("{")) {
		try {
			const json = JSON.parse(trimmed);
			return `json:${json.event}:${Object.keys(json).join(",")}`;
		} catch {
			return `unparseable:${trimmed.slice(0, 60)}`;
		}
	}
	return `text:${trimmed.replace(/Output path: .*/, "Output path: <path>")}`;
}

function normalizeStdout(stdout) {
	return stdout.split(/\r?\n/).map(normalizeStdoutLine).filter(Boolean);
}

function normalizeStderr(stderr) {
	// Keep only ERROR lines (diagnostic INFO differs by implementation detail),
	// with hr codes masked — the codes are driver-dependent.
	return stderr
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.startsWith("ERROR:"))
		.map((l) => l.replace(/hr=0x[0-9a-fA-F]+/, "hr=<hr>"));
}

function ffprobeMeta(file) {
	const probe = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"stream=codec_name,width,height,avg_frame_rate",
			"-show_entries",
			"format=duration",
			"-of",
			"json",
			file,
		],
		{ encoding: "utf8", windowsHide: true },
	);
	if (probe.status !== 0) return null;
	const parsed = JSON.parse(probe.stdout);
	const stream = parsed.streams?.[0] ?? {};
	return {
		codec: stream.codec_name,
		width: stream.width,
		height: stream.height,
		fps: stream.avg_frame_rate,
		duration: Number(parsed.format?.duration ?? 0),
	};
}

function tempOut(tag) {
	return path.join(os.tmpdir(), `closescreen-parity-${tag}-${randomUUID()}.mp4`);
}

if (process.platform !== "win32") {
	console.error("This parity harness is Windows-only.");
	process.exit(1);
}
for (const [label, exe] of [
	["cpp", CPP_EXE],
	["rust", RUST_EXE],
]) {
	if (!fs.existsSync(exe)) {
		console.error(`${label} exe missing: ${exe}`);
		process.exit(1);
	}
}
console.log(`cpp:  ${CPP_EXE}`);
console.log(`rust: ${RUST_EXE}`);

// Case 1: display capture happy path.
{
	const outs = { cpp: tempOut("cpp"), rust: tempOut("rust") };
	const results = {};
	for (const [label, exe] of [
		["cpp", CPP_EXE],
		["rust", RUST_EXE],
	]) {
		const config = {
			schemaVersion: 2,
			outputPath: outs[label],
			sourceType: "display",
			fps: 30,
			captureCursor: false,
			captureSystemAudio: false,
			captureMic: false,
			webcamEnabled: false,
		};
		results[label] = await runCapture(exe, config, { stopAfterStartedMs: RECORD_MS });
	}
	assertEqual("display: exit code", results.cpp.code, results.rust.code);
	assertEqual(
		"display: stdout sequence",
		normalizeStdout(results.cpp.stdout),
		normalizeStdout(results.rust.stdout),
	);
	assertEqual(
		"display: stderr ERROR lines",
		normalizeStderr(results.cpp.stderr),
		normalizeStderr(results.rust.stderr),
	);
	const meta = { cpp: ffprobeMeta(outs.cpp), rust: ffprobeMeta(outs.rust) };
	assertEqual("display: codec", meta.cpp?.codec, meta.rust?.codec);
	assertEqual(
		"display: dims",
		[meta.cpp?.width, meta.cpp?.height],
		[meta.rust?.width, meta.rust?.height],
	);
	assertEqual("display: fps", meta.cpp?.fps, meta.rust?.fps);
	if (meta.cpp && meta.rust) {
		const ratio = meta.rust.duration / Math.max(0.001, meta.cpp.duration);
		if (ratio < 0.85 || ratio > 1.15) {
			failures.push(
				`display: duration divergence cpp=${meta.cpp.duration}s rust=${meta.rust.duration}s`,
			);
		}
	}
	console.log(
		`  display: cpp ${meta.cpp?.duration}s / rust ${meta.rust?.duration}s @ ${meta.cpp?.width}x${meta.cpp?.height}`,
	);
	for (const f of Object.values(outs)) fs.rmSync(f, { force: true });
}

// Case 2: error paths — same stderr shape and exit codes.
const ERROR_CASES = [
	["missing-arg", null, null],
	["bad-json", "not json at all", null],
	["no-output-path", JSON.stringify({ fps: 30 }), null],
	[
		"bad-source-type",
		JSON.stringify({ outputPath: tempOut("badsrc"), sourceType: "nonsense" }),
		null,
	],
	[
		"invalid-window",
		JSON.stringify({ outputPath: tempOut("badwin"), sourceType: "window", windowHandle: "abc" }),
		null,
	],
];
for (const [tag, arg] of ERROR_CASES) {
	const results = {};
	for (const [label, exe] of [
		["cpp", CPP_EXE],
		["rust", RUST_EXE],
	]) {
		results[label] = await new Promise((resolve, reject) => {
			const child = spawn(exe, arg === null ? [] : [arg], {
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (c) => {
				stdout += c.toString();
			});
			child.stderr.on("data", (c) => {
				stderr += c.toString();
			});
			child.once("error", reject);
			const killer = setTimeout(() => child.kill(), 15_000);
			child.once("exit", (code) => {
				clearTimeout(killer);
				resolve({ code, stdout, stderr });
			});
		});
	}
	assertEqual(`${tag}: exit code`, results.cpp.code, results.rust.code);
	assertEqual(
		`${tag}: stdout sequence`,
		normalizeStdout(results.cpp.stdout),
		normalizeStdout(results.rust.stdout),
	);
	assertEqual(
		`${tag}: stderr ERROR lines`,
		normalizeStderr(results.cpp.stderr),
		normalizeStderr(results.rust.stderr),
	);
	console.log(`  ${tag}: exit ${results.cpp.code} on both`);
}

if (failures.length > 0) {
	console.error("\nPARITY FAIL:");
	for (const f of failures) {
		console.error(`  - ${f}`);
	}
	process.exit(1);
}
console.log("\nPASS: C++ and Rust wgc-capture behave identically on the compared surfaces.");
