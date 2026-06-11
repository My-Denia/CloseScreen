# Acceptance Evidence

Date: 2026-06-11
Workspace: `C:\Files\openscreen`
Baseline: `71622a20e34fea4844b5bef1d092927de54bf9a9`
Fork remote: `https://github.com/pjyqifei02/openscreen.git`
Upstream fetch remote: `https://github.com/siddharthvaddem/openscreen.git`
Confirmed identity: name/package/product `openscreen`, appId `io.github.pjyqifei02.openscreen`

## Summary

Local takeover prep is complete for the confirmed `openscreen` identity. Full completion is not claimable yet only because issue migration execution/count verification remains behind the owner gate and fork Issues are still disabled.

Follow-up live recheck after handoff:
- `npm install`: exit 0 on Node `v25.2.1` / npm `11.6.2`; emitted expected engine drift warning against pinned Node `22.22.1` / npm `10.9.4`.
- `npx npm@10.9.4 install`: exit 0; restored npm 11 lockfile metadata noise without content changes.
- `npm run build-vite`: exit 0.
- `npm test`: exit 0, 31 test files and 225 tests passed.
- Final recheck after evidence updates: `npm run build-vite` exit 0; `npm test` exit 0, 31 test files and 225 tests passed.
- `gh repo view pjyqifei02/openscreen --json hasIssuesEnabled`: `false`.
- `node scripts/migrate-upstream-issues.mjs`: exit 0 dry-run, read 29 upstream issues, listed 29 pending copies, and performed no writes.
- GitHub Actions build run `https://github.com/pjyqifei02/openscreen/actions/runs/27367183706`: conclusion `success`; uploaded `windows-installer` and `linux-installer`.
- Approved Visual Studio Build Tools C++ workload and FFmpeg installs completed; `npm run build:native:win` exits 0.

## A. Takeover Map

Status: complete.

Evidence:
- `takeover-map.md` exists and maps product name, appId, publisher IDs, update feeds, signing steps, publish jobs, native requirements, and attribution state.
- `git remote -v` shows:
  - `origin` -> `https://github.com/pjyqifei02/openscreen.git`
  - `upstream` fetch -> `https://github.com/siddharthvaddem/openscreen.git`
  - `upstream` push -> `DISABLED`

## B. Rebrand / Identifier Cleanup

Status: complete for confirmed `openscreen` identity.

Evidence:
- `package.json`: `name` is `openscreen`; author is `openscreen maintainers`.
- `package-lock.json`: root package name is `openscreen`.
- `electron-builder.json5`: `productName` is `openscreen`; `appId` is `io.github.pjyqifei02.openscreen`.
- README first screen states maintained-fork status and keeps prominent attribution to Siddharth Vaddem's OpenScreen (MIT).
- `git grep -n -E 'com\.siddharthvaddem\.openscreen|SiddharthVaddem\.OpenScreen|homebrew-openscreen|Samir Patil|N26FZ4GW28|svaddem@asu\.edu' -- package.json package-lock.json electron-builder.json5 .github/workflows` returned no matches.
- Push preflight criterion 2 check: the same stale upstream identifier grep returned exit 1 with no output before the approved push, meaning no matches were present in package/build/workflow configs.
- Old placeholder drift check returned no matches across the workspace.
- `git grep -n 'Siddharth Vaddem' -- README.md LICENSE` confirms attribution remains.

Intentional remaining references:
- README attribution links to `https://github.com/siddharthvaddem/openscreen`.
- `scripts/migrate-upstream-issues.mjs` defaults source repo to `siddharthvaddem/openscreen` and describes migrated upstream OpenScreen issues.
- `.openscreen` project extension, native helper names, temp/log prefixes, and storage keys remain for compatibility.

## C. CI Workflow

Status: complete for Windows/Linux unsigned installable artifacts.

Evidence:
- `.github/workflows/build.yml`
  - Windows and Linux jobs use `.nvmrc`, `npm ci`, `npm run build-vite`, and `npx electron-builder ... --publish never`.
  - Packaging jobs do not set `GH_TOKEN`.
  - `CSC_IDENTITY_AUTO_DISCOVERY=false` is set for unsigned Windows/Linux packaging.
  - macOS is opt-in via `build_macos`; signing and notarization steps are gated on secrets and use `MAC_SIGNING_IDENTITY`, not the original signing identity.
- First GitHub Actions build run after the approved push: `https://github.com/pjyqifei02/openscreen/actions/runs/27366037433` for head SHA `bc444f1ff0c1edfb3c1f88d5d639ec6964bc331c`.
  - Windows job succeeded and uploaded `windows-installer` with `size_in_bytes` 386907333.
  - Linux job failed during `.deb` packaging with `Please specify author 'email' in the application package.json`; no Linux artifact was uploaded.
  - Local fix applied: `electron-builder.json5` now sets Linux package maintainer to `openscreen maintainers <pjyqifei02@users.noreply.github.com>`.
- Second GitHub Actions build run after the Linux maintainer fix: `https://github.com/pjyqifei02/openscreen/actions/runs/27367183706` for head SHA `261e33d136ef636621eabea588a3c0bc44d183ef`.
  - Run conclusion: `success`.
  - `build-windows`: success; uploaded `windows-installer`, `size_in_bytes` 386907191, not expired.
  - `build-linux`: success; uploaded `linux-installer`, `size_in_bytes` 851775419, not expired.
  - `build-macos`: skipped because `build_macos=false`.
- `gh secret list --repo pjyqifei02/openscreen`: exit 0 with no output, so no original signing/notarization secrets are configured on the fork.
- `.github/workflows/publish-winget.yml`, `.github/workflows/update-homebrew-cask.yml`, `.github/workflows/bump-nix-package.yml`, and `.github/workflows/discord.yaml` are TODO/no-op workflows and perform no external write.
- PyYAML parsed all workflow files successfully.
- `actionlint` and `act` are not installed locally, so no local Actions emulation was run.

Reasoning for GitHub pass:
- Linux packaging uses GitHub-hosted Ubuntu with `libarchive-tools` installed before `electron-builder --linux`.
- Windows packaging builds native helpers first, then runs Vite and `electron-builder --win --publish never`.
- Signing/notarization and publish behavior are not required for Windows/Linux artifacts and are disabled or secret-gated.

## D. Local Build And Unit Tests

Status: complete.

Evidence:
- `npm run build-vite`: exit 0.
- `npm test`: exit 0, 31 test files and 225 tests passed.

## E. Native Windows Report

Status: diagnostic complete after approved VS Build Tools install; one WGC fixture test remains environment-blocked.

Evidence:
- `native-report.md` exists.
- Logs are in `goal-runs/openscreen-takeover/native-logs/`.
- Initial `npm run build:native:win`: exit 1, failed before CMake because Visual Studio `vcvarsall.bat` was not found.
- After owner-approved Visual Studio Build Tools C++ workload install, `npm run build:native:win`: exit 0; `wgc-capture.exe` and `cursor-sampler.exe` were built/copied to `electron/native/bin/win32-x64/`.
- After installing FFmpeg for `ffprobe`/`ffmpeg`, these commands exited 0: `test:wgc-helper:win`, `test:wgc-audio:win`, `test:wgc-mic:win`, `test:wgc-mixed-audio:win`, `test:wgc-webcam:win`, `test:wgc-full:win`, and `test:cursor-native:win`.
- `npm run test:wgc-window:win`: exit 1; failed before capture because `mspaint.exe` is not installed on this Windows image.

## F. Issue Migration

Status: sanitized script ready for review; execution remains blocked pending owner confirmation.

Evidence:
- `scripts/migrate-upstream-issues.mjs` exists.
- `node --check scripts/migrate-upstream-issues.mjs`: exit 0.
- `node scripts/migrate-upstream-issues.mjs --help`: exit 0.
- `node scripts/migrate-upstream-issues.mjs`: exit 0 in dry-run mode, read 29 upstream issues, listed 29 pending issue copies with source links, and warned that existing target issue detection could not run because fork Issues are disabled.
- Script uses label `upstream-migration` and marker `upstream-migration-source`.
- Copied issue bodies are sanitized before creation:
  - upstream issue links in copied/header text are wrapped in code spans;
  - source marker uses `siddharthvaddem/openscreen#<number>` instead of a live URL;
  - GitHub `@mention` patterns are broken with a zero-width space;
  - issue titles are mention-sanitized before creation.
- `node scripts/migrate-upstream-issues.mjs --sample-body 602`: exit 0, printed a sanitized dry-run body where both `https://github.com/siddharthvaddem/openscreen/issues/602` and the copied `#275` upstream issue URL were code-spanned.
- `gh auth status`: logged in as `pjyqifei02`.
- Read-only upstream count: `gh issue list --repo siddharthvaddem/openscreen --state open --limit 100 --json number --jq 'length'` returned `29`.

Unfinished AC4:
- The migration script was not executed.
- `gh issue list --repo pjyqifei02/openscreen --state all --label upstream-migration --limit 200 --json number --jq 'length'` failed with: `the 'pjyqifei02/openscreen' repository has disabled issues`.
- The fork must have Issues enabled and the sanitized sample must be owner-confirmed before migrated issues can be created or counted.

## G. LICENSE And Attribution

Status: complete.

Evidence:
- `git diff upstream/main -- LICENSE` produced no output.
- README first screen states maintained-fork status.
- README attribution section still names Siddharth Vaddem's OpenScreen and MIT.

## Additional Validation

- `git diff --check`: exit 0.
- `git diff --name-only -- electron/native`: no output.
- Secret scan for common token/private-key patterns over tracked files: no matches.
- `npm run lint`: exit 1. Biome reported 250 formatting errors dominated by LF-vs-CRLF differences on baseline checkout files; `git ls-files --eol biome.json components.json electron/globalShortcut.ts tsconfig.json vitest.config.ts` showed `i/lf w/crlf`. This was not fixed because broad repository line-ending normalization is outside the takeover baseline.

## Remaining Owner Gates

- Enable Issues on `pjyqifei02/openscreen`, then confirm the sanitized dry-run sample before running the migration script.

Post-approval command runbook:
- `owner-gate-runbook.md` contains exact commands for issue migration execution/count verification after owner confirmation.
