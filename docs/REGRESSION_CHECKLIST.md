# CloseScreen Regression Checklist

Use this checklist before release or after changes that touch capture, storage, export, security, or
packaging. Labels mean:

- automated: covered by an existing test or CI command.
- manual: must be exercised by a maintainer on a real OS/app build.
- not yet covered: known gap; do not treat as verified.

## Startup And Permissions

| Check | Coverage | Command or path |
| --- | --- | --- |
| Renderer build and typecheck | automated | `npm run build-vite`; CI `Build` job |
| Electron app startup smoke | manual | Launch the built app or run a focused Playwright startup flow |
| Lint and i18n key parity | automated | `npm run lint`; `npm run i18n:check` in CI |
| Source selector handles no-source/error paths | automated | `tests/e2e/first-record-no-source.spec.ts`, `src/components/launch/SourceSelector.test.tsx` |
| Camera/microphone permission UI on real devices | manual | Launch the app on target OS with real devices |
| Rust-default/legacy helper selection | automated | `electron/native-bridge/windowsNativeHelpers.test.ts` |
| Windows native helper availability | automated + manual | `npm run build:native:win`; `npm run test:wgc-helper:win` runs both staged backends |
| macOS startup and capture permissions | not yet covered | No current macOS release target |

## Recording

| Check | Coverage | Command or path |
| --- | --- | --- |
| Disk stream open/append/close/finalize | automated | `electron/ipc/recordingStream.test.ts`, `src/hooks/recorderHandle.test.ts` |
| Custom recordings directory set/reset UI | automated | `tests/e2e/storage-settings.spec.ts` |
| Recordings directory containment rules | automated | `electron/appSettings.test.ts` |
| Low disk warning threshold logic | automated | `electron/diskSpace.test.ts` |
| Windows display capture, pause/resume, timestamps, and error parity | automated on available display | `npm run test:wgc-parity:win` compares explicit Rust and legacy helpers |
| Windows bounded normal/fault shutdown | automated on available display | `npm run test:wgc-helper:win`; `npm run test:wgc-fault:win` runs both backends |
| Windows system-audio packet production | automated on available render endpoint | `test:wgc-audio:win` plays a deterministic tone and requires real AAC packets/frames plus decodable non-silent PCM from both helpers |
| Windows mic/webcam devices | manual, environment-dependent | `test:wgc-mic:win`, `test:wgc-webcam:win`; record actual devices and skipped cases |
| Current laptop packaged webcam path | manual PASS (Rust default) | Packaged preview, recording, normal UI stop/finalization, editor load, and exported picture-in-picture passed. Packaged legacy UI is `NOT VERIFIED`. Earlier fixed-deadline helper results were test-contract false negatives relative to this Electron-managed product path, not product or hardware failures. |
| Native recording through editor to MP4/GIF export | manual | Packaged Rust recording on the available Windows x64 laptop; do not substitute `windows-native-checklist.spec.ts`, which does not start the helper |
| Real low-space recording drive behavior | manual | Run the app against a low-space test volume; verify no automatic deletion occurs |
| Linux screen/window capture under Wayland/X11 | manual | Run packaged app on target Linux sessions |
| Recording retention/cleanup planner | automated | `electron/recordingRetention.test.ts` |

## Export

| Check | Coverage | Command or path |
| --- | --- | --- |
| MP4 exporter internals | automated | `src/lib/exporter/videoExporter.test.ts`, browser exporter tests |
| GIF exporter internals | automated | `src/lib/exporter/gifExporter.test.ts`, `src/lib/exporter/gifExporter.browser.test.ts` |
| Export size estimate/settings | automated | `src/lib/exporter/exportSizeEstimate.test.ts`, `src/lib/exporter/mp4ExportSettings.test.ts` |
| Export save path approval | automated | `electron/ipc/exportPathApproval.test.ts` |
| E2E GIF and redaction export flows | automated | `tests/e2e/gif-export.spec.ts`, `tests/e2e/blur-redaction.spec.ts` |
| Full save-dialog MP4 and GIF export | manual | Run both formats through the packaged or built app UI |
| Export failure messages | automated | `electron/ipc/saveError.test.ts`; manual ENOSPC/EACCES checks |

## Editing

| Check | Coverage | Command or path |
| --- | --- | --- |
| Timeline copy/paste and item cycling | automated | `tests/e2e/timeline-copy-paste.spec.ts`, timeline unit tests |
| Highlight/redaction UI and export structure | automated | `tests/e2e/timeline-highlight.spec.ts`, `tests/e2e/blur-redaction.spec.ts` |
| Annotation, caption, wallpaper, cursor, and layout helpers | automated | Unit tests under `src/lib` and `src/components/video-editor` |
| Keyboard shortcut merge/conflict logic | automated | `src/lib/shortcuts.test.ts` |
| Keyboard shortcut customization in the app UI | manual | Open settings and save a shortcut change |
| Long real recording edit/export | manual | Record/edit/export on target OS |

## Security

| Check | Coverage | Command or path |
| --- | --- | --- |
| IPC handler/preload contract | automated | `electron/ipcContract.test.ts` |
| External URL scheme allowlist | automated | `electron/ipc/externalUrl.test.ts` |
| `app://` safe join utility | automated | `electron/appProtocol.util.test.ts` |
| Approved media and binary reads | manual | Import/load projects and verify unapproved local paths are rejected |
| Retention cleanup deletion boundaries | automated | `electron/recordingRetention.test.ts`, `electron/recordingRetention.ipcContract.test.ts` |
| Export path single-use approval | automated | `electron/ipc/exportPathApproval.test.ts` |
| Full UI export after save-dialog approval | manual | Export `.mp4` and `.gif` through the app UI |
| Redaction safe default | automated | `src/lib/blurEffects.test.ts`; redaction e2e |
| Malicious project-file/path fuzzing | not yet covered | Add targeted tests before claiming coverage |

## Packaging

| Check | Coverage | Command or path |
| --- | --- | --- |
| Renderer build | automated | `npm run build-vite`; CI `Build` job |
| Windows installer packaging | automated + manual | Build/release workflow verifies `win-unpacked/resources`; launch installer manually |
| Linux AppImage/deb/pacman packaging | manual | `npm run build:linux` or release workflow on Linux |
| Dual x64 helper payload and attribution resources packaged | automated | `scripts/verify-windows-native-payload.mjs` checks four helpers plus LICENSE, README, and Rust notices |
| macOS packaging | not yet covered | No current macOS target |
| Code signing/notarization | not yet covered | Builds are currently unsigned |

## Release

| Check | Coverage | Command or path |
| --- | --- | --- |
| Tag matches `package.json` version | automated | `.github/workflows/release.yml` `verify-version` |
| GitHub Release assets are Windows/Linux only | automated | Release workflow artifact upload paths |
| Final asset names are unique and checksums verify | automated | Release workflow flat staging plus `sha256sum -c SHA256SUMS.txt` |
| Source/tool/input provenance is published | automated | `scripts/write-build-provenance.mjs`; Windows/Linux provenance JSON assets |
| Update check points to this fork's GitHub Releases | automated | `electron/ipc/updateCheck.util.test.ts`; e2e update notice |
| Release notes mention unsigned build prompts | manual | Maintainer release checklist |
| CI green before merge | automated | GitHub Actions on PR and `main` |
| Independent review comments resolved | manual | PR review loop |
