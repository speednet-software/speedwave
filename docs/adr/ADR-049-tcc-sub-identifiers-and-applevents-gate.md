# ADR-049: TCC sub-identifiers and unified AppleEvents permission gate for native macOS CLIs

> **Status:** Accepted (2026-05-06), amended 2026-10-23
> **Context:** Speedwave's four native macOS helper CLIs (calendar, reminders, mail, notes) hit TCC-protected APIs but were silently mis-keyed and inconsistently handled.

## Decision

Apply three uniform changes to all four native macOS CLIs so their permission UX is consistent and TCC bookkeeping is correct:

1. Embed each CLI's `Info.plist` directly into its Mach-O via a SwiftPM `-sectcreate __TEXT __info_plist` linker flag, so the calling process carries its own usage-description keys and bundle identifier across the `posix_spawn` boundary from the parent `.app`.
2. Give each helper a distinct sub-identifier `pl.speedwave.desktop.<service>`, and make every error message recommend the `tccutil reset` command that actually targets the correct TCC.db row.
3. Replace the ad-hoc AppleScript exit-code probe (mail / notes) with a unified `PermissionGate` protocol and a canonical `RawAuthorizationStatus` enum, so EventKit and Apple Events flow through one orchestrator with status-aware recovery messages.

## Why

- On macOS 14+, `requestFullAccessToEvents` returns `granted=false` without a dialog unless `NSCalendarsFullAccessUsageDescription` is in the _calling process's_ `Info.plist`[^1]. A spawned CLI without an embedded plist silently rejected — the original Calendar bug. Reminders happened to grant on the same broken setup, masking the defect.
- `codesign` defaults the identifier to the binary basename (`calendar-cli`)[^2], so a documented `tccutil reset Calendar pl.speedwave.desktop` cleared the wrong row and users could not recover from a denied state.
- The old AppleScript probe for mail / notes could not distinguish previously-denied from never-prompted from target-app-not-running — all three looked like "the script failed", with no recovery guidance.
- A unified gate means a user's experience does not depend on which integration they enable first. `procNotFound` now tells the user to open the target app instead of recommending an unhelpful `tccutil reset`.

## Migration

This is described here, not in another ADR. The legacy TCC.db rows were keyed by the codesign-default basename (`calendar-cli` etc.); the new build keys them by `pl.speedwave.desktop.<service>`. So existing users who already granted permission will, on first launch after upgrade, see a one-time amber banner listing services that were auto-disabled because their old grant no longer applies; one toggle click re-triggers the consent dialog (now bound to the new sub-identifier) and one _Allow_ finishes the migration. The stale `<svc>-cli` rows linger harmlessly and are not consulted for the new binaries; the cleanup-minded can clear them with `tccutil reset <Service> <svc>-cli` per service. The startup reconciliation that drives this is `validate_os_integrations_on_startup` (whose doc comment also points back to this ADR).

## Where it lives in code

- Sub-identifier + TCC-service mapping and error text — `subBundleIdentifier(for:)`, `tccServiceName(for:)`, `composeErrorMessage` in `native/macos/shared/Sources/SharedCLI/Utilities.swift`
- Canonical status enum + Apple Events OSStatus mapping (`noErr`→granted, `errAEEventNotPermitted` -1743→denied, `errAEEventWouldRequireUserConsent` -1744→notDetermined, `procNotFound` -600→targetNotRunning, else unknown)[^3] and the second-phase data-access probe — `native/macos/shared/Sources/SharedCLI/AppleEventsGate.swift`. The `typeKernelProcessID` addressing that backs the `procNotFound` fix is detailed in [ADR-070](ADR-070-appleevents-kernel-process-id-gate.md).
- Per-CLI embedded plists and `-sectcreate` linker flag — `native/macos/{calendar,reminders,mail,notes}/Resources/Info.plist` and each `Package.swift`
- Build-time version stamping from git (`crates/speedwave-version`, `SPEEDWAVE_VERSION` env override) — `scripts/build-native-macos.sh`
- Post-sign identifier assertion — `verify_identifier` in `scripts/sign-bundled-binaries.sh`
- Startup auto-validation Tauri command (iterates `TOGGLEABLE_OS_SERVICES`, auto-disables stale toggles) — `validate_os_integrations_on_startup` in `desktop/src-tauri/src/integrations_cmd.rs`; OS-service list SSOT is `speedwave_runtime::consts::TOGGLEABLE_OS_SERVICES`
- Auto-disable banner UI — `desktop/src/src/app/integrations/integrations.component.ts`
- Tests — `_tests/desktop/native-cli-info-plist.bats` (identifier, executable and version of the embedded plist); the sub-identifier check in `sign-bundled-binaries.sh`'s `verify_identifier` has no bats coverage, manual alignment; `native/macos/shared/Tests/SharedCLITests/UtilitiesTests.swift`, `native/macos/{mail,notes}/Tests/{Mail,Notes}Tests.swift`, `desktop/src/src/app/integrations/integrations.component.spec.ts`

## Rejected alternatives

- **Single shared `pl.speedwave.desktop` identifier for all CLIs** — rejected: four independently-signed Mach-Os claiming the same identifier as the parent `.app` confuses TCC, which expects one identifier per code-signed unit. Sub-identifiers (Apple's helper-tool convention[^4]) keep each helper distinct.
- **Re-use `EKAuthorizationStatus` for the Apple Events gate** — rejected: it has no slot for `procNotFound`, forcing a lossy mapping to `.denied` that produces the wrong recovery text for a target-app-not-running situation.
- **Two parallel orchestrators (one per API)** — rejected: the initial-status / request / re-query state machine is identical across both APIs; duplicating it invites drift where a fix to one bypasses the other. One orchestrator with a `RawAuthorizationStatus` seam was chosen instead.
- **Drop the AppleScript data-access probe in mail / notes** — rejected: a TCC `.granted` does not always imply readable data (historical sandbox / Mail data-protection regressions); keeping the second-phase probe as `verifyDataAccess()` preserves the v1 invariant that the check touches real data.

## Amendment (2026-10-23): TCC decides every helper as the Desktop app

**Context.** TCC does not decide a helper's request on the helper's own identity. It looks for the responsible code, the nearest parent process the user knows about[^5], and a spawned process inherits its parent's responsibility unless it is started with `responsibility_spawnattrs_setdisclaim`[^6]. The Desktop app spawns every helper, directly (`integrations_cmd.rs`) or through mcp-os (`host_mcp_process`), so tccd decides each Calendar, Reminders and Apple Events request as `pl.speedwave.desktop` (`AUTHREQ_SUBJECT: subject=pl.speedwave.desktop`). Under the hardened runtime tccd also refuses to prompt when that responsible process lacks the service's resource-access entitlement (`Prompting policy for hardened runtime; service: kTCCServiceCalendar requires entitlement com.apple.security.personal-information.calendars but it is missing for responsible=…`). The app was signed with `com.apple.security.device.audio-input` only, so Calendar, Notes and, on a Mac without an earlier grant, Mail ended as `silentReject` on every signed release since v0.7.2 (2026-04-15). Measured on macOS 27.0.1 with the shipped helpers under a hardened-runtime parent spawned as its own responsible process, and confirmed on a Developer ID build carrying the entitlements. Three premises above do not hold:

- The sub-identifier keys no TCC row. Grants are stored under `pl.speedwave.desktop`, and `tccutil reset <Service> pl.speedwave.desktop.<entity>` fails with `No such bundle identifier` (OSStatus -10814), since a helper is a bare executable, not an app bundle; `tccutil reset Calendar pl.speedwave.desktop` removes the grant.
- The helper's own entitlement is not consulted while the app is its responsible process: a helper without any entitlement, under a parent holding it, was not refused.
- "Reminders happened to grant on the same broken setup": Reminders are not gated by the hardened runtime. Apple's resource-access list has no reminders entitlement[^7], and neither does tccd.

**Decision.**

- The Desktop app carries the resource-access entitlement of every gated service its helpers use: `desktop/src-tauri/entitlements/main-app.plist` holds `device.audio-input`, `personal-information.calendars` and `automation.apple-events`, never a helper's single-capability plist. A helper that starts using another gated service adds its key there.
- Every message that leads the user back to access (`composeErrorMessage` in `native/macos/shared/Sources/SharedCLI/Utilities.swift`) names the System Settings pane (Calendars, Reminders, or Automation for Mail and Notes) and `tccutil reset <Service> pl.speedwave.desktop`. A reset of `AppleEvents` covers every app Speedwave controls, and the message says so.
- `silentReject` no longer advises a reinstall. Once the entitlements ship it usually means the user clicked Don't Allow: the Apple Events gate's passive read cannot tell a refusal from a missing decision, and EventKit can keep answering `notDetermined` in the process that has just asked. The message gives the same steps and asks for a bug report only when no dialog appeared.
- `performCheckPermission` trusts a granted request whose post-status still reads `notDetermined` (seen on three of four first grants); an explicit `denied`, `restricted` or `writeOnly` post-status still wins.
- The helpers keep their sub-identifiers as code-signing identifiers (`verify_identifier` in `scripts/sign-bundled-binaries.sh`) and their embedded `Info.plist`, which EventKit reads in the calling process[^1]. `subBundleIdentifier(for:)` and `resolvedBundleIdentifier()` are removed.

**Consequences.**

- A grant is shared by every process the Desktop app spawns. Once the user lets Speedwave use Calendar or control Mail, mcp-os, the helpers and any other child the app starts can do the same without a new prompt. The per-helper isolation the sub-identifiers suggested never existed; a helper would need `responsibility_spawnattrs_setdisclaim`, a private API that the Node `execFile` path in mcp-os cannot pass, to get a TCC identity of its own.
- A grant already stored in TCC wins over the prompting policy, so a Mac that granted access earlier keeps working on older builds while a fresh install gets Calendar, Notes and Mail only from a build with the entitlements.
- The dev path never meets the check: `make dev` builds a binary without the hardened runtime, and a helper started from a terminal (`swift test`, `LiveMailTests`) makes the terminal responsible. A TCC change is verified on a signed build started from Finder, or under a hardened-runtime parent spawned as its own responsible process.

[^1]: [NSCalendarsFullAccessUsageDescription | Apple Developer Documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsfullaccessusagedescription) - the usage-description key EventKit requires, in the calling process's `Info.plist`, before granting full calendar access.

[^2]: [codesign(1) man page (mirror)](https://ss64.com/mac/codesign.html) - `-i, --identifier`: "If this option is omitted, the identifier is derived from either the Info.plist (if present), or the filename of the executable being signed."

[^3]: [Felix Schwarz: "macOS Mojave gets new APIs around AppleEvent sandboxing"](https://www.felix-schwarz.org/blog/2018/08/new-apple-event-apis-in-macos-mojave) - documents `errAEEventNotPermitted` (-1743), `errAEEventWouldRequireUserConsent` (-1744), and `procNotFound` (-600) as the OSStatus values returned by the Apple Events automation-permission check.

[^4]: [SMJobBless(_:_:_:_:) | Apple Developer Documentation](<https://developer.apple.com/documentation/servicemanagement/smjobbless(_:_:_:_:)>) - privileged-helper-tool identifiers are reverse-DNS labels distinct from, and scoped under, the parent app's identifier.

[^5]: [tccd reports Apple Events entitlement check error, despite a process having it - Apple Developer Forums](https://developer.apple.com/forums/thread/751802) - Apple DTS: "When a process makes a request, TCC tries to find the responsible code, that is, the nearest 'parent' of the process that the user knows about", so the container app needs the entitlement and the usage description too.

[^6]: [The Curious Case of the Responsible Process - Qt blog (2022-02-04)](https://www.qt.io/blog/the-curious-case-of-the-responsible-process) - "permissions are inherited by child processes"; a spawn attribute set with `responsibility_spawnattrs_setdisclaim` makes the child "responsible for its own permissions".

[^7]: [Hardened Runtime - Apple Developer Documentation](https://developer.apple.com/documentation/security/hardened-runtime) - the Resource Access entitlements are audio input, camera, location, address book, calendars, photos library and Apple Events; none covers Reminders.
