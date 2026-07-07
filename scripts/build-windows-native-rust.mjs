// Builds the Rust native helpers (electron/native/rust) for Windows and
// stages the binaries under electron/native/rust/target/dist/.
//
// Pre-cutover the staged exes are OPT-IN only: point the app or the test
// scripts at them via CLOSESCREEN_CURSOR_SAMPLER_EXE (and, from PR2 on,
// CLOSESCREEN_WGC_CAPTURE_EXE). This script never writes to
// electron/native/bin/<arch>/ — the shipped default stays the C++ build
// until the cutover round switches it deliberately.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RUST_DIR = path.join(ROOT, "electron", "native", "rust");
const TARGET = "x86_64-pc-windows-msvc";
const BINARIES = ["cursor-sampler.exe", "wgc-capture.exe"];

function findCargo() {
	const probe = spawnSync("cargo", ["--version"], { encoding: "utf8", windowsHide: true });
	if (probe.status === 0) {
		return "cargo";
	}
	const homeCargo = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
	if (fs.existsSync(homeCargo)) {
		return homeCargo;
	}
	console.error(
		"cargo not found on PATH or in %USERPROFILE%\\.cargo\\bin. Install rustup from https://rustup.rs (stable-x86_64-pc-windows-msvc).",
	);
	process.exit(1);
}

if (process.platform !== "win32") {
	console.error("This build script is Windows-only.");
	process.exit(1);
}

const cargo = findCargo();
const build = spawnSync(cargo, ["build", "--release", "--target", TARGET], {
	cwd: RUST_DIR,
	stdio: "inherit",
	windowsHide: true,
});
if (build.status !== 0) {
	console.error(`cargo build failed with exit code ${build.status}`);
	process.exit(build.status ?? 1);
}

const releaseDir = path.join(RUST_DIR, "target", TARGET, "release");
const distDir = path.join(RUST_DIR, "target", "dist");
fs.mkdirSync(distDir, { recursive: true });

for (const name of BINARIES) {
	const src = path.join(releaseDir, name);
	if (!fs.existsSync(src)) {
		console.error(`Expected build output missing: ${src}`);
		process.exit(1);
	}
	const dest = path.join(distDir, name);
	fs.copyFileSync(src, dest);
	console.log(`Staged ${dest}`);
}

console.log("");
console.log("Rust helpers staged (opt-in only). To use them:");
console.log(
	`  $env:CLOSESCREEN_CURSOR_SAMPLER_EXE = "${path.join(distDir, "cursor-sampler.exe")}"`,
);
console.log(`  $env:CLOSESCREEN_WGC_CAPTURE_EXE = "${path.join(distDir, "wgc-capture.exe")}"`);
