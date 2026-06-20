// Synthetic-fault verification for issue #14 (wgc-capture WriteSample first-frame
// hang blocking shutdown). The real hang only occurs on certain GPU/driver
// configs and does NOT reproduce on this machine, so we inject the fault
// deterministically: CLOSESCREEN_WGC_FAULT_HANG_FIRST_FRAME=1 makes the native
// MFEncoder::writeFrame block forever on the first frame while holding
// writerMutex_, exactly like a wedged sinkWriter_->WriteSample().
//
// Expectation after the shutdown hardening:
//   - on `stop`, the helper detects the wedged writer within ~5s, skips the
//     finalize() that would deadlock on writerMutex_, prints a "video writer
//     wedged" diagnostic, and force-exits (code 1) — instead of hanging until
//     the Node parent force-kills it at 15s.
//
// RED before the fix: the helper never exits, this script's hard-kill fires at
// 13s and the run FAILS (proving the fault reproduces #14).
// GREEN after the fix: the helper exits within ~5-7s of stop with the wedged
// diagnostic, and the run PASSES.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HELPER_PATH =
	process.env.CLOSESCREEN_WGC_CAPTURE_EXE ??
	path.join(ROOT, "electron", "native", "bin", "win32-x64", "wgc-capture.exe");

// Must sit above the native detach timeout (5s) + margin, and below the Node
// parent's real 15s force-kill so a true hang is observed as a failure here.
const HARD_KILL_MS = 13_000;
const MAX_SHUTDOWN_MS = 12_000;

if (process.platform !== "win32") {
	console.log("Skipping WGC fault test: Windows-only.");
	process.exit(0);
}
if (!fs.existsSync(HELPER_PATH)) {
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
}

const outputPath = path.join(
	os.tmpdir(),
	`closescreen-wgc-fault-${process.pid}-${Date.now()}-${randomUUID()}.mp4`,
);

const config = {
	schemaVersion: 2,
	recordingId: Date.now(),
	outputPath,
	sourceType: "display",
	sourceId: "screen:0:0",
	displayId: 0,
	fps: 30,
	videoWidth: 1280,
	videoHeight: 720,
	displayX: 0,
	displayY: 0,
	displayW: 1920,
	displayH: 1080,
	hasDisplayBounds: true,
	captureSystemAudio: false,
	captureMic: false,
	captureCursor: false,
	outputs: { screenPath: outputPath },
};

const child = spawn(HELPER_PATH, [JSON.stringify(config)], {
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
	env: { ...process.env, CLOSESCREEN_WGC_FAULT_HANG_FIRST_FRAME: "1" },
});

let stdout = "";
let stderr = "";
let stopSentAt = 0;
child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	if (
		!stopSentAt &&
		(stdout.includes('"recording-started"') || stdout.includes("Recording started"))
	) {
		stopSentAt = Date.now();
		child.stdin.write("stop\n");
	}
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});

const result = await new Promise((resolve) => {
	const killTimer = setTimeout(() => {
		try {
			child.kill();
		} catch {}
		resolve({ timedOut: true, code: null, ms: stopSentAt ? Date.now() - stopSentAt : -1 });
	}, HARD_KILL_MS);
	child.once("exit", (code) => {
		clearTimeout(killTimer);
		resolve({ timedOut: false, code, ms: stopSentAt ? Date.now() - stopSentAt : -1 });
	});
	child.once("error", (err) => {
		clearTimeout(killTimer);
		resolve({ timedOut: false, error: String(err), code: null, ms: -1 });
	});
});

// A wedged recording leaves a non-finalized (unplayable) mp4; just clean it up.
try {
	if (fs.existsSync(outputPath)) {
		fs.unlinkSync(outputPath);
	}
} catch {}

const wedgedDiagnostic = /video writer wedged/i.test(stderr);
const startedCapture = stopSentAt > 0;
const pass =
	!result.timedOut &&
	startedCapture &&
	result.ms >= 0 &&
	result.ms < MAX_SHUTDOWN_MS &&
	wedgedDiagnostic;

console.log(
	JSON.stringify(
		{
			faultHangShutdown: pass ? "passed" : "FAILED",
			startedCapture,
			timedOut: result.timedOut,
			exitCode: result.code,
			msFromStopToExit: result.ms,
			wedgedDiagnostic,
		},
		null,
		2,
	),
);

if (!pass) {
	if (!startedCapture) {
		console.error("FAIL: capture never started, so the fault path was not exercised.");
	} else if (result.timedOut) {
		console.error(
			`FAIL: helper did not exit within ${HARD_KILL_MS}ms after stop — the shutdown hang is NOT fixed (issue #14 reproduced).`,
		);
	} else {
		console.error("FAIL: helper exited but wedged-shutdown expectations were not met (see above).");
	}
	process.exit(1);
}
console.log("PASS: wedged writer detected; process force-exited cleanly instead of hanging.");
process.exit(0);
