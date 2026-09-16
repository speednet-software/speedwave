#!/usr/bin/env bats

SPW_ROOT="$BATS_TEST_DIRNAME/../.."
SCRIPT="$SPW_ROOT/scripts/build-native-macos.sh"
SPW_PACKAGES="reminders calendar mail notes audio-capture"

setup() {
    if [ "$(uname)" != "Darwin" ]; then
        skip "macOS-only: the script exits early off Darwin and needs PlistBuddy"
    fi
    . "$SCRIPT"
    APP_VERSION="9.9.9"
}

assert_package_list() {
    local pkg n=0
    for pkg in $SPW_PACKAGES; do n=$((n + 1)); done
    [ "$n" -eq 5 ] || {
        echo "SPW_PACKAGES expands to $n services, expected 5" >&2
        return 1
    }
}

plist_fixture() {
    cp "$SPW_ROOT/native/macos/calendar/Resources/Info.plist" "$1"
}

@test "stamping rewrites both version keys" {
    local plist="$BATS_TEST_TMPDIR/Info.plist"
    plist_fixture "$plist"
    stamp_info_plist "$plist"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")" = "9.9.9" ]
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")" = "9.9.9" ]
}

@test "stamping keeps the release-please marker on both version lines" {
    local plist="$BATS_TEST_TMPDIR/Info.plist" markers
    plist_fixture "$plist"
    stamp_info_plist "$plist"
    markers="$(grep -c 'x-release-please-version' "$plist" | tr -d ' ')"
    if [ "$markers" != "2" ]; then
        echo "expected 2 x-release-please-version markers after stamping, found $markers" >&2
        echo "  release-please bumps these plists through the markers; without them it silently stops." >&2
        return 1
    fi
    grep -qE '<string>9\.9\.9</string> <!-- x-release-please-version -->' "$plist"
}

@test "stamping leaves every other key untouched" {
    local plist="$BATS_TEST_TMPDIR/Info.plist" before after
    plist_fixture "$plist"
    before="$(grep -vc 'x-release-please-version' "$plist" | tr -d ' ')"
    stamp_info_plist "$plist"
    after="$(grep -vc 'x-release-please-version' "$plist" | tr -d ' ')"
    [ "$before" = "$after" ]
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" = "pl.speedwave.desktop.calendar" ]
}

@test "stamping is idempotent" {
    local plist="$BATS_TEST_TMPDIR/Info.plist" once
    plist_fixture "$plist"
    stamp_info_plist "$plist"
    once="$(cat "$plist")"
    stamp_info_plist "$plist"
    [ "$once" = "$(cat "$plist")" ]
}

@test "stamping fails loudly when a version key is absent" {
    local plist="$BATS_TEST_TMPDIR/Info.plist"
    python3 - "$plist" <<'PY'
import plistlib, sys
with open(sys.argv[1], "wb") as f:
    plistlib.dump({"CFBundleIdentifier": "pl.speedwave.desktop.calendar"}, f)
PY
    run stamp_info_plist "$plist"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Failed to stamp CFBundleShortVersionString"* ]]
}

@test "stamping fails loudly when the plist is missing" {
    run stamp_info_plist "$BATS_TEST_TMPDIR/absent.plist"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Missing Info.plist"* ]]
}

@test "every committed CLI plist carries both markers" {
    assert_package_list
    local pkg plist markers
    for pkg in $SPW_PACKAGES; do
        plist="$SPW_ROOT/native/macos/$pkg/Resources/Info.plist"
        markers="$(grep -c 'x-release-please-version' "$plist" | tr -d ' ')"
        if [ "$markers" != "2" ]; then
            echo "$pkg/Resources/Info.plist has $markers x-release-please-version markers, expected 2" >&2
            return 1
        fi
    done
}

@test "every committed CLI plist is listed in release-please extra-files" {
    assert_package_list
    local pkg
    for pkg in $SPW_PACKAGES; do
        grep -qF "native/macos/$pkg/Resources/Info.plist" "$SPW_ROOT/release-please-config.json" || {
            echo "native/macos/$pkg/Resources/Info.plist missing from release-please extra-files" >&2
            return 1
        }
    done
}
