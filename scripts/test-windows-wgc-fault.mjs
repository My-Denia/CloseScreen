// Synthetic-fault verification for issue #14 (wgc-capture WriteSample first-frame
// hang blocking shutdown). The real hang only occurs on certain GPU/driver
// configs and does NOT reproduce on this machine, so we inject the fault
// deterministically: CLOSESCREEN_WGC_FAULT_HANG_FIRST_FRAME=1 makes the native
// MFEncoder::writeFrame block forever on the first frame while holding
// writerMutex_, exactly like a wedged sinkWriter_->WriteSample().
//
// Expectation after the shutdown hardening:
//   - on `stop`, the helper detects the wedged writer within ~5s, skips the
//     finalize()/writeAudio()/session.stop() paths that would deadlock on
//     writerMutex_ (or race the detached thread), prints a "video writer wedged"
//     diagnostic, and force-exits (code 1) — instead of hanging until the Node
//     parent force-kills it at 15s.
//
// Pass `--audio` to also enable system-audio capture. This exercises the audio
// shutdown path (AudioMixer::stop joins a thread that calls writeAudio(), which
// takes the same writerMutex_): the wedged-writer detection must run BEFORE the
// audio stop, or audio recordings would still hang (issue #14, Codex review).
//
// RED before the fix: the helper never exits; the post-stop hard-kill fires and
// the run FAILS (proving the fault reproduces #14).
// GREEN after the fix: the helper exits within a few seconds of stop with the
// wedged diagnostic, and the run PASSES.

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

const WITH_AUDIO =
	process.argv.includes("--audio") || process.env.CLOSESCREEN_WGC_FAULT_AUDIO === "true";

// Wait this long for the [fault] marker (writer actually inside writeFrame)
// before giving up — WGC startup + first frame can be slow on loaded machines.
const STARTUP_TIMEOUT_MS = 20_000;
// Hard-kill budget measured FROM the stop signal (not spawn), so a slow startup
// never eats into the post-stop shutdown window. Must exceed the native 5s
// detach + margin and stay under the Node parent's real 15s force-kill.
const POST_STOP_KILL_MS = 10_000;
// A correct wedged shutdown force-exits ~5s after stop; allow margin.
const MAX_SHUTDOWN_MS = 9_000;

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
	captureSystemAudio: WITH_AUDIO,
	captureMic: false,
	captureCursor: false,
	outputs: { screenPath: outputPath },
};

const child = spawn(HELPER_PATH, [JSON.stringify(config)], {
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
	env: { ...process.env, CLOSESCREEN_WGC_FAULT_HANG_FIRST_FRAME: "1" },
});

let stderr = "";
let stopSentAt = 0;

const result = await new Promise((resolve) => {
	let killTimer = null;
	let settled = false;
	const settle = (value) => {
		if (settled) return;
		settled = true;
		resolve(value);
	};

	// Give up if the writer never reaches writeFrame (capture failed / fault env
	// ignored). Don't send stop blindly — that would let the writer exit normally
	// and hide a real regression.
	const startupTimer = setTimeout(() => {
		try {
			child.kill();
		} catch {
			/* ignore: process may already be gone */
		}
		settle({ outcome: "no-fault", code: null, ms: -1 });
	}, STARTUP_TIMEOUT_MS);

	const sendStopOnceWedged = () => {
		if (stopSentAt) return;
		stopSentAt = Date.now();
		clearTimeout(startupTimer);
		child.stdin.write("stop\n");
		// Arm the hard-kill relative to stop (P3), not spawn.
		killTimer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ignore: process may already be gone */
			}
			settle({ outcome: "timeout", code: null, ms: Date.now() - stopSentAt });
		}, POST_STOP_KILL_MS);
	};

	// Drain stdout so its pipe never fills and blocks the child.
	child.stdout.resume();
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
		// Only stop once the writer is genuinely wedged inside writeFrame (the
		// [fault] marker), not merely when capture started (P2). Stopping earlier
		// can race ahead of the writer, which then exits normally and never
		// triggers the fault.
		if (!stopSentAt && stderr.includes("[fault]")) {
			sendStopOnceWedged();
		}
	});
	child.once("exit", (code) => {
		if (killTimer) clearTimeout(killTimer);
		clearTimeout(startupTimer);
		settle({ outcome: "exited", code, ms: stopSentAt ? Date.now() - stopSentAt : -1 });
	});
	child.once("error", (err) => {
		if (killTimer) clearTimeout(killTimer);
		clearTimeout(startupTimer);
		settle({ outcome: "error", error: String(err), code: null, ms: -1 });
	});
});

// A wedged recording leaves a non-finalized (unplayable) mp4; just clean it up.
try {
	if (fs.existsSync(outputPath)) {
		fs.unlinkSync(outputPath);
	}
} catch {
	/* ignore: cleanup is best-effort */
}

const faultTriggered = /\[fault\]/.test(stderr) && stopSentAt > 0;
const wedgedDiagnostic = /video writer wedged/i.test(stderr);
const pass =
	result.outcome === "exited" &&
	faultTriggered &&
	result.code === 1 &&
	result.ms >= 0 &&
	result.ms < MAX_SHUTDOWN_MS &&
	wedgedDiagnostic;

console.log(
	JSON.stringify(
		{
			faultHangShutdown: pass ? "passed" : "FAILED",
			audio: WITH_AUDIO,
			outcome: result.outcome,
			faultTriggered,
			exitCode: result.code,
			msFromStopToExit: result.ms,
			wedgedDiagnostic,
		},
		null,
		2,
	),
);

if (!pass) {
	if (result.outcome === "no-fault" || !faultTriggered) {
		console.error(
			"FAIL: the [fault] marker never appeared — capture or fault injection did not trigger, so the shutdown path was not exercised.",
		);
	} else if (result.outcome === "timeout") {
		console.error(
			`FAIL: helper did not exit within ${POST_STOP_KILL_MS}ms after stop — the shutdown hang is NOT fixed (issue #14 reproduced${WITH_AUDIO ? ", audio path" : ""}).`,
		);
	} else {
		console.error("FAIL: helper exited but wedged-shutdown expectations were not met (see above).");
	}
	process.exit(1);
}
console.log(
	`PASS: wedged writer detected${WITH_AUDIO ? " with audio enabled" : ""}; process force-exited cleanly instead of hanging.`,
);
process.exit(0);
