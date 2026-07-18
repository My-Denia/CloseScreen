import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareReleaseAssets } from "../../scripts/prepare-release-assets.mjs";

const roots = [];

function fixture(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-release-assets-"));
	roots.push(root);
	const artifacts = path.join(root, "artifacts");
	const output = path.join(root, "release-assets");
	for (const [relativePath, contents] of Object.entries(files)) {
		const filePath = path.join(artifacts, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, contents);
	}
	return { artifacts, output };
}

function completeFixture(extra = {}) {
	return fixture({
		"windows/CloseScreen Setup 1.5.0-fork.4.exe": "win",
		"windows/windows-build-provenance.json": "{}",
		"linux/CloseScreen.AppImage": "appimage",
		"linux/CloseScreen.deb": "deb",
		"linux/CloseScreen.pacman": "pacman",
		"linux/linux-build-provenance.json": "{}",
		...extra,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("prepareReleaseAssets", () => {
	it("flattens the exact final asset set and writes verifiable checksums", () => {
		const { artifacts, output } = completeFixture();
		const result = prepareReleaseAssets(artifacts, output);

		expect(result.assets).toEqual([
			"CloseScreen.AppImage",
			"CloseScreen.Setup.1.5.0-fork.4.exe",
			"CloseScreen.deb",
			"CloseScreen.pacman",
			"linux-build-provenance.json",
			"windows-build-provenance.json",
		]);
		const sums = fs.readFileSync(result.checksumPath, "utf8");
		for (const name of result.assets) expect(sums).toContain(`  ${name}\n`);
		expect(fs.readdirSync(output).toSorted()).toEqual(
			[...result.assets, "SHA256SUMS.txt"].toSorted(),
		);
	});

	it("rejects duplicate basenames before staging", () => {
		const { artifacts, output } = completeFixture({
			"other/CloseScreen.deb": "duplicate",
		});
		expect(() => prepareReleaseAssets(artifacts, output)).toThrow(
			"Duplicate release asset basename after canonicalization: CloseScreen.deb",
		);
	});

	it("rejects collisions introduced by basename canonicalization", () => {
		const { artifacts, output } = completeFixture({
			"other/CloseScreen.Setup.1.5.0-fork.4.exe": "duplicate",
		});
		expect(() => prepareReleaseAssets(artifacts, output)).toThrow(
			"Duplicate release asset basename after canonicalization: CloseScreen.Setup.1.5.0-fork.4.exe",
		);
	});

	it("rejects multiple Windows installer assets even when their names differ", () => {
		const { artifacts, output } = completeFixture({
			"other/CloseScreen Portable.exe": "unexpected",
		});
		expect(() => prepareReleaseAssets(artifacts, output)).toThrow(
			"Expected exactly one Windows installer release asset; found 2.",
		);
	});

	it("rejects an incomplete release set", () => {
		const { artifacts, output } = fixture({
			"windows/CloseScreen Setup 1.5.0-fork.4.exe": "win",
			"windows/windows-build-provenance.json": "{}",
		});
		expect(() => prepareReleaseAssets(artifacts, output)).toThrow(
			"Missing required Linux AppImage release asset.",
		);
	});
});
