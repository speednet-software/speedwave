#!/usr/bin/env bats
# Static checks on desktop/src-tauri/Info.plist — prevents regressions where
# a TCC usage-description key is removed or misspelled. Without the right
# description key, macOS cannot display the consent dialog and silently
# blocks access to the protected resource (Reminders, Calendar, Contacts,
# Apple Events, FileProvider domains like OneDrive/iCloud Drive).

INFO_PLIST="$BATS_TEST_DIRNAME/../../desktop/src-tauri/Info.plist"

# Single source of truth for which TCC usage-description keys Speedwave must
# declare. Add a key here when a bundled binary starts using a new TCC-gated
# API — every @test below iterates this list. See ADR-037 §1b for the mapping
# between keys and the APIs/binaries that require them.
REQUIRED_TCC_KEYS=(
    NSRemindersUsageDescription
    NSCalendarsUsageDescription
    NSContactsUsageDescription
    NSAppleEventsUsageDescription
    NSFileProviderDomainUsageDescription
)

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

@test "all required TCC usage descriptions are present and non-empty" {
    # Each key must resolve to a non-empty string, otherwise macOS cannot
    # display the consent dialog. Failures are reported per-key so a
    # missing key names itself in the output.
    local key val missing=()
    for key in "${REQUIRED_TCC_KEYS[@]}"; do
        val="$(plist_get "$key")"
        if [ -z "$val" ]; then
            missing+=("$key")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo "Missing or empty Info.plist keys: ${missing[*]}" >&2
        return 1
    fi
}

@test "NSFileProviderDomainUsageDescription specifically is declared" {
    # Explicit test for the key that caused the v0.7.2 CloudStorage
    # regression — macOS silently blocks virtiofs reads from
    # ~/Library/CloudStorage/ (OneDrive, iCloud Drive, Dropbox, Google
    # Drive) without this key. See anthropics/claude-code#26981.
    local val
    val="$(plist_get NSFileProviderDomainUsageDescription)"
    [ -n "$val" ]
}

@test "NSAppleEventsUsageDescription specifically is declared" {
    # Explicit test for the key used by mail-cli and notes-cli. Missing
    # this key makes osascript → Apple Events calls fail silently with
    # error -1743.
    local val
    val="$(plist_get NSAppleEventsUsageDescription)"
    [ -n "$val" ]
}

@test "all usage descriptions mention Speedwave or Claude Code" {
    # User-facing strings should identify the app, not be Lorem-ipsum
    # placeholder text. This catches copy-paste regressions.
    local key val
    for key in "${REQUIRED_TCC_KEYS[@]}"; do
        val="$(plist_get "$key")"
        if ! echo "$val" | grep -qE 'Speedwave|Claude'; then
            echo "Usage description for $key does not mention Speedwave/Claude: $val" >&2
            return 1
        fi
    done
}
