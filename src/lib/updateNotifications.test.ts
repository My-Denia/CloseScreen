import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getStartupUpdateNotice,
	getUpdateChecksDisabled,
	setUpdateChecksDisabled,
} from "./updateNotifications";

const toastMock = vi.hoisted(() => ({
	base: vi.fn(),
	error: vi.fn(),
	success: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: Object.assign(toastMock.base, {
		error: toastMock.error,
		success: toastMock.success,
	}),
}));

function installLocalStorage(): void {
	const store = new Map<string, string>();
	const stub = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, String(value));
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => store.clear(),
		key: (i: number) => Array.from(store.keys())[i] ?? null,
		get length() {
			return store.size;
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: stub,
		configurable: true,
	});
}

function installUpdateCheck(
	checkForUpdates: () => ReturnType<Window["electronAPI"]["checkForUpdates"]>,
): void {
	window.electronAPI = {
		checkForUpdates,
	} as unknown as Window["electronAPI"];
}

describe("update notification preferences", () => {
	beforeEach(() => {
		installLocalStorage();
		installUpdateCheck(vi.fn().mockResolvedValue({ status: "upToDate", currentVersion: "1.5.0" }));
		toastMock.base.mockClear();
		toastMock.error.mockClear();
		toastMock.success.mockClear();
	});

	it("round-trips the startup update-check opt-out", () => {
		expect(getUpdateChecksDisabled()).toBe(false);

		setUpdateChecksDisabled(true);
		expect(getUpdateChecksDisabled()).toBe(true);

		setUpdateChecksDisabled(false);
		expect(getUpdateChecksDisabled()).toBe(false);
	});

	it("does not call the update IPC when startup checks are disabled", async () => {
		const checkForUpdates = vi.fn().mockResolvedValue({
			status: "update",
			currentVersion: "1.5.0-fork.1",
			latestVersion: "1.5.0-fork.2",
			url: "https://github.com/My-Denia/CloseScreen/releases/tag/v1.5.0-fork.2",
		});
		installUpdateCheck(checkForUpdates);
		setUpdateChecksDisabled(true);

		await expect(getStartupUpdateNotice()).resolves.toBeNull();
		expect(checkForUpdates).not.toHaveBeenCalled();
	});

	it("keeps startup quiet when the update IPC fails", async () => {
		const checkForUpdates = vi.fn().mockRejectedValue(new Error("offline"));
		installUpdateCheck(checkForUpdates);

		await expect(getStartupUpdateNotice()).resolves.toBeNull();
		expect(checkForUpdates).toHaveBeenCalledTimes(1);
		expect(toastMock.base).not.toHaveBeenCalled();
		expect(toastMock.error).not.toHaveBeenCalled();
		expect(toastMock.success).not.toHaveBeenCalled();
	});

	it("returns an available startup update unless that version was dismissed", async () => {
		const update = {
			status: "update" as const,
			currentVersion: "1.5.0-fork.1",
			latestVersion: "1.5.0-fork.2",
			url: "https://github.com/My-Denia/CloseScreen/releases/tag/v1.5.0-fork.2",
		};
		installUpdateCheck(vi.fn().mockResolvedValue(update));

		await expect(getStartupUpdateNotice()).resolves.toEqual(update);

		localStorage.setItem("closescreen_update_dismissed_version", update.latestVersion);
		await expect(getStartupUpdateNotice()).resolves.toBeNull();
	});
});
