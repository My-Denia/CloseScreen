# Windows Native Recorder Roadmap

CloseScreen's Windows recorder is owned by one process contract with two transition implementations. Rust is the Windows x64 release default; the legacy C++ implementation is packaged under distinct filenames for explicit rollback. Electron capture remains the non-Windows path, but Windows production recording does not silently fall back to `getDisplayMedia` / `MediaRecorder`.

## Migration boundary status

The implementation phases below record how the native recorder was built. The final backend
migration now preserves that architecture and changes only the implementation boundary:

- Electron resolves one capture/cursor pair per recording attempt.
- Unset `CLOSESCREEN_WINDOWS_CAPTURE_BACKEND` selects Rust; `legacy` selects the packaged C++ pair.
- Both pairs implement the V2 lifecycle/error contract and remain covered by parity, normal-stop,
  fault-injection, and cursor-sampler gates.
- Windows packages contain both x64 pairs under `resources/electron/native/bin/win32-x64`.
- The renderer, editor, exporter, and `RecordingSession` architecture are unchanged.
- Webcam media is a separate editable `webcamVideoPath` sidecar in production sessions.

The current maintainer validation environment is one Windows x64 laptop. Multi-monitor behavior,
external audio hardware, other GPU/driver combinations, Windows ARM64, macOS, Linux Wayland,
signing, and notarization are not established by this migration.

The laptop's current webcam path is also not a passed release gate: both transition backends
exceeded the 9-second post-stop bound, and the Rust diagnostic run exited under a 30-second ceiling
without producing the webcam sidecar. Because the failure is shared with the legacy backend and no
device-independent root cause is established, it remains a documented hardware-specific limitation
rather than a speculative migration patch.

## Goals

- Capture displays and windows through Windows Graphics Capture (WGC).
- Render the native Windows cursor as CloseScreen's high-quality scalable cursor overlay.
- Capture system audio through WASAPI loopback.
- Capture microphone audio through WASAPI.
- Mix system audio and microphone audio into the primary screen recording.
- Capture webcam video natively into the separate sidecar used by the existing editor.
- Keep preview/export aligned by preserving normalized screen/audio/cursor timing and the existing
  webcam sidecar session contract.
- Keep exported MP4s Windows-friendly: H.264 video plus AAC audio. Opus-in-MP4 is not an acceptable Windows export target.
- Package the native helper with the Windows app.

## Non-Goals

- Replacing the renderer, editor, session, or export pipeline.
- Adding a native backend for macOS or Linux in this migration.
- Removing the legacy C++ implementation before transition evidence and a later removal decision.
- Claiming hardware or platform coverage unavailable to the maintainer's validation environment.

## Target Architecture

The renderer keeps the existing recording controls. On Windows, `useScreenRecorder` sends a complete recording request to Electron and does not assemble Windows `MediaStream` tracks with `MediaRecorder`.

Electron owns the native recording session:

- resolves the selected source;
- resolves output paths;
- starts cursor sampling;
- starts the helper process;
- sends pause/resume/stop/cancel commands;
- writes `RecordingSession` manifests;
- reports explicit errors when a Windows-native capability is unavailable.

`electron/native-bridge/windowsNativeHelpers.ts` selects the Rust or legacy pair once before these
steps. A selected backend failure remains explicit; the app does not automatically retry the other
implementation after startup.

The helper owns Windows media capture:

- WGC screen/window frames;
- WASAPI system loopback;
- WASAPI microphone input;
- Media Foundation webcam capture;
- DirectShow webcam fallback for virtual cameras not visible to Media Foundation;
- Media Foundation encoding/muxing;
- stream timestamp normalization.

## Helper Contract V2

The helper receives a single JSON argument:

```json
{
  "schemaVersion": 2,
  "recordingId": 1234567890,
  "source": {
    "type": "display",
    "sourceId": "screen:0:0",
    "displayId": 123,
    "windowHandle": null,
    "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 }
  },
  "video": {
    "fps": 60,
    "width": 1920,
    "height": 1080,
    "bitrate": 18000000
  },
  "audio": {
    "system": { "enabled": true },
    "microphone": { "enabled": true, "deviceId": "default", "gain": 1.4 }
  },
  "webcam": {
    "enabled": true,
    "deviceId": "default",
    "deviceName": "Camera (NVIDIA Broadcast)",
    "width": 1280,
    "height": 720,
    "fps": 30,
    "bitrate": 18000000
  },
  "outputs": {
    "screenPath": "C:\\Users\\me\\recording-123.mp4",
    "manifestPath": "C:\\Users\\me\\recording-123.session.json"
  }
}
```

The helper emits newline-delimited JSON events to stdout:

```json
{ "event": "ready", "schemaVersion": 2 }
{ "event": "recording-started", "timestampMs": 1234567890 }
{ "event": "warning", "code": "audio-device-unavailable", "message": "..." }
{ "event": "recording-stopped", "screenPath": "..." }
{ "event": "error", "code": "unsupported-window-source", "message": "..." }
```

During migration, Electron also accepts the current textual helper messages so existing display-only smoke tests keep working.

## Implementation Phases

### 1. Native Session Boundary

- Add a structured Windows native recording request type.
- Pass source kind, audio flags, microphone device, webcam flags, and output paths into the helper.
- On Windows, do not silently fall back to Electron capture. If the helper is unavailable or a native feature is missing, show a clear error.
- Keep Electron fallback only for non-Windows and optional developer diagnostics.

Acceptance:

- Display-only recording still works.
- Enabling an unsupported native feature returns an explicit native error instead of recording through Electron.

### 2. WASAPI System Audio

Status: implemented in the legacy and Rust helpers. Pure timing/audio logic and opt-in real-device
parity cover the maintained contract. Long-run drift on unavailable hardware remains an unverified
limitation, not a completed matrix claim.

- Add `WasapiLoopbackCapture`.
- Capture the default render endpoint in shared loopback mode.
- Keep `WasapiLoopbackCapture` responsible only for device activation, packet capture, and packet timestamps.
- Keep `MFEncoder` responsible for all Media Foundation stream definitions and muxing.
- Feed the endpoint mix format into `MFEncoder` as the single source of truth for audio stream shape: sample rate, channel count, bits per sample, block alignment, average bytes/sec, and subtype (`PCM` or `Float`).
- Encode the primary screen MP4 with H.264 video and AAC audio through one `IMFSinkWriter`.
- Timestamp audio from the captured frame count in 100ns units. The first implementation uses the WASAPI packet timeline; later drift correction will add explicit silence or resampling if long recordings show measurable clock skew.
- Treat microphone mixing as a later phase. System loopback must land first without introducing renderer-side audio code.

Acceptance:

- Screen MP4 has an AAC audio track when system audio is enabled.
- A 5-minute recording has audio/video duration drift below one frame.

SSOT rules for this phase:

- `src/lib/nativeWindowsRecording.ts` is the renderer/main TypeScript request contract.
- `docs/engineering/windows-native-recorder-roadmap.md` is the feature-level contract and phase checklist.
- `WgcSession::captureWidth()/captureHeight()` is the encoded screen frame size until a dedicated native scaling stage exists.
- `WasapiLoopbackCapture::inputFormat()` is the runtime audio format source used by `MFEncoder`.
- The renderer passes both the browser webcam `deviceId` and selected display label as `deviceName`; `electron/native/wgc-capture/src/webcam_capture.*` is the only place that maps those values to Media Foundation devices.
- Electron resolves the selected label to a DirectShow filter CLSID once and passes it as `webcamDirectShowClsid`; the helper must not independently guess among DirectShow filters.
- No duplicated hard-coded audio format assumptions in `main.cpp`.

### 3. WASAPI Microphone

Status: implemented in the legacy and Rust helpers. The helper opens the selected/default WASAPI
capture endpoint, applies microphone gain, and mixes system plus microphone audio into one queued
timeline. Device unplug, mismatched endpoint formats, and long-run external-device behavior remain
device-dependent checks.

- Add microphone device enumeration and stable device-id mapping.
- Capture selected/default microphone through WASAPI.
- Apply CloseScreen's current mic gain policy.
- Mix microphone and system audio before AAC encoding.

Acceptance:

- Mic-only, system-only, and mixed audio recordings produce a valid AAC track.
- Device unplug/permission failure produces an explicit error or warning.

### 4. Webcam Capture

Status: implemented in both transition backends as a separate `webcamPath` output. The renderer and
editor keep ownership of webcam layout.

- Add Media Foundation webcam source reader.
- Select requested dimensions/fps or the nearest format accepted by Media Foundation.
- Encode webcam samples into the explicit sidecar path supplied by Electron.
- Ignore black webcam warmup frames until the first visible frame is available.
- Keep the helper process as the SSOT for screen/window, WASAPI system audio, microphone, webcam
  capture, and native timestamp normalization.
- Match the requested webcam through Media Foundation friendly names first, then browser device ids/symbolic links, so UI selection remains stable across Chromium and Windows native device namespaces.
- Use the Electron-resolved DirectShow CLSID when the selected virtual camera, for example NVIDIA Broadcast, is registered for DirectShow but absent from Media Foundation enumeration.

Acceptance:

- Native display/window recordings can include webcam without returning to Electron capture.
- `npm run test:wgc-webcam:win` validates the helper path when a webcam is available and skips explicitly when no webcam device exists.
- Combined webcam + system audio + microphone produces a screen MP4 with optional AAC audio and a
  readable H.264 webcam sidecar for the existing session/editor path.

### 5. Native Window Capture

Status: baseline implementation exists in both helpers. Electron parses the `window:<HWND>:...`
source id and the helper creates the WGC item with `CreateForWindow(HWND)`. Resize, minimize,
protected-window, DPI, and monitor-move behavior remains hardware/window-specific validation.

- Resolve Electron `window:*` selections to an `HWND`.
- Use WGC `CreateForWindow(HWND)`.
- Handle window close, minimize, resize, DPI scaling, and monitor moves.
- Return clear errors for unsupported protected windows.

Acceptance:

- Capturing a normal app window works with cursor/audio/mic/webcam.
- Window resize and movement do not corrupt the recording.

### 6. Runtime Controls

Status: pause/resume and bounded normal/fault shutdown are implemented in both helpers. Cancel
cleanup remains orchestrated by Electron rather than a new application architecture.

- Add pause/resume commands to the helper.
- Add cancel command that removes partial screen/webcam outputs.
- Keep restart as stop-discard-start from Electron until the helper supports a native restart event.

Acceptance:

- Pause/resume keeps preview duration coherent.
- Cancel leaves no stale media/session/cursor files.

### 7. Test Pipeline

- `npm run test:wgc-helper:win`: display-only normal-start/stop gate for both backends, with a hard
  post-stop deadline.
- `npm run test:wgc-parity:win`: paired lifecycle, pause/resume, error, metadata, and packet-timestamp
  comparison.
- `npm run test:wgc-fault:win`: deterministic wedged-writer shutdown gate for both backends.
- `npm run test:cursor-sampler:win`: black-box cursor protocol and GDI regression gate for both
  cursor helpers.
- `npm run test:wgc-audio:win`: validates AAC track presence and duration.
- `npm run test:wgc-window:win`: captures a fixture window by HWND.
- `npm run test:wgc-webcam:win`: validates webcam output when a webcam is available, otherwise skips explicitly.
- Packaging check: confirms exactly four x64 helpers plus attribution under the unpacked app's
  `resources/` directory; native helpers are `extraResources`, not `app.asar.unpacked` contents.
- Export check: exported MP4s generated from native recordings keep an AAC audio track when the source has audio.
- `npm run test:wgc-mic:win`: validates default-microphone capture writes an AAC track when an input endpoint is available.
- `npm run test:wgc-mixed-audio:win`: validates system loopback plus microphone writes one mixed AAC track when endpoint formats are compatible.

## Backlog

### Native Cursor Click Bounce Is Not Visibly Applied

Status: open. Do not treat Windows native cursor `Click Bounce` as shipped.

Problem:

- The cursor settings UI exposes `Size`, `Smoothing`, `Motion Blur`, and `Click Bounce`.
- On Windows native cursor recordings, `Size`, `Smoothing`, and `Motion Blur` are visibly applied in preview/export.
- `Click Bounce` still has no visible effect in manual packaged-app testing, even after adding click-related sample metadata.

What has already been tried:

- Added `interactionType: "click" | "mouseup" | "move"` to native cursor samples.
- Added polling-based left-button state through `GetAsyncKeyState`.
- Added the `GetAsyncKeyState` low-bit path to catch quick clicks between samples.
- Added a PowerShell/C# `WH_MOUSE_LL` mouse hook experiment and launched the sampler through a temporary `.ps1` file to avoid Windows command-line length limits.
- Updated `npm run test:cursor-native:win` so the diagnostic can observe a synthetic short click and emit `clickSampleCount`.

Current diagnosis:

- The diagnostic can observe synthetic click events, but this has not translated into a visible `Click Bounce` effect in the real packaged app.
- The test currently proves that some click metadata can be recorded, not that the full CloseScreen record -> preview -> export path displays a bounce at the expected time.
- The current native implementation may be animating from metadata that is not present in the real recording session, may be using the wrong timestamp origin, or may be applying a scale change too subtle to notice on the DOM/native cursor path.

Next investigation when resumed:

- Inspect the actual `.cursor.json`/session sidecar generated by a packaged-app manual recording and confirm whether real clicks produce `interactionType: "click"` at the right `timeMs`.
- Add a targeted end-to-end fixture that records a known click, loads the generated project, and asserts the preview/export cursor scale changes across adjacent frames.
- Compare the native DOM cursor path against the older `PixiCursorOverlay` click visual state and decide whether native cursor bounce should be a scale-only animation, an additional click ring, or a short explicit keyframe animation independent of sample cadence.
- If event capture remains unreliable in the PowerShell sampler, move click events into a small native cursor helper instead of PowerShell/C# script injection.

## Ship Criteria

- Rust is the default packaged Windows x64 capture/cursor pair.
- The legacy C++ pair remains packaged and selectable with one documented environment variable.
- Both implementations satisfy the non-device parity, bounded shutdown, fault, and cursor gates.
- Device-dependent audio, microphone, webcam, and window checks record the environment or an
  explicit skip; they are not generalized beyond the available laptop.
- The packaged Rust recording can be loaded by the unchanged editor and exported to MP4/GIF in the
  manual release gate.
- Final uploaded release assets have unique names, verified SHA-256 checksums, packaged attribution,
  and source/tool/input provenance.
- Windows production builds do not depend on Electron capture fallback.
