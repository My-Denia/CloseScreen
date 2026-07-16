import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PROVENANCE = ["linux-build-provenance.json", "windows-build-provenance.json"];

function filesRecursively(root) {
	const files = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) files.push(...filesRecursively(fullPath));
		else if (entry.isFile()) files.push(fullPath);
	}
	return files;
}

function isReleaseInput(filePath) {
	const name = path.basename(filePath);
	return /\.(exe|AppImage|deb|pacman)$/.test(name) || REQUIRED_PROVENANCE.includes(name);
}

function sha256(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requireInputKinds(names) {
	for (const [label, predicate] of [
		["Windows installer", (name) => name.endsWith(".exe")],
		["Linux AppImage", (name) => name.endsWith(".AppImage")],
		["Linux deb", (name) => name.endsWith(".deb")],
		["Linux pacman", (name) => name.endsWith(".pacman")],
	]) {
		const matching = names.filter(predicate);
		if (matching.length === 0) throw new Error(`Missing required ${label} release asset.`);
		if (matching.length !== 1) {
			throw new Error(`Expected exactly one ${label} release asset; found ${matching.length}.`);
		}
	}
	for (const provenance of REQUIRED_PROVENANCE) {
		if (!names.includes(provenance)) throw new Error(`Missing required ${provenance}.`);
	}
}

export function prepareReleaseAssets(artifactsDir, outputDir) {
	const candidates = filesRecursively(artifactsDir).filter(isReleaseInput);
	if (candidates.length === 0) throw new Error("No release assets found.");
	const names = candidates.map((filePath) => path.basename(filePath));
	if (new Set(names).size !== names.length) {
		const duplicate = names.find((name, index) => names.indexOf(name) !== index);
		throw new Error(`Duplicate release asset basename: ${duplicate}`);
	}
	requireInputKinds(names);

	fs.rmSync(outputDir, { recursive: true, force: true });
	fs.mkdirSync(outputDir, { recursive: true });
	for (const source of candidates) {
		fs.copyFileSync(source, path.join(outputDir, path.basename(source)));
	}

	const staged = fs
		.readdirSync(outputDir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	if (JSON.stringify(staged) !== JSON.stringify(names.toSorted())) {
		throw new Error("Final staged release asset set differs from the downloaded artifact set.");
	}

	const checksumLines = staged.map((name) => `${sha256(path.join(outputDir, name))}  ${name}`);
	const checksumPath = path.join(outputDir, "SHA256SUMS.txt");
	fs.writeFileSync(checksumPath, `${checksumLines.join("\n")}\n`, "utf8");

	for (const line of checksumLines) {
		const [expected, name] = line.split(/\s{2}/);
		const actual = sha256(path.join(outputDir, name));
		if (actual !== expected) throw new Error(`Checksum self-check failed for ${name}.`);
	}
	return { assets: staged, checksumPath };
}

const isEntrypoint =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	const artifactsIndex = process.argv.indexOf("--artifacts");
	const outputIndex = process.argv.indexOf("--output");
	if (artifactsIndex < 0 || outputIndex < 0) {
		throw new Error("usage: prepare-release-assets.mjs --artifacts DIR --output DIR");
	}
	const artifactsDir = path.resolve(process.argv[artifactsIndex + 1]);
	const outputDir = path.resolve(process.argv[outputIndex + 1]);
	const relativeOutput = path.relative(process.cwd(), outputDir);
	if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) {
		throw new Error("Refusing to replace a release output directory outside the workspace.");
	}
	const result = prepareReleaseAssets(artifactsDir, outputDir);
	console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
