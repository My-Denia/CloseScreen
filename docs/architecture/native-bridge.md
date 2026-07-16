# Native Bridge Architecture

## Goal

Provide a single, resilient source of truth for platform-native capabilities while keeping Electron transport thin and renderer APIs unified.

## Layers

1. Native adapters
Platform-specific providers implement stable domain interfaces such as cursor telemetry or system asset discovery.

2. Main-process services
Services orchestrate adapters, own runtime state, and expose domain-level operations.

3. Unified IPC transport
Renderer code talks to a single `native-bridge:invoke` channel using versioned contracts.

4. Renderer client
React code should consume `src/native/client.ts` rather than binding directly to ad hoc Electron APIs.

## Principles

- Single source of truth: runtime-native state lives in the Electron main process.
- Capability-first: renderer can query support before attempting native behavior.
- Versioned contracts: requests and responses are explicit and evolve predictably.
- Resilience: every response uses a consistent result envelope with stable error codes.

## Current rollout

This repository now contains the initial scaffold:

- shared contracts in `src/native/contracts.ts`
- renderer SDK in `src/native/client.ts`
- main-process state store in `electron/native-bridge/store.ts`
- cursor telemetry adapter in `electron/native-bridge/cursor/telemetryCursorAdapter.ts`
- domain services in `electron/native-bridge/services/*`
- unified handler registration in `electron/ipc/nativeBridge.ts`

The legacy `window.electronAPI` surface still exists for backward compatibility. New native-facing features should prefer the unified bridge client.

## Windows capture backend boundary

Windows recording keeps the existing Electron IPC and session architecture, but the external helper
pair is selected through `electron/native-bridge/windowsNativeHelpers.ts`. The selector resolves the
capture executable and cursor sampler together, freezes the result for one recording attempt, and
reports the requested and effective backend identity.

- Unset `CLOSESCREEN_WINDOWS_CAPTURE_BACKEND` means the Rust x64 backend.
- `CLOSESCREEN_WINDOWS_CAPTURE_BACKEND=legacy` selects the packaged C++ rollback pair.
- Invalid explicit values fail before capture starts.
- Individual executable overrides remain diagnostic-only and are reported as `mixed` or `custom`.
- A selected helper failure is explicit; there is no automatic backend retry or Windows browser
  fallback after native startup.

Both implementations preserve the V2 process/event contract, so this migration does not change the
renderer, editor, exporter, or `RecordingSession` model.
