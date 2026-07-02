import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 120_000, // GIF encoding is CPU-bound; give it room
	retries: 0,
	// Each spec boots a real Electron app; on a real Windows desktop session parallel
	// instances flake on the capture-heavy specs (shared GPU disk cache, WGC "Source is
	// not capturable" under contention). Serial is reliably green and still fast (<1 min).
	workers: 1,
	reporter: "list",
});
