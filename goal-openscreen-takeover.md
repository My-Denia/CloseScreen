# Goal Contract - OpenScreen Takeover Baseline

## Goal

Convert the archived siddharthvaddem/openscreen repository into openscreen: a rebranded, attribution-preserving community fork whose CI produces installable Windows and Linux artifacts without the original author's secrets, with all upstream open issues migrated and the Windows native layer's build/test status documented in a report.

## Scope

- Repo: pjyqifei02/openscreen (hard fork of siddharthvaddem/openscreen, MIT), default branch only, full upstream git history retained.
- Paths: package.json, electron-builder.json5, .github/workflows/*, README, docs, i18n strings containing the product name, scripts/, and a new native-report.md. Local working machine: Windows (native build/tests).

## Non-goals

- No C++/Swift bug fixes (diagnosis only), no new features, no UI changes.
- No winget/brew submissions, no public release, no announcements, no contact with the upstream repo or its community.
- No LICENSE changes; no deletion or weakening of any existing test.
- No code-signing certificate acquisition; signing stays optional in CI.

## Constraints

- Node >= 22. Repo-facing docs in English. Credentials never written to any file; they exist only in GitHub Actions secrets configured by the owner.
- Original-author attribution (Siddharth Vaddem / OpenScreen, MIT) must be permanently visible in the README and untouched in LICENSE.

## Risk Level

auto - owner expectation: medium overall; the Windows native real-machine validation portion meets the harness definition of high. Resolve at triage.

## Owner-Only Boundaries

- Running the issue-migration script (writes under owner's gh identity).
- Any install > ~1 GB (e.g., Visual Studio Build Tools C++ workload).
- Anything touching the upstream archived repo, external registries, or public visibility.

## Acceptance Criteria

1. `npm run build-vite` and `npm test` both exit 0 on the fork.
2. `git grep` over package.json, electron-builder.json5, and .github/workflows shows zero stale upstream identifiers (productName/appId/publisher/update-feed/`SiddharthVaddem.OpenScreen`); README attribution section and LICENSE still name the original author.
3. One GitHub Actions build run on the fork completes successfully with no original signing secrets present and uploads >= 1 Windows and >= 1 Linux installable artifact (evidence: run URL + artifact list).
4. Migrated-issue count on the fork (label `upstream-migration`, each body containing its source link) equals the count of open issues on the upstream repo at migration time (29 as of 2026-06-11; re-count at run), verified by `gh` count commands. Execution sits behind the owner gate.
5. native-report.md exists with verbatim exit codes/output for `npm run build:native:win` and every `test:wgc-*:win` and `test:cursor-native:win` script, plus a diagnosis per failure.
6. `git diff upstream/main -- LICENSE` is empty; README first screen states maintained-fork status.

## Evidence Plan

Each criterion maps to: command transcript with cwd and exit code (1, 2, 5, 6), Actions run URL and artifact listing (3), gh count output (4). Closeout per harness contract.

## Guardrails

Harness defaults apply. Additionally: treat tests as correctness oracles - changing a test to make rebrand pass is a violation, not a fix.

## Skill Harvesting

report-only. If a reusable "oss-takeover" procedure emerges, report it; do not write skill files.

## Audit Mode

Independent audit per runtime mechanism (subagents on Claude Code; Codex twin's equivalent). self-check cannot reach completed at medium+.

## Gate Requirements

Before execution: preconditions below confirmed. Before completion: all six criteria evidenced or explicitly listed as blocked with cause.

## Stop Conditions

- Fork absent or gh unauthenticated -> needs-owner-decision.
- VS Build Tools missing and install unapproved -> mark criterion 5 blocked, continue all others.
- Upstream API limits prevent issue reads -> blocked with evidence.

## Verified Context

Dated 2026-06-11; prefer current repo state on conflict.

- Upstream archived 2026-06-06 after final release v1.5.0; author publicly encouraged forks; MIT.
- Stack: Electron 41, React 18, Vite 7, PixiJS 8; about 44k LOC TS/TSX; about 5.4k LOC native (electron/native/wgc-capture C++: WGC/WASAPI/MediaFoundation; electron/native/screencapturekit Swift).
- Verified green on Linux at audit date: npm install (782 pkgs), tsc, vite build, 225/225 unit tests.
- CI: build.yml, ci.yml, publish-winget.yml, update-homebrew-cask.yml, bump-nix-package.yml, discord.yaml. Signing secrets referenced: MAC_CERTIFICATE_P12, MAC_CERTIFICATE_PASSWORD, APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD; macOS notarization wired; Windows unsigned.
- Upstream distribution identifiers: winget `SiddharthVaddem.OpenScreen`, brew tap `siddharthvaddem/openscreen`, nix flake - all need new identifiers or disabling with TODO.
- Upstream open issues: 29; dominant clusters: export reliability, signing/auto-update, cursor/keyboard highlighting, Windows native capture (#626 WGC WriteSample hang), packaging.
