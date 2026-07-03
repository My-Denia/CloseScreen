// Guards preload/main IPC registration drift. A preload invoke without a matching
// main-process handler becomes a dead Promise at runtime; PR #63 restored exactly
// that kind of missing registration for "discard-cursor-telemetry".
//
// The main handler modules pull in Electron and native/runtime dependencies, so
// this test mirrors localStorageMigration.test.ts and checks source text instead
// of importing the modules. Two guards protect the guard itself from silently
// drifting (both flagged by the PR #64 audit):
//   - source is comment-stripped before matching, so a commented-out handler can't
//     be counted as satisfying the contract while a live invoke goes unhandled;
//   - every `ipcRenderer.invoke(` site must be captured by the literal/symbol
//     regexes and every symbolic channel must resolve, so a future invoke in a form
//     the regexes don't understand (template literal, lowercase var, off-contract
//     symbol) fails loudly instead of being silently skipped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Strip block and line comments before matching. Without this a commented-out
// `// ipcMain.handle("x")` would count as HANDLED and mask a real dead invoke.
const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const read = (rel: string): string => stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const HANDLER_REGISTRARS = [
	"electron/ipc/handlers.ts",
	"electron/ipc/nativeBridge.ts",
	"electron/ipc/recordingStream.ts",
	"electron/ipc/updateCheck.ts",
	"electron/main.ts",
];

const CHANNEL_CONSTANT_SOURCES = ["src/native/contracts.ts"];

const CHANNEL_CONSTANT = /export const ([A-Z0-9_]+)\s*=\s*["']([a-z0-9:-]+)["']/g;
const INVOKE_SITE = /ipcRenderer\.invoke\(/g;
const INVOKE_CHANNEL_LITERAL = /ipcRenderer\.invoke\(\s*["']([a-z0-9:-]+)["']/g;
const INVOKE_CHANNEL_SYMBOL = /ipcRenderer\.invoke\(\s*([A-Z0-9_]+)\b/g;
const HANDLE_CHANNEL_LITERAL = /ipcMain\.handle\(\s*["']([a-z0-9:-]+)["']/g;
const HANDLE_CHANNEL_SYMBOL = /ipcMain\.handle\(\s*([A-Z0-9_]+)\b/g;

const matchCount = (source: string, pattern: RegExp): number =>
	[...source.matchAll(pattern)].length;

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
	const preloadSource = read("electron/preload.ts");
	const preloadInvokedChannels = uniqueSorted([
		...extractChannels(preloadSource, INVOKE_CHANNEL_LITERAL),
		...resolveChannelSymbols(preloadSource, INVOKE_CHANNEL_SYMBOL),
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

	// Protects the guard from a silent blind spot: if a future invoke uses a form the
	// channel regexes miss, it would drop out of the checked set and its missing
	// handler would go unnoticed. Fail loudly instead.
	it("captures every preload invoke site (no silently-skipped invoke form)", () => {
		const invokeSites = matchCount(preloadSource, INVOKE_SITE);
		const captured =
			matchCount(preloadSource, INVOKE_CHANNEL_LITERAL) +
			matchCount(preloadSource, INVOKE_CHANNEL_SYMBOL);
		expect(
			captured,
			`Some ipcRenderer.invoke( sites use a channel form the contract test can't parse ` +
				`(template literal, lowercase variable, etc.): ${invokeSites} sites, ${captured} captured. ` +
				`Add the form to INVOKE_CHANNEL_* or give it an [A-Z0-9_] constant in src/native/contracts.ts.`,
		).toBe(invokeSites);

		const unresolvedSymbols = uniqueSorted(
			extractChannels(preloadSource, INVOKE_CHANNEL_SYMBOL).filter(
				(symbol) => !channelConstants.has(symbol),
			),
		);
		expect(
			unresolvedSymbols,
			`Symbolic invoke channel(s) not defined in src/native/contracts.ts: ${unresolvedSymbols.join(", ")}`,
		).toEqual([]);
	});

	it("registers a main-process handler for every preload invoke channel", () => {
		const handled = new Set(mainHandledChannels);
		const missing = preloadInvokedChannels.filter((channel) => !handled.has(channel));

		expect(missing, formatMissing(missing)).toEqual([]);
	});
});
