# CloseScreen Support Matrix

CloseScreen is a maintained community fork of OpenScreen. This matrix describes the current fork
state from repository evidence, not a long-term product promise. Unknown or unverified paths are
marked that way intentionally.

## Status Terms

- Supported: implemented and part of the current maintained path for this fork.
- Community-supported: implemented or expected to work through Electron/browser APIs, but not the
  primary native path and not fully covered by this fork's release validation.
- Not verified: code may exist, but this fork does not currently publish or validate that path.
- Not currently provided: no current release artifact or release workflow for that platform.

## Release Targets

| Platform | Current release status | Evidence |
| --- | --- | --- |
| Windows 10 2004+ / Windows 11 x64 | Primary maintained target; unsigned NSIS installer | Rust default in `electron/native/rust`; packaged C++ rollback in `electron/native/wgc-capture`; payload verification in build/release workflows |
| Linux | Community-supported; unsigned AppImage, deb, and pacman artifacts | `electron-builder.json5` `linux.target`, `.github/workflows/build.yml`, `.github/workflows/release.yml`, Wayland/PipeWire switch in `electron/main.ts` |
| macOS | Not currently provided as a release target | No macOS target in `electron-builder.json5`; build/release workflows only build Windows and Linux |

Unsigned artifacts can trigger operating-system warnings. Windows may show SmartScreen or
unknown-publisher prompts. Linux users may need to mark an AppImage executable or trust a locally
installed package.

## Feature Matrix

| Feature | Windows | Linux | macOS | Evidence and notes |
| --- | --- | --- | --- | --- |
| Screen recording | Supported primary path on x64 | Community-supported browser/Electron path | Not verified | Windows uses the Rust WGC backend by default and an explicit packaged legacy rollback; Linux enables `WebRTCPipeWireCapturer` on Wayland. |
| Window recording | Supported with known hardening gaps | Community-supported where Electron source capture exposes windows | Not verified | Windows helper accepts window capture inputs, but the roadmap still tracks resize/minimize/protected-window hardening. |
| Microphone audio | Supported where an input device is available | Community-supported through browser permissions/devices | Not verified | Windows helper scripts include `test:wgc-mic:win` and `test:wgc-full:win`; renderer has microphone controls. |
| System audio | Supported on Windows helper path where WASAPI loopback is available | Not verified | Not verified | Windows helper uses WASAPI loopback and has `test:wgc-audio:win`/`test:wgc-mixed-audio:win`; Linux system audio is not claimed as release-verified. |
| Webcam overlay | Implemented; current device validation incomplete | Community-supported | Not verified | Windows native capture writes a separate webcam sidecar consumed by the unchanged editor/export path. On the migration-validation laptop, both Rust and legacy helpers exceeded the 9-second webcam stop gate; do not treat webcam hardware as release-verified from this run. |
| Cursor capture | Supported on Windows native path; click-bounce remains unverified | Community-supported/not fully verified | Not verified | Native cursor docs and tests cover Windows; renderer/export cursor effects are tested separately. |
| Captions | Supported in packaged builds with bundled local assets | Supported in packaged builds with bundled local assets | Not verified | `beforePack` fetches `caption-assets`; packaged `app://` worker loads local model assets. Dev mode may fetch remote model assets. |
| Export | Supported for MP4 and GIF | Supported for MP4 and GIF | Not verified | Exporter unit/browser tests and e2e GIF/blur-redaction tests cover MP4/GIF behavior. Export writes require an OS save-dialog-approved path. |
| Update check | Supported as stable GitHub Releases check/link only | Supported as stable GitHub Releases check/link only | Not verified | Main-process `check-for-updates` reads `My-Denia/CloseScreen` GitHub Releases and returns a stable release URL; no auto-install provider or prerelease notification channel is configured. |
| Custom recording directory | Supported | Supported | Not verified | `electron/appSettings.ts` validates custom folders in the main process; `tests/e2e/storage-settings.spec.ts` covers the UI path. |
| Manual recording cleanup | Supported for manifest-managed session artifacts | Supported for manifest-managed session artifacts | Not verified | Cleanup is manual only, plan-first, and limited to CloseScreen session files under the effective recordings directory. |
| Low disk warning | Supported warning, not a hard block | Supported warning, not a hard block | Not verified | `electron/diskSpace.ts` checks free space and callers treat unknown as non-blocking; warnings do not auto-delete recordings. |
| Redaction | Supported solid-block default; mosaic available with warning | Supported solid-block default; mosaic available with warning | Not verified | `src/lib/blurEffects.ts` defaults legacy/unknown blur types to solid; localized UI warns that mosaic may be reversible. |
| Offline usage | Mostly local after install; Google Fonts, update checks, and dev caption model fetch need network | Mostly local after install; Google Fonts, update checks, and dev caption model fetch need network | Not verified | Record/edit/export are local. Packaged captions use bundled assets. The renderer may request Google Fonts, and update check calls GitHub Releases. |

## Manual Verification To Keep Current

- Windows: `npm run build:native:win`, dual-backend helper/parity/fault/cursor gates, packaged payload
  verification, and a full MP4/GIF export from the UI on the available x64 laptop. This does not
  validate multiple monitors, external audio hardware, ARM64, or a GPU/driver matrix.
- Linux: `npm run build:linux`, launch the AppImage/deb/pacman package, verify screen/window capture
  under the target display server, and run MP4/GIF export.
- macOS: do not mark supported until build configuration, CI/release workflow, and manual capture
  validation exist for this fork.
