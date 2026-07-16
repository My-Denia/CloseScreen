// Black-box protocol test for cursor-sampler.exe (the native cursor helper
// spawned by electron/native-bridge/cursor/recording/windowsNativeRecordingSession.ts).
//
// Asserts the stdout contract the TS session depends on: `ready` as the
// first line within 5s, zero error events, sample cadence, exact sample and
// asset field order, handle/bounds/PNG shapes, and a flat --gdi-leak-test.
// Runs against both packaged/staged backends by default. Use
// --backend rust|legacy to isolate one, or CLOSESCREEN_CURSOR_SAMPLER_EXE
// for a diagnostic custom executable.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BACKEND_ARG_INDEX = process.argv.indexOf("--backend");
const BACKEND_OVERRIDE = process.env.CLOSESCREEN_CURSOR_SAMPLER_EXE?.trim();
const BACKEND =
	BACKEND_ARG_INDEX >= 0
		? process.argv[BACKEND_ARG_INDEX + 1]
		: BACKEND_OVERRIDE
			? "custom"
			: "all";
if (BACKEND === "all") {
	for (const backend of ["rust", "legacy"]) {
		const result = spawnSync(process.execPath, [SCRIPT_PATH, "--backend", backend], {
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
		"--backend must be rust or legacy (custom requires CLOSESCREEN_CURSOR_SAMPLER_EXE).",
	);
}

const READY_TIMEOUT_MS = 5000;
const SAMPLE_INTERVAL_MS = 25;
const RUN_DURATION_MS = Number(process.env.CLOSESCREEN_CURSOR_SAMPLER_TEST_DURATION_MS ?? 1500);

const SAMPLE_KEY_ORDER = [
	"type",
	"timestampMs",
	"x",
	"y",
	"visible",
	"handle",
	"cursorType",
	"leftButtonDown",
	"leftButtonPressed",
	"leftButtonReleased",
	"bounds",
	"asset",
];
const ASSET_KEY_ORDER = [
	"id",
	"imageDataUrl",
	"width",
	"height",
	"hotspotX",
	"hotspotY",
	"cursorType",
];
const BOUNDS_KEY_ORDER = ["x", "y", "width", "height"];

function resolveHelperPath() {
	// A non-empty override must point at a real file — falling back to the
	// C++ binary here would make a Rust-contract run pass vacuously.
	const envPath = BACKEND === "custom" ? BACKEND_OVERRIDE : undefined;
	if (envPath) {
		if (!fs.existsSync(envPath)) {
			console.error(`CLOSESCREEN_CURSOR_SAMPLER_EXE points at a missing file: ${envPath}`);
			process.exit(1);
		}
		return envPath;
	}
	const candidates = [
		path.join(
			ROOT,
			"electron",
			"native",
			"bin",
			"win32-x64",
			BACKEND === "legacy" ? "cursor-sampler-legacy.exe" : "cursor-sampler.exe",
		),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	console.error(`cursor-sampler.exe not found. Tried:\n${candidates.join("\n")}`);
	process.exit(1);
}

const failures = [];
function assertThat(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function runSampler(helperPath, args, durationMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(helperPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const startedAt = Date.now();
		const lines = [];
		let stderr = "";
		let buffer = "";
		let readyAtMs = null;

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			const parts = buffer.split(/\r?\n/);
			buffer = parts.pop() ?? "";
			for (const part of parts) {
				const trimmed = part.trim();
				if (!trimmed) continue;
				lines.push(trimmed);
				if (readyAtMs === null && trimmed.includes('"ready"')) {
					readyAtMs = Date.now() - startedAt;
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);

		setTimeout(() => {
			child.kill();
		}, durationMs);
		child.once("exit", (code, signal) => {
			resolve({ lines, stderr, readyAtMs, code, signal });
		});
	});
}

function parseLines(lines, label) {
	const events = [];
	for (const line of lines) {
		try {
			events.push({ raw: line, json: JSON.parse(line) });
		} catch {
			failures.push(`[${label}] non-JSON stdout line: ${line.slice(0, 200)}`);
		}
	}
	return events;
}

function checkCommonContract(events, readyAtMs, label) {
	assertThat(events.length > 0, `[${label}] no stdout lines at all`);
	if (events.length === 0) return [];

	assertThat(
		events[0].json.type === "ready",
		`[${label}] first line is ${events[0].json.type}, expected ready`,
	);
	assertThat(
		typeof events[0].json.timestampMs === "number",
		`[${label}] ready.timestampMs is not a number`,
	);
	assertThat(
		readyAtMs !== null && readyAtMs <= READY_TIMEOUT_MS,
		`[${label}] ready arrived in ${readyAtMs}ms (limit ${READY_TIMEOUT_MS}ms)`,
	);

	const errors = events.filter((e) => e.json.type === "error");
	assertThat(errors.length === 0, `[${label}] ${errors.length} error event(s) emitted`);

	const samples = events.filter((e) => e.json.type === "sample");
	const minSamples = Math.floor(RUN_DURATION_MS / SAMPLE_INTERVAL_MS / 3);
	assertThat(
		samples.length >= minSamples,
		`[${label}] only ${samples.length} samples (expected >= ${minSamples})`,
	);

	for (const sample of samples) {
		const keys = Object.keys(sample.json);
		if (JSON.stringify(keys) !== JSON.stringify(SAMPLE_KEY_ORDER)) {
			failures.push(`[${label}] sample key order mismatch: ${keys.join(",")}`);
			break;
		}
	}
	for (const sample of samples) {
		const { handle } = sample.json;
		if (handle !== null && !/^0x[0-9A-F]+$/.test(handle)) {
			failures.push(`[${label}] bad handle format: ${handle}`);
			break;
		}
	}
	for (const sample of samples) {
		const j = sample.json;
		if (
			typeof j.timestampMs !== "number" ||
			typeof j.x !== "number" ||
			typeof j.y !== "number" ||
			typeof j.visible !== "boolean" ||
			typeof j.leftButtonDown !== "boolean" ||
			typeof j.leftButtonPressed !== "boolean" ||
			typeof j.leftButtonReleased !== "boolean"
		) {
			failures.push(`[${label}] sample field types wrong: ${sample.raw.slice(0, 160)}`);
			break;
		}
	}
	return samples;
}

function checkAssets(samples, label) {
	const withAsset = samples.filter((s) => s.json.asset !== null);
	assertThat(withAsset.length >= 1, `[${label}] no asset was emitted`);
	for (const s of withAsset) {
		const asset = s.json.asset;
		const keys = Object.keys(asset);
		if (JSON.stringify(keys) !== JSON.stringify(ASSET_KEY_ORDER)) {
			failures.push(`[${label}] asset key order mismatch: ${keys.join(",")}`);
			return;
		}
		assertThat(asset.id === s.json.handle, `[${label}] asset.id !== sample.handle`);
		assertThat(
			asset.width > 0 && asset.height > 0,
			`[${label}] asset dims ${asset.width}x${asset.height}`,
		);
		assertThat(
			asset.hotspotX >= 0 &&
				asset.hotspotX <= asset.width &&
				asset.hotspotY >= 0 &&
				asset.hotspotY <= asset.height,
			`[${label}] hotspot ${asset.hotspotX},${asset.hotspotY} outside ${asset.width}x${asset.height}`,
		);
		const prefix = "data:image/png;base64,";
		if (!asset.imageDataUrl.startsWith(prefix)) {
			failures.push(`[${label}] imageDataUrl prefix wrong`);
			return;
		}
		const pngBytes = Buffer.from(asset.imageDataUrl.slice(prefix.length), "base64");
		assertThat(
			pngBytes.length > 8 &&
				pngBytes[0] === 0x89 &&
				pngBytes[1] === 0x50 &&
				pngBytes[2] === 0x4e &&
				pngBytes[3] === 0x47,
			`[${label}] asset payload is not a PNG`,
		);
	}
}

// Self-contained fixture window (WinForms via PowerShell) — avoids relying
// on preinstalled GUI apps; on current Win11 mspaint/notepad are Store stubs
// whose launcher process exits immediately.
function startFixtureWindow() {
	return new Promise((resolve, reject) => {
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"$form = New-Object System.Windows.Forms.Form",
			"$form.Text = 'closescreen cursor-sampler fixture'",
			"$form.Width = 640",
			"$form.Height = 480",
			'$form.add_Shown({ [Console]::Out.WriteLine("HWND:" + $form.Handle.ToInt64()); [Console]::Out.Flush() })',
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
			reject(new Error("Timed out waiting for fixture window handle"));
		}, 10_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			const match = buffer.match(/HWND:(\d+)/);
			if (match) {
				clearTimeout(timer);
				resolve({ child, handle: match[1] });
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			reject(new Error("Fixture window process exited before reporting a handle"));
		});
	});
}

if (process.platform !== "win32") {
	console.error("This test is Windows-only.");
	process.exit(1);
}

const helperPath = resolveHelperPath();
console.log(`Testing ${BACKEND}: ${helperPath}`);

// Case 1: plain run, no window handle — every bounds must be null.
{
	const run = await runSampler(helperPath, [String(SAMPLE_INTERVAL_MS)], RUN_DURATION_MS);
	const events = parseLines(run.lines, "plain");
	const samples = checkCommonContract(events, run.readyAtMs, "plain");
	checkAssets(samples, "plain");
	assertThat(
		samples.every((s) => s.json.bounds === null),
		"[plain] bounds must be null when no window handle is passed",
	);
	console.log(
		`  plain: ${samples.length} samples, ready at ${run.readyAtMs}ms, assets ${samples.filter((s) => s.json.asset !== null).length}`,
	);
}

// Case 2: bogus and literal-"null" window handles are silently ignored.
for (const bogus of ["abc", "null"]) {
	const run = await runSampler(helperPath, [String(SAMPLE_INTERVAL_MS), bogus], 700);
	const events = parseLines(run.lines, `handle:${bogus}`);
	assertThat(
		events.length > 0 && events[0].json.type === "ready",
		`[handle:${bogus}] helper did not start`,
	);
	const samples = events.filter((e) => e.json.type === "sample");
	assertThat(samples.length > 0, `[handle:${bogus}] no samples`);
	assertThat(
		samples.every((s) => s.json.bounds === null),
		`[handle:${bogus}] bounds must be null for an unusable handle`,
	);
	console.log(`  handle:${bogus}: ignored as expected (${samples.length} samples)`);
}

// Case 3: real window handle — bounds object with exact field order.
{
	let fixture = null;
	try {
		fixture = await startFixtureWindow();
	} catch (error) {
		failures.push(`[window] fixture failed: ${error.message}`);
	}
	if (fixture) {
		try {
			const run = await runSampler(
				helperPath,
				[String(SAMPLE_INTERVAL_MS), fixture.handle],
				RUN_DURATION_MS,
			);
			const events = parseLines(run.lines, "window");
			const samples = checkCommonContract(events, run.readyAtMs, "window");
			const withBounds = samples.filter((s) => s.json.bounds !== null);
			assertThat(withBounds.length > 0, "[window] no sample carried bounds");
			for (const s of withBounds) {
				const keys = Object.keys(s.json.bounds);
				if (JSON.stringify(keys) !== JSON.stringify(BOUNDS_KEY_ORDER)) {
					failures.push(`[window] bounds key order mismatch: ${keys.join(",")}`);
					break;
				}
				if (s.json.bounds.width <= 0 || s.json.bounds.height <= 0) {
					failures.push(`[window] non-positive bounds dims: ${JSON.stringify(s.json.bounds)}`);
					break;
				}
			}
			console.log(`  window: ${withBounds.length}/${samples.length} samples carried bounds`);
		} finally {
			fixture.child.kill();
		}
	}
}

// Case 4: GDI leak regression mode.
{
	const result = spawnSync(helperPath, ["--gdi-leak-test", "500"], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 120_000,
	});
	assertThat(result.status === 0, `[gdi-leak-test] exit code ${result.status} (expected 0)`);
	const line = (result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
	try {
		const report = JSON.parse(line);
		assertThat(report.type === "gdi-leak-test", "[gdi-leak-test] wrong report type");
		console.log(
			`  gdi-leak-test: gdiDelta ${report.gdiDelta}, userDelta ${report.userDelta} (exit ${result.status})`,
		);
	} catch {
		failures.push(`[gdi-leak-test] unparseable report line: ${line.slice(0, 200)}`);
	}
}

if (failures.length > 0) {
	console.error("\nFAIL:");
	for (const failure of failures) {
		console.error(`  - ${failure}`);
	}
	process.exit(1);
}
console.log(`\nPASS: ${BACKEND} cursor-sampler protocol contract holds.`);
