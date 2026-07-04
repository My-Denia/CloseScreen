# Security Policy

CloseScreen is a maintained community fork of OpenScreen. This policy documents the current fork's
security boundaries and reporting expectations. It does not make CloseScreen an official OpenScreen
successor.

## Reporting A Vulnerability

Prefer GitHub's private vulnerability reporting for `My-Denia/CloseScreen` if it is available on
the repository. If it is not available, open a minimal public issue that says you have a security
report to share, without exploit details, private data, or reproduction steps that could harm other
users.

Please include:

- affected CloseScreen version or commit;
- operating system and package type;
- whether the issue requires a malicious project file, local file path, renderer compromise, native
  helper access, or user interaction;
- a short impact statement.

## Supported Versions

Security fixes target the current `main` branch and the latest GitHub Release for this fork. Older
fork builds and upstream OpenScreen releases are not maintained by this repository.

## Electron And File Access Boundaries

Current hardening is based on these repository facts:

- Packaged renderer content is served from the privileged `app://bundle` scheme.
- `app://bundle` applies a restrictive Content Security Policy from `electron/appProtocol.ts`.
- Renderer windows use `contextIsolation: true` and `nodeIntegration: false`.
- Main windows block navigation away from the app origin. Allowed external web/mail links are opened
  in the OS browser and new Electron windows are denied.
- The `app://bundle/_res/` route only serves allowlisted resource subtrees: wallpapers, cursors, and
  caption assets.
- The `app://bundle/_media/` route serves local media only after main-process approval through the
  recordings directory, picker/project load, or equivalent approved-path rule.
- `read-binary-file` is approved-path-only and does not auto-approve arbitrary renderer-supplied
  paths.
- Export writes require an absolute `.mp4` or `.gif` file path approved by the OS save dialog for
  that export, and the approval is consumed once.

Other IPC that accepts a path is documented and reviewed separately; do not describe every
path-taking IPC as a media-read allowlist. The main process must remain the final authority for
local file reads, local file writes, and native helper launch parameters.

## Recording Directory Boundaries

The recordings directory is user configurable, but it is not a broad filesystem permission grant.
The main process:

- stores settings in Electron `userData/app-settings.json`;
- rejects empty and relative paths;
- rejects drive roots, the user profile root, and the app data root;
- resolves real paths to catch symlink/junction aliases to guarded locations;
- re-checks available stored custom folders on startup before using their resolved real path;
- preserves an unavailable stored custom folder so sessions can load again if that drive returns;
- locks folder changes while recording or finalizing.

If this area changes, tests should cover setting-time validation, startup validation, and the
unavailable-folder fallback path.

## Redaction Guidance

The safe default redaction style is a solid opaque block. Mosaic is available for visual workflows,
but it should not be described as strong redaction for passwords, IDs, keys, or other sensitive
text. Blur and mosaic can preserve recoverable information depending on source content and
resolution.

## Native Helper Boundary

The Windows native helper is a local capture/export component invoked by the Electron main process.
It must receive output paths and device/capture parameters from validated main-process flows. Do not
let renderer-supplied strings become native helper file paths or command parameters without a tested
main-process validation rule.

## Release And Update Boundary

CloseScreen does not configure an auto-updater provider or updater token. The current update check
contacts this fork's GitHub Releases API from the main process and surfaces a release link to the
renderer. It does not auto-download or auto-install updates.
