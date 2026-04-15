#!/usr/bin/env bats
# Static checks on desktop/src-tauri/Info.plist — prevents regressions where
# a TCC usage-description key is removed or misspelled. Without the right
# description key, macOS cannot display the consent dialog and silently
# blocks access to the protected resource (Reminders, Calendar, Contacts,
# Apple Events, FileProvider domains like OneDrive/iCloud Drive).

INFO_PLIST="$BATS_TEST_DIRNAME/../../desktop/src-tauri/Info.plist"

plist_get() {
    # Parse the plist XML directly with python so this works on Linux CI
    # where plutil does not exist. Handles the standard <key>/<string>
    # layout used in Info.plist files.
    local key="$1"
    python3 - "$INFO_PLIST" "$key" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    data = plistlib.load(f)
val = data.get(sys.argv[2], "")
print(val if isinstance(val, str) else "")
PY
}

@test "Info.plist exists" {
    [ -f "$INFO_PLIST" ]
}

@test "Info.plist is valid XML plist" {
    # plutil is macOS-only; use python's plistlib which is cross-platform
    # and ships with the stdlib.
    run python3 -c "import plistlib; plistlib.load(open('$INFO_PLIST', 'rb'))"
    [ "$status" -eq 0 ]
}

@test "NSRemindersUsageDescription is present and non-empty" {
    local val
    val="$(plist_get NSRemindersUsageDescription)"
    [ -n "$val" ]
}

@test "NSCalendarsUsageDescription is present and non-empty" {
    local val
    val="$(plist_get NSCalendarsUsageDescription)"
    [ -n "$val" ]
}

@test "NSContactsUsageDescription is present and non-empty" {
    local val
    val="$(plist_get NSContactsUsageDescription)"
    [ -n "$val" ]
}

@test "NSAppleEventsUsageDescription is present and non-empty" {
    # Required by mail-cli and notes-cli — without this, macOS cannot
    # display the Automation consent prompt and osascript → Apple Events
    # calls are silently blocked (error -1743).
    local val
    val="$(plist_get NSAppleEventsUsageDescription)"
    [ -n "$val" ]
}

@test "NSFileProviderDomainUsageDescription is present and non-empty" {
    # Required for virtiofs access to ~/Library/CloudStorage/ (OneDrive,
    # iCloud Drive, Dropbox, Google Drive). Without this, macOS TCC
    # silently blocks reads and stat returns "operation not permitted"
    # inside the VM. Regression introduced by code signing (PR #458),
    # fixed by PR #475. See anthropics/claude-code#26981 for the same
    # pattern in Claude Code.
    local val
    val="$(plist_get NSFileProviderDomainUsageDescription)"
    [ -n "$val" ]
}

@test "all usage descriptions mention Speedwave or Claude Code" {
    # User-facing strings should identify the app, not be Lorem-ipsum
    # placeholder text. This catches copy-paste regressions.
    for key in NSRemindersUsageDescription NSCalendarsUsageDescription \
               NSContactsUsageDescription NSAppleEventsUsageDescription \
               NSFileProviderDomainUsageDescription; do
        val="$(plist_get "$key")"
        if ! echo "$val" | grep -qE 'Speedwave|Claude'; then
            echo "Usage description for $key does not mention Speedwave/Claude: $val" >&2
            return 1
        fi
    done
}
