import type {
	NativeWindowsRecordingStartResult,
	SystemAudioUnavailableReason,
} from "../../src/lib/nativeWindowsRecording";

export type NativeWindowsWebcamFormat = {
	width?: number;
	height?: number;
	fps?: number;
	deviceName?: string;
};

type NativeWindowsSystemAudioUnavailableEvent = {
	event?: string;
	reason?: string;
};

const SYSTEM_AUDIO_UNAVAILABLE_REASONS = new Set<SystemAudioUnavailableReason>([
	"no-render-endpoint",
	"device-in-use",
	"unsupported-format",
	"init-failed",
]);

function parseJsonEvent(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

export function readNativeWindowsWebcamFormat(output: string): NativeWindowsWebcamFormat | null {
	const lines = output.split(/\r?\n/).filter((line) => line.includes('"event":"webcam-format"'));
	const lastLine = lines.at(-1);
	if (!lastLine) {
		return null;
	}

	const parsed = parseJsonEvent(lastLine);
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	return parsed as NativeWindowsWebcamFormat;
}

export function readNativeWindowsSystemAudioUnavailableReason(
	output: string,
): SystemAudioUnavailableReason | undefined {
	const lines = output
		.split(/\r?\n/)
		.filter((line) => line.includes('"event":"system-audio-unavailable"'));
	const lastLine = lines.at(-1);
	if (!lastLine) {
		return undefined;
	}

	const parsed = parseJsonEvent(lastLine) as NativeWindowsSystemAudioUnavailableEvent | null;
	if (
		parsed?.event === "system-audio-unavailable" &&
		typeof parsed.reason === "string" &&
		SYSTEM_AUDIO_UNAVAILABLE_REASONS.has(parsed.reason as SystemAudioUnavailableReason)
	) {
		return parsed.reason as SystemAudioUnavailableReason;
	}

	return "init-failed";
}

export function createNativeWindowsRecordingStartResult(
	recordingId: number,
	outputPath: string,
	helperPath: string,
	output: string,
): NativeWindowsRecordingStartResult {
	const systemAudioUnavailableReason = readNativeWindowsSystemAudioUnavailableReason(output);
	return {
		success: true,
		recordingId,
		path: outputPath,
		helperPath,
		...(systemAudioUnavailableReason ? { systemAudioUnavailableReason } : {}),
	};
}
