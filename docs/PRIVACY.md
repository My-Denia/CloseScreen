# CloseScreen Privacy Notes

CloseScreen is designed around local recording and editing. This document describes the current
implementation from repository evidence.

## What Stays Local

- Screen recordings, webcam sidecars, cursor sidecars, and session manifests are written to the
  effective recordings directory.
- The default recordings directory is under Electron `userData/recordings`.
- Users can choose a custom recordings directory through the app's OS directory picker.
- Project files and exported MP4/GIF files are saved only when the user chooses a save path.
- The repository does not contain a built-in upload path for recordings or exports.

There is no implemented retention policy in the current app. Users should manage disk usage and
delete old recordings, project files, and exports when they no longer need them.

## Captions

Packaged builds load the Whisper model and ONNX Runtime wasm from bundled `caption-assets` through
the app resource route, so caption inference runs locally in a renderer Web Worker. Development mode
uses the remote Transformers.js model path because it runs from the Vite dev server; release
packages should use bundled assets.

Caption text is generated in the editor and stored only if the user saves a project or export that
contains those caption annotations.

## Network Access

Current built-in network paths are limited:

- The main-process update check calls GitHub Releases for `My-Denia/CloseScreen` and returns a
  download page URL when a newer version is available.
- The packaged renderer CSS imports Google Fonts, and the packaged CSP allows
  `fonts.googleapis.com` and `fonts.gstatic.com` for stylesheet/font loading.
- External links opened from the app are restricted to web and mail schemes and are handed to the OS
  browser.
- Packaged caption inference is local. Development caption model loading can fetch remote model
  assets.

The current implementation does not include telemetry, analytics, crash reporting, or automatic
recording upload code. Console logs and saved diagnostics can still contain local paths, selected
device labels, project state, or error details if the user chooses to create/share them.

## Local Data Locations

Exact paths depend on Electron and the operating system, but the code uses these storage areas:

- recordings and session artifacts: the effective recordings directory shown by the app;
- app settings: Electron `userData/app-settings.json`;
- keyboard shortcuts: Electron `userData/shortcuts.json`;
- renderer preferences, update-dismissal state, locale, and custom fonts: Chromium localStorage
  under Electron `userData`;
- Chromium cache and logs: Electron/Chromium data under `userData`.

To remove local data, close CloseScreen first, then delete the recordings directory you configured
and the CloseScreen Electron app data directory for the relevant OS account. If you use a custom
recordings directory, deleting only app data will not remove recordings stored there.

## Updates

The update check is a link/check flow only. It does not install updates, download installers in the
background, send telemetry, or use a third-party update service.

## Implementation References

Relevant implementation files include `electron/appSettings.ts`, `electron/ipc/handlers.ts`,
`electron/ipc/updateCheck.ts`, `electron/ipc/externalUrl.ts`, `electron/localStorageMigration.ts`,
`src/lib/captioning/transcribe.ts`, `src/lib/captioning/transcribe.worker.ts`,
`src/lib/userPreferences.ts`, and `src/lib/updateNotifications.ts`.
