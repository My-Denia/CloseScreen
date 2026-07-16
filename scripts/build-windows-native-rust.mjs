// Builds the Rust native helpers (electron/native/rust) for Windows and
// stages diagnostic copies under electron/native/rust/target/dist/ and the
// Windows release defaults under electron/native/bin/win32-x64/.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RUST_DIR = path.join(ROOT, "electron", "native", "rust");
const RUST_TOOLCHAIN = "1.96.1";
const TARGET = "x86_64-pc-windows-msvc";
const BINARIES = ["cursor-sampler.exe", "wgc-capture.exe"];
const BIN_DIR = path.join(ROOT, "electron", "native", "bin", "win32-x64");

function findCargo() {
	const probe = spawnSync("cargo", [`+${RUST_TOOLCHAIN}`, "--version"], {
		encoding: "utf8",
		windowsHide: true,
	});
	if (probe.status === 0) {
		return "cargo";
	}
	const homeCargo = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
	if (fs.existsSync(homeCargo)) {
		return homeCargo;
	}
	console.error(
		`cargo with Rust ${RUST_TOOLCHAIN} not found on PATH or in %USERPROFILE%\\.cargo\\bin. Install the pinned toolchain with rustup.`,
	);
	process.exit(1);
}

if (process.platform !== "win32") {
	console.error("This build script is Windows-only.");
	process.exit(1);
}

const cargo = findCargo();
const build = spawnSync(
	cargo,
	[`+${RUST_TOOLCHAIN}`, "build", "--locked", "--release", "--target", TARGET],
	{
		cwd: RUST_DIR,
		stdio: "inherit",
		windowsHide: true,
	},
);
if (build.status !== 0) {
	console.error(`cargo build failed with exit code ${build.status}`);
	process.exit(build.status ?? 1);
}

const releaseDir = path.join(RUST_DIR, "target", TARGET, "release");
const distDir = path.join(RUST_DIR, "target", "dist");
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(BIN_DIR, { recursive: true });

for (const name of BINARIES) {
	const src = path.join(releaseDir, name);
	if (!fs.existsSync(src)) {
		console.error(`Expected build output missing: ${src}`);
		process.exit(1);
	}
	const dest = path.join(distDir, name);
	fs.copyFileSync(src, dest);
	console.log(`Staged ${dest}`);
	const releaseDest = path.join(BIN_DIR, name);
	fs.copyFileSync(src, releaseDest);
	console.log(`Staged release default ${releaseDest}`);
}

console.log("");
console.log("Rust helpers staged as the Windows x64 release default.");
console.log("Set CLOSESCREEN_WINDOWS_CAPTURE_BACKEND=legacy to use the packaged C++ rollback.");
