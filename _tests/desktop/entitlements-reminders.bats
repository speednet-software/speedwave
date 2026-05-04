#!/usr/bin/env bats
# Static checks on desktop/src-tauri/entitlements/reminders.plist — prevents
# regressions where the Reminders entitlement file is missing or malformed.
# The separate reminders.plist (distinct from calendars.plist) is required because
# com.apple.security.personal-information.reminders and .calendars are separate
# Hardened Runtime Resource Access entitlements per ADR-037.

PLIST="$BATS_TEST_DIRNAME/../../desktop/src-tauri/entitlements/reminders.plist"

@test "reminders.plist exists" {
    [ -f "$PLIST" ]
}

@test "reminders.plist is valid XML plist" {
    run python3 -c "import plistlib; plistlib.load(open('$PLIST', 'rb'))"
    [ "$status" -eq 0 ]
}

@test "reminders.plist contains com.apple.security.personal-information.reminders" {
    run python3 - "$PLIST" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    data = plistlib.load(f)
key = "com.apple.security.personal-information.reminders"
if key not in data:
    print(f"Missing key: {key}", file=sys.stderr)
    sys.exit(1)
if data[key] is not True:
    print(f"Key {key} must be true, got: {data[key]}", file=sys.stderr)
    sys.exit(1)
PY
    [ "$status" -eq 0 ]
}

@test "reminders.plist does NOT contain calendars entitlement" {
    run python3 -c "
import plistlib, sys
with open('$PLIST', 'rb') as f:
    data = plistlib.load(f)
if 'com.apple.security.personal-information.calendars' in data:
    print('ERROR: reminders.plist must not contain .calendars entitlement', file=sys.stderr)
    sys.exit(1)
"
    [ "$status" -eq 0 ]
}

@test "reminders.plist declares exactly one <key>" {
    local keys
    keys="$(grep -c '<key>' "$PLIST")"
    [ "$keys" = "1" ]
}
