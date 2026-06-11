# openscreen

openscreen is a maintained community fork of Siddharth Vaddem's OpenScreen, the MIT-licensed open-source screen recorder and editor. The upstream project was archived in June 2026; this fork keeps the original license and visible attribution while the product identity, CI, issue backlog, and Windows native verification are brought under fork maintainership.

## Attribution

This project is based on [Siddharth Vaddem's OpenScreen](https://github.com/siddharthvaddem/openscreen). The original project is licensed under MIT, and the original `LICENSE` file is intentionally preserved unchanged.

## Project Status

- Maintained fork: active takeover and CI hardening are in progress.
- Product identity: confirmed as `openscreen` with package slug `openscreen` and appId `io.github.pjyqifei02.openscreen`.
- Distribution status: GitHub Actions builds are being prepared for unsigned Windows and Linux installable artifacts from this fork. WinGet, Homebrew, Discord notification, and Nix release automation are disabled until the maintainer explicitly re-enables them with new identifiers and tokens.
- Native status: Windows WGC/WASAPI/MediaFoundation verification is tracked in `native-report.md`.

## Core Features

- Record a specific window, or your whole screen.
- Record microphone and system audio.
- Webcam overlay with picture-in-picture, drag-to-position, mirroring, and shape options.
- Auto or manual zooms with adjustable depth, duration, easing, and pixel-precise position; auto-zoom follows your cursor as you work.
- Custom cursor size, smoothing, and click effects, with cursor themes and post-recording path smoothing.
- Automatic captions for voiceovers, generated on-device with no upload.
- Wallpapers, solid colors, gradients, or your own background image.
- Motion blur.
- Crop, trim, and per-segment speed control on the timeline.
- Text, arrow, and image annotations, with text animation presets.
- Timeline snapping guides and an audio waveform to make trimming easier.
- Customizable keyboard shortcuts.
- Export to MP4 or GIF in multiple aspect ratios and resolutions.
- Languages supported: Arabic, English, Spanish, French, Italian, Japanese, Korean, Portuguese (Brazil), Russian, Turkish, Vietnamese, Simplified Chinese, and Traditional Chinese.

## Installation

Installers will be published from this fork's GitHub Releases after the takeover CI is verified. Until then, build locally from source:

```bash
npm ci
npm run build-vite
```

Platform packaging is handled by `electron-builder`:

```bash
npm run build:win
npm run build:linux
npm run build:mac
```

The Windows and macOS native helper builds require their platform toolchains. Windows helper status for this machine is documented in `native-report.md`.

## Platform Differences

Everything in the editor and export is intended to stay consistent on macOS, Windows, and Linux: zooms, backgrounds, motion blur, crop/trim/speed, blur regions, annotations, auto-captions, projects, export, and supported languages. Capture differs by operating system:

- macOS and Windows use native capture helpers for higher quality screen/window capture and cursor data.
- Linux uses the browser capture path.
- System audio support depends on the operating system and local permissions.

## Development

```bash
npm install
npm run build-vite
npm test
```

Native Windows helper diagnostics:

```bash
npm run build:native:win
npm run test:wgc-full:win
npm run test:cursor-native:win
```

Issue migration tooling is prepared but owner-gated:

```bash
node scripts/migrate-upstream-issues.mjs --help
```

## License

This project is licensed under the [MIT License](./LICENSE). By using this software, you agree that the authors are not liable for any issues, damages, or claims arising from its use.
