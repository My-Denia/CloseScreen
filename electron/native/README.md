# Native capture helpers

## Windows release architecture

CloseScreen ships a paired capture helper and cursor sampler for Windows x64. The Rust
implementation is the release default; the legacy C++ implementation remains in the same package
as an explicit rollback path during the transition.

At the start of each recording attempt, Electron resolves both helpers once and freezes that pair
for the session. Capture and cursor do not independently change backend after startup, and a helper
failure does not silently retry another backend or switch the Windows recording to browser capture.

Set the backend before starting CloseScreen:

~~~powershell
# Default; the assignment is optional.
$env:CLOSESCREEN_WINDOWS_CAPTURE_BACKEND = "rust"

# Explicit packaged rollback.
$env:CLOSESCREEN_WINDOWS_CAPTURE_BACKEND = "legacy"
~~~

The value must be exactly **rust** or **legacy**. An unset value selects Rust; an empty, whitespace,
or other value is an explicit configuration error.

The CLOSESCREEN_WGC_CAPTURE_EXE and CLOSESCREEN_CURSOR_SAMPLER_EXE variables remain
higher-priority diagnostic overrides. Setting one produces a **mixed** effective identity; setting
both produces a **custom** identity. Overrides are not an automatic fallback policy.

### Packaged payload

Windows packages contain exactly these x64 PE helpers under
resources/electron/native/bin/win32-x64/:

| Backend | Capture | Cursor |
| --- | --- | --- |
| Rust default | wgc-capture.exe | cursor-sampler.exe |
| Legacy C++ rollback | wgc-capture-legacy.exe | cursor-sampler-legacy.exe |

Windows ARM64 is not built, packaged, or claimed as supported.

For local development, the resolver also recognizes Rust outputs under
electron/native/rust/target/dist/ and legacy C++ outputs under
electron/native/wgc-capture/build/. The packaged layout is authoritative for a release.

## Build and payload verification

~~~powershell
npm run build:native:win
npm run verify:native:win
~~~

The native build entry point creates a fresh electron/native/bin/win32-x64 directory, builds the
legacy C++ pair, builds the Rust pair with Cargo's lockfile, stages both names above, checks the
generated Rust third-party notices, and verifies the exact file set and PE x64 machine type.

After electron-builder runs, verify the real packaged resources:

~~~powershell
$version = node -p "require('./package.json').version"
node scripts/verify-windows-native-payload.mjs --resources "release/$version/win-unpacked/resources"
~~~

This also checks LICENSE, README.md, and RUST_THIRD_PARTY_NOTICES.md under resources/licenses/.

## Process contract

Both implementations use the same process boundary: Electron starts the capture helper with one
JSON argument, reads newline-delimited lifecycle events, and sends **pause**, **resume**, or
**stop** on stdin. During the transition both helpers also print the legacy **Recording started**
and **Recording stopped. Output path: PATH** messages.

The request includes source details, video settings, optional system/microphone audio, optional
webcam settings, and explicit output paths:

~~~json
{
  "schemaVersion": 2,
  "recordingId": 123,
  "sourceType": "display",
  "sourceId": "screen:0:0",
  "displayId": 1,
  "outputPath": "C:\\path\\recording-123.mp4",
  "videoWidth": 1920,
  "videoHeight": 1080,
  "fps": 60,
  "captureSystemAudio": false,
  "captureMic": false,
  "webcamEnabled": true,
  "outputs": {
    "screenPath": "C:\\path\\recording-123.mp4",
    "webcamPath": "C:\\path\\recording-123-webcam.mp4"
  }
}
~~~

The production session keeps webcam video in the separate webcamPath sidecar so the existing
editor can position it. The primary screen MP4 remains H.264 with optional AAC audio. The Electron
session/editor/export architecture is unchanged.

## Validation

The non-device-specific commands exercise both staged backends by default:

~~~powershell
npm run test:wgc-helper:win
npm run test:wgc-parity:win
npm run test:wgc-fault:win
npm run test:cursor-sampler:win
~~~

Use -- --backend rust or -- --backend legacy with the helper, fault, and cursor-sampler harnesses
to isolate a backend. Parity always compares the two explicit staged executables.

Device-dependent checks remain opt-in and must record the actual available environment:

~~~powershell
npm run test:wgc-window:win
npm run test:wgc-audio:win
npm run test:wgc-mic:win
npm run test:wgc-webcam:win
~~~

These checks do not establish multi-monitor, external-audio, GPU/driver-matrix, ARM64, macOS,
Linux Wayland, signing, or notarization support.
