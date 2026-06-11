# Native Windows Verification Report

- Date: 2026-06-11
- CWD: C:\Files\openscreen
- Host: Windows PowerShell
- Scope: npm run build:native:win, every test:wgc-*:win, and test:cursor-native:win.
- Constraint: no C++ fixes this week; no Visual Studio Build Tools install was performed.

## npm run build:native:win

- Start: 2026-06-11T17:23:39.5573485+01:00
- End: 2026-06-11T17:23:39.9256134+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\build-native-win.log
- Diagnosis: Failed before CMake because Visual Studio vcvarsall.bat was not found. This matches preflight: the Visual Studio C++ workload is missing or not installed in a standard location. Install is owner-gated because it is larger than about 1 GB.

```text

> openscreen@1.5.0 build:native:win
> node scripts/build-windows-wgc-helper.mjs

file:///C:/Files/openscreen/scripts/build-windows-wgc-helper.mjs:77
		throw new Error(
		      ^

Error: Could not find Visual Studio vcvarsall.bat. Install Visual Studio Build Tools with C++.
    at runInVsEnv (file:///C:/Files/openscreen/scripts/build-windows-wgc-helper.mjs:77:9)
    at file:///C:/Files/openscreen/scripts/build-windows-wgc-helper.mjs:114:7
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## After Approved VS Build Tools C++ Workload Install

Date: 2026-06-11
Workspace: `C:\Files\openscreen`

Environment changes performed after owner approval:

- `winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --accept-package-agreements --accept-source-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"`: exit 0.
- `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat`: present.
- `winget install --id Gyan.FFmpeg --exact --source winget --accept-package-agreements --accept-source-agreements`: exit 0.
- `ffprobe -version`: exit 0, `ffprobe version 8.1.1-full_build-www.gyan.dev`.
- `mspaint.exe`: not found on PATH and no Paint AppX package was installed.

Full verbatim command logs are saved under `goal-runs/openscreen-takeover/native-logs/`.

### `npm run build:native:win`

- Exit code: 0.
- Full log: `goal-runs/openscreen-takeover/native-logs/build-native-win-after-vs.log`

Key output:

```text
-- The CXX compiler identification is MSVC 19.44.35228.0
-- Build files have been written to: C:/Files/openscreen/electron/native/wgc-capture/build
[11/11] Linking CXX executable wgc-capture.exe
Built C:\Files\openscreen\electron\native\wgc-capture\build\wgc-capture.exe
Copied C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe
Built C:\Files\openscreen\electron\native\wgc-capture\build\cursor-sampler.exe
Copied C:\Files\openscreen\electron\native\bin\win32-x64\cursor-sampler.exe
Exit code: 0
```

Diagnosis: Windows native helper compilation is no longer blocked by Visual Studio Build Tools. The build emits existing MSVC warnings in webcam capture sources but produces both executables.

### First WGC Test Pass After VS Install, Before FFmpeg Install

After `build:native:win` succeeded, the first WGC suite run proved the helper executable existed but exposed missing media probe tools.

| Command | Exit | Full log | Diagnosis |
| --- | ---: | --- | --- |
| `npm run test:wgc-helper:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-helper-win-after-vs.log` | `ffprobe` was not available on PATH. |
| `npm run test:wgc-window:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-window-win-after-vs.log` | `mspaint.exe` fixture app was not available. |
| `npm run test:wgc-audio:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-audio-win-after-vs.log` | `ffprobe` was not available on PATH. |
| `npm run test:wgc-mic:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-mic-win-after-vs.log` | `ffprobe` was not available on PATH. |
| `npm run test:wgc-mixed-audio:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-mixed-audio-win-after-vs.log` | `ffprobe` was not available on PATH. |
| `npm run test:wgc-webcam:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-webcam-win-after-vs.log` | `ffprobe` was not available on PATH. |
| `npm run test:wgc-full:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-full-win-after-vs.log` | `ffprobe` was not available on PATH. |
| `npm run test:cursor-native:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-cursor-native-win-after-vs.log` | Cursor native sampler passed. |

Representative verbatim failure output for the `ffprobe` class:

```text
Error: ffprobe failed: undefined
    at probeStreams (file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:179:9)
```

Verbatim failure output for the window fixture class:

```text
Error: spawn mspaint.exe ENOENT
  errno: -4058,
  code: 'ENOENT',
  syscall: 'spawn mspaint.exe',
  path: 'mspaint.exe',
  spawnargs: []
```

### WGC Test Pass After FFmpeg Install

After installing FFmpeg, all non-window WGC tests passed. `test:wgc-window:win` still fails because the test fixture hard-codes `mspaint.exe`, which is not installed on this machine.

| Command | Exit | Full log | Result |
| --- | ---: | --- | --- |
| `npm run test:wgc-helper:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-wgc-helper-win-after-ffmpeg.log` | Passed; produced H.264 video. |
| `npm run test:wgc-window:win` | 1 | `goal-runs/openscreen-takeover/native-logs/test-wgc-window-win-after-ffmpeg.log` | Failed before capture: `mspaint.exe` missing. |
| `npm run test:wgc-audio:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-wgc-audio-win-after-ffmpeg.log` | Passed; produced video + AAC audio. |
| `npm run test:wgc-mic:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-wgc-mic-win-after-ffmpeg.log` | Passed; selected `麦克风阵列 (Realtek(R) Audio)`. |
| `npm run test:wgc-mixed-audio:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-wgc-mixed-audio-win-after-ffmpeg.log` | Passed; produced video + AAC audio. |
| `npm run test:wgc-webcam:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-wgc-webcam-win-after-ffmpeg.log` | Passed; selected `USB2.0 HD UVC WebCam`. |
| `npm run test:wgc-full:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-wgc-full-win-after-ffmpeg.log` | Passed; produced screen, audio, microphone, and webcam outputs. |
| `npm run test:cursor-native:win` | 0 | `goal-runs/openscreen-takeover/native-logs/test-cursor-native-win-after-ffmpeg.log` | Passed; cursor native sampler produced events/assets. |

Verbatim remaining failure:

```text
> openscreen@1.5.0 test:wgc-window:win
> node scripts/test-windows-wgc-helper.mjs --window

Error: spawn mspaint.exe ENOENT
    at ChildProcess._handle.onexit (node:internal/child_process:285:19)
    at onErrorNT (node:internal/child_process:483:16)
    at process.processTicksAndRejections (node:internal/process/task_queues:89:21) {
  errno: -4058,
  code: 'ENOENT',
  syscall: 'spawn mspaint.exe',
  path: 'mspaint.exe',
  spawnargs: []
}
```

Diagnosis: the Windows native WGC helper now builds and the screen/audio/microphone/webcam/full capture paths pass when FFmpeg is available. The remaining window-specific test failure is a test fixture dependency on Paint, not a C++ compile or capture pipeline failure. No C++ changes were made.

## npm run test:wgc-helper:win

- Start: 2026-06-11T17:23:39.9403306+01:00
- End: 2026-06-11T17:23:40.2975464+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\test-wgc-helper-win.log
- Diagnosis: Failed because electron/native/bin/win32-x64/wgc-capture.exe is absent. This is a downstream consequence of build:native:win failing before producing the helper.

```text

> openscreen@1.5.0 test:wgc-helper:win
> node scripts/test-windows-wgc-helper.mjs

file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
	      ^

Error: WGC helper not found at C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe. Run npm run build:native:win first.
    at file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226:8
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## npm run test:wgc-window:win

- Start: 2026-06-11T17:23:40.3015933+01:00
- End: 2026-06-11T17:23:40.6981002+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\test-wgc-window-win.log
- Diagnosis: Failed because electron/native/bin/win32-x64/wgc-capture.exe is absent. This is a downstream consequence of build:native:win failing before producing the helper.

```text

> openscreen@1.5.0 test:wgc-window:win
> node scripts/test-windows-wgc-helper.mjs --window

file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
	      ^

Error: WGC helper not found at C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe. Run npm run build:native:win first.
    at file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226:8
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## npm run test:wgc-audio:win

- Start: 2026-06-11T17:23:40.6999195+01:00
- End: 2026-06-11T17:23:41.1074600+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\test-wgc-audio-win.log
- Diagnosis: Failed because electron/native/bin/win32-x64/wgc-capture.exe is absent. This is a downstream consequence of build:native:win failing before producing the helper.

```text

> openscreen@1.5.0 test:wgc-audio:win
> node scripts/test-windows-wgc-helper.mjs --system-audio

file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
	      ^

Error: WGC helper not found at C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe. Run npm run build:native:win first.
    at file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226:8
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## npm run test:wgc-mic:win

- Start: 2026-06-11T17:23:41.1091078+01:00
- End: 2026-06-11T17:23:41.5208800+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\test-wgc-mic-win.log
- Diagnosis: Failed because electron/native/bin/win32-x64/wgc-capture.exe is absent. This is a downstream consequence of build:native:win failing before producing the helper.

```text

> openscreen@1.5.0 test:wgc-mic:win
> node scripts/test-windows-wgc-helper.mjs --microphone

file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
	      ^

Error: WGC helper not found at C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe. Run npm run build:native:win first.
    at file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226:8
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## npm run test:wgc-mixed-audio:win

- Start: 2026-06-11T17:23:41.5226663+01:00
- End: 2026-06-11T17:23:41.9333062+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\test-wgc-mixed-audio-win.log
- Diagnosis: Failed because electron/native/bin/win32-x64/wgc-capture.exe is absent. This is a downstream consequence of build:native:win failing before producing the helper.

```text

> openscreen@1.5.0 test:wgc-mixed-audio:win
> node scripts/test-windows-wgc-helper.mjs --system-audio --microphone

file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
	      ^

Error: WGC helper not found at C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe. Run npm run build:native:win first.
    at file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226:8
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## npm run test:wgc-webcam:win

- Start: 2026-06-11T17:23:41.9348645+01:00
- End: 2026-06-11T17:23:42.3810939+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\test-wgc-webcam-win.log
- Diagnosis: Failed because electron/native/bin/win32-x64/wgc-capture.exe is absent. This is a downstream consequence of build:native:win failing before producing the helper.

```text

> openscreen@1.5.0 test:wgc-webcam:win
> node scripts/test-windows-wgc-helper.mjs --webcam

file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
	      ^

Error: WGC helper not found at C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe. Run npm run build:native:win first.
    at file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226:8
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## npm run test:wgc-full:win

- Start: 2026-06-11T17:23:42.3827808+01:00
- End: 2026-06-11T17:23:42.8111940+01:00
- Exit code: 1
- Log file: goal-runs\openscreen-takeover\native-logs\test-wgc-full-win.log
- Diagnosis: Failed because electron/native/bin/win32-x64/wgc-capture.exe is absent. This is a downstream consequence of build:native:win failing before producing the helper.

```text

> openscreen@1.5.0 test:wgc-full:win
> node scripts/test-windows-wgc-helper.mjs --webcam --system-audio --microphone

file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226
	throw new Error(`WGC helper not found at ${HELPER_PATH}. Run npm run build:native:win first.`);
	      ^

Error: WGC helper not found at C:\Files\openscreen\electron\native\bin\win32-x64\wgc-capture.exe. Run npm run build:native:win first.
    at file:///C:/Files/openscreen/scripts/test-windows-wgc-helper.mjs:226:8
    at ModuleJob.run (node:internal/modules/esm/module_job:413:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:654:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)

Node.js v25.2.1
```

## npm run test:cursor-native:win

- Start: 2026-06-11T17:23:42.8125634+01:00
- End: 2026-06-11T17:23:46.7021626+01:00
- Exit code: 0
- Log file: goal-runs\openscreen-takeover\native-logs\test-cursor-native-win.log
- Diagnosis: Command exited 0. The diagnostic JSON still reports optional Playwright Chromium preview capture errors; those do not fail this native cursor command.

```text

> openscreen@1.5.0 test:cursor-native:win
> node scripts/test-windows-native-cursor.mjs

{
  "outputDir": "C:\\Users\\25725\\AppData\\Local\\Temp\\openscreen-cursor-native-1781195023248",
  "sampleIntervalMs": 25,
  "durationMs": 1800,
  "eventCount": 88,
  "sampleCount": 87,
  "visibleSampleCount": 87,
  "assetCount": 1,
  "uniqueCursorHandleCount": 1,
  "uniquePositionCount": 69,
  "leftButtonDownSampleCount": 1,
  "leftButtonPressedSampleCount": 1,
  "clickSampleCount": 1,
  "errorCount": 0,
  "firstSample": {
    "x": 500,
    "handle": "0x10003",
    "type": "sample",
    "visible": true,
    "timestampMs": 1781195023656,
    "y": 743,
    "bounds": {
      "y": 0,
      "width": 1707,
      "height": 1067,
      "x": 0
    },
    "leftButtonPressed": false,
    "leftButtonDown": false,
    "asset": {
      "id": "0x10003",
      "width": 32,
      "cursorType": "arrow",
      "height": 32,
      "imageDataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADoSURBVFhH7ZE9CsIwFICfWNChUdALiGfQY3g3B6/gDRS66K6Lg6M4FAp1K6TFn0D75JmhNlZd2tclHxSaF0q+fAUAEUKzkIAzNaeMiBAREUBszB0mtICWaKRELtBQiaKAlmAt8SlAMJYoF0hTthLlAsT9oThKfBcgokjWXeK3ABEElzpL/BdQSqHv+3WVyAXi+Jq9H6xvbT6VowWS5EY3nAC4x1yABRHqw93ktWz1Vrv9AbMsQ3qH9nBmflEx7hKgMyrOugsqcDqdSWxe3ONhQAJSSvS8LdevMHHWAP2xObVYLBaLxVI1T1ihPilk36rEAAAAAElFTkSuQmCC",
      "hotspotX": 0,
      "hotspotY": 0
    },
    "cursorType": "arrow",
    "leftButtonReleased": false
  },
  "lastSample": {
    "x": 1391,
    "handle": "0x10003",
    "type": "sample",
    "visible": true,
    "timestampMs": 1781195026388,
    "y": 419,
    "bounds": {
      "y": 0,
      "width": 1707,
      "height": 1067,
      "x": 0
    },
    "leftButtonPressed": false,
    "leftButtonDown": false,
    "asset": null,
    "cursorType": "arrow",
    "leftButtonReleased": false
  },
  "assets": [
    {
      "id": "0x10003",
      "width": 32,
      "height": 32,
      "hotspotX": 0,
      "hotspotY": 0,
      "cursorType": "arrow"
    }
  ],
  "screenFrameCount": 16,
  "previewVideoError": "browserType.launch: Failed to launch chromium because executable doesn't exist at C:\\Users\\25725\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe",
  "realCaptureVideoError": "browserType.launch: Failed to launch chromium because executable doesn't exist at C:\\Users\\25725\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe"
}
```
