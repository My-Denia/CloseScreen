import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenRecorder } from "./useScreenRecorder";

const translations = vi.hoisted(() => ({
	"recording.systemAudioUnavailable": "System audio not available. Recording without system audio.",
	"recording.systemAudioUnavailableReasons.captureFailed":
		"Windows could not start system-audio capture. Check the selected output device and exclusive-mode audio apps.",
	"recording.systemAudioUnavailableReasons.deviceInUse":
		"The selected output device is in exclusive use by another app.",
	"recording.systemAudioUnavailableReasons.noAudioTrack":
		"Windows did not return a system-audio track. Check that an output device is active and selected.",
}));

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => translations[key as keyof typeof translations] ?? key,
}));

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
	},
}));

type ElectronAPI = Window["electronAPI"];

const selectedSource = {
	id: "screen:1",
	name: "Display 1",
	display_id: "1",
	thumbnail: null,
	appIcon: null,
};

class FakeMediaStreamTrack {
	readonly kind: string;
	stop = vi.fn();
	applyConstraints = vi.fn(async () => undefined);
	getSettings = vi.fn(() => ({
		width: 1920,
		height: 1080,
		frameRate: 60,
	}));

	constructor(kind: string) {
		this.kind = kind;
	}
}

class FakeMediaStream {
	private tracks: FakeMediaStreamTrack[];

	constructor(tracks: FakeMediaStreamTrack[] = []) {
		this.tracks = [...tracks];
	}

	addTrack(track: FakeMediaStreamTrack) {
		this.tracks.push(track);
	}

	getTracks() {
		return [...this.tracks];
	}

	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === "video");
	}

	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === "audio");
	}
}

class FakeMediaRecorder {
	static instances: FakeMediaRecorder[] = [];
	static isTypeSupported = vi.fn(() => true);

	readonly stream: FakeMediaStream;
	readonly options: MediaRecorderOptions;
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	state: RecordingState = "inactive";
	private listeners = new Map<string, Array<() => void>>();

	constructor(stream: FakeMediaStream, options: MediaRecorderOptions) {
		this.stream = stream;
		this.options = options;
		FakeMediaRecorder.instances.push(this);
	}

	start() {
		this.state = "recording";
	}

	stop() {
		this.state = "inactive";
		this.onstop?.();
		for (const listener of this.listeners.get("stop") ?? []) {
			listener();
		}
	}

	pause() {
		this.state = "paused";
	}

	resume() {
		this.state = "recording";
	}

	addEventListener(type: string, listener: () => void) {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
}

const mockGetDisplayMedia = vi.fn();
const mockGetUserMedia = vi.fn();

function installElectronAPI(overrides: Partial<ElectronAPI> = {}) {
	window.electronAPI = {
		getSelectedSource: vi.fn(async () => selectedSource),
		getPlatform: vi.fn(async () => "win32"),
		isNativeWindowsCaptureAvailable: vi.fn(async () => ({
			success: true,
			available: false,
			reason: "unsupported-os",
		})),
		startNativeWindowsRecording: vi.fn(async () => ({
			success: false,
			error: "not mocked",
		})),
		showCountdownOverlay: vi.fn(async () => undefined),
		setCountdownOverlayValue: vi.fn(async () => undefined),
		hideCountdownOverlay: vi.fn(async () => undefined),
		setRecordingState: vi.fn(),
		getRecordingStorageStatus: vi.fn(async () => ({ lowSpace: false, freeBytes: 1_000_000 })),
		openRecordingStream: vi.fn(async () => ({ success: true })),
		appendRecordingChunk: vi.fn(async () => ({ success: true })),
		...overrides,
	} as unknown as ElectronAPI;
}

async function startThroughCountdown(result: ReturnType<typeof renderHook>["result"]) {
	await act(async () => {
		result.current.toggleRecording();
	});
	for (let i = 0; i < 3; i++) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
	}
	await act(async () => {
		await Promise.resolve();
	});
}

describe("useScreenRecorder Windows system audio warnings", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("MediaStream", FakeMediaStream);
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		Object.defineProperty(global.navigator, "mediaDevices", {
			value: {
				getDisplayMedia: mockGetDisplayMedia,
				getUserMedia: mockGetUserMedia,
			},
			configurable: true,
		});
		FakeMediaRecorder.instances = [];
		FakeMediaRecorder.isTypeSupported.mockReturnValue(true);
		mockGetDisplayMedia.mockReset();
		mockGetUserMedia.mockReset();
		vi.mocked(toast.error).mockClear();
		installElectronAPI();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		window.electronAPI = undefined as unknown as ElectronAPI;
	});

	it("warns and continues video-only when Windows getDisplayMedia omits a requested system-audio track", async () => {
		mockGetDisplayMedia.mockResolvedValueOnce(
			new FakeMediaStream([new FakeMediaStreamTrack("video")]),
		);

		const { result, unmount } = renderHook(() => useScreenRecorder());
		await act(async () => {
			result.current.setSystemAudioEnabled(true);
		});

		await startThroughCountdown(result);

		expect(mockGetDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: true }));
		expect(toast.error).toHaveBeenCalledWith(
			"System audio not available. Recording without system audio. Windows did not return a system-audio track. Check that an output device is active and selected.",
		);
		expect(result.current.recording).toBe(true);
		expect(FakeMediaRecorder.instances).toHaveLength(1);
		expect(FakeMediaRecorder.instances[0]?.stream.getVideoTracks()).toHaveLength(1);
		expect(FakeMediaRecorder.instances[0]?.stream.getAudioTracks()).toHaveLength(0);

		unmount();
	});

	it("warns once, retries video-only, and records when Windows system-audio getDisplayMedia rejects", async () => {
		mockGetDisplayMedia
			.mockRejectedValueOnce(new DOMException("loopback failed", "NotReadableError"))
			.mockResolvedValueOnce(new FakeMediaStream([new FakeMediaStreamTrack("video")]));

		const { result, unmount } = renderHook(() => useScreenRecorder());
		await act(async () => {
			result.current.setSystemAudioEnabled(true);
		});

		await startThroughCountdown(result);

		expect(mockGetDisplayMedia).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ audio: true }),
		);
		expect(mockGetDisplayMedia).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ audio: false }),
		);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith(
			"System audio not available. Recording without system audio. Windows could not start system-audio capture. Check the selected output device and exclusive-mode audio apps.",
		);
		expect(result.current.recording).toBe(true);

		unmount();
	});

	it("shows the native helper reason when WGC starts after degrading system audio", async () => {
		installElectronAPI({
			isNativeWindowsCaptureAvailable: vi.fn(async () => ({
				success: true,
				available: true,
				helperPath: "C:\\helper\\wgc-capture.exe",
			})),
			startNativeWindowsRecording: vi.fn(async () => ({
				success: true,
				recordingId: 24,
				path: "C:\\recordings\\recording-24.mp4",
				helperPath: "C:\\helper\\wgc-capture.exe",
				systemAudioUnavailableReason: "device-in-use",
			})),
		});

		const { result, unmount } = renderHook(() => useScreenRecorder());
		await act(async () => {
			result.current.setSystemAudioEnabled(true);
		});

		await startThroughCountdown(result);

		expect(mockGetDisplayMedia).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith(
			"System audio not available. Recording without system audio. The selected output device is in exclusive use by another app.",
		);
		expect(result.current.recording).toBe(true);

		unmount();
	});
});
