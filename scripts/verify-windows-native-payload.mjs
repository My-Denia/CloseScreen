import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_X64_HELPERS = [
	"cursor-sampler-legacy.exe",
	"cursor-sampler.exe",
	"wgc-capture-legacy.exe",
	"wgc-capture.exe",
];

export const PACKAGED_ATTRIBUTION = ["LICENSE", "README.md", "RUST_THIRD_PARTY_NOTICES.md"];

function fail(message) {
	throw new Error(`Windows native payload verification failed: ${message}`);
}

function readPeMachine(filePath) {
	const bytes = fs.readFileSync(filePath);
	if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
		fail(`${filePath} is not a PE executable (missing MZ header)`);
	}
	const peOffset = bytes.readUInt32LE(0x3c);
	if (
		peOffset + 6 > bytes.length ||
		bytes[peOffset] !== 0x50 ||
		bytes[peOffset + 1] !== 0x45 ||
		bytes[peOffset + 2] !== 0 ||
		bytes[peOffset + 3] !== 0
	) {
		fail(`${filePath} is not a PE executable (missing PE signature)`);
	}
	return bytes.readUInt16LE(peOffset + 4);
}

export function verifyNativeBin(nativeBinDir) {
	if (!fs.existsSync(nativeBinDir) || !fs.statSync(nativeBinDir).isDirectory()) {
		fail(`native bin directory is missing: ${nativeBinDir}`);
	}
	const actual = fs
		.readdirSync(nativeBinDir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	if (JSON.stringify(actual) !== JSON.stringify(WINDOWS_X64_HELPERS)) {
		fail(
			`expected exactly ${WINDOWS_X64_HELPERS.join(", ")}; found ${actual.join(", ") || "none"}`,
		);
	}

	for (const name of WINDOWS_X64_HELPERS) {
		const filePath = path.join(nativeBinDir, name);
		const machine = readPeMachine(filePath);
		if (machine !== 0x8664) {
			fail(`${name} has PE machine 0x${machine.toString(16)}; expected x64 (0x8664)`);
		}
	}
	return { nativeBinDir, helpers: [...WINDOWS_X64_HELPERS], architecture: "x64" };
}

export function verifyPackagedResources(resourcesDir) {
	const nativeBinDir = path.join(resourcesDir, "electron", "native", "bin", "win32-x64");
	const native = verifyNativeBin(nativeBinDir);
	const licensesDir = path.join(resourcesDir, "licenses");
	for (const name of PACKAGED_ATTRIBUTION) {
		const filePath = path.join(licensesDir, name);
		if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			fail(`packaged attribution is missing: ${filePath}`);
		}
		if (fs.statSync(filePath).size === 0) {
			fail(`packaged attribution is empty: ${filePath}`);
		}
	}
	return { ...native, resourcesDir, attribution: [...PACKAGED_ATTRIBUTION] };
}

function parseCli(argv) {
	if (argv.length !== 2 || !["--native-bin", "--resources"].includes(argv[0])) {
		fail("usage: verify-windows-native-payload.mjs (--native-bin DIR | --resources DIR)");
	}
	return { mode: argv[0], target: path.resolve(argv[1]) };
}

const isEntrypoint =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	try {
		const { mode, target } = parseCli(process.argv.slice(2));
		const result =
			mode === "--native-bin" ? verifyNativeBin(target) : verifyPackagedResources(target);
		console.log(JSON.stringify({ ok: true, ...result }, null, 2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
