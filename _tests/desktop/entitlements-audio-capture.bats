#!/usr/bin/env bats
# Guard audio-capture.plist: must have com.apple.security.device.audio-input entitlement, no broader (ADR-056).

PLIST="$BATS_TEST_DIRNAME/../../desktop/src-tauri/entitlements/audio-capture.plist"

@test "audio-capture.plist exists" {
    [ -f "$PLIST" ]
}

@test "audio-capture.plist is valid XML plist" {
    run python3 -c "import plistlib; plistlib.load(open('$PLIST', 'rb'))"
    [ "$status" -eq 0 ]
}

@test "audio-capture.plist contains com.apple.security.device.audio-input" {
    run python3 - "$PLIST" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    data = plistlib.load(f)
key = "com.apple.security.device.audio-input"
if key not in data:
    print(f"Missing key: {key}", file=sys.stderr)
    sys.exit(1)
if data[key] is not True:
    print(f"Key {key} must be true, got: {data[key]}", file=sys.stderr)
    sys.exit(1)
PY
    [ "$status" -eq 0 ]
}

@test "audio-capture.plist declares exactly one <key>" {
    # Only the mic entitlement is needed; a second key is a regression.
    local keys
    keys="$(grep -c '<key>' "$PLIST")"
    [ "$keys" = "1" ]
}
