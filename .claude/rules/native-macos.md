---
paths:
  - 'native/**'
  - 'crates/speedwave-runtime/src/mcp_os_process.rs'
  - 'crates/speedwave-runtime/src/transcription/**'
  - 'desktop/src-tauri/entitlements/**'
  - 'desktop/src-tauri/src/mic_permission_cmd.rs'
  - 'desktop/src-tauri/Info.plist'
  - 'mcp-servers/os/src/tools/reminder-tools.ts'
---

# Native macOS Rules (Swift OS integrations, TCC, transcription)

The native OS integrations (Mail, Calendar, Reminders, Notes) run as Swift CLIs on the host and drive first-party apps via AppleEvents; transcription is host-side Whisper. These carry invariants that are macOS-only and invisible from a Windows-only or test-only pass.

## AppleEvents permission gates

`native/macos/shared/Sources/SharedCLI/AppleEventsGate.swift` gates every automation target. Two-stage, PID-addressed:

- Resolve a PID via `NSWorkspace` first — if the app is not running, short-circuit to `.targetNotRunning` and send no Apple Event at all.
- Build the `AEAddressDesc` with **`typeKernelProcessID`** — never bundle-id or PSN addressing (intermittent `procNotFound -600`).
- After any `askUserIfNeeded=true` consent request (toggle click — triggers the TCC dialog, may auto-launch the target), re-read status with `askUserIfNeeded=false` as the source of truth. Mind the asymmetry: the silent `false` read cannot distinguish never-prompted from denied (both surface as `errAEEventWouldRequireUserConsent -1744` → notDetermined); only a `true` prompt yields a definitive denied (`errAEEventNotPermitted -1743`).

Extending a Mail/Notes gate or adding a new native automation gate must keep this shape — "simplifying" back to bundle-id addressing reintroduces the non-deterministic failure.

## TCC and entitlements

- macOS entitlements plists live in `desktop/src-tauri/entitlements/` (one per restricted API: apple-events, audio-capture, calendars, node, reminders, virtualization). Add a new plist for a new restricted API — never relax an existing one. Coverage is test-guarded: `_tests/desktop/sign-bundled-binaries.bats` parses every plist in the directory and pins the single-key shape of all but node (two keys by design) and audio-capture; `entitlements-reminders.bats`, `main-app-entitlements.bats` and `transcription-bundle.bats` pin individual plists key-by-key, plus `info-plist.bats`.
- Native CLI Info.plists must embed the tauri.conf.json version, correct sub-identifier, and TCC UsageDescription keys — test-guarded (`native-cli-info-plist.bats`); see alignments rules. The source-plist and `Package.swift` halves run everywhere, the embedded-section halves only after `make build-native-macos`.
- **Never write a native CLI `Resources/Info.plist` with `PlistBuddy -c Set`.** It rewrites the whole file and drops every XML comment, including the trailing `<!-- x-release-please-version -->` markers that release-please bumps these five plists through; the loss is silent and only shows up as a release that forgets them. `build-native-macos.sh::stamp_info_plist` edits the value in place with `sed` and reads it back with `PlistBuddy -c Print` (read-only) to fail loud on a missed key. Guard: `_tests/desktop/build-native-macos.bats`.
- **Microphone consent is requested in-process by the main Tauri app** (`mic_permission_cmd.rs`, before any capture spawn), never left to a spawned CLI: `AVCaptureDevice.requestAccess` shows no prompt from a headless helper — it silently denies, with no TCC entry to re-enable. The grant lands under `pl.speedwave.desktop` and child CLIs inherit it. The main app is therefore signed with `bundle.macOS.entitlements` (`audio-capture.plist`, guarded by `main-app-entitlements.bats`) and carries `NSMicrophoneUsageDescription` in its Info.plist.

## Reminders (EventKit)

- **Public EventKit only.** `reminders-cli` talks to `EKEventStore` and nothing else: no AppleScript, no reading the Reminders SQLite store (needs Full Disk Access), no private ReminderKit. Consequence: flags, native tags, subtasks, sections, images and smart lists are out of reach; "tags" are `[#tag]` markers inside the notes field (`combineTags`/`extractTags`/`stripTags`), parsed back into a separate `tags` array.
- **Glossary** (tool params, schemas and docs use these words): _list_ = an `EKCalendar` that holds reminders (never "calendar"); _reminder_; _tag_ = a `[#tag]` marker; _due date_ is _all-day_ (`YYYY-MM-DD`, components without time fields) or _timed_, and always _floating_ (`timeZone == nil`: 9:00 stays 9:00 in every zone); _alarm_ (not alert/notification); _recurrence_ (not repeat); _completed_.
- **Due dates go through `dueDateComponents(from:timeZone:)`/`dueDateString(from:timeZone:)`** in `RemindersCLI.swift`; `timeZone` defaults to the host zone and exists so tests pin explicit zones (CI runners sit in UTC, where an offset conversion is indistinguishable from none). Input: `YYYY-MM-DD` (all-day), `YYYY-MM-DDTHH:MM:SS` (kept as typed, never resolved through the host zone, so a DST-gap time stays what the user asked for) or the same with an offset/`Z` (converted to host wall clock); anything else, including unpadded dates and impossible dates, is rejected. The components always carry the Gregorian calendar (EventKit raises otherwise, and `Calendar.current` need not be Gregorian) and no time zone. Output: `YYYY-MM-DD` or local time with an explicit UTC offset (`+00:00`, never `Z`, via SharedCLI `iso8601String(from:timeZone:)`), plus `all_day`; `completed_date` is local time with offset. `calendar-cli` keeps its own `Date`-based model.
- **`update_reminder` is a PATCH:** an omitted field keeps its value; JSON `null` on `due_date` clears the due date and drops the recurrence rules with it (EventKit refuses a recurring reminder without a due date). `notes` and `tags` share one EventKit field; `mergeNotes` replaces only the side the caller sent and keeps the other byte-for-byte (`tags: []` clears tags); `completed: false` reopens. A `list_id` that names several lists is refused (`CLIError.ambiguous`), never resolved to the first match.

## Transcription

- Fully local: raw audio and transcript passes never leave the machine (see security rules — this is a privacy invariant, not just a design choice).
- Models are auto-selected per pass from the runtime GPU class (`accel.rs`: Metal on macOS, Vulkan on Windows — ADR-085; CUDA deferred). No user model picker — do not add one. macOS asserts `GpuClass::Discrete` rather than probing; a Metal init failure falls back inside whisper.cpp (visible in logs via the routed whisper hooks).
- No speaker diarization — deliberately removed as inherently unreliable (ADR-075, which also removed sherpa-onnx and every Windows CRT workaround with it; see cross-platform rules). Do not reintroduce diarization or swap in another engine.
