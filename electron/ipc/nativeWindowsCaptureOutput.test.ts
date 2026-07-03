import { describe, expect, it } from "vitest";
import {
	createNativeWindowsRecordingStartResult,
	readNativeWindowsSystemAudioUnavailableReason,
	readNativeWindowsWebcamFormat,
} from "./nativeWindowsCaptureOutput";

describe("native Windows capture stdout parsing", () => {
	it("reads the latest structured system audio unavailable reason", () => {
		const output = [
			'{"event":"system-audio-unavailable","schemaVersion":2,"reason":"no-render-endpoint"}',
			"Recording started",
			'{"event":"system-audio-unavailable","schemaVersion":2,"reason":"device-in-use"}',
		].join("\n");

		expect(readNativeWindowsSystemAudioUnavailableReason(output)).toBe("device-in-use");
	});

	it("normalizes malformed system audio unavailable events to init-failed", () => {
		expect(
			readNativeWindowsSystemAudioUnavailableReason(
				'{"event":"system-audio-unavailable","schemaVersion":2,"reason":"surprise"}',
			),
		).toBe("init-failed");
	});

	it("forwards the parsed reason on the native recording start result", () => {
		const result = createNativeWindowsRecordingStartResult(
			24,
			"C:\\recordings\\recording-24.mp4",
			"C:\\helper\\wgc-capture.exe",
			'{"event":"system-audio-unavailable","schemaVersion":2,"reason":"unsupported-format"}',
		);

		expect(result).toMatchObject({
			success: true,
			recordingId: 24,
			systemAudioUnavailableReason: "unsupported-format",
		});
	});

	it("keeps webcam format parsing intact", () => {
		expect(
			readNativeWindowsWebcamFormat(
				'{"event":"webcam-format","schemaVersion":2,"width":1280,"height":720,"fps":30,"deviceName":"Cam"}',
			),
		).toMatchObject({
			width: 1280,
			height: 720,
			fps: 30,
			deviceName: "Cam",
		});
	});
});
