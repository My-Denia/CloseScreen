import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraDevices } from "./useCameraDevices";

// Mock navigator.mediaDevices
const mockDevices = [
	{ kind: "videoinput", deviceId: "cam1", label: "Camera 1", groupId: "group1" },
	{ kind: "videoinput", deviceId: "cam2", label: "Camera 2", groupId: "group1" },
	{ kind: "audioinput", deviceId: "mic1", label: "Mic 1", groupId: "group2" },
];

const mockGetUserMedia = vi.fn().mockResolvedValue({
	getTracks: () => [{ stop: vi.fn() }],
});

const mockEnumerateDevices = vi.fn().mockResolvedValue(mockDevices);

Object.defineProperty(global.navigator, "mediaDevices", {
	value: {
		enumerateDevices: mockEnumerateDevices,
		getUserMedia: mockGetUserMedia,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	},
	configurable: true,
});

describe("useCameraDevices", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockEnumerateDevices.mockResolvedValue(mockDevices);
	});

	afterEach(() => {
		vi.resetAllMocks();
	});

	it("should list video input devices", async () => {
		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.devices).toHaveLength(2);
		});

		expect(result.current.devices[0].label).toBe("Camera 1");
		expect(result.current.devices[1].deviceId).toBe("cam2");
	});

	it("should set first device as default", async () => {
		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam1");
		});
	});

	it("should request permission if labels are empty and populate devices after", async () => {
		mockEnumerateDevices
			.mockResolvedValueOnce([
				{ kind: "videoinput", deviceId: "cam1", label: "", groupId: "group1" },
			])
			.mockResolvedValueOnce(mockDevices);

		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(mockGetUserMedia).toHaveBeenCalledWith({ video: true });
		});

		await waitFor(() => {
			expect(result.current.devices[0]?.label).toBe("Camera 1");
		});
	});

	it("should fall back to first available device when selected device is unplugged", async () => {
		const { result } = renderHook(() => useCameraDevices(true));

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam1");
		});

		// Simulate cam1 being unplugged — only cam2 remains
		// loadDevices calls enumerateDevices twice, mock both to return only cam2
		const cam2Only = [
			{ kind: "videoinput", deviceId: "cam2", label: "Camera 2", groupId: "group1" },
		];
		mockEnumerateDevices.mockResolvedValueOnce(cam2Only).mockResolvedValueOnce(cam2Only);

		// Trigger devicechange event via the registered handler
		const devicechangeHandler = (
			navigator.mediaDevices.addEventListener as ReturnType<typeof vi.fn>
		).mock.calls[0]?.[1] as (() => void) | undefined;

		await act(async () => {
			devicechangeHandler?.();
		});

		await waitFor(() => {
			expect(result.current.selectedDeviceId).toBe("cam2");
		});
	});
});
