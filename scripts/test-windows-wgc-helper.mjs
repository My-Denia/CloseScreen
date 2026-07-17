import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BACKEND_ARG_INDEX = process.argv.indexOf("--backend");
const BACKEND_OVERRIDE = process.env.CLOSESCREEN_WGC_CAPTURE_EXE?.trim();
const BACKEND =
	BACKEND_ARG_INDEX >= 0
		? process.argv[BACKEND_ARG_INDEX + 1]
		: BACKEND_OVERRIDE
			? "custom"
			: "all";
if (BACKEND === "all") {
	const forwarded = process.argv
		.slice(2)
		.filter((value, index, values) => value !== "--backend" && values[index - 1] !== "--backend");
	for (const backend of ["rust", "legacy"]) {
		const result = spawnSync(process.execPath, [SCRIPT_PATH, "--backend", backend, ...forwarded], {
			stdio: "inherit",
			windowsHide: true,
			env: process.env,
		});
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
	process.exit(0);
}
if (
	!["rust", "legacy", "custom"].includes(BACKEND) ||
	(BACKEND === "custom" && !BACKEND_OVERRIDE)
) {
	throw new Error(
		"--backend must be rust or legacy (custom requires CLOSESCREEN_WGC_CAPTURE_EXE).",
	);
}
const HELPER_PATH =
	(BACKEND === "custom" ? BACKEND_OVERRIDE : undefined) ??
	path.join(
		ROOT,
		"electron",
		"native",
		"bin",
		"win32-x64",
		BACKEND === "legacy" ? "wgc-capture-legacy.exe" : "wgc-capture.exe",
	);

const DURATION_MS = Number(process.env.CLOSESCREEN_WGC_TEST_DURATION_MS ?? 5000);
const POST_STOP_TIMEOUT_MS = Number(process.env.CLOSESCREEN_WGC_POST_STOP_TIMEOUT_MS ?? 9000);
if (!Number.isFinite(POST_STOP_TIMEOUT_MS) || POST_STOP_TIMEOUT_MS <= 0) {
	throw new Error("CLOSESCREEN_WGC_POST_STOP_TIMEOUT_MS must be a positive number.");
}
const WITH_SYSTEM_AUDIO =
	process.env.CLOSESCREEN_WGC_TEST_SYSTEM_AUDIO === "true" ||
	process.argv.includes("--system-audio");
const WITH_MICROPHONE =
	process.env.CLOSESCREEN_WGC_TEST_MICROPHONE === "true" ||
	process.argv.includes("--microphone") ||
	process.argv.includes("--mic");
const WITH_WINDOW =
	process.env.CLOSESCREEN_WGC_TEST_WINDOW === "true" || process.argv.includes("--window");
const WITH_WEBCAM =
	process.env.CLOSESCREEN_WGC_TEST_WEBCAM === "true" || process.argv.includes("--webcam");
const CAPTURE_CURSOR =
	process.env.CLOSESCREEN_WGC_TEST_CAPTURE_CURSOR === "true" ||
	process.argv.includes("--capture-cursor");
const SYSTEM_AUDIO_TONE_HZ = 997;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_RMS_MIN = 500;
const AUDIO_PEAK_MIN = 2000;
const TONE_TOLERANCE_HZ = 10;
const KEEP_ARTIFACTS = process.env.CLOSESCREEN_WGC_KEEP_ARTIFACTS === "1";

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

async function startLoopbackTone() {
	const available = spawnSync("ffplay", ["-version"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (available.status !== 0) {
		throw new Error("--system-audio requires ffplay for the deterministic loopback tone.");
	}
	const renderEndpointId = defaultRenderEndpointId();
	const stimulusStartedAt = Date.now();
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
			`sine=frequency=${SYSTEM_AUDIO_TONE_HZ}:sample_rate=${AUDIO_SAMPLE_RATE},pan=stereo|c0=c0|c1=c0`,
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
	child.stimulusStartedAt = stimulusStartedAt;
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

function runHelper(config) {
	return new Promise((resolve, reject) => {
		const child = spawn(HELPER_PATH, [JSON.stringify(config)], {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let stopTimer = null;
		let postStopTimer = null;
		let stopTimedOut = false;
		let stopSentAt = 0;
		let recordingStartedAt = 0;
		const scheduleStop = () => {
			if (stopTimer) {
				return;
			}
			stopTimer = setTimeout(() => {
				stopSentAt = Date.now();
				child.stdin.write("stop\n");
				postStopTimer = setTimeout(() => {
					stopTimedOut = true;
					child.kill();
				}, POST_STOP_TIMEOUT_MS);
			}, DURATION_MS);
		};
		const fallbackTimer = setTimeout(scheduleStop, 15_000);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.includes('"recording-started"') || stdout.includes("Recording started")) {
				if (recordingStartedAt === 0) recordingStartedAt = Date.now();
				scheduleStop();
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			clearTimeout(fallbackTimer);
			if (postStopTimer) clearTimeout(postStopTimer);
			if (stopTimer) {
				clearTimeout(stopTimer);
			}
			if (stopTimedOut) {
				reject(
					new Error(
						`${BACKEND} WGC helper exceeded the ${POST_STOP_TIMEOUT_MS}ms post-stop deadline\n${stdout}\n${stderr}`,
					),
				);
				return;
			}
			resolve({
				code,
				stdout,
				stderr,
				postStopMs: stopSentAt > 0 ? Date.now() - stopSentAt : null,
				stopSentAt,
				recordingStartedAt,
				closedAt: Date.now(),
			});
		});
	});
}

function startMspaintFixtureWindow() {
	return new Promise((resolve, reject) => {
		const child = spawn("mspaint.exe", [], {
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: false,
		});

		const poll = setInterval(() => {
			const lookup = spawnSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					`(Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue).MainWindowHandle`,
				],
				{ encoding: "utf8", windowsHide: true },
			);
			const handle = lookup.stdout
				.trim()
				.split(/\r?\n/)
				.find((line) => /^\d+$/.test(line.trim()));
			if (handle && handle !== "0") {
				clearInterval(poll);
				clearTimeout(timer);
				resolve({ child, sourceId: `window:${handle.trim()}:0` });
			}
		}, 250);

		const timer = setTimeout(() => {
			clearInterval(poll);
			child.kill();
			reject(new Error("Timed out waiting for fixture window handle"));
		}, 10_000);
		child.once("error", (error) => {
			clearInterval(poll);
			clearTimeout(timer);
			reject(error);
		});
	});
}

// Self-contained fallback for machines where mspaint is a Store stub or
// missing entirely: a WinForms window with a bright filled body, so the
// non-black first-frame assertion still has content to see.
function startWinFormsFixtureWindow() {
	return new Promise((resolve, reject) => {
		// The fixture must keep repainting: WGC's initial frame for a window
		// can predate its first composition (black), and a static window
		// produces no further dirty updates to replace it. A bright color
		// cycle keeps frames flowing and the luma assertion meaningful.
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			"$form = New-Object System.Windows.Forms.Form",
			"$form.Text = 'closescreen wgc capture fixture'",
			"$form.Width = 960",
			"$form.Height = 640",
			"$form.BackColor = [System.Drawing.Color]::White",
			"$form.TopMost = $true",
			"$script:tick = 0",
			"$paint = New-Object System.Windows.Forms.Timer",
			"$paint.Interval = 100",
			"$paint.add_Tick({ $script:tick++; $form.BackColor = if ($script:tick % 2) { [System.Drawing.Color]::White } else { [System.Drawing.Color]::Gainsboro }; $form.Invalidate() })",
			"$announce = New-Object System.Windows.Forms.Timer",
			"$announce.Interval = 750",
			'$announce.add_Tick({ $announce.Stop(); [Console]::Out.WriteLine("HWND:" + $form.Handle.ToInt64()); [Console]::Out.Flush() })',
			"$form.add_Shown({ $form.Refresh(); $paint.Start(); $announce.Start() })",
			"[System.Windows.Forms.Application]::Run($form)",
		].join("; ");
		const child = spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				script,
			],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: false },
		);

		let buffer = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("Timed out waiting for WinForms fixture window handle"));
		}, 10_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			const match = buffer.match(/HWND:(\d+)/);
			if (match) {
				clearTimeout(timer);
				resolve({ child, sourceId: `window:${match[1]}:0` });
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			reject(new Error("WinForms fixture process exited before reporting a handle"));
		});
	});
}

async function startFixtureWindow() {
	try {
		return await startMspaintFixtureWindow();
	} catch (error) {
		console.warn(`mspaint fixture unavailable (${error.message}); using WinForms fixture.`);
		return startWinFormsFixtureWindow();
	}
}

function normalizeDeviceName(value) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function scoreDeviceName(candidateName, candidateId, requestedName) {
	const candidate = normalizeDeviceName(candidateName ?? "");
	const id = normalizeDeviceName(candidateId ?? "");
	const requested = normalizeDeviceName(requestedName ?? "");
	if (!requested) return 0;
	if (candidate === requested) return 1000;
	if (candidate.includes(requested) || requested.includes(candidate)) return 900;
	if (id.includes(requested) || requested.includes(id)) return 800;
	return requested
		.split(/\s+/)
		.filter((word) => word.length > 1 && !["camera", "webcam", "video", "input"].includes(word))
		.reduce((score, word) => {
			if (candidate.includes(word)) return score + 100;
			if (id.includes(word)) return score + 50;
			return score;
		}, 0);
}

function resolveDirectShowWebcamClsid(requestedName) {
	if (!requestedName) return "";
	const query = spawnSync(
		"reg.exe",
		["query", "HKCR\\CLSID\\{860BB310-5D01-11D0-BD3B-00A0C911CE86}\\Instance", "/s"],
		{ encoding: "utf8", windowsHide: true },
	);
	if (query.status !== 0) return "";
	const entries = [];
	let current = {};
	for (const rawLine of query.stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		if (/^HKEY_/i.test(line)) {
			if (current.friendlyName || current.clsid) entries.push(current);
			current = {};
			continue;
		}
		const match = line.match(/^(\S+)\s+REG_SZ\s+(.+)$/);
		if (!match) continue;
		if (match[1] === "FriendlyName") current.friendlyName = match[2].trim();
		if (match[1] === "CLSID") current.clsid = match[2].trim();
	}
	if (current.friendlyName || current.clsid) entries.push(current);

	let best = null;
	for (const entry of entries) {
		if (!entry.clsid) continue;
		const score = scoreDeviceName(entry.friendlyName, entry.clsid, requestedName);
		if (!best || score > best.score) {
			best = { ...entry, score };
		}
	}
	return best && best.score > 0 ? best.clsid : "";
}

function probeStreams(outputPath) {
	const ffprobe = spawnSync(
		"ffprobe",
		["-v", "error", "-count_packets", "-count_frames", "-show_streams", "-of", "json", outputPath],
		{ encoding: "utf8", windowsHide: true },
	);
	if (ffprobe.status !== 0) {
		throw new Error(`ffprobe failed: ${ffprobe.stderr || ffprobe.stdout}`);
	}
	return JSON.parse(ffprobe.stdout).streams ?? [];
}

function decodeAudioEvidence(outputPath) {
	const ffmpeg = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-xerror",
			"-i",
			outputPath,
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
		{ windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
	);
	if (ffmpeg.status !== 0 || !ffmpeg.stdout?.length) {
		throw new Error(
			`ffmpeg did not decode AAC frames from ${outputPath}: ${ffmpeg.stderr?.toString() ?? ""}`,
		);
	}
	let sumSquares = 0;
	let peak = 0;
	let samples = 0;
	let positiveCrossings = 0;
	let previous = null;
	const totalFrames = Math.floor(ffmpeg.stdout.length / (AUDIO_CHANNELS * 2));
	const edgeFrames = Math.floor(AUDIO_SAMPLE_RATE * 0.25);
	const frequencyStart = Math.min(edgeFrames, totalFrames);
	const frequencyEnd = Math.max(frequencyStart, totalFrames - edgeFrames);
	for (let offset = 0; offset + 3 < ffmpeg.stdout.length; offset += AUDIO_CHANNELS * 2) {
		const frame = offset / (AUDIO_CHANNELS * 2);
		const sample = ffmpeg.stdout.readInt16LE(offset);
		sumSquares += sample * sample;
		peak = Math.max(peak, Math.abs(sample));
		samples++;
		if (frame >= frequencyStart && frame < frequencyEnd) {
			if (previous !== null && previous < 0 && sample >= 0) positiveCrossings++;
			previous = sample;
		}
	}
	const frequencyDuration = (frequencyEnd - frequencyStart) / AUDIO_SAMPLE_RATE;
	return {
		decodedFrames: samples,
		rms: samples > 0 ? Math.sqrt(sumSquares / samples) : 0,
		peak,
		frequency: frequencyDuration > 0 ? positiveCrossings / frequencyDuration : 0,
	};
}

function measureFirstFrameLuma(outputPath) {
	const ffmpeg = spawnSync(
		"ffmpeg",
		[
			"-v",
			"error",
			"-i",
			outputPath,
			"-frames:v",
			"1",
			"-f",
			"rawvideo",
			"-pix_fmt",
			"gray",
			"pipe:1",
		],
		{ windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
	);
	if (ffmpeg.status !== 0) {
		throw new Error(`ffmpeg frame extraction failed: ${ffmpeg.stderr?.toString() ?? ""}`);
	}
	const data = ffmpeg.stdout;
	if (!data || data.length === 0) {
		throw new Error(`ffmpeg did not return frame data for ${outputPath}`);
	}
	let sum = 0;
	let max = 0;
	for (const value of data) {
		sum += value;
		if (value > max) {
			max = value;
		}
	}
	return { average: sum / data.length, max };
}

if (process.platform !== "win32") {
	console.log("Skipping WGC helper smoke test: Windows-only.");
	process.exit(0);
}

if (!fs.existsSync(HELPER_PATH)) {
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
}

const outputPath = path.join(
	os.tmpdir(),
	`closescreen-wgc-helper-${WITH_WEBCAM ? "webcam" : WITH_WINDOW ? "window" : WITH_SYSTEM_AUDIO || WITH_MICROPHONE ? "audio" : "video"}-${process.pid}-${Date.now()}-${randomUUID()}.mp4`,
);
const webcamOutputPath = WITH_WEBCAM ? outputPath.replace(/\.mp4$/i, "-webcam.mp4") : null;

const fixtureWindow = WITH_WINDOW ? await startFixtureWindow() : null;
let systemAudioStimulus = null;
try {
	systemAudioStimulus = WITH_SYSTEM_AUDIO ? await startLoopbackTone() : null;
} catch (error) {
	fixtureWindow?.child.kill();
	throw error;
}

const config = {
	schemaVersion: 2,
	recordingId: Date.now(),
	outputPath,
	sourceType: fixtureWindow ? "window" : "display",
	sourceId: fixtureWindow ? fixtureWindow.sourceId : "screen:0:0",
	displayId: 0,
	fps: 30,
	videoWidth: 1280,
	videoHeight: 720,
	displayX: 0,
	displayY: 0,
	displayW: 1920,
	displayH: 1080,
	hasDisplayBounds: true,
	captureSystemAudio: WITH_SYSTEM_AUDIO,
	captureMic: WITH_MICROPHONE,
	captureCursor: CAPTURE_CURSOR,
	microphoneDeviceId: process.env.CLOSESCREEN_WGC_TEST_MICROPHONE_DEVICE_ID ?? "default",
	microphoneDeviceName: process.env.CLOSESCREEN_WGC_TEST_MICROPHONE_DEVICE_NAME ?? "",
	microphoneGain: 1.4,
	webcamEnabled: WITH_WEBCAM,
	webcamDeviceId: process.env.CLOSESCREEN_WGC_TEST_WEBCAM_DEVICE_ID ?? "",
	webcamDeviceName: process.env.CLOSESCREEN_WGC_TEST_WEBCAM_DEVICE_NAME ?? "",
	webcamDirectShowClsid: resolveDirectShowWebcamClsid(
		process.env.CLOSESCREEN_WGC_TEST_WEBCAM_DEVICE_NAME ?? "",
	),
	webcamWidth: 640,
	webcamHeight: 360,
	webcamFps: 30,
	outputs: {
		screenPath: outputPath,
		...(webcamOutputPath ? { webcamPath: webcamOutputPath } : {}),
	},
};

let result;
try {
	if (systemAudioStimulus) {
		assertLoopbackToneAlive(systemAudioStimulus, "before capture");
	}
	result = await runHelper(config);
	if (systemAudioStimulus) {
		assertLoopbackToneAlive(systemAudioStimulus, "after capture");
	}
} finally {
	if (fixtureWindow) {
		fixtureWindow.child.kill();
	}
	if (systemAudioStimulus) {
		await stopLoopbackTone(systemAudioStimulus);
	}
}
if (result.code !== 0) {
	if (
		WITH_WEBCAM &&
		/No native Windows webcam devices were found|Failed to initialize native webcam/.test(
			result.stderr,
		)
	) {
		console.log("Skipping WGC webcam smoke test: no native Windows webcam device is available.");
		process.exit(0);
	}
	throw new Error(`WGC helper exited with ${result.code}\n${result.stdout}\n${result.stderr}`);
}
if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
	throw new Error(`WGC helper did not produce a video at ${outputPath}`);
}
if (WITH_WEBCAM && (!fs.existsSync(webcamOutputPath) || fs.statSync(webcamOutputPath).size === 0)) {
	throw new Error(`WGC helper did not produce a webcam video at ${webcamOutputPath}`);
}

const streams = probeStreams(outputPath);
const webcamStreams =
	webcamOutputPath && fs.existsSync(webcamOutputPath) ? probeStreams(webcamOutputPath) : [];
const hasVideo = streams.some((stream) => stream.codec_type === "video");
const audioStream = streams.find((stream) => stream.codec_type === "audio");
const hasAudio = Boolean(audioStream);
const webcamFormatLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"webcam-format"'));
const webcamFormat = webcamFormatLine ? JSON.parse(webcamFormatLine) : null;
const audioFormatLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"audio-format"'));
const audioFormat = audioFormatLine ? JSON.parse(audioFormatLine) : null;
const cursorCaptureLine = result.stdout
	.split(/\r?\n/)
	.find((line) => line.includes('"event":"cursor-capture"'));
const cursorCapture = cursorCaptureLine ? JSON.parse(cursorCaptureLine) : null;
const nativeWebcamDiagnostics = result.stderr
	.split(/\r?\n/)
	.filter((line) => line.includes("Native webcam candidate"));
const nativeMicrophoneDiagnostics = result.stderr
	.split(/\r?\n/)
	.filter(
		(line) =>
			line.includes("Native microphone candidate") ||
			line.includes("Selected native microphone endpoint"),
	);
if (!hasVideo) {
	throw new Error(`WGC helper output has no video stream: ${outputPath}`);
}
if (WITH_WEBCAM && !webcamStreams.some((stream) => stream.codec_type === "video")) {
	throw new Error(`WGC helper webcam output has no video stream: ${webcamOutputPath}`);
}
if (
	(CAPTURE_CURSOR && !cursorCapture) ||
	(cursorCapture &&
		(cursorCapture.requested !== CAPTURE_CURSOR || cursorCapture.applied !== CAPTURE_CURSOR))
) {
	throw new Error(
		`WGC helper did not apply requested cursor capture mode (${CAPTURE_CURSOR}): ${result.stdout}`,
	);
}
if ((WITH_SYSTEM_AUDIO || WITH_MICROPHONE) && !hasAudio) {
	throw new Error(`WGC helper output has no audio stream: ${outputPath}`);
}
if (!WITH_SYSTEM_AUDIO && !WITH_MICROPHONE && hasAudio) {
	throw new Error(
		`WGC helper no-audio output unexpectedly contains an audio stream: ${outputPath}`,
	);
}
let audioEvidence = null;
if (audioStream) {
	const packets = Number(audioStream.nb_read_packets ?? 0);
	const frames = Number(audioStream.nb_read_frames ?? 0);
	if (
		audioStream.codec_name !== "aac" ||
		!Number.isFinite(packets) ||
		!Number.isFinite(frames) ||
		packets <= 0 ||
		frames <= 0
	) {
		throw new Error(
			`WGC helper did not produce real AAC media: codec=${audioStream.codec_name} packets=${packets} frames=${frames}`,
		);
	}
	if (
		WITH_SYSTEM_AUDIO &&
		(Number(audioStream.sample_rate) !== AUDIO_SAMPLE_RATE ||
			Number(audioStream.channels) !== AUDIO_CHANNELS)
	) {
		throw new Error(
			`WGC helper system audio has unexpected shape: ${audioStream.sample_rate}Hz/${audioStream.channels}ch`,
		);
	}
	audioEvidence = {
		packets,
		frames,
		...decodeAudioEvidence(outputPath),
	};
	if (
		WITH_SYSTEM_AUDIO &&
		(audioEvidence.rms < AUDIO_RMS_MIN ||
			audioEvidence.peak < AUDIO_PEAK_MIN ||
			Math.abs(audioEvidence.frequency - SYSTEM_AUDIO_TONE_HZ) > TONE_TOLERANCE_HZ)
	) {
		throw new Error(
			`Decoded system-audio tone mismatch: rms=${audioEvidence.rms.toFixed(1)} peak=${audioEvidence.peak} frequency=${audioEvidence.frequency.toFixed(2)}Hz`,
		);
	}
}
const frameLuma = measureFirstFrameLuma(outputPath);
if (frameLuma.average < 1 && frameLuma.max < 5) {
	throw new Error(
		`WGC helper output first frame is black: ${outputPath}\n${result.stdout}\n${result.stderr}`,
	);
}

console.log(
	JSON.stringify(
		{
			success: true,
			backend: BACKEND,
			helperPath: HELPER_PATH,
			postStopMs: result.postStopMs,
			artifactsRetained: KEEP_ARTIFACTS,
			renderEndpointId: systemAudioStimulus?.renderEndpointId,
			toneAliveMs: systemAudioStimulus
				? result.closedAt - systemAudioStimulus.stimulusStartedAt
				: undefined,
			toneCaptureOverlapMs:
				systemAudioStimulus && result.recordingStartedAt > 0 && result.stopSentAt > 0
					? result.stopSentAt - result.recordingStartedAt
					: undefined,
			outputPath,
			webcamOutputPath,
			bytes: fs.statSync(outputPath).size,
			webcamBytes:
				webcamOutputPath && fs.existsSync(webcamOutputPath)
					? fs.statSync(webcamOutputPath).size
					: undefined,
			streams: streams.map((stream) => ({
				index: stream.index,
				codecType: stream.codec_type,
				codecName: stream.codec_name,
				duration: stream.duration,
			})),
			webcamStreams: webcamStreams.map((stream) => ({
				index: stream.index,
				codecType: stream.codec_type,
				codecName: stream.codec_name,
				width: stream.width,
				height: stream.height,
				duration: stream.duration,
			})),
			cursorCapture,
			selectedMicrophoneDeviceName: audioFormat?.microphoneDeviceName,
			selectedWebcamDeviceName: webcamFormat?.deviceName,
			nativeMicrophoneDiagnostics,
			nativeWebcamDiagnostics,
			audioEvidence,
			firstFrameLuma: frameLuma,
		},
		null,
		2,
	),
);

if (!KEEP_ARTIFACTS) {
	fs.rmSync(outputPath, { force: true });
	if (webcamOutputPath) fs.rmSync(webcamOutputPath, { force: true });
}
