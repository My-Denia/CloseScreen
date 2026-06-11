# Acceptance Evidence

Date: 2026-06-11
Workspace: `C:\Files\openscreen`
Baseline: `71622a20e34fea4844b5bef1d092927de54bf9a9`
Fork remote: `https://github.com/My-Denia/openscreen.git`
Upstream fetch remote: `https://github.com/siddharthvaddem/openscreen.git`
Confirmed identity: name/package/product `openscreen`, appId `io.github.My-Denia.openscreen`

## Summary

Local takeover prep is complete for the confirmed `openscreen` identity. Full completion is not claimable yet because the real GitHub Actions artifact run, issue migration execution/count verification, fork Issues enablement, and Visual Studio C++ workload install remain owner-gated or environment-gated.

Follow-up live recheck after handoff:
- `npm install`: exit 0 on Node `v25.2.1` / npm `11.6.2`; emitted expected engine drift warning against pinned Node `22.22.1` / npm `10.9.4`.
- `npx npm@10.9.4 install`: exit 0; restored npm 11 lockfile metadata noise without content changes.
- `npm run build-vite`: exit 0.
- `npm test`: exit 0, 31 test files and 225 tests passed.
- `gh repo view My-Denia/openscreen --json hasIssuesEnabled`: `false`.
- `node scripts/migrate-upstream-issues.mjs`: exit 0 dry-run, read 29 upstream issues, listed 29 pending copies, and performed no writes.

## A. Takeover Map

Status: complete.

Evidence:
- `takeover-map.md` exists and maps product name, appId, publisher IDs, update feeds, signing steps, publish jobs, native requirements, and attribution state.
- `git remote -v` shows:
  - `origin` -> `https://github.com/My-Denia/openscreen.git`
  - `upstream` fetch -> `https://github.com/siddharthvaddem/openscreen.git`
  - `upstream` push -> `DISABLED`

## B. Rebrand / Identifier Cleanup

Status: complete for confirmed `openscreen` identity.

Evidence:
- `package.json`: `name` is `openscreen`; author is `openscreen maintainers`.
- `package-lock.json`: root package name is `openscreen`.
- `electron-builder.json5`: `productName` is `openscreen`; `appId` is `io.github.My-Denia.openscreen`.
- README first screen states maintained-fork status and keeps prominent attribution to Siddharth Vaddem's OpenScreen (MIT).
- `git grep -n -E 'com\.siddharthvaddem\.openscreen|SiddharthVaddem\.OpenScreen|homebrew-openscreen|Samir Patil|N26FZ4GW28|svaddem@asu\.edu' -- package.json package-lock.json electron-builder.json5 .github/workflows` returned no matches.
- `git grep -n 'Siddharth Vaddem' -- README.md LICENSE` confirms attribution remains.

Intentional remaining references:
- README attribution links to `https://github.com/siddharthvaddem/openscreen`.
- `scripts/migrate-upstream-issues.mjs` defaults source repo to `siddharthvaddem/openscreen` and describes migrated upstream OpenScreen issues.
- `.openscreen` project extension, native helper names, temp/log prefixes, and storage keys remain for compatibility.

## C. CI Workflow

Status: locally validated; real GitHub Actions evidence is owner-gated.

Evidence:
- `.github/workflows/build.yml`
  - Windows and Linux jobs use `.nvmrc`, `npm ci`, `npm run build-vite`, and `npx electron-builder ... --publish never`.
  - Packaging jobs do not set `GH_TOKEN`.
  - `CSC_IDENTITY_AUTO_DISCOVERY=false` is set for unsigned Windows/Linux packaging.
  - macOS is opt-in via `build_macos`; signing and notarization steps are gated on secrets and use `MAC_SIGNING_IDENTITY`, not the original signing identity.
- `.github/workflows/publish-winget.yml`, `.github/workflows/update-homebrew-cask.yml`, `.github/workflows/bump-nix-package.yml`, and `.github/workflows/discord.yaml` are TODO/no-op workflows and perform no external write.
- PyYAML parsed all workflow files successfully.
- `actionlint` and `act` are not installed locally, so no local Actions emulation was run.

Reasoning for GitHub pass:
- Linux packaging uses GitHub-hosted Ubuntu with `libarchive-tools` installed before `electron-builder --linux`.
- Windows packaging builds native helpers first, then runs Vite and `electron-builder --win --publish never`.
- Signing/notarization and publish behavior are not required for Windows/Linux artifacts and are disabled or secret-gated.

Unfinished AC3:
- No real GitHub Actions run URL or artifact list exists yet because push/workflow execution is owner-gated.
- Acceptance criterion requiring >=1 Windows and >=1 Linux installable artifact uploaded by GitHub Actions remains pending.

## D. Local Build And Unit Tests

Status: complete.

Evidence:
- `npm run build-vite`: exit 0.
- `npm test`: exit 0, 31 test files and 225 tests passed.

## E. Native Windows Report

Status: diagnostic complete; WGC build/tests blocked by missing VS C++ workload.

Evidence:
- `native-report.md` exists.
- Logs are in `goal-runs/openscreen-takeover/native-logs/`.
- `npm run build:native:win`: exit 1, failed before CMake because Visual Studio `vcvarsall.bat` was not found.
- Every `test:wgc-*:win`: exit 1, failed because `electron/native/bin/win32-x64/wgc-capture.exe` was absent.
- `npm run test:cursor-native:win`: exit 0.

Unfinished AC5:
- WGC helper build/test cannot be green on this machine until Visual Studio Build Tools with C++ are installed or a valid `VCVARSALL` path is provided.
- No large install was performed because it is owner-gated.

## F. Issue Migration

Status: script ready for review; execution blocked.

Evidence:
- `scripts/migrate-upstream-issues.mjs` exists.
- `node --check scripts/migrate-upstream-issues.mjs`: exit 0.
- `node scripts/migrate-upstream-issues.mjs --help`: exit 0.
- `node scripts/migrate-upstream-issues.mjs`: exit 0 in dry-run mode, read 29 upstream issues, listed 29 pending issue copies with source links, and warned that existing target issue detection could not run because fork Issues are disabled.
- Script uses label `upstream-migration` and marker `upstream-migration-source`.
- `gh auth status`: logged in as `My-Denia`.
- Read-only upstream count: `gh issue list --repo siddharthvaddem/openscreen --state open --limit 100 --json number --jq 'length'` returned `29`.

Unfinished AC4:
- The migration script was not executed.
- `gh issue list --repo My-Denia/openscreen --state all --label upstream-migration --limit 200 --json number --jq 'length'` failed with: `the 'My-Denia/openscreen' repository has disabled issues`.
- The fork must have Issues enabled before migrated issues can be created or counted.

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

- Enable Issues on `My-Denia/openscreen`, then review and approve running the migration script.
- Approve push and GitHub Actions workflow run to collect AC3 artifact evidence.
- Approve Visual Studio Build Tools C++ workload install if native WGC verification must run on this machine.

Post-approval command runbook:
- `owner-gate-runbook.md` contains exact commands for push/build artifact evidence, issue migration execution/count verification, and optional native rerun after Visual Studio C++ setup.
