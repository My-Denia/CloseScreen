import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const read = (rel: string): string => stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("recording retention IPC contract", () => {
	it("does not let the renderer send cleanup paths or candidates", () => {
		const preloadSource = read("electron/preload.ts");

		expect(preloadSource).toMatch(
			/cleanupRecordings:\s*\(\)\s*=>\s*\{\s*return\s+ipcRenderer\.invoke\(\s*["']cleanup-recordings["']\s*\)/s,
		);
		expect(preloadSource).not.toMatch(/cleanupRecordings:\s*\([^)]*[a-zA-Z_$][^)]*\)/);
	});

	it("routes cleanup through the main-process storage lock gate", () => {
		const handlerSource = read("electron/ipc/handlers.ts");
		const cleanupHandler = handlerSource.match(
			/ipcMain\.handle\(\s*["']cleanup-recordings["'],\s*async\s*\(\)\s*=>\s*\{(?<body>[\s\S]*?)\n\t\}\);/,
		)?.groups?.["body"];

		expect(cleanupHandler).toBeTruthy();
		expect(cleanupHandler).toContain("cleanupRecordingsWithLock");
		expect(cleanupHandler).toContain("isLocked: isRecordingStorageLocked");
		expect(cleanupHandler).not.toMatch(
			/ipcMain\.handle\(\s*["']cleanup-recordings["'],\s*async\s*\(_/,
		);
	});
});
