# Owner Gate Runbook

Date: 2026-06-11
Workspace: `C:\Files\openscreen`
Fork: `My-Denia/openscreen`
Runbook created from local HEAD: `64d6761 docs: refresh openscreen takeover verification`

This runbook captures the remaining owner-gated steps for the openscreen takeover baseline. Do not run the write commands until the repository owner explicitly approves that gate.

## Current Gate State

- Local branch `main` is ahead of `origin/main` by 2 commits.
- Fork Issues are disabled: `gh repo view My-Denia/openscreen --json hasIssuesEnabled` returned `false`.
- No GitHub Actions runs currently exist on the fork: `gh run list --repo My-Denia/openscreen --limit 5 --json databaseId,workflowName,status,conclusion,headSha,createdAt,url` returned `[]`.
- Upstream currently has 29 open issues.

## Gate A: Push And Build Artifacts

Owner approval required because this writes to the public fork and starts GitHub Actions.

```powershell
git status --short --branch
git log --oneline --decorate -3
git push origin main
gh workflow run build.yml --repo My-Denia/openscreen --ref main -f arch=both -f build_macos=false
gh run list --repo My-Denia/openscreen --workflow build.yml --branch main --limit 1 --json databaseId,status,conclusion,headSha,url
```

After the run starts, replace `<RUN_ID>` with the returned `databaseId`:

```powershell
gh run watch <RUN_ID> --repo My-Denia/openscreen --exit-status
gh run view <RUN_ID> --repo My-Denia/openscreen --json status,conclusion,headSha,jobs,url
gh api repos/My-Denia/openscreen/actions/runs/<RUN_ID>/artifacts --jq '.artifacts[] | {name, size_in_bytes, expired, archive_download_url}'
```

Acceptance evidence to copy into `acceptance.md`:

- GitHub Actions run URL.
- Run conclusion is `success`.
- Artifact list includes `windows-installer`.
- Artifact list includes `linux-installer`.
- The run head SHA matches the pushed takeover commit.

## Gate B: Enable Issues And Migrate Upstream Issues

Owner approval required because this writes issues under the owner's GitHub identity. Enabling Issues is also required before the script can detect existing migrated issues.

```powershell
gh repo edit My-Denia/openscreen --enable-issues
gh repo view My-Denia/openscreen --json hasIssuesEnabled
gh issue list --repo siddharthvaddem/openscreen --state open --limit 100 --json number --jq 'length'
node scripts/migrate-upstream-issues.mjs
```

Review the dry-run output. If the dry-run is correct and owner approval is explicit:

```powershell
node scripts/migrate-upstream-issues.mjs --execute
gh issue list --repo My-Denia/openscreen --state all --label upstream-migration --limit 200 --json number --jq 'length'
gh issue list --repo My-Denia/openscreen --state all --label upstream-migration --limit 200 --json body --jq '[.[].body | contains("upstream-migration-source: https://github.com/siddharthvaddem/openscreen/issues/")] | all'
```

Acceptance evidence to copy into `acceptance.md`:

- Upstream open issue count at migration time.
- Migrated issue count with label `upstream-migration`.
- Source-link marker check result is `true`.
- Any script output showing skipped existing migrated issues, if rerun.

## Gate C: Visual Studio Build Tools C++ Workload

Owner approval required because installing Visual Studio Build Tools with the C++ workload can exceed 1 GB. If approved, install the C++ build tools or provide a valid `VCVARSALL` path, then rerun and append results to `native-report.md`:

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

Acceptance evidence to copy into `native-report.md` and `acceptance.md`:

- Command, cwd, exit code, and verbatim output for each native command.
- Diagnosis per failed command.
- If WGC remains failing, do not edit C++ unless the fix is trivial and test-covered.
