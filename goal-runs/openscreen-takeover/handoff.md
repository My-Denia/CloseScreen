# Handoff - openscreen Takeover

## Current State

- Final name confirmed by owner: `openscreen`.
- Package/product identity:
  - `package.json` name: `openscreen`
  - `electron-builder.json5` productName: `openscreen`
  - `electron-builder.json5` appId: `io.github.My-Denia.openscreen`
- README first screen states maintained-fork status and preserves attribution to Siddharth Vaddem's OpenScreen.
- LICENSE has not been changed.

## Verified Locally

- `npm run build-vite`: exit 0.
- `npm test`: exit 0, 31 files / 225 tests.
- Follow-up recheck after handoff: `npm install`, `npx npm@10.9.4 install`, `npm run build-vite`, and `npm test` all exited 0.
- Workflow YAML parse with PyYAML: exit 0.
- Stale upstream publisher identifier greps over package/build configs: no matches.
- `git diff upstream/main -- LICENSE`: no output.
- `git diff --name-only -- electron/native`: no output.
- Native report regenerated after final name confirmation.
- `node scripts/migrate-upstream-issues.mjs` dry-run: exit 0, read 29 upstream issues, listed 29 pending copies, no writes.
- `gh repo view My-Denia/openscreen --json hasIssuesEnabled`: `false`.
- `owner-gate-runbook.md` documents exact post-approval commands for remaining owner-gated evidence.
- First `build.yml` run after push: `https://github.com/My-Denia/openscreen/actions/runs/27366037433`; Windows job uploaded `windows-installer`, Linux failed on missing `.deb` maintainer email.
- Linux maintainer fix was pushed: `electron-builder.json5` has `openscreen maintainers <176143450+My-Denia@users.noreply.github.com>`.
- Second `build.yml` run after the maintainer fix: `https://github.com/My-Denia/openscreen/actions/runs/27367183706`; conclusion `success`; uploaded `windows-installer` size 386907191 and `linux-installer` size 851775419.
- VS Build Tools C++ workload and FFmpeg are installed. `build:native:win` passes; all WGC tests except `test:wgc-window:win` pass; window test fails because `mspaint.exe` is missing.

## Blocked / Owner-Gated

- AC4 migration execution: sanitized script is ready, but `--execute` remains paused until owner confirms the sanitized dry-run sample and fork Issues are enabled.
- Fork Issues remain disabled, blocking migrated issue creation/count verification.
- Native WGC window fixture remains environment-blocked by missing `mspaint.exe`; no C++ changes were made.

## Continue From Here

1. Keep native status as documented unless `mspaint.exe` becomes available; do not change C++.
2. Wait for owner confirmation of sanitized issue dry-run sample and fork Issues enablement before `node scripts/migrate-upstream-issues.mjs --execute`.
3. Do not create releases, enable external publishing, or run issue migration without owner approval.
