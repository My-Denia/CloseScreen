// Empirical root-cause probe for issue #35 (formerly #33):
// "first record-button click before any source selection crashes the main
// process with TypeError: Error processing argument at index 0, conversion
// failure from ... at an IpcMainImpl handler".
//
// This spec does NOT assume the crash reproduces. It launches a real Electron
// main process with a FRESH user-data-dir, selects no source, and forcibly
// drives every candidate main-process crash site named in the investigation,
// while watching the main-process stderr for the "conversion failure" /
// "Error processing argument" signature. It then prints a single PROBE_RESULT
// JSON blob so the run yields a definitive REPRODUCES vs DOES-NOT-REPRODUCE
// branch.
//
// Windows-only: the reported crash is in the Windows native/displayMedia path.
// The platform guard below skips elsewhere; the in-test sentinel assertion
// fails loudly if this is ever run on the intended platform but silently
// no-ops, so "skipped" can never be mistaken for "did not reproduce".

import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;

// Main-process crash signatures for issue #35. The "Video was requested, but
// no video stream was provided" rejection is the one thrown by
// setDisplayMediaRequestHandler when callback({}) is used with a pending video
// request — the actual unhandled main-process exception behind the crash dialog.
const CRASH_SIGNATURE =
	/conversion failure|Error processing argument at index|Video was requested, but no video stream/i;

async function launchApp() {
	const testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "closescreen-e2e-norepro-"));
	const app = await electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			"--lang=en-US",
			`--user-data-dir=${testUserDataDir}`,
		],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: testUserDataDir,
			HEADLESS: process.env["HEADLESS"] ?? "true",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
		},
	});

	const childProcess = app.process();
	let stderrBuf = "";
	let stdoutBuf = "";
	childProcess.stderr?.on("data", (d) => {
		stderrBuf += String(d);
		process.stderr.write(`[electron] ${d}`);
	});
	childProcess.stdout?.on("data", (d) => {
		stdoutBuf += String(d);
	});
	const holder = app as ElectronApplication & {
		__testUserDataDir?: string;
		__childProcess?: ReturnType<ElectronApplication["process"]>;
		__getStderr?: () => string;
		__getStdout?: () => string;
	};
	holder.__testUserDataDir = testUserDataDir;
	holder.__childProcess = childProcess;
	holder.__getStderr = () => stderrBuf;
	holder.__getStdout = () => stdoutBuf;
	return app;
}

async function closeApp(app: ElectronApplication) {
	const holder = app as ElectronApplication & {
		__childProcess?: ReturnType<ElectronApplication["process"]>;
		__testUserDataDir?: string;
	};
	const childProcess = holder.__childProcess;
	await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
	if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
		if (!childProcess.killed) childProcess.kill();
		await Promise.race([
			once(childProcess, "close"),
			new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
	const dir = holder.__testUserDataDir;
	if (dir && fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

async function dismissLanguagePrompt(page: Page) {
	const keepCurrentLanguage = page
		.getByRole("button")
		.filter({ hasText: /Keep current language|Conserver la langue actuelle/ });
	if ((await keepCurrentLanguage.count()) > 0) {
		await keepCurrentLanguage.click();
	}
}

test.describe("issue #35 — first record before source selection (empirical probe)", () => {
	test.skip(
		process.platform !== "win32",
		"Reported crash is Windows-only (native/displayMedia path).",
	);

	test("no-source startup does not crash the main process", async () => {
		// Sentinel: this spec is only meaningful when it actually executes on the
		// intended platform. If it is ever reached on non-win32, fail loudly
		// rather than letting a skip masquerade as "did not reproduce".
		expect(process.platform).toBe("win32");

		const app = await launchApp();
		const holder = app as ElectronApplication & {
			__getStderr?: () => string;
			__getStdout?: () => string;
		};
		try {
			const hud = await app.firstWindow({ timeout: 60_000 });
			await hud.waitForLoadState("domcontentloaded");
			await dismissLanguagePrompt(hud);

			// (0) Confirm we are genuinely in the no-source state.
			const selectedSource = await hud.evaluate(() => window.electronAPI.getSelectedSource());

			// (1) UI guard: record button must be disabled, and a forced click a no-op.
			const recBtn = hud.getByTestId("launch-record-button");
			const recordButtonDisabled = await recBtn.isDisabled();
			let forceClickError: string | null = null;
			try {
				await recBtn.click({ force: true, timeout: 3_000 });
			} catch (e) {
				forceClickError = String(e);
			}

			// (2) Main-process: directly hammer the unguarded native binding
			// desktopCapturer.getSources(opts) with assorted opts, including the
			// exact opts SourceSelector uses and several malformed ones. Each call
			// is bounded so a hang on one opt cannot stall the whole probe.
			const getSourcesProbe = await app.evaluate(async ({ desktopCapturer }) => {
				const optsList: Record<string, unknown> = {
					undefined_opts: undefined,
					empty_opts: {},
					real_opts: {
						types: ["screen", "window"],
						thumbnailSize: { width: 320, height: 180 },
						fetchWindowIcons: true,
					},
					bad_types_string: { types: "screen" },
					bad_types_number: { types: [1, 2] },
					bad_thumbnail: { types: ["screen"], thumbnailSize: "big" },
				};
				const settle = (p: Promise<unknown>, ms: number) =>
					Promise.race([
						p.then(
							(v) => ({
								threw: false,
								count: Array.isArray(v) ? (v as unknown[]).length : -1,
							}),
							(e: unknown) => ({
								threw: true,
								message: e instanceof Error ? e.message : String(e),
							}),
						),
						new Promise<{ threw: boolean; timedOut: boolean }>((res) =>
							setTimeout(() => res({ threw: false, timedOut: true }), ms),
						),
					]);
				const out: Record<string, unknown> = {};
				for (const [name, opts] of Object.entries(optsList)) {
					// @ts-expect-error intentionally passing malformed opts to probe the binding
					out[name] = await settle(desktopCapturer.getSources(opts), 5_000);
				}
				return out;
			});

			// (3) Renderer-driven: invoke the real recording entry points with no
			// / invalid source, exactly as a forced record attempt would.
			const rendererProbe = await hud.evaluate(async () => {
				const settle = (fn: () => Promise<unknown>, ms: number) =>
					Promise.race([
						(async () => {
							try {
								return { threw: false, detail: await fn() };
							} catch (e) {
								return { threw: true, message: e instanceof Error ? e.message : String(e) };
							}
						})(),
						new Promise<{ threw: boolean; timedOut: boolean }>((res) =>
							setTimeout(() => res({ threw: false, timedOut: true }), ms),
						),
					]);

				const out: Record<string, unknown> = {};
				out.startNativeNullSource = await settle(
					() =>
						window.electronAPI.startNativeWindowsRecording({
							recordingId: 123456,
							// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid source for probe
							source: { type: "display", sourceId: null as any },
							video: { fps: 30, width: 1920, height: 1080 },
							audio: {
								system: { enabled: false },
								microphone: { enabled: false, deviceId: undefined, deviceName: undefined, gain: 1 },
							},
							webcam: {
								enabled: false,
								deviceId: undefined,
								deviceName: undefined,
								width: 0,
								height: 0,
								fps: 30,
							},
							cursor: { mode: "editable-overlay" },
							// biome-ignore lint/suspicious/noExplicitAny: probe payload
						} as any),
					8_000,
				);

				out.getDisplayMediaNoSource = await settle(async () => {
					const stream = await navigator.mediaDevices.getDisplayMedia({
						video: true,
						audio: false,
					});
					const n = stream.getTracks().length;
					stream.getTracks().forEach((track) => track.stop());
					return n;
				}, 8_000);

				return out;
			});

			// Give any async uncaughtException time to surface in stderr.
			await new Promise((r) => setTimeout(r, 1_000));
			const stderr = holder.__getStderr?.() ?? "";
			const stdout = holder.__getStdout?.() ?? "";
			const crashInStderr = CRASH_SIGNATURE.test(stderr);
			const crashInStdout = CRASH_SIGNATURE.test(stdout);

			// App must still be responsive (not crashed) — read a value over IPC.
			const stillAlive = await hud.evaluate(() => window.electronAPI.getPlatform());

			// eslint-disable-next-line no-console
			console.log(
				`PROBE_RESULT ${JSON.stringify(
					{
						selectedSourceWasNull: selectedSource === null,
						recordButtonDisabled,
						forceClickError,
						getSourcesProbe,
						rendererProbe,
						crashSignatureInStderr: crashInStderr,
						crashSignatureInStdout: crashInStdout,
						stillAlive,
					},
					null,
					2,
				)}`,
			);

			// Binary acceptance for the current source tree:
			// no source ⇒ record button disabled, and no main-process crash signature.
			expect(selectedSource).toBeNull();
			expect(recordButtonDisabled).toBe(true);
			expect(crashInStderr).toBe(false);
			expect(stillAlive).toBe("win32");
		} finally {
			await closeApp(app);
		}
	});
});
