#!/usr/bin/env bats

INFO_PLIST="$BATS_TEST_DIRNAME/../../desktop/src-tauri/Info.plist"

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
    run python3 -c "import plistlib; plistlib.load(open('$INFO_PLIST', 'rb'))"
    [ "$status" -eq 0 ]
}

@test "all required TCC usage descriptions are present and non-empty" {
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
    local val
    val="$(plist_get NSFileProviderDomainUsageDescription)"
    [ -n "$val" ]
}

@test "NSAppleEventsUsageDescription specifically is declared" {
    local val
    val="$(plist_get NSAppleEventsUsageDescription)"
    [ -n "$val" ]
}

@test "all usage descriptions mention Speedwave or Claude Code" {
    local key val
    for key in "${REQUIRED_TCC_KEYS[@]}"; do
        val="$(plist_get "$key")"
        if ! echo "$val" | grep -qE 'Speedwave|Claude'; then
            echo "Usage description for $key does not mention Speedwave/Claude: $val" >&2
            return 1
        fi
    done
}
