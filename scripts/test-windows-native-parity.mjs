// Behavioral parity harness: runs the C++ wgc-capture.exe and the Rust port
// back-to-back with identical configs and diffs what the Electron side can
// observe — the ordered stdout line sequence (JSON events + legacy text),
// exit codes, and ffprobe stream metadata of the outputs. Volatile values
// (paths, durations) are normalized. stdout and stderr are compared as
// separate ordered streams; cross-pipe interleaving is not part of the
// contract.
//
// Usage: node scripts/test-windows-native-parity.mjs
//   C++ exe:  electron/native/bin/win32-x64/wgc-capture-legacy.exe (or CLOSESCREEN_PARITY_CPP_EXE)
//   Rust exe: electron/native/bin/win32-x64/wgc-capture.exe (or CLOSESCREEN_PARITY_RUST_EXE)

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeAudibleSpan } from "./windows-native-audio-analysis.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const CPP_EXE =
	process.env.CLOSESCREEN_PARITY_CPP_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture-legacy.exe");
const RUST_EXE =
	process.env.CLOSESCREEN_PARITY_RUST_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture.exe");

const RECORD_MS = 4000;
const PAUSE_AFTER_MS = 1000;
const PAUSE_FOR_MS = 1000;
const EXPECTED_MEDIA_SECONDS = (RECORD_MS - PAUSE_FOR_MS) / 1000;
const TONE_HZ = 997;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_RMS_MIN = 500;
const AUDIO_PEAK_MIN = 2000;
const TONE_TOLERANCE_HZ = 10;
const AAC_FRAME_SAMPLES = 1024;
const MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES =
	AAC_FRAME_SAMPLES + Math.ceil(AUDIO_SAMPLE_RATE / (TONE_HZ - TONE_TOLERANCE_HZ));
const START_DRIFT_MAX_SECONDS = 0.25;
const END_DRIFT_MAX_SECONDS = 0.75;
const DURATION_TOLERANCE_SECONDS = 0.75;
const KEEP_ARTIFACTS = process.env.CLOSESCREEN_PARITY_KEEP_ARTIFACTS === "1";
const failures = [];

function assertEqual(label, cpp, rust) {
	const a = JSON.stringify(cpp);
	const b = JSON.stringify(rust);
	if (a !== b) {
		failures.push(`${label}:\n  cpp:  ${a}\n  rust: ${b}`);
	}
}

function runCapture(
	exe,
	config,
	{ stopAfterStartedMs, pauseAfterStartedMs = null, pauseForMs = 0 },
) {
	return new Promise((resolve, reject) => {
		const child = spawn(exe, [JSON.stringify(config)], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let stopSent = false;
		let commandsScheduled = false;
		let recordingStartedAt = 0;
		let stopSentAt = 0;
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (!commandsScheduled && stdout.includes("Recording started")) {
				commandsScheduled = true;
				recordingStartedAt = Date.now();
				if (pauseAfterStartedMs !== null) {
					setTimeout(() => child.stdin.write("pause\n"), pauseAfterStartedMs);
					setTimeout(() => child.stdin.write("resume\n"), pauseAfterStartedMs + pauseForMs);
				}
				setTimeout(() => {
					if (stopSent || stopAfterStartedMs === null) return;
					stopSent = true;
					stopSentAt = Date.now();
					try {
						child.stdin.write("stop\n");
					} catch {
						// The process may have exited between the lifecycle event and the stop timer.
					}
				}, stopAfterStartedMs);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		const killer = setTimeout(() => child.kill(), 30_000);
		// `close`, not `exit`: the stdio pipes must be drained before the
		// captured strings are compared, or trailing lines can go missing.
		child.once("close", (code) => {
			clearTimeout(killer);
			resolve({
				code,
				stdout,
				stderr,
				recordingStartedAt,
				stopSentAt,
				closedAt: Date.now(),
			});
		});
	});
}

function packetTimeline(file, stream) {
	const probe = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			stream,
			"-show_entries",
			"packet=pts_time,duration_time",
			"-of",
			"json",
			file,
		],
		{ encoding: "utf8", windowsHide: true },
	);
	if (probe.status !== 0) return null;
	const packets = JSON.parse(probe.stdout).packets ?? [];
	const pts = packets.map((packet) => Number(packet.pts_time)).filter(Number.isFinite);
	if (pts.length === 0) return null;
	const durations = packets.map((packet) => Number(packet.duration_time)).filter(Number.isFinite);
	return {
		first: pts[0],
		last: pts.at(-1),
		end: pts.at(-1) + (durations.at(-1) ?? 0),
		monotonic: pts.every((value, index) => index === 0 || value >= pts[index - 1]),
		packets: pts.length,
	};
}

function assertTimeline(label, timeline) {
	if (!timeline) {
		failures.push(`${label}: no packet timestamps`);
		return;
	}
	if (!timeline.monotonic) failures.push(`${label}: packet PTS are not monotonic`);
	if (timeline.first < -0.05 || timeline.first > START_DRIFT_MAX_SECONDS) {
		failures.push(`${label}: first PTS ${timeline.first}s is not rebased near zero`);
	}
}

function probeAudio(file) {
	const probe = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"a:0",
			"-count_packets",
			"-count_frames",
			"-show_entries",
			"stream=codec_name,sample_rate,channels,duration,nb_read_packets,nb_read_frames",
			"-of",
			"json",
			file,
		],
		{ encoding: "utf8", windowsHide: true },
	);
	if (probe.status !== 0) return null;
	const stream = JSON.parse(probe.stdout).streams?.[0];
	if (!stream) return null;
	return {
		codec: stream.codec_name,
		sampleRate: Number(stream.sample_rate),
		channels: Number(stream.channels),
		duration: Number(stream.duration),
		packets: Number(stream.nb_read_packets ?? 0),
		frames: Number(stream.nb_read_frames ?? 0),
	};
}

function decodeStereoPcm(file) {
	const decode = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-xerror",
			"-i",
			file,
			"-map",
			"0:a:0",
			"-ac",
			String(AUDIO_CHANNELS),
			"-ar",
			String(AUDIO_SAMPLE_RATE),
			"-f",
			"s16le",
			"pipe:1",
		],
		{ encoding: null, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
	);
	if (decode.status !== 0 || !Buffer.isBuffer(decode.stdout)) {
		return {
			ok: false,
			error: decode.stderr?.toString() || `ffmpeg exited ${decode.status}`,
		};
	}
	return { ok: true, pcm: decode.stdout };
}

function analyzeLeftChannel(pcm, startFrame = 0, endFrame = Number.POSITIVE_INFINITY) {
	const frameCount = Math.floor(pcm.length / (AUDIO_CHANNELS * 2));
	const start = Math.max(0, Math.min(frameCount, Math.floor(startFrame)));
	const end = Math.max(start, Math.min(frameCount, Math.floor(endFrame)));
	let sumSquares = 0;
	let peak = 0;
	let positiveCrossings = 0;
	let previous = null;
	for (let frame = start; frame < end; frame++) {
		const sample = pcm.readInt16LE(frame * AUDIO_CHANNELS * 2);
		const absolute = Math.abs(sample);
		peak = Math.max(peak, absolute);
		sumSquares += sample * sample;
		if (previous !== null && previous < 0 && sample >= 0) positiveCrossings++;
		previous = sample;
	}
	const samples = end - start;
	const duration = samples / AUDIO_SAMPLE_RATE;
	return {
		samples,
		rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
		peak,
		frequency: duration > 0 ? positiveCrossings / duration : 0,
	};
}

function assertAudioEvidence(label, file, expectedDurationSeconds) {
	const audio = probeAudio(file);
	if (!audio) {
		failures.push(`${label}: no readable audio stream`);
		return null;
	}
	if (
		audio.codec !== "aac" ||
		audio.sampleRate !== AUDIO_SAMPLE_RATE ||
		audio.channels !== AUDIO_CHANNELS
	) {
		failures.push(
			`${label}: unexpected audio shape ${audio.codec} ${audio.sampleRate}Hz/${audio.channels}ch`,
		);
	}
	if (
		!Number.isFinite(audio.packets) ||
		!Number.isFinite(audio.frames) ||
		audio.packets <= 0 ||
		audio.frames <= 0
	) {
		failures.push(
			`${label}: AAC track has no media (packets=${audio.packets}, frames=${audio.frames})`,
		);
	}
	if (
		!Number.isFinite(audio.duration) ||
		Math.abs(audio.duration - expectedDurationSeconds) > DURATION_TOLERANCE_SECONDS
	) {
		failures.push(
			`${label}: audio duration ${audio.duration}s differs from expected ${expectedDurationSeconds}s`,
		);
	}

	const decoded = decodeStereoPcm(file);
	if (!decoded.ok) {
		failures.push(`${label}: ffmpeg audio decode failed: ${decoded.error}`);
		return { ...audio, decodeOk: false };
	}
	const whole = analyzeLeftChannel(decoded.pcm);
	const windowFrames = Math.floor(AUDIO_SAMPLE_RATE * 0.25);
	const first = analyzeLeftChannel(decoded.pcm, 0, windowFrames);
	const totalFrames = Math.floor(decoded.pcm.length / (AUDIO_CHANNELS * 2));
	const last = analyzeLeftChannel(decoded.pcm, totalFrames - windowFrames, totalFrames);
	const toneAnalysisOptions = {
		channels: AUDIO_CHANNELS,
		sampleRate: AUDIO_SAMPLE_RATE,
		threshold: 200,
		expectedFrequency: TONE_HZ,
		frequencyTolerance: TONE_TOLERANCE_HZ,
	};
	const firstTone = analyzeAudibleSpan(decoded.pcm, 0, windowFrames, toneAnalysisOptions);
	const lastTone = analyzeAudibleSpan(
		decoded.pcm,
		totalFrames - windowFrames,
		totalFrames,
		toneAnalysisOptions,
	);
	const middle = analyzeLeftChannel(decoded.pcm, windowFrames, totalFrames - windowFrames);
	if (whole.rms < AUDIO_RMS_MIN || whole.peak < AUDIO_PEAK_MIN) {
		failures.push(
			`${label}: decoded tone is silent/too quiet (rms=${whole.rms.toFixed(1)}, peak=${whole.peak})`,
		);
	}
	if (Math.abs(middle.frequency - TONE_HZ) > TONE_TOLERANCE_HZ) {
		failures.push(
			`${label}: decoded tone frequency ${middle.frequency.toFixed(2)}Hz is not ${TONE_HZ}+/-${TONE_TOLERANCE_HZ}Hz`,
		);
	}
	for (const [position, analysis, tone] of [
		["first", first, firstTone],
		["last", last, lastTone],
	]) {
		if (analysis.rms < AUDIO_RMS_MIN || analysis.peak < AUDIO_PEAK_MIN) {
			failures.push(
				`${label}: ${position} 250ms has no retained tone (rms=${analysis.rms.toFixed(1)}, peak=${analysis.peak})`,
			);
		}
		if (Math.abs(tone.frequency - TONE_HZ) > TONE_TOLERANCE_HZ) {
			failures.push(
				`${label}: ${position} 250ms tone frequency ${tone.frequency.toFixed(2)}Hz is not ${TONE_HZ}+/-${TONE_TOLERANCE_HZ}Hz`,
			);
		}
		if (position === "last" && tone.trailingBelowThresholdFrames > AAC_FRAME_SAMPLES) {
			failures.push(
				`${label}: last 250ms has ${tone.trailingBelowThresholdFrames} trailing below-threshold frames (maximum one AAC frame / ${AAC_FRAME_SAMPLES})`,
			);
		}
		if (
			position === "last" &&
			tone.trailingWithoutValidToneFrames > MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES
		) {
			failures.push(
				`${label}: last 250ms has ${tone.trailingWithoutValidToneFrames} frames after the last valid ${TONE_HZ}Hz cycle window (maximum ${MAX_TRAILING_WITHOUT_VALID_TONE_FRAMES})`,
			);
		}
	}
	return {
		...audio,
		decodeOk: true,
		rms: whole.rms,
		peak: whole.peak,
		frequency: middle.frequency,
		firstRms: first.rms,
		lastRms: last.rms,
		firstFrequency: firstTone.frequency,
		lastFrequency: lastTone.frequency,
		lastTrailingBelowThresholdFrames: lastTone.trailingBelowThresholdFrames,
		lastTrailingWithoutValidToneFrames: lastTone.trailingWithoutValidToneFrames,
	};
}

// Normalizes one stdout line to its comparable shape: JSON lines keep every
// stable key AND value (schemaVersion, requested/applied, reason, ...) with
// only genuinely volatile values (output paths) masked; text lines have
// paths stripped.
function normalizeStdoutLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("{")) {
		try {
			const json = JSON.parse(trimmed);
			for (const volatileKey of ["screenPath", "webcamPath"]) {
				if (typeof json[volatileKey] === "string") {
					json[volatileKey] = "<path>";
				}
			}
			return `json:${JSON.stringify(json)}`;
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

function finishCaseArtifacts(label, files, failureCountAtStart) {
	const uniqueFiles = [...new Set(files)];
	if (failures.length === failureCountAtStart && !KEEP_ARTIFACTS) {
		for (const file of uniqueFiles) fs.rmSync(file, { force: true });
		return;
	}
	const existing = uniqueFiles.filter((file) => fs.existsSync(file));
	if (existing.length > 0) {
		console.log(`  ${label}: retained artifacts: ${existing.join(", ")}`);
	}
}

async function startLoopbackTone() {
	const available = spawnSync("ffplay", ["-version"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (available.status !== 0) {
		throw new Error(
			"CLOSESCREEN_PARITY_AUDIO=1 requires ffplay for the deterministic loopback tone.",
		);
	}
	const renderEndpointId = defaultRenderEndpointId();
	const startedAt = Date.now();
	const child = spawn(
		"ffplay",
		[
			"-nodisp",
			"-autoexit",
			"-loglevel",
			"quiet",
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=${TONE_HZ}:sample_rate=${AUDIO_SAMPLE_RATE},pan=stereo|c0=c0|c1=c0`,
		],
		{ stdio: "ignore", windowsHide: true },
	);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, 400);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			if (code !== null && code !== 0) {
				clearTimeout(timer);
				reject(new Error(`Loopback tone exited early with code ${code}.`));
			}
		});
	});
	child.stimulusStartedAt = startedAt;
	child.renderEndpointId = renderEndpointId;
	return child;
}

function assertLoopbackToneAlive(child, stage) {
	if (child.exitCode !== null || child.killed) {
		throw new Error(
			`Loopback tone was not alive ${stage} (exitCode=${child.exitCode}, killed=${child.killed}).`,
		);
	}
}

async function stopLoopbackTone(child) {
	if (child.exitCode !== null) return;
	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Loopback tone did not exit within 5 seconds.")),
			5000,
		);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		if (!child.kill()) {
			clearTimeout(timer);
			reject(new Error("Failed to terminate the loopback tone process."));
		}
	});
}

function defaultRenderEndpointId() {
	const probe = spawnSync(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			path.join(ROOT, "scripts", "get-windows-default-render-endpoint.ps1"),
		],
		{ encoding: "utf8", windowsHide: true },
	);
	if (probe.status !== 0 || !probe.stdout.trim()) {
		throw new Error(
			`Could not resolve the default eConsole render endpoint: ${probe.stderr || probe.stdout}`,
		);
	}
	return probe.stdout.trim();
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
	const failureCountAtStart = failures.length;
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
		results[label] = await runCapture(exe, config, {
			stopAfterStartedMs: RECORD_MS,
			pauseAfterStartedMs: 1000,
			pauseForMs: 1000,
		});
	}
	// The happy path must actually succeed — equal-but-nonzero exits or
	// missing outputs would otherwise sail through the parity diffs.
	for (const label of ["cpp", "rust"]) {
		if (results[label].code !== 0) {
			failures.push(`display: ${label} exited ${results[label].code} (expected 0)`);
		}
		for (const event of ["recording-paused", "recording-resumed"]) {
			if (!results[label].stdout.includes(`"event":"${event}"`)) {
				failures.push(`display: ${label} did not emit ${event}`);
			}
		}
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
	for (const label of ["cpp", "rust"]) {
		if (!meta[label]) {
			failures.push(`display: ffprobe could not read the ${label} output file`);
		}
	}
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
		for (const label of ["cpp", "rust"]) {
			if (meta[label].duration < 2.4 || meta[label].duration > 3.8) {
				failures.push(
					`display: ${label} duration ${meta[label].duration}s did not exclude the 1s pause`,
				);
			}
			assertTimeline(`display: ${label} video`, packetTimeline(outs[label], "v:0"));
		}
	}
	for (const label of ["cpp", "rust"]) {
		if (probeAudio(outs[label])) {
			failures.push(`display: ${label} no-audio capture unexpectedly contains an audio stream`);
		}
		if (packetTimeline(outs[label], "a:0")) {
			failures.push(`display: ${label} no-audio capture unexpectedly contains audio packets`);
		}
	}
	console.log(
		`  display: cpp ${meta.cpp?.duration}s / rust ${meta.rust?.duration}s @ ${meta.cpp?.width}x${meta.cpp?.height}`,
	);
	finishCaseArtifacts("display", Object.values(outs), failureCountAtStart);
}

// Case 1b (opt-in: CLOSESCREEN_PARITY_AUDIO=1 — needs a render endpoint):
// system-audio capture parity with a real, known-frequency render stimulus.
// A track header is not enough: this case requires non-zero AAC packets and
// frames, successful PCM decode, audible signal energy, tone identity, and
// retained samples at both capture boundaries.
if (process.env.CLOSESCREEN_PARITY_AUDIO === "1") {
	const failureCountAtStart = failures.length;
	const outs = { cpp: tempOut("cpp-audio"), rust: tempOut("rust-audio") };
	const results = {};
	const stimulusEvidence = {};
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
			captureSystemAudio: true,
			captureMic: false,
			webcamEnabled: false,
		};
		const stimulus = await startLoopbackTone();
		try {
			assertLoopbackToneAlive(stimulus, `before ${label} capture`);
			results[label] = await runCapture(exe, config, {
				stopAfterStartedMs: RECORD_MS,
				pauseAfterStartedMs: PAUSE_AFTER_MS,
				pauseForMs: PAUSE_FOR_MS,
			});
			assertLoopbackToneAlive(stimulus, `after ${label} capture`);
			stimulusEvidence[label] = {
				renderEndpointId: stimulus.renderEndpointId,
				aliveMs: results[label].closedAt - stimulus.stimulusStartedAt,
				captureOverlapMs:
					results[label].recordingStartedAt > 0 && results[label].stopSentAt > 0
						? results[label].stopSentAt - results[label].recordingStartedAt
						: 0,
			};
		} finally {
			await stopLoopbackTone(stimulus);
		}
	}
	for (const label of ["cpp", "rust"]) {
		if (results[label].code !== 0) {
			failures.push(`audio: ${label} exited ${results[label].code} (expected 0)`);
		}
		for (const event of ["recording-paused", "recording-resumed"]) {
			if (!results[label].stdout.includes(`"event":"${event}"`)) {
				failures.push(`audio: ${label} did not emit ${event}`);
			}
		}
		if (stimulusEvidence[label].captureOverlapMs < RECORD_MS - 100) {
			failures.push(
				`audio: ${label} tone overlapped capture for only ${stimulusEvidence[label].captureOverlapMs}ms`,
			);
		}
	}
	assertEqual(
		"audio: stdout sequence",
		normalizeStdout(results.cpp.stdout),
		normalizeStdout(results.rust.stdout),
	);
	assertEqual(
		"audio: stderr ERROR lines",
		normalizeStderr(results.cpp.stderr),
		normalizeStderr(results.rust.stderr),
	);
	const evidence = {
		cpp: assertAudioEvidence("audio: cpp", outs.cpp, EXPECTED_MEDIA_SECONDS),
		rust: assertAudioEvidence("audio: rust", outs.rust, EXPECTED_MEDIA_SECONDS),
	};
	assertEqual(
		"audio: stream shape",
		[evidence.cpp?.codec, evidence.cpp?.sampleRate, evidence.cpp?.channels],
		[evidence.rust?.codec, evidence.rust?.sampleRate, evidence.rust?.channels],
	);
	for (const label of ["cpp", "rust"]) {
		const videoTimeline = packetTimeline(outs[label], "v:0");
		const audioTimeline = packetTimeline(outs[label], "a:0");
		assertTimeline(`audio: ${label} video`, videoTimeline);
		assertTimeline(`audio: ${label} audio`, audioTimeline);
		if (
			videoTimeline &&
			audioTimeline &&
			(Math.abs(videoTimeline.first - audioTimeline.first) > START_DRIFT_MAX_SECONDS ||
				Math.abs(videoTimeline.end - audioTimeline.end) > END_DRIFT_MAX_SECONDS)
		) {
			failures.push(
				`audio: ${label} A/V timeline drift first=${Math.abs(videoTimeline.first - audioTimeline.first)}s end=${Math.abs(videoTimeline.end - audioTimeline.end)}s`,
			);
		}
	}
	console.log(
		`  audio: real AAC packets/frames cpp=${evidence.cpp?.packets}/${evidence.cpp?.frames} rust=${evidence.rust?.packets}/${evidence.rust?.frames}; decoded ${TONE_HZ}Hz tone retained across pause and stop`,
	);
	console.log(
		`  audio stimulus: endpoint=${stimulusEvidence.cpp.renderEndpointId}; cpp alive/overlap=${stimulusEvidence.cpp.aliveMs}/${stimulusEvidence.cpp.captureOverlapMs}ms; rust alive/overlap=${stimulusEvidence.rust.aliveMs}/${stimulusEvidence.rust.captureOverlapMs}ms`,
	);
	if (stimulusEvidence.cpp.renderEndpointId !== stimulusEvidence.rust.renderEndpointId) {
		failures.push(
			`audio: default render endpoint changed between helpers (${stimulusEvidence.cpp.renderEndpointId} -> ${stimulusEvidence.rust.renderEndpointId})`,
		);
	}
	finishCaseArtifacts("audio", Object.values(outs), failureCountAtStart);
} else {
	console.log(
		"  audio: skipped (set CLOSESCREEN_PARITY_AUDIO=1 on a machine with a render endpoint)",
	);
}

// Case 1c (opt-in: CLOSESCREEN_PARITY_WEBCAM=1 — needs a capture device that
// delivers VISIBLE frames; set CLOSESCREEN_PARITY_WEBCAM_DEVICE_NAME /
// _CLSID to pin one, e.g. a virtual camera): separate-webcam-file parity —
// webcam-format payloads, webcamPath in the stopped event, and both webcam
// mp4s carrying a real video stream.
if (process.env.CLOSESCREEN_PARITY_WEBCAM === "1") {
	const failureCountAtStart = failures.length;
	const outs = { cpp: tempOut("cpp-webcam"), rust: tempOut("rust-webcam") };
	const webcamOut = (f) => f.replace(/\.mp4$/i, "-webcam.mp4");
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
			webcamEnabled: true,
			webcamDeviceId: "",
			webcamDeviceName: process.env.CLOSESCREEN_PARITY_WEBCAM_DEVICE_NAME ?? "",
			webcamDirectShowClsid: process.env.CLOSESCREEN_PARITY_WEBCAM_CLSID ?? "",
			webcamWidth: 640,
			webcamHeight: 360,
			webcamFps: 30,
			outputs: { screenPath: outs[label], webcamPath: webcamOut(outs[label]) },
		};
		results[label] = await runCapture(exe, config, { stopAfterStartedMs: RECORD_MS });
	}
	for (const label of ["cpp", "rust"]) {
		if (results[label].code !== 0) {
			failures.push(`webcam: ${label} exited ${results[label].code} (expected 0)`);
		}
	}
	assertEqual(
		"webcam: stdout sequence",
		normalizeStdout(results.cpp.stdout),
		normalizeStdout(results.rust.stdout),
	);
	assertEqual(
		"webcam: stderr ERROR lines",
		normalizeStderr(results.cpp.stderr),
		normalizeStderr(results.rust.stderr),
	);
	// The webcam-format payloads must match on every field (same machine,
	// same device → same negotiated size/fps/name).
	const webcamFormat = (stdout) => {
		const line = stdout.split(/\r?\n/).find((l) => l.includes('"event":"webcam-format"'));
		return line ? JSON.parse(line) : null;
	};
	assertEqual(
		"webcam: webcam-format payload",
		webcamFormat(results.cpp.stdout),
		webcamFormat(results.rust.stdout),
	);
	for (const label of ["cpp", "rust"]) {
		const stopped = results[label].stdout
			.split(/\r?\n/)
			.find((l) => l.includes('"event":"recording-stopped"'));
		if (!stopped || !JSON.parse(stopped).webcamPath) {
			failures.push(`webcam: ${label} recording-stopped is missing webcamPath`);
		}
		const meta = ffprobeMeta(webcamOut(outs[label]));
		if (!meta || meta.codec !== "h264") {
			failures.push(`webcam: ${label} webcam output has no h264 stream (${JSON.stringify(meta)})`);
		}
		assertTimeline(`webcam: ${label}`, packetTimeline(webcamOut(outs[label]), "v:0"));
	}
	const meta = { cpp: ffprobeMeta(webcamOut(outs.cpp)), rust: ffprobeMeta(webcamOut(outs.rust)) };
	assertEqual(
		"webcam: webcam mp4 dims",
		[meta.cpp?.width, meta.cpp?.height],
		[meta.rust?.width, meta.rust?.height],
	);
	console.log(
		`  webcam: ${meta.cpp?.width}x${meta.cpp?.height} h264 on both (cpp ${meta.cpp?.duration}s / rust ${meta.rust?.duration}s)`,
	);
	finishCaseArtifacts(
		"webcam",
		Object.values(outs).flatMap((file) => [file, webcamOut(file)]),
		failureCountAtStart,
	);
} else {
	console.log(
		"  webcam: skipped (set CLOSESCREEN_PARITY_WEBCAM=1 on a machine with a frame-delivering capture device)",
	);
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
			child.once("close", (code) => {
				clearTimeout(killer);
				resolve({ code, stdout, stderr });
			});
		});
	}
	for (const label of ["cpp", "rust"]) {
		if (results[label].code === 0) {
			failures.push(`${tag}: ${label} exited 0 (expected a nonzero error exit)`);
		}
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
