#!/usr/bin/env bats
# Static checks on desktop/src-tauri/Info.plist TCC usage-description keys.

INFO_PLIST="$BATS_TEST_DIRNAME/../../desktop/src-tauri/Info.plist"

# SSOT for required TCC usage-description keys (see ADR-037 §1b for mapping).
REQUIRED_TCC_KEYS=(
    NSRemindersUsageDescription
    NSRemindersFullAccessUsageDescription
    NSCalendarsUsageDescription
    NSCalendarsFullAccessUsageDescription
    NSContactsUsageDescription
    NSAppleEventsUsageDescription
    NSFileProviderDomainUsageDescription
    NSAudioCaptureUsageDescription
    NSMicrophoneUsageDescription
)

plist_get() {
    # Parse the plist XML with python (cross-platform; plutil is macOS-only).
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
    # Each key must resolve to a non-empty string; failures reported per-key.
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
    # v0.7.2 regression: without this key macOS silently blocks virtiofs
    # reads from ~/Library/CloudStorage/. See anthropics/claude-code#26981.
    local val
    val="$(plist_get NSFileProviderDomainUsageDescription)"
    [ -n "$val" ]
}

@test "NSAppleEventsUsageDescription specifically is declared" {
    # Key used by mail-cli and notes-cli; missing it makes Apple Events
    # calls fail silently with error -1743.
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
