import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const NATIVE_BIN_ROOT = path.join(ROOT, "electron", "native", "bin");
const TARGET_DIR = path.join(NATIVE_BIN_ROOT, "win32-x64");

function run(script, args = []) {
	const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
		cwd: ROOT,
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

if (process.platform !== "win32") {
	console.error("The CloseScreen native Windows release payload can be built only on Windows x64.");
	process.exit(1);
}
if (process.arch !== "x64") {
	console.error(
		`Unsupported Windows architecture: ${process.arch}. The release payload is x64 only.`,
	);
	process.exit(1);
}

const relativeTarget = path.relative(NATIVE_BIN_ROOT, TARGET_DIR);
if (
	relativeTarget !== "win32-x64" ||
	relativeTarget.startsWith("..") ||
	path.isAbsolute(relativeTarget)
) {
	throw new Error(`Refusing to clean unexpected native staging path: ${TARGET_DIR}`);
}

fs.rmSync(TARGET_DIR, { recursive: true, force: true });
fs.mkdirSync(TARGET_DIR, { recursive: true });
run("build-windows-wgc-helper.mjs");
run("build-windows-native-rust.mjs");
run("generate-rust-third-party-notices.mjs", ["--check"]);

const verify = spawnSync(
	process.execPath,
	[path.join(__dirname, "verify-windows-native-payload.mjs"), "--native-bin", TARGET_DIR],
	{ cwd: ROOT, stdio: "inherit", windowsHide: true },
);
if (verify.status !== 0) {
	process.exit(verify.status ?? 1);
}

console.log(
	`Built the fresh CloseScreen Windows x64 Rust-default + legacy rollback payload: ${TARGET_DIR}`,
);
