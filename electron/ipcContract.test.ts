// Guards preload/main IPC registration drift. A preload invoke without a matching
// main-process handler becomes a dead Promise at runtime; PR #63 restored exactly
// that kind of missing registration for "discard-cursor-telemetry".
//
// The main handler modules pull in Electron and native/runtime dependencies, so
// this test mirrors localStorageMigration.test.ts and checks source text instead
// of importing the modules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const HANDLER_REGISTRARS = [
	"electron/ipc/handlers.ts",
	"electron/ipc/nativeBridge.ts",
	"electron/ipc/recordingStream.ts",
	"electron/ipc/updateCheck.ts",
	"electron/main.ts",
];

const CHANNEL_CONSTANT_SOURCES = ["src/native/contracts.ts"];

const CHANNEL_CONSTANT = /export const ([A-Z0-9_]+)\s*=\s*["']([a-z0-9:-]+)["']/g;
const INVOKE_CHANNEL_LITERAL = /ipcRenderer\.invoke\(\s*["']([a-z0-9:-]+)["']/g;
const INVOKE_CHANNEL_SYMBOL = /ipcRenderer\.invoke\(\s*([A-Z0-9_]+)\b/g;
const HANDLE_CHANNEL_LITERAL = /ipcMain\.handle\(\s*["']([a-z0-9:-]+)["']/g;
const HANDLE_CHANNEL_SYMBOL = /ipcMain\.handle\(\s*([A-Z0-9_]+)\b/g;

const extractChannels = (source: string, pattern: RegExp): string[] =>
	[...source.matchAll(pattern)].map((match) => match[1]);

const uniqueSorted = (channels: string[]): string[] => [...new Set(channels)].sort();

const channelConstants = new Map(
	CHANNEL_CONSTANT_SOURCES.flatMap((rel) =>
		[...read(rel).matchAll(CHANNEL_CONSTANT)].map((match) => [match[1], match[2]] as const),
	),
);

const resolveChannelSymbols = (source: string, pattern: RegExp): string[] =>
	extractChannels(source, pattern).flatMap((symbol) => {
		const channel = channelConstants.get(symbol);
		return channel ? [channel] : [];
	});

const formatMissing = (missing: string[]): string =>
	missing.length > 0
		? `Missing ipcMain.handle registrations for preload invoke channels:\n${missing
				.map((channel) => `- ${channel}`)
				.join("\n")}`
		: "";

describe("IPC channel contract", () => {
	const preloadInvokedChannels = uniqueSorted([
		...extractChannels(read("electron/preload.ts"), INVOKE_CHANNEL_LITERAL),
		...resolveChannelSymbols(read("electron/preload.ts"), INVOKE_CHANNEL_SYMBOL),
	]);
	const mainHandledChannels = uniqueSorted(
		HANDLER_REGISTRARS.flatMap((rel) => {
			const source = read(rel);
			return [
				...extractChannels(source, HANDLE_CHANNEL_LITERAL),
				...resolveChannelSymbols(source, HANDLE_CHANNEL_SYMBOL),
			];
		}),
	);

	it("parses preload invoke channels and main-process handle registrations", () => {
		expect(preloadInvokedChannels.length).toBeGreaterThan(0);
		expect(mainHandledChannels.length).toBeGreaterThan(0);
	});

	it("registers a main-process handler for every preload invoke channel", () => {
		const handled = new Set(mainHandledChannels);
		const missing = preloadInvokedChannels.filter((channel) => !handled.has(channel));

		expect(missing, formatMissing(missing)).toEqual([]);
	});
});
