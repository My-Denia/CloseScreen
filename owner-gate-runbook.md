# Owner Gate Runbook

Date: 2026-06-11
Workspace: `C:\Files\openscreen`
Fork: `My-Denia/openscreen`
Runbook updated after successful build run `27367183706`; artifact-producing head: `261e33d136ef636621eabea588a3c0bc44d183ef`

This runbook captures owner-gated steps and final evidence for the openscreen takeover baseline.

## Current Gate State

- Local branch `main` is pushed to `origin/main`; the artifact-producing build run used head `261e33d136ef636621eabea588a3c0bc44d183ef`.
- Fork Issues are enabled: `gh repo view My-Denia/openscreen --json hasIssuesEnabled` returned `true`.
- GitHub Actions run `27367183706` completed successfully and uploaded `windows-installer` plus `linux-installer`.
- Upstream currently has 29 open issues.
- Target fork has 29 migrated issues with label `upstream-migration`.

## Gate A: Push And Build Artifacts

Completed after owner approval.

```powershell
gh run view 27367183706 --repo My-Denia/openscreen --json databaseId,status,conclusion,headSha,url
gh api repos/My-Denia/openscreen/actions/runs/27367183706/artifacts --jq '.artifacts[] | {name, size_in_bytes, expired, archive_download_url}'
```

Acceptance evidence recorded in `acceptance.md`:

- GitHub Actions run URL: `https://github.com/My-Denia/openscreen/actions/runs/27367183706`.
- Run conclusion is `success`.
- Artifact list includes `windows-installer`, size `386907191`.
- Artifact list includes `linux-installer`, size `851775419`.
- The run head SHA matches the pushed takeover commit `261e33d136ef636621eabea588a3c0bc44d183ef`.

## Gate B: Enable Issues And Migrate Upstream Issues

Completed after owner approval. The sanitized dry-run sample was confirmed, fork Issues were enabled, and the migration script created 29 issues.

```powershell
gh repo view My-Denia/openscreen --json hasIssuesEnabled
gh issue list --repo siddharthvaddem/openscreen --state open --limit 100 --json number --jq 'length'
node scripts/migrate-upstream-issues.mjs
node scripts/migrate-upstream-issues.mjs --execute
gh issue list --repo My-Denia/openscreen --state all --label upstream-migration --limit 200 --json number --jq 'length'
gh issue list --repo My-Denia/openscreen --state all --label upstream-migration --limit 200 --json body --jq '[.[].body | contains("`https://github.com/siddharthvaddem/openscreen/issues/") and contains("upstream-migration-source: siddharthvaddem/openscreen#")] | all'
```

Acceptance evidence recorded in `acceptance.md`:

- Upstream open issue count at migration time: `29`.
- Migrated issue count with label `upstream-migration`: `29`.
- Post-execute dry-run detected 29 existing migrated issues and 0 pending copies.
- Source markers and code-spanned upstream issue URLs verified across all migrated issues.

## Gate C: Visual Studio Build Tools C++ Workload

Completed after owner approval. These verification commands were run and results were appended to `native-report.md`:

```powershell
npm run build:native:win
npm run test:wgc-helper:win
npm run test:wgc-window:win
npm run test:wgc-audio:win
npm run test:wgc-mic:win
npm run test:wgc-mixed-audio:win
npm run test:wgc-webcam:win
npm run test:wgc-full:win
npm run test:cursor-native:win
```

Acceptance evidence recorded in `native-report.md` and `acceptance.md`:

- Command, cwd, exit code, and verbatim output for each native command.
- Diagnosis per failed command.
- `build:native:win`, WGC helper/audio/mic/mixed-audio/webcam/full, and cursor-native pass.
- `test:wgc-window:win` remains failed because `mspaint.exe` is missing; no C++ changes were made.
