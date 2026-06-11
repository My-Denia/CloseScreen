# Takeover Map

## Baseline

- Workspace: `C:\Files\openscreen`
- Fork remote: `https://github.com/pjyqifei02/openscreen.git`
- Upstream remote: removed after issue migration completion; use explicit upstream repository URLs for future read-only checks.
- Baseline commit: `71622a20e34fea4844b5bef1d092927de54bf9a9`
- Confirmed fork name: `openscreen`

## Product Name And Package Identity

- `package.json`
  - `name`: `openscreen`
  - `author`: `openscreen maintainers`
  - package URL: `https://github.com/pjyqifei02/openscreen`
- `package-lock.json`
  - root `name`: `openscreen`
- `electron-builder.json5`
  - `appId`: `io.github.pjyqifei02.openscreen`
  - `productName`: `openscreen`
  - Linux package maintainer: `openscreen maintainers <pjyqifei02@users.noreply.github.com>`
  - Linux artifact names derive from `${productName}`.
- Runtime/UI/i18n display strings containing the product name use `openscreen`.
- Deliberately retained compatibility identifiers:
  - `.openscreen` project file extension
  - temp/log/storage key prefixes such as `openscreen_user_preferences`
  - source links and attribution references to Siddharth Vaddem's OpenScreen

## Publisher And Distribution Workflows

- `.github/workflows/build.yml`
  - Builds Windows and Linux installer artifacts in the fork.
  - Uses `--publish never`.
  - Sets `CSC_IDENTITY_AUTO_DISCOVERY=false` for unsigned Windows/Linux packaging.
- Removed external channel workflows:
  - `.github/workflows/publish-winget.yml`
  - `.github/workflows/update-homebrew-cask.yml`
  - `.github/workflows/bump-nix-package.yml`
  - `.github/workflows/discord.yaml`

## Update Feeds

- No app-level updater code was found with:
  - `rg -n "autoUpdater|electron-updater|update-electron-app|checkForUpdates|setFeedURL|latest\.yml"`
- `electron-builder.json5` has no explicit `publish` block.
- Packaging commands in build CI use `--publish never`.

## Signing

- macOS signing and notarization material has been removed from the fork.
- Windows and Linux packaging set `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- No signing credentials are stored in files.

## Native Windows Build Requirements

- `scripts/build-windows-wgc-helper.mjs`
  - Finds `vcvarsall.bat` from `VCVARSALL`, `VSINSTALLDIR`, or standard Visual Studio 2022 paths.
  - Uses `cmake` with Ninja and builds `wgc-capture.exe` plus `cursor-sampler.exe`.
  - Copies outputs to `electron/native/bin/win32-x64`.
- Initial preflight on this machine found no Visual Studio C++ Build Tools in standard paths.
- After owner-approved Visual Studio Build Tools C++ workload install, `build:native:win` succeeds and copies both native helper binaries.
- After owner-approved FFmpeg install, all WGC tests except the Paint-backed window fixture pass; `test:wgc-window:win` remains blocked because `mspaint.exe` is missing.
- `native-report.md` records the initial failure, post-install success, remaining window fixture failure, and diagnoses verbatim.

## README And Attribution

- `README.md` first screen states this is a maintained community fork named `openscreen`.
- README attribution to Siddharth Vaddem's OpenScreen (MIT) remains prominent.
- `LICENSE` is unchanged in this working tree.
