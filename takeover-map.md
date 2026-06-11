# Takeover Map

## Baseline

- Workspace: `C:\Files\openscreen`
- Fork remote: `https://github.com/My-Denia/openscreen.git`
- Upstream fetch remote: `https://github.com/siddharthvaddem/openscreen.git`
- Baseline commit: `71622a20e34fea4844b5bef1d092927de54bf9a9`
- Confirmed fork name: `openscreen`

## Product Name And Package Identity

- `package.json`
  - `name`: `openscreen`
  - `author`: `openscreen maintainers`
  - package URL: `https://github.com/My-Denia/openscreen`
- `package-lock.json`
  - root `name`: `openscreen`
- `electron-builder.json5`
  - `appId`: `io.github.My-Denia.openscreen`
  - `productName`: `openscreen`
  - Linux package maintainer: `openscreen maintainers <176143450+My-Denia@users.noreply.github.com>`
  - mac/linux artifact names derive from `${productName}`.
  - mac permission strings use `openscreen`.
- Runtime/UI/i18n display strings containing the product name use `openscreen`.
- Deliberately retained compatibility identifiers:
  - `.openscreen` project file extension
  - native helper binary names such as `openscreen-screencapturekit-helper`
  - temp/log/storage key prefixes such as `openscreen_user_preferences`
  - source links and attribution references to Siddharth Vaddem's OpenScreen

## Publisher And Distribution Workflows

- `.github/workflows/build.yml`
  - Builds Windows and Linux installer artifacts in the fork.
  - Uses `--publish never`.
  - Sets `CSC_IDENTITY_AUTO_DISCOVERY=false` for unsigned Windows/Linux packaging.
  - macOS is opt-in and signing/notarization are conditional on fork-owned secrets.
- `.github/workflows/publish-winget.yml`
  - Disabled TODO/no-op job; no package-manager submission.
  - Needs new WinGet identifier and token before re-enabling.
- `.github/workflows/update-homebrew-cask.yml`
  - Disabled TODO/no-op job; no tap checkout, commit, or push.
  - Needs new Homebrew tap/cask identifiers and token before re-enabling.
- `.github/workflows/bump-nix-package.yml`
  - Disabled TODO/no-op job; no branch, commit, push, or PR.
  - Needs final Nix release policy before re-enabling.
- `.github/workflows/discord.yaml`
  - Disabled no-op job; no external webhook posting.

## Update Feeds

- No app-level updater code was found with:
  - `rg -n "autoUpdater|electron-updater|update-electron-app|checkForUpdates|setFeedURL|latest\.yml"`
- `electron-builder.json5` has no explicit `publish` block.
- Packaging commands in build CI use `--publish never`.

## Signing And Notarization

- Original hard-coded macOS signing identity was removed from workflow logic.
- macOS signing mode is resolved at runtime from fork secrets:
  - `MAC_CERTIFICATE_P12`
  - `MAC_CERTIFICATE_PASSWORD`
  - `MAC_SIGNING_IDENTITY`
- macOS notarization runs only when signing is enabled and notarization secrets are present:
  - `APPLE_ID`
  - `APPLE_TEAM_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
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
