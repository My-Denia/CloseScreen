import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecordingStreamRegistry } from "./recordingStream";

describe("RecordingStreamRegistry", () => {
	let dir: string;
	const pathFor = (name: string) => path.join(dir, name);

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "closescreen-stream-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("streams chunks to disk in order and reports streamed on finalize", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("hello "));
		await registry.append("rec.webm", Buffer.from("world"));

		const streamed = await registry.finalize("rec.webm");

		expect(streamed).toBe(true);
		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("hello world");
		// A second finalize has nothing to close.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("reports not-streamed when no stream was opened", async () => {
		const registry = new RecordingStreamRegistry();
		expect(await registry.finalize("missing.webm")).toBe(false);
		expect(registry.has("missing.webm")).toBe(false);
	});

	it("rejects open when the target path is not writable (open is awaited, not assumed)", async () => {
		const registry = new RecordingStreamRegistry();
		// A FILE where the parent directory must go defeats the recursive mkdir, so the
		// open still fails up front. (A merely missing parent is recreated instead —
		// covered below — since a custom recordings dir can vanish between startup and
		// record, issue #23.)
		await writeFile(pathFor("blocker"), "x", "utf8");
		await expect(
			registry.open("rec.webm", path.join(dir, "blocker", "rec.webm")),
		).rejects.toThrow();
		// A failed open must not register a stream the renderer would treat as live.
		expect(registry.has("rec.webm")).toBe(false);
	});

	it("recreates a missing parent directory on open (vanished custom dir, issue #23)", async () => {
		const registry = new RecordingStreamRegistry();
		const nestedPath = path.join(dir, "was-deleted", "rec.webm");
		await registry.open("rec.webm", nestedPath);
		await registry.append("rec.webm", Buffer.from("bytes"));
		expect(await registry.finalize("rec.webm")).toBe(true);
		expect(await readFile(nestedPath, "utf8")).toBe("bytes");
	});

	it("rejects append when no stream is open", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.append("rec.webm", Buffer.from("x"))).rejects.toThrow(
			/No active recording stream/,
		);
	});

	it("discard closes the stream and removes the partial file", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("partial"));

		await registry.discard("rec.webm", pathFor("rec.webm"));

		expect(registry.has("rec.webm")).toBe(false);
		await expect(stat(pathFor("rec.webm"))).rejects.toThrow();
		// Nothing left to finalize after a discard.
		expect(await registry.finalize("rec.webm")).toBe(false);
	});

	it("discard tolerates a missing file", async () => {
		const registry = new RecordingStreamRegistry();
		await expect(registry.discard("never.webm", pathFor("never.webm"))).resolves.toBeUndefined();
	});

	it("opening the same file twice replaces the prior stream", async () => {
		const registry = new RecordingStreamRegistry();
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("first"));
		await registry.open("rec.webm", pathFor("rec.webm"));
		await registry.append("rec.webm", Buffer.from("second"));
		await registry.finalize("rec.webm");

		expect(await readFile(pathFor("rec.webm"), "utf8")).toBe("second");
	});

	// The recordings dir is user-configurable (issue #23): paths are pinned at open()
	// so a mid-recording settings change can't retarget finalize/discard.
	describe("open-time path pinning", () => {
		it("exposes the pinned path while open, and drops it after finalize", async () => {
			const registry = new RecordingStreamRegistry();
			await registry.open("rec.webm", pathFor("rec.webm"));
			expect(registry.getOpenPath("rec.webm")).toBe(pathFor("rec.webm"));
			expect(registry.size).toBe(1);

			await registry.finalize("rec.webm");
			expect(registry.getOpenPath("rec.webm")).toBeUndefined();
			expect(registry.size).toBe(0);
		});

		it("discard unlinks the pinned open-time path, not the caller's re-resolved one", async () => {
			const registry = new RecordingStreamRegistry();
			await registry.open("rec.webm", pathFor("rec.webm"));
			await registry.append("rec.webm", Buffer.from("partial"));
			// Simulates the recordings dir changing between open and discard: the caller
			// re-resolves to a different location, but the bytes live at the pinned path.
			const wrongPath = pathFor("elsewhere.webm");
			await writeFile(wrongPath, "unrelated", "utf8");

			await registry.discard("rec.webm", wrongPath);

			await expect(stat(pathFor("rec.webm"))).rejects.toThrow();
			expect(await readFile(wrongPath, "utf8")).toBe("unrelated");
		});
	});
});
