# CloseScreen

CloseScreen is a maintained community fork of Siddharth Vaddem's OpenScreen, the MIT-licensed open-source screen recorder and editor. It is not an official OpenScreen continuation or successor; it keeps the original attribution and license while this fork maintains its own product identity, issue backlog, CI, and release process.

## Attribution

This project is based on [Siddharth Vaddem's OpenScreen](https://github.com/siddharthvaddem/openscreen). The original project is licensed under MIT, and the original `LICENSE` file is intentionally preserved unchanged.

## Project Status

- Maintained fork: active takeover, CI hardening, and Windows native verification are in progress.
- Product identity: `CloseScreen`, package slug `closescreen`, appId `io.github.my-denia.closescreen`.
- Package manager: npm with `package-lock.json`; use the Node version in `.nvmrc`.
- Distribution: GitHub Actions can build unsigned Windows and Linux artifacts for this fork's GitHub Releases. External package-manager channels are not automated.
- Updates: the app checks this fork's stable GitHub Releases and opens the release page when a newer version exists. It does not auto-download, auto-install, run an updater service, or subscribe users to prerelease notifications.

## Platform Support

Short version: CloseScreen currently publishes unsigned Windows and Linux builds from this
community fork. macOS is not a current release target for this fork. See the full
[support matrix](./docs/SUPPORT_MATRIX.md) for feature-by-feature status and verification notes.

| Platform | Current status | Capture path | Release artifact |
| --- | --- | --- | --- |
| Windows 10 2004+ / Windows 11 | Primary maintained desktop target | Native WGC/WASAPI/MediaFoundation helper, with browser fallback behavior where implemented | Unsigned NSIS installer from GitHub Releases |
| Linux | Community-supported | Browser capture path, with Wayland PipeWire flags enabled when detected | Unsigned AppImage, deb, and pacman packages from GitHub Releases |
| macOS | Not a current release target | Not validated for this fork's current release flow | No macOS artifact in the current electron-builder config or GitHub release workflow |

Unsigned builds can trigger operating-system warnings. Windows may show Microsoft Defender SmartScreen or an unknown-publisher prompt; Linux desktops may require marking an AppImage executable or trusting a locally installed package. Treat those prompts as expected for unsigned community builds, not as a security guarantee.

## Core Features

- Record a specific window, or your whole screen.
- Record microphone and system audio where the platform and permissions allow it.
- Webcam overlay with picture-in-picture, drag-to-position, mirroring, and shape options.
- Auto or manual zooms with adjustable depth, duration, easing, and pixel-precise position; auto-zoom follows your cursor as you work.
- Custom cursor size, smoothing, click effects, themes, highlight regions, and post-recording path smoothing.
- Automatic captions for voiceovers, generated on-device with bundled model assets in packaged builds.
- Wallpapers, solid colors, gradients, or your own background image.
- Motion blur and solid-block redaction regions.
- Crop, trim, and per-segment speed control on the timeline.
- Text, arrow, image, and figure annotations.
- Timeline snapping guides and an audio waveform to make trimming easier.
- Customizable keyboard shortcuts.
- Export to MP4 or GIF in multiple aspect ratios and resolutions.
- Languages supported: Arabic, English, Spanish, French, Italian, Japanese, Korean, Portuguese (Brazil), Russian, Turkish, Vietnamese, Simplified Chinese, and Traditional Chinese.

## Install And Build

Release artifacts, when present, are attached to this fork's GitHub Releases. Tags must match `package.json` exactly, for example `v1.5.0-fork.1`.

Local development and renderer build:

```bash
npm ci
npm run build-vite
npm test
```

Windows packaging:

```powershell
npm run build:native:win
npm run test:wgc-full:win
npm run build:win
```

Linux packaging:

```bash
npm run build:linux
```

Packaging runs `scripts/before-pack.cjs`, which ensures the offline caption model and ONNX Runtime wasm assets exist under `caption-assets/` before electron-builder copies them into the app resources.

## Release Process

- `npm run lint`, `npm test`, and `npm run build-vite` are the baseline local gates.
- `.github/workflows/ci.yml` runs lint, i18n parity, typecheck, unit tests, browser tests, and Vite build on pull requests and `main`.
- `.github/workflows/build.yml` is a manual build workflow for unsigned Windows and Linux artifacts.
- `.github/workflows/release.yml` runs on `v*` tags, verifies the tag matches `package.json`, builds Windows and Linux artifacts, then publishes a GitHub Release.
- The app's update check reads stable GitHub Releases from the main process and only surfaces a download link.

## Recording And Export Storage

- New recordings are written to the effective recordings directory from the main process. The default is the app data `recordings` folder; users can choose a custom folder from the OS directory picker.
- Custom recording folders are validated in the main process. Drive roots, the user profile root, the app data root, and symlink or junction aliases to those guarded locations are rejected.
- Recording paths are pinned when recording starts or when a stream opens. Session manifests and cursor sidecars derive from the actual video path.
- The recordings folder cannot be changed while a recording is active or finalizing.
- Manual retention cleanup is available from the recording storage panel. Cleanup first builds a plan, then deletes only CloseScreen session artifacts referenced by session manifests inside the effective recordings directory.
- Low disk space for the recordings drive is a warning, not a hard block, and it does not auto-delete recordings.
- Exports are saved only to a file path selected through the OS save dialog for that export. Export failures surface filesystem-specific errors where possible.

## Security Notes

For the detailed security policy and privacy notes, see [SECURITY.md](./SECURITY.md) and
[docs/PRIVACY.md](./docs/PRIVACY.md). Release and manual QA coverage is tracked in
[docs/REGRESSION_CHECKLIST.md](./docs/REGRESSION_CHECKLIST.md).

- Packaged renderer content is served through the privileged `app://bundle` scheme with a restrictive Content Security Policy.
- Local media served through `app://bundle/_media/` must already be approved by a picker, project load, or recordings-directory rule.
- `read-binary-file` is approved-path-only and does not auto-approve arbitrary renderer-supplied paths.
- Preload exposes a narrow IPC surface with `contextIsolation` enabled and `nodeIntegration` disabled.
- External links are opened through a scheme allowlist.
- Credentials and release secrets are not stored in the repository. GitHub Actions secrets are the only supported place for release credentials.

## Native Windows Helper

The Windows helper source is in `electron/native/wgc-capture`. Build and diagnostic commands are documented in [electron/native/README.md](./electron/native/README.md). The Windows native roadmap is tracked in [docs/engineering/windows-native-recorder-roadmap.md](./docs/engineering/windows-native-recorder-roadmap.md).

## License

This project is licensed under the [MIT License](./LICENSE). By using this software, you agree that the authors are not liable for any issues, damages, or claims arising from its use.
