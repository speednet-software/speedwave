# ADR-048: TCC sub-identifiers and unified AppleEvents permission gate for native macOS CLIs

## Status

Accepted (2026-05-06).

## Context

Speedwave ships four native macOS CLI binaries that integrate with
TCC-protected APIs:

| CLI | Mechanism | TCC service |
|---|---|---|
| `calendar-cli` | EventKit (`requestFullAccessToEvents`) | `Calendar` |
| `reminders-cli` | EventKit (`requestFullAccessToReminders`) | `Reminders` |
| `mail-cli` | Apple Events (`AEDeterminePermissionToAutomateTarget`) | `AppleEvents` |
| `notes-cli` | Apple Events (`AEDeterminePermissionToAutomateTarget`) | `AppleEvents` |

Three problems compounded into a hard-to-diagnose UX failure for Calendar
on macOS 14+ and a less-obvious permission UX gap for Mail / Notes:

### Problem 1 — Calendar TCC silent reject on macOS 14+

`EKEventStore.requestFullAccessToEvents` on macOS 14+ rigorously requires
`NSCalendarsFullAccessUsageDescription` in the **calling process's** `Info.plist`.
When the API cannot find that key, it returns `granted=false` immediately
*without* showing the consent dialog.[^1]

Speedwave's `calendar-cli` is a stand-alone CLI binary spawned by the parent
`.app` via `posix_spawn`. The parent's `Info.plist` (with all the TCC usage
descriptions) does not propagate across the spawn boundary because the child
is a separate process with its own `code signature identifier`. With no
embedded `__TEXT,__info_plist` section in the binary, EventKit silently
rejects.

`reminders-cli` uses the same EventKit pattern but `requestFullAccessToReminders`
is historically more permissive and silently grants on the same setup —
masking the underlying defect for Reminders while Calendar fails.[^2]

### Problem 2 — TCC binds to the wrong identifier

`codesign` defaults the identifier to the binary basename (e.g.
`calendar-cli`). The `tccutil reset Calendar pl.speedwave.desktop` command
in the troubleshooting docs does not clear a row keyed by `calendar-cli`,
so users following the documentation could not actually recover from a
denied state.

### Problem 3 — Mail / Notes use a different, weaker permission API

`mail-cli` and `notes-cli` historically used a synchronous AppleScript probe
through `osascript` and inferred granted/denied from the script's exit code.
That approach:

- Cannot distinguish *previously denied* from *prompt never appeared* from
  *target app not running* — all three look like "the script failed".
- Produces error messages without recovery guidance (no `tccutil reset`
  hint, no "open Mail.app" hint).
- Is inconsistent with the rich, status-aware error messages calendar / reminders
  produce.

The 4 integrations needed unified handling so a user's experience does not
depend on which integration they happen to enable first.

## Decision

Three changes, applied uniformly to all four native CLIs.

### 1. Embed `Info.plist` directly into each CLI's Mach-O

Each `Package.swift` adds `linkerSettings.unsafeFlags` with
`-sectcreate __TEXT __info_plist Resources/Info.plist`,[^3] which embeds the
package's `Info.plist` into the resulting binary's `__TEXT,__info_plist`
section.[^4] The build script (`scripts/build-native-macos.sh`) stamps the
app version from `desktop/src-tauri/tauri.conf.json` into each plist before
building, keeping the SSOT alignment between bundle and helper binaries.

The embedded plist carries:

- `CFBundleIdentifier=pl.speedwave.desktop.<service>` — the new sub-identifier
- `CFBundleExecutable`, `CFBundleName`, `CFBundleShortVersionString`
- `NS<Service>FullAccessUsageDescription` (Calendar / Reminders) or
  `NSAppleEventsUsageDescription` (Mail / Notes)

### 2. Sub-identifier scheme `pl.speedwave.desktop.<service>`

`SharedCLI/Utilities.swift` adds `subBundleIdentifier(for:)` and
`tccServiceName(for:)`, both consumed by `composeErrorMessage` so every error
message recommends the *correct* `tccutil reset` command. A new
`scripts/sign-bundled-binaries.sh::verify_identifier` step asserts that
`codesign -dvvv` reports the expected sub-identifier post-signing, catching
drift between Swift code, build, and signing.

### 3. Unified `PermissionGate` protocol with two concrete implementations

A new `RawAuthorizationStatus` enum is the canonical type produced by both
gates:

```swift
enum RawAuthorizationStatus {
    case granted, denied, restricted, notDetermined
    case writeOnly                            // EventKit-only (Calendar)
    case targetNotRunning(bundleId: String)   // AE-only (procNotFound -600)
    case unknown                              // unmapped @unknown / OSStatus
}
```

`EventStoreGate` (calendar / reminders) maps `EKAuthorizationStatus` to it.
`AppleEventsGate` (mail / notes) maps `AEDeterminePermissionToAutomateTarget`
OSStatus values:[^5]

| OSStatus | Constant | Mapping |
|---|---|---|
| `0` | `noErr` | `.granted` |
| `-1743` | `errAEEventNotPermitted` | `.denied` |
| `-1744` | `errAEEventWouldRequireUserConsent` | `.notDetermined` |
| `-600` | `procNotFound` | `.targetNotRunning(bundleId:)` |
| other | — | `.unknown` |

Both gates flow through a single `performCheckPermission` orchestrator.
`AppleEventsGate` additionally implements the optional `verifyDataAccess()`
hook, which runs the legacy AppleScript probe as a second phase when TCC
reports `.granted` — this preserves the v1 invariant that Mail / Notes
permission checks accessed *real data*, not just the app name. If TCC says
granted but data access fails, the result is downgraded to `.silentReject`
with the underlying probe error attached.

### 4. Auto-validation at startup

A new `validate_os_integrations_on_startup` Tauri command iterates every
service in `TOGGLEABLE_OS_SERVICES` that the active project has
`enabled=true`, calls `check_os_permission`, and auto-disables the toggle
in config if the permission no longer holds. The Angular component renders
a one-time amber banner listing the auto-disabled services and the recovery
text from `composeErrorMessage`.

This is the migration path for users upgrading across the
embedded-Info.plist boundary: the prior TCC.db row was bound to `<svc>-cli`
(the codesign default identifier); the new build's row is bound to
`pl.speedwave.desktop.<service>`. Without auto-validation, the config would
say `enabled=true` but the integration would silently fail at use time.

## Rejected alternatives

### A. Single shared `pl.speedwave.desktop` identifier for all CLIs

Tempting because the troubleshooting docs already used that string. Rejected:
codesign verifies the identifier against the embedded `Info.plist`, and
having four independently-signed Mach-Os claiming the same `CFBundleIdentifier`
as the parent `.app` confuses TCC bookkeeping (which expects unique identifier
per code-signed unit). Sub-identifiers (Apple's standard convention for
helper tools) keep the parent `.app` and each helper distinct.

### B. Re-use `EKAuthorizationStatus` for the AE gate (`PermissionGate.authorizationStatus -> EKAuthorizationStatus`)

Considered when the `RawAuthorizationStatus` enum was introduced. Rejected
because `EKAuthorizationStatus` has no slot for `procNotFound`, forcing a
lossy mapping (probably `.denied`) that produces the wrong recovery text
("run `tccutil reset`") for what is actually a target-app-not-running
problem.

### C. Two parallel orchestrators (one per API)

Keeping `performCheckPermission` for EventKit and adding
`performAutomationCheckPermission` for Apple Events. Rejected: the
state machine (initial-status check → request → re-query post-status) is
identical between the two APIs; duplicating it invites drift (a fix to one
orchestrator silently bypasses the other). Option C (the chosen design)
funnels both through one orchestrator with a `RawAuthorizationStatus` seam
at the protocol layer.

### D. Drop the AppleScript data-access probe in mail / notes

Tempting for KISS. Rejected because the v1 test
`testPermissionCheckScriptAccessesData` deliberately verifies the probe
accesses *real* data (mailboxes / notes), not just app metadata. Apple has
historically had regressions where TCC `.granted` did not imply readable
data (sandbox edge cases, Mail data protection); preserving the second-phase
probe as `gate.verifyDataAccess()` keeps the invariant.

## Migration

Existing users who previously granted Calendar / Reminders / Mail / Notes
permission will see the auto-disable banner once on first launch after the
upgrade. One click on the toggle re-triggers the consent dialog (now bound
to the new sub-identifier), one *Allow* click finishes the migration.

The legacy TCC.db rows under `calendar-cli`, `reminders-cli`, `mail-cli`,
`notes-cli` linger but are harmless — they are not consulted for the new
binaries. Users with extreme cleanliness preferences can run:

```bash
tccutil reset Calendar calendar-cli
tccutil reset Reminders reminders-cli
tccutil reset AppleEvents mail-cli
tccutil reset AppleEvents notes-cli
```

after the migration. This is documented in `docs/troubleshooting.md`.

## Consequences

### Positive

- Calendar TCC prompt now appears reliably on macOS 14+ (the original bug).
- All four integrations share one error-message vocabulary; recovery text
  is consistently a `tccutil reset` command that actually targets the right
  TCC.db row.
- Mail / Notes get the same `targetNotRunning` clarity as Calendar / Reminders'
  `silentReject`/`writeOnly` — no more silent failures masked by
  AppleScript exit codes.
- `procNotFound` no longer recommends `tccutil reset` (which would not help)
  and instead tells the user to open the target app.

### Negative

- One-time re-prompt for existing users (mitigated by the auto-disable
  banner explaining what to do).
- New `RawAuthorizationStatus` enum is a new public type in `SharedCLI`. No
  out-of-tree consumers exist today; one-time breaking change for any
  hypothetical future consumer.
- Each CLI now has a `Resources/Info.plist` SSOT — drift between this file
  and the codesign step would silently bind TCC to the wrong identifier.
  Mitigated by `_tests/desktop/native-cli-info-plist.bats` which verifies
  the embedded plist's `CFBundleIdentifier`, `CFBundleExecutable`, version,
  and usage description for every CLI on every build.

### Neutral

- `mapAuthorizationStatus(_ raw: EKAuthorizationStatus) -> PermissionStatus`
  is kept (unchanged) for backward compatibility with direct callers and
  the 55 existing SharedCLI tests; it is no longer on the
  `performCheckPermission` hot path but remains a public API.

## Verification

- `_tests/desktop/native-cli-info-plist.bats` — embedded plist contents
  per CLI (CFBundleIdentifier, version, usage description, linker flags
  in Package.swift)
- `_tests/desktop/sign-bundled-binaries.bats` — `verify_identifier` is
  invoked for each native CLI, sub-identifier mapping covers all 4 services
- `native/macos/shared/Tests/SharedCLITests/UtilitiesTests.swift` —
  RawAuthorizationStatus mapping, sub-identifier text in composeErrorMessage,
  performCheckPermission with verifyDataAccess and targetNotRunning paths
- `native/macos/{mail,notes}/Tests/{Mail,Notes}Tests.swift` — AppleEventsGate
  end-to-end through performCheckPermission for granted / denied /
  targetNotRunning / silentReject / dataAccessFailure
- `desktop/src-tauri/src/integrations_cmd.rs` tests — parse_permission_output
  handles sub-identifier and AppleEvents-service strings, validate command
  short-circuits on non-macOS
- `desktop/src/src/app/integrations/integrations.component.spec.ts` —
  banner appears for auto-disabled services, dismiss works, validator
  errors are non-fatal

## Sources

[^1]: Apple Developer Documentation, *requestFullAccessToEvents(completion:)* —
    "An app must include the [`NSCalendarsFullAccessUsageDescription`](https://developer.apple.com/documentation/bundleresources/information_property_list/nscalendarsfullaccessusagedescription)
    key in its Info.plist file. The system uses this value when alerting the
    user." Accessed 2026-05-06 from
    <https://developer.apple.com/documentation/eventkit/ekeventstore/4162272-requestfullaccesstoevents>.

[^2]: WWDC 2023 session 10052, *Discover Calendar and EventKit* — Apple
    explicitly hardened the Calendar full-access path in macOS 14, including
    enforcement of usage-description requirements that Reminders does not
    apply with the same strictness. Accessed 2026-05-06 from
    <https://developer.apple.com/videos/play/wwdc2023/10052/>.

[^3]: Pol Piella Abadia, *Adding an Info.plist file to a Swift executable*
    (2024) — canonical SwiftPM pattern for embedding `Info.plist` via
    `linkerSettings.unsafeFlags` with `-sectcreate __TEXT __info_plist`.
    Accessed 2026-05-06 from <https://www.polpiella.dev/info-plist-swift-cli/>.

[^4]: Adam Wulf, *Embedded command line tool in Mac App Store app* (2023) —
    discusses Xcode's `CREATE_INFOPLIST_SECTION_IN_BINARY` build setting
    which performs the equivalent of the SwiftPM `-sectcreate` linker flag.
    Accessed 2026-05-06 from
    <https://adamwulf.me/2023/04/embedded-command-line-tool-in-mac-app-store-app/>.

[^5]: Felix Schwarz, *New Apple Event APIs in macOS Mojave* (2018-08) —
    documents the `AEDeterminePermissionToAutomateTarget` OSStatus return
    values: `noErr` / `errAEEventNotPermitted` (-1743) /
    `errAEEventWouldRequireUserConsent` (-1744) / `procNotFound` (-600), and
    the known limitation that `askUserIfNeeded=true` cannot distinguish
    "never prompted" from "previously denied". Accessed 2026-05-06 from
    <https://www.felix-schwarz.org/blog/2018/08/new-apple-event-apis-in-macos-mojave>.
