import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PACKAGED_ATTRIBUTION,
	verifyNativeBin,
	verifyPackagedResources,
	WINDOWS_X64_HELPERS,
} from "../../scripts/verify-windows-native-payload.mjs";

function writePe(filePath, machine = 0x8664) {
	const bytes = Buffer.alloc(256);
	bytes[0] = 0x4d;
	bytes[1] = 0x5a;
	bytes.writeUInt32LE(0x80, 0x3c);
	bytes[0x80] = 0x50;
	bytes[0x81] = 0x45;
	bytes.writeUInt16LE(machine, 0x84);
	fs.writeFileSync(filePath, bytes);
}

describe("Windows native release payload verification", () => {
	let root;
	let nativeBin;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-native-payload-"));
		nativeBin = path.join(root, "electron", "native", "bin", "win32-x64");
		fs.mkdirSync(nativeBin, { recursive: true });
		for (const name of WINDOWS_X64_HELPERS) {
			writePe(path.join(nativeBin, name));
		}
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("accepts exactly the fresh Rust-default and legacy x64 helper pairs", () => {
		expect(verifyNativeBin(nativeBin)).toMatchObject({
			architecture: "x64",
			helpers: WINDOWS_X64_HELPERS,
		});
	});

	it("rejects stale or unexpected staged files", () => {
		fs.writeFileSync(path.join(nativeBin, "old-helper.exe"), "stale");
		expect(() => verifyNativeBin(nativeBin)).toThrow("expected exactly");
	});

	it("rejects non-x64 PE payloads", () => {
		writePe(path.join(nativeBin, "wgc-capture.exe"), 0xaa64);
		expect(() => verifyNativeBin(nativeBin)).toThrow("expected x64");
	});

	it("verifies packaged attribution alongside the helper payload", () => {
		const licenses = path.join(root, "licenses");
		fs.mkdirSync(licenses, { recursive: true });
		for (const name of PACKAGED_ATTRIBUTION) {
			fs.writeFileSync(path.join(licenses, name), `${name}\n`);
		}
		expect(verifyPackagedResources(root)).toMatchObject({
			architecture: "x64",
			attribution: PACKAGED_ATTRIBUTION,
		});
	});
});
