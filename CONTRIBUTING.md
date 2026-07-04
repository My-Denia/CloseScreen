# Contribution Guidelines

CloseScreen is a maintained community fork of Siddharth Vaddem's OpenScreen. Contributions must preserve the original MIT license and visible OpenScreen attribution, and must not present this fork as an official OpenScreen successor.

## Development Setup

Use npm and the locked dependency graph in `package-lock.json`:

```bash
npm ci
npm run build-vite
npm test
```

The Node version is pinned in `.nvmrc`. Do not introduce a second package manager or lockfile unless the maintainer explicitly changes the project policy.

## Branches And Pull Requests

1. Fork and clone the repository.
2. Create a focused branch for one issue or maintenance task.
3. Keep changes scoped. Avoid unrelated refactors, generated artifacts, and local run files.
4. Open a pull request with the reason, changed behavior, risk, and validation commands.

Local-only workflow files such as `AGENTS.md`, `CLAUDE.md`, `progress.md`, `tasks.json`, `goal-runs/`, release output, native build output, and `caption-assets/` are ignored and must not be committed.

## Required Validation

Run the closest focused tests for the code you changed, then the broader gates that fit the risk:

```bash
npm run lint
npm test
npm run build-vite
```

Additional gates by area:

- Windows native capture: `npm run build:native:win`, then `npm run test:wgc-full:win` on Windows.
- Electron packaging: `npm run build:win` on Windows or `npm run build:linux` on Linux.
- End-to-end UI flows: `npm run test:e2e` after `npm run build-vite`.
- Browser/export internals: `npm run test:browser` after installing the browser test runtime with `npm run test:browser:install`.
- Translation key changes: `npm run i18n:check`.

Do not delete or weaken tests to make a change pass.

For release-readiness changes, also check the public documentation set:

- [Support matrix](./docs/SUPPORT_MATRIX.md)
- [Security policy](./SECURITY.md)
- [Privacy notes](./docs/PRIVACY.md)
- [Regression checklist](./docs/REGRESSION_CHECKLIST.md)

Do not mark a platform, feature, or test path as supported unless the repository currently has
code, build configuration, and validation evidence for that claim.

## Release And Packaging Changes

Release artifacts are unsigned Windows and Linux builds published from GitHub Actions on matching `v*` tags. A packaging or release change must state whether it affects:

- unsigned installer prompts or operating-system trust UX;
- the tag/version contract in `package.json`;
- GitHub Releases and update-check behavior;
- bundled resources such as `caption-assets/`, wallpapers, cursors, README, and LICENSE;
- Windows native helper packaging under `electron/native/bin`.

Do not add release tokens, external publishing channels, auto-update installers, or credential files to the repository.

## Security-Sensitive Areas

Use conservative changes and tests around:

- `app://` scheme routing, CSP, and resource allowlists;
- preload IPC and `ipcMain.handle` registration;
- local file reads, project loading, export paths, and recordings directory rules;
- custom recordings directory validation and low-disk handling;
- native capture and export pipelines.

Renderer-supplied paths must not gain new filesystem power unless they are tied to an OS picker, an already approved media path, or a clearly tested main-process validation rule.

## Reporting Issues

Open issues at [My-Denia/CloseScreen](https://github.com/My-Denia/CloseScreen/issues). Include the OS, app version or commit, capture mode, whether the build is unsigned, reproduction steps, and any relevant logs or screenshots.

## License

By contributing to this project, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
