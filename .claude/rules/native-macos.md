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

- macOS entitlements plists live in `desktop/src-tauri/entitlements/` (one per restricted API: apple-events, audio-capture, calendars, node, reminders, virtualization). Add a new plist for a new restricted API — never relax an existing one. The single-key shape of each plist (two keys for node, by design) and the mapping from plist to binary are a manual alignment (`.claude/rules/alignments.md`); `_tests/desktop/sign-bundled-binaries.bats` and `_tests/desktop/native-cli-info-plist.bats` only check that signing and the embedded identifiers behave correctly, not the plist content itself.
- Native CLI Info.plists must embed the computed app version (`SPEEDWAVE_VERSION`, from `crates/speedwave-version` or the env override — see `build-native-macos.sh`), correct sub-identifier, and TCC UsageDescription keys. The embedded version is test-guarded (`native-cli-info-plist.bats`, macOS-only, runs only after `make build-native-macos`); the source `Info.plist`/`Package.swift` content is a manual alignment.
- **No build step writes a native CLI `Resources/Info.plist`.** `build-native-macos.sh::stage_info_plist` copies it to `native/macos/<pkg>/.build/Info.plist` with the version substituted by `sed`, reads the copy back with `PlistBuddy -c Print` (read-only) to fail loud on a missed key, and each `Package.swift` embeds that copy with `-sectcreate`. A bare `swift build`/`swift test` therefore needs `build-native-macos.sh --stage-only` first; `make build-native-macos` and `make test-swift` do it. Guard: `_tests/desktop/build-native-macos.bats` (clean `git status` after staging).
- **Microphone consent is requested in-process by the main Tauri app** (`mic_permission_cmd.rs`, before any capture spawn), never left to a spawned CLI: `AVCaptureDevice.requestAccess` shows no prompt from a headless helper — it silently denies, with no TCC entry to re-enable. The grant lands under `pl.speedwave.desktop` and child CLIs inherit it. The main app is therefore signed with `bundle.macOS.entitlements` (`audio-capture.plist`, manual alignment) and carries `NSMicrophoneUsageDescription` in its Info.plist.

## Reminders (EventKit)

- **Public EventKit only.** `reminders-cli` talks to `EKEventStore` and nothing else: no AppleScript, no reading the Reminders SQLite store (needs Full Disk Access), no private ReminderKit. Consequence: flags, native tags, subtasks, sections, images and smart lists are out of reach; "tags" are `[#tag]` markers inside the notes field (`combineTags`/`extractTags`/`stripTags`), parsed back into a separate `tags` array.
- **Glossary** (tool params, schemas and docs use these words): _list_ = an `EKCalendar` that holds reminders (never "calendar"); _reminder_; _tag_ = a `[#tag]` marker; _due date_ is _all-day_ (`YYYY-MM-DD`, components without time fields) or _timed_, and always _floating_ (`timeZone == nil`: 9:00 stays 9:00 in every zone); _alarm_ (not alert/notification); _recurrence_ (not repeat); _completed_.
- **Due dates go through `dueDateComponents(from:timeZone:)`/`dueDateString(from:timeZone:)`** in `RemindersCLI.swift`; `timeZone` defaults to the host zone and exists so tests pin explicit zones (CI runners sit in UTC, where an offset conversion is indistinguishable from none). Input: `YYYY-MM-DD` (all-day), `YYYY-MM-DDTHH:MM:SS` (kept as typed, never resolved through the host zone, so a DST-gap time stays what the user asked for) or the same with an offset/`Z` (converted to host wall clock); anything else, including unpadded dates and impossible dates, is rejected. The components always carry the Gregorian calendar (EventKit raises otherwise, and `Calendar.current` need not be Gregorian) and no time zone. Output: `YYYY-MM-DD` or local time with an explicit UTC offset (`+00:00`, never `Z`, via SharedCLI `iso8601String(from:timeZone:)`), plus `all_day`; `completed_date` is local time with offset.
- **One date parser for both EventKit CLIs:** SharedCLI `parseISODateInput` classifies input as a bare day, a wall-clock time or an instant (strict, zero-padded, impossible dates rejected). Reminders map it to floating components (above); `calendar-cli` resolves it with `eventDate(from:timeZone:)`: a bare day is local midnight, a wall-clock time is local time, an instant is kept. Event output stays UTC with `Z`. `parseISO8601` accepts instants only: its old bare-date fallback turned `2026-06-15` into UTC midnight, which is the previous evening west of UTC, so never route a bare day through it.
- **`update_reminder` is a PATCH:** an omitted field keeps its value; JSON `null` on `due_date` clears the due date and drops the recurrence rules with it (EventKit refuses a recurring reminder without a due date). `notes` and `tags` share one EventKit field; `mergeNotes` replaces only the side the caller sent and keeps the other byte-for-byte (`tags: []` clears tags); `completed: false` reopens. A `list_id` that names several lists is refused (`CLIError.ambiguous`), never resolved to the first match; the same SharedCLI `resolveSingleCalendar` guards the target calendar of `create_event`. Listing (`list_reminders`, `list_events`) still merges every calendar a shared name matches.

## Transcription

- Fully local: raw audio and transcript passes never leave the machine (see security rules — this is a privacy invariant, not just a design choice).
- Models are auto-selected per pass from the runtime GPU class (`accel.rs`: Metal on macOS, Vulkan on Windows — ADR-085; CUDA deferred). No user model picker — do not add one. macOS asserts `GpuClass::Discrete` rather than probing; a Metal init failure falls back inside whisper.cpp (visible in logs via the routed whisper hooks).
- Speaker diarization is one optional mode with fixed invariants (ADR-097, amending ADR-075): off by default behind the Settings switch, offline pass only, `System` channel only (microphone segments stay "You", a mono recording is never diarized), one model (`model_catalog.rs::DIARIZATION_MODEL`, no picker), no embeddings or voice profiles on disk, and a failure leaves a complete transcript without labels. The engine is the vendored whisper.cpp code in `crates/speedwave-runtime/native/whisper-diarization/` on the ggml Whisper already links; never bring back sherpa-onnx, onnxruntime or any engine with its own native runtime, which is what ADR-075 removed together with the Windows CRT workarounds (cross-platform rules).
