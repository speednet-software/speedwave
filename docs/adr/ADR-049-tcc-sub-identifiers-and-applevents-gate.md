# ADR-049: TCC sub-identifiers and unified AppleEvents permission gate for native macOS CLIs

> **Status:** Accepted (2026-05-06)
> **Context:** Speedwave's four native macOS helper CLIs (calendar, reminders, mail, notes) hit TCC-protected APIs but were silently mis-keyed and inconsistently handled.

## Decision

Apply three uniform changes to all four native macOS CLIs so their permission UX is consistent and TCC bookkeeping is correct:

1. Embed each CLI's `Info.plist` directly into its Mach-O via a SwiftPM `-sectcreate __TEXT __info_plist` linker flag, so the calling process carries its own usage-description keys and bundle identifier across the `posix_spawn` boundary from the parent `.app`.
2. Give each helper a distinct sub-identifier `pl.speedwave.desktop.<service>`, and make every error message recommend the `tccutil reset` command that actually targets the correct TCC.db row.
3. Replace the ad-hoc AppleScript exit-code probe (mail / notes) with a unified `PermissionGate` protocol and a canonical `RawAuthorizationStatus` enum, so EventKit and Apple Events flow through one orchestrator with status-aware recovery messages.

## Why

- On macOS 14+, `requestFullAccessToEvents` returns `granted=false` without a dialog unless `NSCalendarsFullAccessUsageDescription` is in the _calling process's_ `Info.plist`. A spawned CLI without an embedded plist silently rejected — the original Calendar bug. Reminders happened to grant on the same broken setup, masking the defect.
- `codesign` defaults the identifier to the binary basename (`calendar-cli`), so a documented `tccutil reset Calendar pl.speedwave.desktop` cleared the wrong row and users could not recover from a denied state.
- The old AppleScript probe for mail / notes could not distinguish previously-denied from never-prompted from target-app-not-running — all three looked like "the script failed", with no recovery guidance.
- A unified gate means a user's experience does not depend on which integration they enable first. `procNotFound` now tells the user to open the target app instead of recommending an unhelpful `tccutil reset`.

## Migration

This is described here, not in another ADR. The legacy TCC.db rows were keyed by the codesign-default basename (`calendar-cli` etc.); the new build keys them by `pl.speedwave.desktop.<service>`. So existing users who already granted permission will, on first launch after upgrade, see a one-time amber banner listing services that were auto-disabled because their old grant no longer applies; one toggle click re-triggers the consent dialog (now bound to the new sub-identifier) and one _Allow_ finishes the migration. The stale `<svc>-cli` rows linger harmlessly and are not consulted for the new binaries; the cleanup-minded can clear them with `tccutil reset <Service> <svc>-cli` per service (documented in `docs/troubleshooting.md`). The startup reconciliation that drives this is `validate_os_integrations_on_startup` (whose doc comment also points back to this ADR).

## Where it lives in code

- Sub-identifier + TCC-service mapping and error text — `subBundleIdentifier(for:)`, `tccServiceName(for:)`, `composeErrorMessage` in `native/macos/shared/Sources/SharedCLI/Utilities.swift`
- Canonical status enum + Apple Events OSStatus mapping (`noErr`→granted, `errAEEventNotPermitted` -1743→denied, `errAEEventWouldRequireUserConsent` -1744→notDetermined, `procNotFound` -600→targetNotRunning, else unknown) and the second-phase data-access probe — `native/macos/shared/Sources/SharedCLI/AppleEventsGate.swift`. The `typeKernelProcessID` addressing that backs the `procNotFound` fix is detailed in [ADR-069](ADR-069-appleevents-kernel-process-id-gate.md).
- Per-CLI embedded plists and `-sectcreate` linker flag — `native/macos/{calendar,reminders,mail,notes}/Resources/Info.plist` and each `Package.swift`
- Build-time version stamping from `desktop/src-tauri/tauri.conf.json` — `scripts/build-native-macos.sh`
- Post-sign identifier assertion — `verify_identifier` in `scripts/sign-bundled-binaries.sh`
- Startup auto-validation Tauri command (iterates `TOGGLEABLE_OS_SERVICES`, auto-disables stale toggles) — `validate_os_integrations_on_startup` in `desktop/src-tauri/src/integrations_cmd.rs`; OS-service list SSOT is `speedwave_runtime::consts::TOGGLEABLE_OS_SERVICES`
- Auto-disable banner UI — `desktop/src/src/app/integrations/integrations.component.ts`
- Tests — `_tests/desktop/native-cli-info-plist.bats`, `_tests/desktop/sign-bundled-binaries.bats`, `native/macos/shared/Tests/SharedCLITests/UtilitiesTests.swift`, `native/macos/{mail,notes}/Tests/{Mail,Notes}Tests.swift`, `desktop/src/src/app/integrations/integrations.component.spec.ts`

## Rejected alternatives

- **Single shared `pl.speedwave.desktop` identifier for all CLIs** — rejected: four independently-signed Mach-Os claiming the same identifier as the parent `.app` confuses TCC, which expects one identifier per code-signed unit. Sub-identifiers (Apple's helper-tool convention) keep each helper distinct.
- **Re-use `EKAuthorizationStatus` for the Apple Events gate** — rejected: it has no slot for `procNotFound`, forcing a lossy mapping to `.denied` that produces the wrong recovery text for a target-app-not-running situation.
- **Two parallel orchestrators (one per API)** — rejected: the initial-status / request / re-query state machine is identical across both APIs; duplicating it invites drift where a fix to one bypasses the other. One orchestrator with a `RawAuthorizationStatus` seam was chosen instead.
- **Drop the AppleScript data-access probe in mail / notes** — rejected: a TCC `.granted` does not always imply readable data (historical sandbox / Mail data-protection regressions); keeping the second-phase probe as `verifyDataAccess()` preserves the v1 invariant that the check touches real data.
