import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
	appGetVersion: vi.fn(() => "1.5.0-fork.1"),
	ipcHandle: vi.fn(),
	netFetch: vi.fn(),
}));

vi.mock("electron", () => ({
	app: { getVersion: electronMock.appGetVersion },
	ipcMain: { handle: electronMock.ipcHandle },
	net: { fetch: electronMock.netFetch },
}));

import { checkForUpdates, GITHUB_REPO, registerUpdateCheckHandler } from "./updateCheck";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
	tag_name: tag,
	html_url: `https://github.com/My-Denia/CloseScreen/releases/tag/${tag}`,
	...extra,
});

const jsonResponse = (payload: unknown, options: { ok?: boolean; link?: string } = {}) => ({
	ok: options.ok ?? true,
	headers: {
		get: vi.fn((name: string) => (name.toLowerCase() === "link" ? (options.link ?? null) : null)),
	},
	json: vi.fn().mockResolvedValue(payload),
});

describe("checkForUpdates", () => {
	beforeEach(() => {
		electronMock.appGetVersion.mockReturnValue("1.5.0-fork.1");
		electronMock.ipcHandle.mockClear();
		electronMock.netFetch.mockReset();
	});

	it("uses this fork's paginated GitHub Releases endpoint", async () => {
		electronMock.netFetch.mockResolvedValue(jsonResponse([release("v1.5.0-fork.2")]));

		await checkForUpdates();

		expect(GITHUB_REPO).toBe("My-Denia/CloseScreen");
		expect(electronMock.netFetch).toHaveBeenCalledWith(
			"https://api.github.com/repos/My-Denia/CloseScreen/releases?per_page=100",
			expect.objectContaining({
				headers: expect.objectContaining({
					Accept: "application/vnd.github+json",
					"User-Agent": "CloseScreen/1.5.0-fork.1",
				}),
			}),
		);
	});

	it("returns an update for a newer stable release", async () => {
		electronMock.netFetch.mockResolvedValue(jsonResponse([release("v1.5.0-fork.2")]));

		await expect(checkForUpdates()).resolves.toEqual({
			status: "update",
			currentVersion: "1.5.0-fork.1",
			latestVersion: "1.5.0-fork.2",
			url: "https://github.com/My-Denia/CloseScreen/releases/tag/v1.5.0-fork.2",
		});
	});

	it("paginates past prereleases and picks the highest parseable stable version", async () => {
		electronMock.netFetch
			.mockResolvedValueOnce(
				jsonResponse([release("v9.9.9-fork.9", { prerelease: true }), release("v1.5.1")], {
					link: '<https://api.github.com/repos/My-Denia/CloseScreen/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/My-Denia/CloseScreen/releases?per_page=100&page=2>; rel="last"',
				}),
			)
			.mockResolvedValueOnce(jsonResponse([release("v1.6.0")]));

		await expect(checkForUpdates()).resolves.toEqual({
			status: "update",
			currentVersion: "1.5.0-fork.1",
			latestVersion: "1.6.0",
			url: "https://github.com/My-Denia/CloseScreen/releases/tag/v1.6.0",
		});
		expect(electronMock.netFetch).toHaveBeenCalledTimes(2);
	});

	it("does not report a newer prerelease on the default stable channel", async () => {
		electronMock.netFetch.mockResolvedValue(
			jsonResponse([release("v1.5.0-fork.3", { prerelease: true }), release("v1.5.0-fork.1")]),
		);

		await expect(checkForUpdates()).resolves.toEqual({
			status: "upToDate",
			currentVersion: "1.5.0-fork.1",
		});
	});

	it("returns up to date when the current version is newer than the latest stable release", async () => {
		electronMock.appGetVersion.mockReturnValue("1.5.0-fork.2");
		electronMock.netFetch.mockResolvedValue(jsonResponse([release("v1.5.0-fork.1")]));

		await expect(checkForUpdates()).resolves.toEqual({
			status: "upToDate",
			currentVersion: "1.5.0-fork.2",
		});
	});

	it("degrades to an error result for network failures", async () => {
		electronMock.netFetch.mockRejectedValue(new Error("offline"));

		await expect(checkForUpdates()).resolves.toEqual({
			status: "error",
			currentVersion: "1.5.0-fork.1",
		});
	});

	it("degrades to an error result for malformed release responses", async () => {
		electronMock.netFetch.mockResolvedValue(jsonResponse({ message: "not an array" }));

		await expect(checkForUpdates()).resolves.toEqual({
			status: "error",
			currentVersion: "1.5.0-fork.1",
		});
	});

	it("degrades to an error result for rate-limited responses", async () => {
		electronMock.netFetch.mockResolvedValue(
			jsonResponse({ message: "API rate limit exceeded" }, { ok: false }),
		);

		await expect(checkForUpdates()).resolves.toEqual({
			status: "error",
			currentVersion: "1.5.0-fork.1",
		});
	});

	it("degrades to an error result if a later page fails", async () => {
		electronMock.netFetch
			.mockResolvedValueOnce(
				jsonResponse([release("v1.5.0-fork.2")], {
					link: '<https://api.github.com/repos/My-Denia/CloseScreen/releases?per_page=100&page=2>; rel="next"',
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ message: "rate limited" }, { ok: false }));

		await expect(checkForUpdates()).resolves.toEqual({
			status: "error",
			currentVersion: "1.5.0-fork.1",
		});
	});

	it("registers the update-check IPC handler", () => {
		registerUpdateCheckHandler();

		expect(electronMock.ipcHandle).toHaveBeenCalledWith("check-for-updates", expect.any(Function));
	});
});
