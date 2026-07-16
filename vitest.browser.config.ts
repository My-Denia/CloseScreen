import path from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.browser.test.{ts,tsx}"],
		browser: {
			enabled: true,
			// Keep Vite's listener and Playwright's navigation on the same IPv4
			// loopback address. On Windows, `localhost` can resolve to ::1 while
			// the test server is listening on 127.0.0.1, yielding a false
			// ERR_CONNECTION_REFUSED before any browser test is collected.
			api: { host: "127.0.0.1" },
			provider: playwright({
				launch: {
					// Software WebGL so Pixi.js works in headless CI without a GPU.
					args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"],
				},
			}),
			headless: true,
			instances: [{ browser: "chromium" }],
		},
		testTimeout: 120_000,
		hookTimeout: 30_000,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	assetsInclude: ["**/*.webm"],
});
