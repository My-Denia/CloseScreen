# Rust native capture cutover handoff

Date: 2026-07-16
Implementation baseline: `bb632283917d8adc9ae35b14a96fcdab970f7ba3`
Cutover integrated in main: `71b991a50f54f2cabbc0698c44e4637f554a69ea`
Packet-production gate integrated in main: `0c58b89f05e231d8868ae876d5c7fabb5edf404b`

## Architecture state

The Windows x64 release path now stages and packages Rust `wgc-capture.exe` and
`cursor-sampler.exe` as the default native pair. The legacy C++ implementation remains packaged as
`wgc-capture-legacy.exe` and `cursor-sampler-legacy.exe`.

Electron, the renderer, editor, exporter, and session formats are unchanged. Electron resolves one
paired backend before a recording attempt and injects that frozen pair into the existing recording
session. An unset `CLOSESCREEN_WINDOWS_CAPTURE_BACKEND` selects Rust; the exact value `legacy`
selects the C++ rollback pair. Invalid values fail explicitly. There is no automatic mid-session or
missing-binary fallback between native implementations.

Per-helper executable overrides remain available for diagnostics. They take priority over the
paired selector and are reported as a custom or mixed backend identity rather than being presented
as a normal release configuration.

## Migration status

- Rust WGC video, WASAPI audio, cursor sampling, and webcam-sidecar support are on the default
  Windows x64 packaging path.
- The C++ capture and cursor helpers remain buildable, packaged, parity-tested, and explicitly
  selectable for rollback.
- `npm run build:native:win` cleans the staged payload, builds both implementations, uses locked
  dependencies and Rust 1.96.1, verifies Rust notices, and verifies the exact four-file PE x64 set.
- The packaged payload verifier also requires `LICENSE`, `README.md`, and
  `RUST_THIRD_PARTY_NOTICES.md`.
- Runtime and support documentation now describe the actual Rust-default transition architecture.
  Historical OpenScreen attribution remains intact. macOS is documented as not being a current
  CloseScreen release target rather than as a currently built or supported artifact.

## Validation evidence

Validation was performed on one Windows x64 laptop with Node 22.22.1, npm 10.9.4, and the pinned
Rust 1.96.1 MSVC toolchain.

- TypeScript: `npx tsc --noEmit` passed.
- Lint and localization: `npm run lint` and `npm run i18n:check` passed.
- Unit tests: 62 Vitest files and 489 tests passed.
- Browser tests: 2 files and 7 tests passed with the browser server bound to `127.0.0.1`.
- Rust: format and Clippy passed; Windows-target tests passed (6 protocol, 14 cursor, 40 WGC).
- Native build: the Rust-default and legacy rollback helpers built and the exact x64 payload passed
  verification.
- Normal display capture passed independently for Rust and C++, producing readable H.264 video.
- Rust/C++ parity passed startup, pause/resume, duration, monotonic/near-zero packet timestamps,
  explicit error exits, optional AAC audio timing, and A/V drift checks.
- Self-contained system-audio parity and direct system-audio smoke tests passed for both backends.
  The packet-production gate plays deterministic render audio and requires non-zero AAC
  packets/frames, full decode, and the expected signal; AAC stream metadata alone is not a pass.
- Fault injection passed for both backends: the deliberately wedged writer produced the expected
  diagnostic and exited within the bounded shutdown gate.
- Cursor protocol/window-bounds/GDI checks passed for both backends. The self-contained window
  fixture is required; fixture creation failure now fails the harness.
- A Windows unsigned installer was built locally. Its unpacked resources passed the packaged native
  payload and attribution checks.
- Release-asset staging tests passed: assets are flattened to a unique final set, checksums are
  generated from that set, verified before upload, and both platform provenance records are
  included.

## Remaining release gates and risks

The migration boundary and the maintainer-owned Rust-default packaged-application gate are
complete:

- The packaged application passed native recording, normal UI stop and finalization, editor load,
  MP4/GIF export, system-audio, microphone, webcam, and native save-dialog validation on the
  maintainer's Windows x64 laptop.
- Packaged legacy UI behavior was not repeated in this validation round and is `NOT VERIFIED`, not
  failed. The explicit rollback remains packaged.
- Earlier direct-helper microphone and webcam runs exceeded a fixed 9-second post-stop deadline.
  Those results did not reproduce through the Electron-managed packaged lifecycle and are
  test-contract false negatives relative to the product path, not product or hardware failures.
- The locally built installer is unsigned. Code signing and publication were not attempted.
- GitHub Actions YAML, action pinning, artifact layout, provenance, and checksum logic were validated
  locally; the remote release workflow itself was not dispatched and no release was published.
- `npm audit` reports 13 pre-existing dependency findings (2 low, 3 moderate, 5 high, 3 critical).
  They were not changed because dependency remediation is outside this migration boundary.

## Unsupported or unvalidated environments

This handoff makes no support claim for multi-monitor behavior, ARM64 Windows, external audio or
camera hardware, broad GPU/driver combinations, signing infrastructure, macOS, or Linux Wayland.
Linux packaging remains a separate Electron capture path; Linux provenance explicitly marks the
Windows native backend as not applicable.

## Release readiness decision

The Rust-default Windows x64 migration, rollback boundary, and packaged interactive
record-to-editor-to-export gate are ready for release promotion. Keep the legacy pair in the
package until a later evidence-based removal decision.
