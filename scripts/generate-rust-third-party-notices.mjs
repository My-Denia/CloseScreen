import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUST_DIR = path.join(ROOT, "electron", "native", "rust");
const LOCK_PATH = path.join(RUST_DIR, "Cargo.lock");
const NOTICE_PATH = path.join(ROOT, "RUST_THIRD_PARTY_NOTICES.md");

function findCargo() {
	const probe = spawnSync("cargo", ["--version"], { encoding: "utf8", windowsHide: true });
	if (probe.status === 0) return "cargo";
	const candidate = path.join(os.homedir(), ".cargo", "bin", "cargo.exe");
	if (fs.existsSync(candidate)) return candidate;
	throw new Error("cargo is required to generate the locked Rust third-party notice");
}

function cargoMetadata() {
	const result = spawnSync(
		findCargo(),
		[
			"metadata",
			"--locked",
			"--format-version",
			"1",
			"--manifest-path",
			path.join(RUST_DIR, "Cargo.toml"),
		],
		{ cwd: RUST_DIR, encoding: "utf8", windowsHide: true },
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || `cargo metadata failed with exit code ${result.status}`);
	}
	return JSON.parse(result.stdout);
}

function renderNotice(metadata) {
	const lockHash = crypto.createHash("sha256").update(fs.readFileSync(LOCK_PATH)).digest("hex");
	const packages = metadata.packages
		.filter((pkg) => typeof pkg.source === "string" && pkg.source.startsWith("registry+"))
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
	const lines = [
		"# CloseScreen Rust third-party notices",
		"",
		"This file lists the registry packages in the locked Rust native-helper dependency graph.",
		"The SPDX expressions and source links below are supplied by each package's Cargo metadata.",
		"Refer to the linked upstream package for its complete license text and notices.",
		"",
		`Cargo.lock SHA-256: \`${lockHash}\``,
		"",
		"| Package | Version | License | Upstream |",
		"| --- | --- | --- | --- |",
	];
	for (const pkg of packages) {
		const upstream = pkg.repository || pkg.homepage || `https://crates.io/crates/${pkg.name}`;
		lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license || "UNKNOWN"} | ${upstream} |`);
	}
	lines.push("", `Locked registry packages: ${packages.length}`, "");
	return lines.join("\n");
}

const expected = renderNotice(cargoMetadata());
if (process.argv.includes("--check")) {
	const actual = fs.existsSync(NOTICE_PATH) ? fs.readFileSync(NOTICE_PATH, "utf8") : "";
	if (actual.replace(/\r\n/g, "\n") !== expected) {
		console.error("RUST_THIRD_PARTY_NOTICES.md is stale; regenerate it with npm run notices:rust.");
		process.exit(1);
	}
	console.log(`Verified ${NOTICE_PATH}`);
} else {
	fs.writeFileSync(NOTICE_PATH, expected, "utf8");
	console.log(`Wrote ${NOTICE_PATH}`);
}
