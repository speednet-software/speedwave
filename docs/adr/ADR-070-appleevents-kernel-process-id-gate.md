# ADR-070: AppleEvents permission gate via `typeKernelProcessID` addressing

> **Status:** Accepted (2026-06-09)
> **Context:** The Mail/Notes native CLIs probe Automation (Apple Events) permission through `AppleEventsGate`. An earlier revision addressed the target app by bundle id and intermittently returned `procNotFound (-600)` even when the app was running and `osascript` could reach it. This ADR records why the gate resolves a PID first and addresses the target by kernel process id, and the exact OSStatus → status mapping. It complements [ADR-049](ADR-049-tcc-sub-identifiers-and-applevents-gate.md), which introduced the unified `PermissionGate` and TCC sub-identifiers.

## Decision

`AppleEventsGate.determineStatus` is two-stage:

1. **Resolve a PID first via NSWorkspace.** `NSRunningApplication.runningApplications(withBundleIdentifier:)` is consulted before any Apple Event is sent. If no running application matches, the gate short-circuits with `.targetNotRunning(bundleId:)` and never calls Apple Events — giving the user an "open the app" hint instead of a misleading `tccutil reset` suggestion.
2. **Address the target by kernel process id.** When a `pid_t` is available the `AEAddressDesc` is built with `typeKernelProcessID` (a 4-byte pid) via `AECreateDesc`, not with the bundle-id string. PID addressing is the documented future-proof Apple Events addressing scheme[^1] and avoids the `procNotFound (-600)` failure that bundle-id / process-serial-number addressing exhibits even for a running target[^2].

`AEDeterminePermissionToAutomateTarget` is always called with `askUserIfNeeded=false` first to read the actual status, then `requestAccess` re-calls it with `askUserIfNeeded=true` to trigger the TCC consent dialog. `askUserIfNeeded=true` cannot distinguish "never prompted" from "previously denied" — both surface as `errAEEventNotPermitted`[^3] — so the orchestrator (`performCheckPermission`) re-queries with `askUserIfNeeded=false` after the request as the source of truth. The orchestrator fires `requestAccess` when the initial status is `.notDetermined` **or** `.targetNotRunning`; the latter lets the gate auto-launch the target app on the active (toggle-click) path before probing again.

## OSStatus → `RawAuthorizationStatus` mapping

The mapping lives in `mapAEStatusToRaw` and is unit-tested independently of any live target:

| OSStatus                            | Value | Mapped status                  |
| ----------------------------------- | ----- | ------------------------------ |
| `noErr`                             | 0     | `.granted`                     |
| `errAEEventNotPermitted`            | -1743 | `.denied`                      |
| `errAEEventWouldRequireUserConsent` | -1744 | `.notDetermined`               |
| `procNotFound`                      | -600  | `.targetNotRunning(bundleId:)` |
| any other                           | —     | `.unknown`                     |

With the `typeKernelProcessID` scheme `procNotFound` should not occur in practice — the PID was already verified via NSWorkspace — but the case is kept as a safety net for a process that exits between the NSWorkspace lookup and the AE call.

## Why

- Bundle-id addressing requires the Apple Event Manager to map the bundle id to a live Application Serial Number through LaunchServices at call time; when that lookup misses, the call returns `procNotFound (-600)` even though the process is running and reachable by other tooling[^2]. PID addressing bypasses that resolution path[^1].
- Probing without a prior running-process check cannot tell "denied" from "app not running", producing the wrong recovery copy. Resolving the PID first makes "not running" an explicit, AE-free state.

## Where it lives in code

- Gate + PID resolver + launcher abstractions, and `mapAEStatusToRaw` — `native/macos/shared/Sources/SharedCLI/AppleEventsGate.swift`
- Orchestrator and status projection — `performCheckPermission`, `mapRawToPermissionStatus`, `composeErrorMessage` in `native/macos/shared/Sources/SharedCLI/Utilities.swift`
- CLI wiring (`--launch` toggles auto-launch on/off) — `native/macos/{mail,notes}/Sources/{Mail,Notes}CLI.swift`
- Tests — `native/macos/shared/Tests/SharedCLITests/{AppleEventsGateTests,UtilitiesTests}.swift`, `native/macos/mail/Tests/MailTests.swift`

## Rejected alternatives

- **Keep bundle-id addressing and just retry on `procNotFound`** — rejected: the failure is non-deterministic LaunchServices resolution; a retry loop neither bounds latency nor fixes the root cause. PID addressing removes the failing path entirely.
- **Drop the NSWorkspace pre-check and rely on `procNotFound` to mean "not running"** — rejected: with PID addressing `procNotFound` becomes a near-impossible edge, so the only reliable "is it running" signal is the NSWorkspace lookup itself.

[^1]: Apple Events addressing types including `typeKernelProcessID` for targeting a process by its kernel process id: https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleEvents/appendix2_aepg/appendix2_aepg.html

[^2]: AESend / Apple Events fail with `procNotFound (-600)` under process-serial-number / bundle-id addressing while a `typeKernelProcessID` (pid) return address works reliably: https://discussions.apple.com/thread/5513047

[^3]: `AEDeterminePermissionToAutomateTarget` return values - `noErr` (authorized), `errAEEventNotPermitted` (-1743, declined), `errAEEventWouldRequireUserConsent` (-1744, consent required) - and the `askUserIfNeeded` parameter: https://developer.apple.com/documentation/coreservices/3025784-aedeterminepermissiontoautomatet
