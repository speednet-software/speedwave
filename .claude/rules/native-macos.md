---
paths:
  - 'native/**'
  - 'crates/speedwave-runtime/src/mcp_os_process.rs'
  - 'crates/speedwave-runtime/src/transcription/**'
---

# Native macOS Rules (Swift OS integrations, TCC, transcription)

The native OS integrations (Mail, Calendar, Reminders, Notes) run as Swift CLIs on the host and drive first-party apps via AppleEvents; transcription is host-side Whisper. These carry invariants that are macOS-only and invisible from a Windows-only or test-only pass.

## AppleEvents permission gates

`native/macos/shared/Sources/SharedCLI/AppleEventsGate.swift` gates every automation target. Two-stage, PID-addressed:

- Resolve a PID via `NSWorkspace` first — if the app is not running, short-circuit to `.targetNotRunning` and send no Apple Event at all.
- Build the `AEAddressDesc` with **`typeKernelProcessID`** — never bundle-id or PSN addressing (intermittent `procNotFound -600`).
- After any `askUserIfNeeded=true` consent request, re-read status with `askUserIfNeeded=false` as the source of truth (`true` cannot distinguish never-prompted from denied).

Extending a Mail/Notes gate or adding a new native automation gate must keep this shape — "simplifying" back to bundle-id addressing reintroduces the non-deterministic failure.

## TCC and entitlements

- macOS entitlements plists live in `desktop/src-tauri/entitlements/` (one per restricted API: apple-events, audio-capture, calendars, node, reminders, virtualization). Add a new plist for a new restricted API — never relax an existing one. Coverage is test-guarded (`_tests/desktop/entitlements-*.bats`, `info-plist.bats`).
- Native CLI Info.plists must embed the tauri.conf.json version, correct sub-identifier, and TCC UsageDescription keys — test-guarded (`native-cli-info-plist.bats`); see alignments rules.

## Transcription

- Fully local: raw audio and transcript passes never leave the machine (see security rules — this is a privacy invariant, not just a design choice).
- One model, auto-selected from compile-time backends (`accel.rs`: CPU + Metal only on v1; CUDA/Vulkan deferred). No user model picker — do not add one.
- No speaker diarization — deliberately removed as inherently unreliable (ADR-075, which also removed sherpa-onnx and every Windows CRT workaround with it; see cross-platform rules). Do not reintroduce diarization or swap in another engine.
