# Acceptance Evidence

Date: 2026-06-11
Workspace: `C:\Files\openscreen`
Baseline: `71622a20e34fea4844b5bef1d092927de54bf9a9`
Fork remote: `https://github.com/My-Denia/openscreen.git`
Upstream remote: removed after issue migration completion; future read-only checks should use explicit upstream repository URLs
Confirmed identity: name/package/product `openscreen`, appId `io.github.My-Denia.openscreen`

## Summary

Takeover baseline is complete for the confirmed `openscreen` identity. The owner-confirmed issue migration executed successfully after fork Issues were enabled.

Follow-up live recheck after handoff:
- `npm install`: exit 0 on Node `v25.2.1` / npm `11.6.2`; emitted expected engine drift warning against pinned Node `22.22.1` / npm `10.9.4`.
- `npx npm@10.9.4 install`: exit 0; restored npm 11 lockfile metadata noise without content changes.
- `npm run build-vite`: exit 0.
- `npm test`: exit 0, 31 test files and 225 tests passed.
- Final recheck after evidence updates: `npm run build-vite` exit 0; `npm test` exit 0, 31 test files and 225 tests passed.
- Post-migration final recheck: `npm run build-vite` exit 0; `npm test` exit 0, 31 test files and 225 tests passed.
- `gh repo view My-Denia/openscreen --json hasIssuesEnabled`: `true`.
- Pre-execute `node scripts/migrate-upstream-issues.mjs`: exit 0 dry-run, read 29 upstream issues, detected 0 existing migrated issues, and listed 29 pending copies.
- Owner confirmed the sanitized dry-run sample; `node scripts/migrate-upstream-issues.mjs --execute`: exit 0 and created migrated issues for all 29 upstream issues.
- Post-execute `node scripts/migrate-upstream-issues.mjs`: exit 0 dry-run, read 29 upstream issues, detected 29 existing migrated issues, and listed 0 pending copies.
- GitHub Actions build run `https://github.com/My-Denia/openscreen/actions/runs/27367183706`: conclusion `success`; uploaded `windows-installer` and `linux-installer`.
- Approved Visual Studio Build Tools C++ workload and FFmpeg installs completed; `npm run build:native:win` exits 0.
- De-mac pass local validation and PR-branch Actions evidence are complete.
- Post-migration cleanup: `scripts/migrate-upstream-issues.mjs` is deleted and `git remote -v` now shows `origin` only.
- Final post-cleanup validation: `npm run build-vite` exit 0; `npm test` exit 0 with 31 test files and 225 tests.
- PR evidence: `https://github.com/My-Denia/openscreen/pull/30` is open from `chore/demac-personalization` to `main`; PR CI checks Lint, Type Check, Test, and Build passed.
- Trimmed build workflow evidence: `https://github.com/My-Denia/openscreen/actions/runs/27371559635` concluded `success` on head `146cbbabb6503dcbedafa140df40c2fc61916329`.
- Artifact evidence for run `27371559635`: `windows-installer` size 386907134, `linux-installer` size 851792127.

## A. Takeover Map

Status: complete.

Evidence:
- `takeover-map.md` exists and maps product name, appId, publisher IDs, update feeds, signing steps, publish jobs, native requirements, and attribution state.
- `git remote -v` now shows:
  - `origin` -> `https://github.com/My-Denia/openscreen.git`

## B. Rebrand / Identifier Cleanup

Status: complete for confirmed `openscreen` identity.

Evidence:
- `package.json`: `name` is `openscreen`; author is `openscreen maintainers`.
- `package-lock.json`: root package name is `openscreen`.
- `electron-builder.json5`: `productName` is `openscreen`; `appId` is `io.github.My-Denia.openscreen`.
- README first screen states maintained-fork status and keeps prominent attribution to Siddharth Vaddem's OpenScreen (MIT).
- `git grep -n -E 'com\.siddharthvaddem\.openscreen|SiddharthVaddem\.OpenScreen|homebrew-openscreen|Samir Patil|N26FZ4GW28|svaddem@asu\.edu' -- package.json package-lock.json electron-builder.json5 .github/workflows` returned no matches.
- Push preflight criterion 2 check: the same stale upstream identifier grep returned exit 1 with no output before the approved push, meaning no matches were present in package/build/workflow configs.
- Old placeholder drift check returned no matches across the workspace.
- `git grep -n 'Siddharth Vaddem' -- README.md LICENSE` confirms attribution remains.

Intentional remaining references:
- README attribution links to `https://github.com/siddharthvaddem/openscreen`.
- Historical migrated issues link back to `siddharthvaddem/openscreen`; the local migration script is removed after completion.
- `.openscreen` project extension, native helper names, temp/log prefixes, and storage keys remain for compatibility.

## C. CI Workflow

Status: complete for takeover baseline; de-mac trimmed workflow is pending a new GitHub Actions run.

Evidence:
- `.github/workflows/build.yml`
  - Windows and Linux jobs use `.nvmrc`, `npm ci`, `npm run build-vite`, and `npx electron-builder ... --publish never`.
  - Packaging jobs do not set `GH_TOKEN`.
  - `CSC_IDENTITY_AUTO_DISCOVERY=false` is set for unsigned Windows/Linux packaging.
  - Current de-mac pass removes the macOS job, signing, notarization, and macOS workflow-dispatch inputs.
- First GitHub Actions build run after the approved push: `https://github.com/My-Denia/openscreen/actions/runs/27366037433` for head SHA `bc444f1ff0c1edfb3c1f88d5d639ec6964bc331c`.
  - Windows job succeeded and uploaded `windows-installer` with `size_in_bytes` 386907333.
  - Linux job failed during `.deb` packaging with `Please specify author 'email' in the application package.json`; no Linux artifact was uploaded.
  - Local fix applied: `electron-builder.json5` now sets Linux package maintainer to `openscreen maintainers <176143450+My-Denia@users.noreply.github.com>`.
- Second GitHub Actions build run after the Linux maintainer fix: `https://github.com/My-Denia/openscreen/actions/runs/27367183706` for head SHA `261e33d136ef636621eabea588a3c0bc44d183ef`.
  - Run conclusion: `success`.
  - `build-windows`: success; uploaded `windows-installer`, `size_in_bytes` 386907191, not expired.
  - `build-linux`: success; uploaded `linux-installer`, `size_in_bytes` 851775419, not expired.
- `gh secret list --repo My-Denia/openscreen`: exit 0 with no output, so no original signing/notarization secrets are configured on the fork.
- Current de-mac pass deletes `.github/workflows/publish-winget.yml`, `.github/workflows/update-homebrew-cask.yml`, `.github/workflows/bump-nix-package.yml`, and `.github/workflows/discord.yaml` outright.
- PyYAML parsed all workflow files successfully.
- `actionlint` and `act` are not installed locally, so no local Actions emulation was run.

Reasoning for GitHub pass:
- Linux packaging uses GitHub-hosted Ubuntu with `libarchive-tools` installed before `electron-builder --linux`.
- Windows packaging builds native helpers first, then runs Vite and `electron-builder --win --publish never`.
- Signing/notarization and external publish behavior are not required for Windows/Linux artifacts; macOS signing/notarization material is removed in the de-mac pass.

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

Status: complete; helper removed after execution.

Evidence:
- Historical pre-removal checks: `node --check scripts/migrate-upstream-issues.mjs` exit 0 and `node scripts/migrate-upstream-issues.mjs --help` exit 0.
- Pre-execute `node scripts/migrate-upstream-issues.mjs`: exit 0 in dry-run mode, read 29 upstream issues, detected 0 existing migrated issues, and listed 29 pending issue copies with source links.
- Script uses label `upstream-migration` and marker `upstream-migration-source`.
- Copied issue bodies are sanitized before creation:
  - upstream issue links in copied/header text are wrapped in code spans;
  - source marker uses `siddharthvaddem/openscreen#<number>` instead of a live URL;
  - GitHub `@mention` patterns are broken with a zero-width space;
  - issue titles are mention-sanitized before creation.
- `node scripts/migrate-upstream-issues.mjs --sample-body 602`: exit 0, printed a sanitized dry-run body where both `https://github.com/siddharthvaddem/openscreen/issues/602` and the copied `#275` upstream issue URL were code-spanned.
- Owner confirmed the sanitized dry-run sample.
- `node scripts/migrate-upstream-issues.mjs --execute`: exit 0; output included `Created migrated issue for upstream #...` for all 29 upstream issues.
- `gh auth status`: logged in as `My-Denia`.
- Read-only upstream count: `gh issue list --repo siddharthvaddem/openscreen --state open --limit 100 --json number --jq 'length'` returned `29`.
- Migrated issue count: `gh issue list --repo My-Denia/openscreen --state all --label upstream-migration --limit 200 --json number --jq 'length'` returned `29`.
- Post-execute dry-run: `node scripts/migrate-upstream-issues.mjs` returned `Existing migrated issues detected: 29` and `Issues to create: 0`.
- Body verification over all 29 migrated issues returned no missing `upstream-migration-source` markers, no missing code-spanned upstream issue URLs, no live unwrapped source URLs, and no plain mentions outside code.
- Example migrated issue: `https://github.com/My-Denia/openscreen/issues/19` for upstream #602 starts with code-spanned source URL and `Source: ` code span.
- Post-completion cleanup: `scripts/migrate-upstream-issues.mjs` is removed from the working tree because migration has completed and post-execute dry-run showed 0 pending copies.

## G. LICENSE And Attribution

Status: complete.

Evidence:
- `git diff -- LICENSE` produced no output.
- README first screen states maintained-fork status.
- README attribution section still names Siddharth Vaddem's OpenScreen and MIT.

## Additional Validation

- `git diff --check`: exit 0.
- `git diff --name-only -- electron/native`: no output.
- Secret scan for common token/private-key patterns over tracked files: no matches.
- `npm run lint`: exit 1. Biome reported 250 formatting errors dominated by LF-vs-CRLF differences on baseline checkout files; `git ls-files --eol biome.json components.json electron/globalShortcut.ts tsconfig.json vitest.config.ts` showed `i/lf w/crlf`. This was not fixed because broad repository line-ending normalization is outside the takeover baseline.

## H. De-mac And Personalization Pass

Status: local validation complete; AC5 pending owner-approved branch push/PR.

Evidence so far:
- AC1: `.github/workflows/publish-winget.yml`, `.github/workflows/update-homebrew-cask.yml`, `.github/workflows/bump-nix-package.yml`, and `.github/workflows/discord.yaml` are deleted in the working tree.
- AC2: `rg -n -i "MAC_CERTIFICATE|APPLE_|notarytool|macos|screencapturekit|entitlements" .github/workflows package.json electron-builder.json5 README.md` returned no matches.
- AC3: `macos.entitlements` and tracked Swift helper files under `electron/native/screencapturekit` are deleted; the empty directory was removed from the worktree.
- Scope cleanup: `scripts/build_macos.sh`, `scripts/build-macos-screencapturekit-helper.mjs`, package `build:native:mac` and `build:mac` scripts, and `electron-builder.json5` mac config were removed.
- Owner clarification: `.gitignore` now ignores `AGENTS.md` and `/goal-runs/`; previously tracked `goal-runs/openscreen-takeover/*` agent artifacts are removed from the repository.
- Stop condition check: macOS helper references in TypeScript are platform-gated runtime paths/strings, not imports of deleted Swift source files; `npm run build-vite` remains the binary validation before completion.
- AC4: final post-AC6 `npm run build-vite` exit 0; final post-AC6 `npm test` exit 0 with 31 files and 225 tests.
- Additional static checks: workflow YAML parse exit 0; `git diff --check` exit 0; `git diff --name-only -- electron/native/wgc-capture` returned no output; `tasks.json` and `package.json` parsed.
- AC5: `build.yml` run `https://github.com/My-Denia/openscreen/actions/runs/27371559635` concluded `success` on the trimmed workflow branch and uploaded `windows-installer` size 386907134 plus `linux-installer` size 851792127.
- AC6: `scripts/migrate-upstream-issues.mjs` is deleted; `git remote -v` shows `origin` only; README attribution line remains and `LICENSE` has no diff.

## Remaining Owner Gates

- Main-branch merge of PR #30 remains owner-gated.
- No public release, registry submission, or upstream mutation was performed.
