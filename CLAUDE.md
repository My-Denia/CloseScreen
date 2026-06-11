# Project: <openscreen> (community fork of OpenScreen)

## Context
Maintained fork of siddharthvaddem/openscreen (MIT, archived 2026-06).
Electron 41 + React 18 + Vite 7 + PixiJS. Native capture: C++ (WGC/WASAPI/
MediaFoundation) in electron/native/wgc-capture, Swift ScreenCaptureKit
helpers for macOS. The maintainer (me) is the reviewer/key-holder; you do
the engineering.

## Commands
- Typecheck + renderer build: `npm run build-vite`
- Unit tests: `npm test` (225 tests; all green on takeover baseline)
- Native Windows helper: `npm run build:native:win`, then `npm run test:wgc-full:win`
- Lint: `npm run lint`  E2E: `npm run test:e2e`

## Rules
- Tests verify correctness; never delete or weaken a test to make a change pass.
- Track work in progress.md and tasks.json; commit locally in small steps.
- Never write credentials into any file. Secrets live only in GitHub Actions.
- Local, reversible actions: proceed freely. Ask me first before: git push,
  creating releases, posting to issues/PRs/external sites, winget/brew
  submissions, deleting files, or installs larger than ~1 GB.
- Attribution to the original author stays in README permanently.