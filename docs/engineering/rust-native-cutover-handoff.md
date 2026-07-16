# Rust native capture cutover handoff

Date: 2026-07-16
Source baseline: `bb632283917d8adc9ae35b14a96fcdab970f7ba3`

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

The migration boundary is complete, but release promotion still requires maintainer-owned evidence
that cannot be substituted by automated local checks:

- Run the packaged application through native recording, editor load, and MP4/GIF export on the
  release candidate. Browser exporter tests and import-oriented E2E checks passed, but they are not
  evidence of this full packaged interactive path.
- The current laptop's webcam run exceeded the 9-second post-stop bound for both Rust and legacy
  backends. A Rust diagnostic run exited under a 30-second ceiling without a webcam sidecar. This is
  a shared device-specific limitation, not evidence of a Rust-only regression, and no unverified
  hardware-specific fix was attempted.
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

The Rust-default Windows x64 migration and rollback boundary are ready for a release candidate. A
stable release should be promoted only after the packaged interactive record-to-editor-to-export
gate passes and the webcam limitation is accepted or reproduced as a separately tracked issue.
Keep the legacy pair in the package until a later evidence-based removal decision.
