#!/usr/bin/env bats
# Guard the MAIN app's signing entitlements: bundle.macOS.entitlements must point
# at an existing plist carrying the mic entitlement (in-process consent, ADR-056).

CONF="$BATS_TEST_DIRNAME/../../desktop/src-tauri/tauri.macos.conf.json"

entitlements_path() {
    python3 - "$CONF" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    conf = json.load(f)
path = conf.get("bundle", {}).get("macOS", {}).get("entitlements")
if not path:
    sys.exit(1)
print(path)
PY
}

@test "tauri.macos.conf.json sets bundle.macOS.entitlements" {
    run entitlements_path
    [ "$status" -eq 0 ]
    [ -n "$output" ]
}

@test "main-app entitlements plist exists" {
    local rel
    rel="$(entitlements_path)"
    [ -f "$BATS_TEST_DIRNAME/../../desktop/src-tauri/$rel" ]
}

@test "main-app entitlements carry com.apple.security.device.audio-input" {
    local rel
    rel="$(entitlements_path)"
    run python3 - "$BATS_TEST_DIRNAME/../../desktop/src-tauri/$rel" <<'PY'
import plistlib, sys
with open(sys.argv[1], "rb") as f:
    data = plistlib.load(f)
key = "com.apple.security.device.audio-input"
if data.get(key) is not True:
    print(f"Key {key} must be present and true", file=sys.stderr)
    sys.exit(1)
PY
    [ "$status" -eq 0 ]
}
