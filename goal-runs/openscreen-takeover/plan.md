# Plan - OpenScreen Takeover Baseline

## Confirmed Identity

The owner confirmed the final name is `openscreen`.

- Display/product name: `openscreen`
- npm/package slug: `openscreen`
- bundle/appId: `io.github.pjyqifei02.openscreen`
- current GitHub repo target: `pjyqifei02/openscreen`

## Milestones

1. Confirm preflight and current workspace state.
   - Commands:
     - `node -v`
     - `npm -v`
     - `npm install`
     - `Get-Command cl.exe,msbuild.exe,vswhere.exe -ErrorAction SilentlyContinue`
     - `@('C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat','C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat','C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvarsall.bat','C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvarsall.bat') | ForEach-Object { if (Test-Path $_) { $_ } }`
     - `python -c "import yaml; print('pyyaml ok')"`
     - `git status --short --branch`
     - `git rev-parse HEAD`
   - Pass condition: Node major is >= 22, `npm install` exits 0, PyYAML is available for workflow parse validation, workspace baseline is recorded, and VS Build Tools are either found or explicitly marked owner-gated.

2. Apply confirmed rebrand and publisher identifier cleanup.
   - Touch: `package.json`, `package-lock.json`, `electron-builder.json5`, README head, `CONTRIBUTING.md`, relevant repo links, i18n display strings containing the product name, and docs that describe install/distribution identity.
   - Do not touch: `LICENSE`, native C++/Swift fixes, `.openscreen` project extension, native helper binary names, temp/log filename prefixes, storage keys, tests that only assert compatibility/path handling, or source links to upstream attribution/migration.
   - Commands:
     - `node -e "const p=require('./package.json'); if(p.name!=='openscreen') process.exit(1)"`
     - `node -e "const p=require('./package-lock.json'); if(p.name!=='openscreen'||p.packages[''].name!=='openscreen') process.exit(1)"`
     - `if ((Select-String -Path electron-builder.json5 -Pattern '\"productName\": \"openscreen\"').Count -ne 1) { exit 1 }; if ((Select-String -Path electron-builder.json5 -Pattern '\"appId\": \"io.github.pjyqifei02.openscreen\"').Count -ne 1) { exit 1 }`
     - `git grep -n -E 'com\.siddharthvaddem\.openscreen|SiddharthVaddem\.OpenScreen|homebrew-openscreen|Samir Patil|N26FZ4GW28|svaddem@asu\.edu' -- package.json package-lock.json electron-builder.json5 .github/workflows; if ($LASTEXITCODE -eq 0) { exit 1 }; if ($LASTEXITCODE -ne 1) { exit $LASTEXITCODE }`
     - `if ((git grep -n 'Siddharth Vaddem' -- README.md LICENSE).Count -lt 2) { exit 1 }`
   - Pass condition: confirmed identity is present where required, stale upstream publisher identifiers return zero matches in build/package configs, README and LICENSE still contain original attribution.

3. Make CI fork-safe and artifact-producing.
   - Touch: `.github/workflows/build.yml`, `.github/workflows/publish-winget.yml`, `.github/workflows/update-homebrew-cask.yml`, `.github/workflows/bump-nix-package.yml`, `.github/workflows/discord.yaml`.
   - Commands:
     - `@'\nimport pathlib, yaml\nfor path in pathlib.Path('.github/workflows').glob('*'):\n    if path.is_file(): yaml.safe_load(path.read_text(encoding='utf-8'))\nprint('workflow yaml parse ok')\n'@ | python -`
     - `git grep -n -E 'siddharthvaddem|WINGET_ACC_TOKEN|HOMEBREW_TAP_TOKEN|DISCORD_|SiddharthVaddem\.OpenScreen|homebrew-openscreen|Samir Patil|N26FZ4GW28' -- .github/workflows; if ($LASTEXITCODE -eq 0) { exit 1 }; if ($LASTEXITCODE -ne 1) { exit $LASTEXITCODE }`
     - `foreach ($p in @('--publish never','release/**/*.exe','release/**/*.AppImage','CSC_IDENTITY_AUTO_DISCOVERY')) { if ((Select-String -Path .github/workflows/build.yml -SimpleMatch -Pattern $p).Count -lt 1) { exit 1 } }`
     - `foreach ($file in @('.github/workflows/publish-winget.yml','.github/workflows/update-homebrew-cask.yml')) { if ((Select-String -Path $file -Pattern 'TODO|disabled').Count -lt 1) { exit 1 } }`
   - Pass condition: workflows parse, Windows and Linux upload installable artifacts with `--publish never`, original author secrets/publish identifiers are absent, and package-manager publish jobs are no-op TODO jobs.
   - Owner-gated AC3: real GitHub Actions run URL and artifact list require owner-approved push/workflow execution.

4. Keep Windows native verification documented.
   - Commands to run and capture in `native-report.md`:
     - `npm run build:native:win`
     - `npm run test:wgc-helper:win`
     - `npm run test:wgc-window:win`
     - `npm run test:wgc-audio:win`
     - `npm run test:wgc-mic:win`
     - `npm run test:wgc-mixed-audio:win`
     - `npm run test:wgc-webcam:win`
     - `npm run test:wgc-full:win`
     - `npm run test:cursor-native:win`
   - Report validation command:
     - `node -e "const fs=require('fs'); const s=fs.readFileSync('native-report.md','utf8'); const cmds=['npm run build:native:win','npm run test:wgc-helper:win','npm run test:wgc-window:win','npm run test:wgc-audio:win','npm run test:wgc-mic:win','npm run test:wgc-mixed-audio:win','npm run test:wgc-webcam:win','npm run test:wgc-full:win','npm run test:cursor-native:win']; for (const c of cmds) if(!s.includes(c)) throw new Error('missing '+c); for (const token of ['CWD: C:\\\\Files\\\\openscreen','Exit code:','Log file:','Diagnosis:']) if(!s.includes(token)) throw new Error('missing '+token); console.log('native-report ok')"`
   - Pass condition: command logs are freshly captured or existing logs are verified, and the validation command confirms `native-report.md` includes cwd, exit code, verbatim output/log path, and diagnosis markers for every command. If VS Build Tools are missing, WGC failures are documented and the large install remains owner-gated.

5. Prepare issue migration for owner review only.
   - Touch: `scripts/migrate-upstream-issues.mjs`.
   - Commands:
     - `node --check scripts/migrate-upstream-issues.mjs`
     - `node scripts/migrate-upstream-issues.mjs --help`
     - `foreach ($p in @('upstream-migration','upstream-migration-source','--execute','Dry-run is the default')) { if ((Select-String -Path scripts/migrate-upstream-issues.mjs -SimpleMatch -Pattern $p).Count -lt 1) { exit 1 } }`
     - `gh issue list --repo siddharthvaddem/openscreen --state open --limit 100 --json number --jq 'length'`
     - `gh issue list --repo pjyqifei02/openscreen --state all --label upstream-migration --limit 200 --json number --jq 'length'`
   - Pass condition: script is syntactically valid, defaults to dry-run, uses label `upstream-migration`, includes source links/markers, and is ready for owner review. If fork Issues are disabled, count verification is marked blocked with verbatim `gh` error.
   - Owner-gated AC4: creating migrated issues requires owner approval and `--execute`.

6. Rebuild takeover evidence and progress tracking.
   - Touch: `takeover-map.md`, `progress.md`, `tasks.json`, `acceptance.md`, `goal-runs/openscreen-takeover/state.json`, `goal-runs/openscreen-takeover/execution-log.md`, and `goal-runs/openscreen-takeover/handoff.md`.
   - Commands:
     - `node -e "JSON.parse(require('fs').readFileSync('tasks.json','utf8'))"`
     - `node -e "JSON.parse(require('fs').readFileSync('goal-runs/openscreen-takeover/state.json','utf8'))"`
     - `foreach ($p in @('openscreen','upstream-migration','Visual Studio Build Tools','owner-gated')) { if ((Select-String -Path takeover-map.md,progress.md,acceptance.md -SimpleMatch -Pattern $p).Count -lt 1) { exit 1 } }`
   - Pass condition: tracking artifacts match current file state and list unfinished owner-gated criteria without claiming completion.

7. Run local validation and independent execution audit.
   - Commands:
     - `npm run build-vite`
     - `npm test`
     - `git diff --check`
     - `git diff upstream/main -- LICENSE`
     - `git diff --name-only -- electron/native`
     - `git grep -n -E 'AKIA|BEGIN (RSA|OPENSSH|PRIVATE) KEY|ghp_|github_pat_|xox[baprs]-' -- .; if ($LASTEXITCODE -eq 0) { exit 1 }; if ($LASTEXITCODE -ne 1) { exit $LASTEXITCODE }`
     - `git diff --stat`
   - Pass condition: build and tests exit 0, LICENSE diff is empty, native source has no changes, no obvious credential patterns are introduced in changed files, and independent execution audit returns `pass`, `blocked`, or `needs-owner-decision` with no unresolved `needs-fix`.

## Owner-Only Boundaries

- Changing the confirmed `openscreen` identifiers again.
- Installing Visual Studio Build Tools C++ workload if missing.
- Running issue migration with `--execute`.
- Enabling Issues on the fork, pushing, creating/running remote GitHub Actions evidence, creating releases, publishing, submitting WinGet/Homebrew/Nix updates, or contacting upstream.

## Rollback

- Config/doc/script changes remain reviewable in `git diff` and can be reverted per file.
- No remote or public state is changed in this run unless the owner explicitly approves that gate.
