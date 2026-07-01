import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

// onnxruntime-web references its wasm via `new URL(..., import.meta.url)`, so a production
// `vite build` emits the ORT wasm (~23.5MB asyncify + siblings) into dist/assets. The captioning
// worker always loads wasm from env.wasm.wasmPaths (vite dev server in dev; caption-assets/ort
// under file:// when packaged), so those emitted assets are dead weight — drop them from the build.
// Build-only: dev (vite serve) still serves the wasm on demand.
function stripOrtWasmFromBundle() {
	return {
		name: "strip-ort-wasm-from-bundle",
		apply: "build" as const,
		generateBundle(_options: unknown, bundle: Record<string, unknown>) {
			for (const fileName of Object.keys(bundle)) {
				if (fileName.includes("ort-wasm") && fileName.endsWith(".wasm")) delete bundle[fileName];
			}
		},
	};
}

// https://vitejs.dev/config/
export default defineConfig({
	plugins: [
		react(),
		electron({
			main: {
				entry: "electron/main.ts",
				onstart({ startup }) {
					const env = { ...process.env };
					delete env.ELECTRON_RUN_AS_NODE;
					return startup(["."], { env });
				},
				vite: {
					build: {},
				},
			},
			preload: {
				input: path.join(__dirname, "electron/preload.ts"),
			},
			renderer: process.env.NODE_ENV === "test" ? undefined : {},
		}),
		stripOrtWasmFromBundle(),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
			// @huggingface/transformers: env.js statically imports fs/path/url; onnx.js imports
			// onnxruntime-node (must not be bundled in the renderer — it requires fs).
			fs: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			path: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			url: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"onnxruntime-node": path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts"), // re-exports web ORT
		},
	},
	optimizeDeps: {
		exclude: ["@huggingface/transformers"],
	},
	// The captioning worker dynamically imports @huggingface/transformers, which makes the
	// worker bundle code-split — unsupported by the default "iife" worker format.
	worker: {
		format: "es",
	},
	build: {
		target: "esnext",
		minify: "terser",
		terserOptions: {
			compress: {
				drop_console: true,
				drop_debugger: true,
				pure_funcs: ["console.log", "console.debug"],
			},
		},
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("pixi.js") || id.includes("pixi-filters") || id.includes("@pixi/"))
						return "pixi";
					if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
					if (id.includes("mediabunny") || id.includes("fix-webm-duration"))
						return "video-processing";
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
});
