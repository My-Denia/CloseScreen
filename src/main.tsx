// Patch PixiJS to avoid `new Function()` shader/uniform codegen under the packaged app's
// Content-Security-Policy. The CSP currently allows 'unsafe-eval' only because web-demuxer's
// FFmpeg glue needs it; this patch removes PixiJS's own eval dependency so the renderer isn't a
// blocker if that allowance is ever dropped. Must run before any PixiJS renderer is created
// (editor preview + the exporter's FrameRenderer). Side-effect import.
import "pixi.js/unsafe-eval";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "./contexts/I18nContext";
import "./index.css";

const windowType = new URLSearchParams(window.location.search).get("windowType") || "";
if (
	windowType === "hud-overlay" ||
	windowType === "source-selector" ||
	windowType === "countdown-overlay"
) {
	document.body.style.background = "transparent";
	document.documentElement.style.background = "transparent";
	document.getElementById("root")?.style.setProperty("background", "transparent");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<I18nProvider>
			<App />
		</I18nProvider>
	</React.StrictMode>,
);
