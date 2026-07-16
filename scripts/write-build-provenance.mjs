import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUST_TOOLCHAIN = "1.96.1";
const OUTPUT_ARG = process.argv.indexOf("--output");
const PLATFORM_ARG = process.argv.indexOf("--platform");
const output =
	OUTPUT_ARG >= 0
		? path.resolve(ROOT, process.argv[OUTPUT_ARG + 1])
		: path.join(ROOT, "release-provenance", "build-provenance.json");
const platform = PLATFORM_ARG >= 0 ? process.argv[PLATFORM_ARG + 1] : process.platform;

function command(executable, args) {
	const result = spawnSync(executable, args, {
		cwd: ROOT,
		encoding: "utf8",
		windowsHide: true,
		shell: process.platform === "win32" && executable === "npm",
	});
	if (result.status !== 0) return null;
	return result.stdout.trim();
}

function sha256(relativePath) {
	return createHash("sha256")
		.update(readFileSync(path.join(ROOT, relativePath)))
		.digest("hex");
}

function readOptional(filePath) {
	return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

const cmakeBuildDir = path.join(ROOT, "electron", "native", "wgc-capture", "build");
const cmakeCache = readOptional(path.join(cmakeBuildDir, "CMakeCache.txt"));
const cacheValue = (name) =>
	cmakeCache.match(new RegExp(`^${name}:[^=]*=(.+)$`, "m"))?.[1]?.trim() ?? null;
const compilerMetadataPath = existsSync(path.join(cmakeBuildDir, "CMakeFiles"))
	? readdirSync(path.join(cmakeBuildDir, "CMakeFiles"), { recursive: true })
			.map((entry) => path.join(cmakeBuildDir, "CMakeFiles", entry.toString()))
			.find((entry) => entry.endsWith("CMakeCXXCompiler.cmake"))
	: null;
const compilerMetadata = compilerMetadataPath ? readOptional(compilerMetadataPath) : "";
const compilerValue = (name) =>
	compilerMetadata.match(new RegExp(`set\\(${name} "([^"]*)"\\)`))?.[1] ?? null;
const cmakeExecutable = cacheValue("CMAKE_COMMAND") ?? "cmake";

const sourceSha = command("git", ["rev-parse", "HEAD"]);
if (!sourceSha || !/^[0-9a-f]{40}$/.test(sourceSha)) {
	throw new Error("Could not resolve the source commit for build provenance.");
}
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceSha) {
	throw new Error(
		`Checked out source ${sourceSha} does not match GITHUB_SHA ${process.env.GITHUB_SHA}.`,
	);
}

const provenance = {
	schemaVersion: 1,
	sourceSha,
	eventSha: process.env.GITHUB_SHA ?? null,
	platform,
	runnerImage: process.env.ImageOS ?? null,
	runnerVersion: process.env.ImageVersion ?? null,
	generatedAt: new Date().toISOString(),
	nativeCapture:
		platform === "windows"
			? {
					applicable: true,
					defaultBackend: "rust",
					legacyFallbackPackaged: true,
					target: "x86_64-pc-windows-msvc",
				}
			: { applicable: false },
	toolchains: {
		node: process.version,
		npm: command("npm", ["--version"]),
		rustc:
			platform === "windows"
				? command("rustc", [`+${RUST_TOOLCHAIN}`, "--version", "--verbose"])
				: null,
		cargo:
			platform === "windows"
				? command("cargo", [`+${RUST_TOOLCHAIN}`, "--version", "--verbose"])
				: null,
		cmake: command(cmakeExecutable, ["--version"]),
		cpp: {
			compiler: cacheValue("CMAKE_CXX_COMPILER"),
			compilerId: compilerValue("CMAKE_CXX_COMPILER_ID"),
			compilerVersion: compilerValue("CMAKE_CXX_COMPILER_VERSION"),
			generator: cacheValue("CMAKE_GENERATOR"),
		},
	},
	inputs: {
		packageLockSha256: sha256("package-lock.json"),
		cargoLockSha256: sha256("electron/native/rust/Cargo.lock"),
		captionAssetManifestSha256: sha256("scripts/caption-assets-manifest.json"),
	},
	note: "This records repeatable inputs and tool versions; it does not claim byte-identical builds.",
};

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
console.log(`Build provenance written to ${path.relative(ROOT, output)}`);
