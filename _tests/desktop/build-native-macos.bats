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

staged_fixture_repo() {
    local root="$1" pkg
    mkdir -p "$root/scripts" "$root/desktop/src-tauri"
    cp -p "$SCRIPT" "$root/scripts/"
    cp "$SPW_ROOT/.gitignore" "$root/"
    for pkg in $SPW_PACKAGES; do
        mkdir -p "$root/native/macos/$pkg/Resources"
        cp "$SPW_ROOT/native/macos/$pkg/Resources/Info.plist" "$root/native/macos/$pkg/Resources/"
    done
    git -C "$root" init -q
    git -C "$root" add -A
    git -C "$root" -c user.name=t -c user.email=t@t commit -qm fixture
}

@test "staging writes both version keys into the copy" {
    local src="$BATS_TEST_TMPDIR/Info.plist" dest="$BATS_TEST_TMPDIR/.build/Info.plist"
    plist_fixture "$src"
    stage_info_plist "$src" "$dest"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$dest")" = "9.9.9" ]
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$dest")" = "9.9.9" ]
}

@test "staging leaves the source plist byte-identical" {
    local src="$BATS_TEST_TMPDIR/Info.plist" before
    plist_fixture "$src"
    before="$(cat "$src")"
    stage_info_plist "$src" "$BATS_TEST_TMPDIR/.build/Info.plist"
    [ "$before" = "$(cat "$src")" ]
}

@test "staging leaves every other line untouched" {
    local src="$BATS_TEST_TMPDIR/Info.plist" dest="$BATS_TEST_TMPDIR/.build/Info.plist"
    plist_fixture "$src"
    stage_info_plist "$src" "$dest"
    diff <(grep -v 'x-release-please-version' "$src") <(grep -v 'x-release-please-version' "$dest")
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$dest")" = "pl.speedwave.desktop.calendar" ]
}

@test "staging is idempotent" {
    local src="$BATS_TEST_TMPDIR/Info.plist" dest="$BATS_TEST_TMPDIR/.build/Info.plist" once
    plist_fixture "$src"
    stage_info_plist "$src" "$dest"
    once="$(cat "$dest")"
    stage_info_plist "$src" "$dest"
    [ "$once" = "$(cat "$dest")" ]
}

@test "staging fails loudly when a version key is absent" {
    local src="$BATS_TEST_TMPDIR/Info.plist"
    python3 - "$src" <<'PY'
import plistlib, sys
with open(sys.argv[1], "wb") as f:
    plistlib.dump({"CFBundleIdentifier": "pl.speedwave.desktop.calendar"}, f)
PY
    run stage_info_plist "$src" "$BATS_TEST_TMPDIR/.build/Info.plist"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Failed to stamp CFBundleShortVersionString"* ]]
}

@test "staging fails loudly when the source plist is missing" {
    run stage_info_plist "$BATS_TEST_TMPDIR/absent.plist" "$BATS_TEST_TMPDIR/.build/Info.plist"
    [ "$status" -ne 0 ]
    [[ "$output" == *"Missing Info.plist"* ]]
}

@test "--stage-only stamps every package copy and leaves git status clean" {
    assert_package_list
    local root="$BATS_TEST_TMPDIR/repo" pkg dirty
    staged_fixture_repo "$root"
    run env SPEEDWAVE_VERSION=9.9.9 "$root/scripts/build-native-macos.sh" --stage-only
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    dirty="$(git -C "$root" status --porcelain)"
    if [ -n "$dirty" ]; then
        echo "a build step wrote to tracked files:" >&2
        echo "$dirty" >&2
        return 1
    fi
    for pkg in $SPW_PACKAGES; do
        [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$root/native/macos/$pkg/.build/Info.plist")" = "9.9.9" ] || {
            echo "$pkg/.build/Info.plist was not stamped with 9.9.9" >&2
            return 1
        }
    done
}

@test "--stage-only falls back to 0.0.0 without SPEEDWAVE_VERSION or a usable cargo workspace" {
    assert_package_list
    local root="$BATS_TEST_TMPDIR/repo" pkg
    staged_fixture_repo "$root"
    run env -u SPEEDWAVE_VERSION "$root/scripts/build-native-macos.sh" --stage-only
    [ "$status" -eq 0 ] || { echo "$output" >&2; return 1; }
    for pkg in $SPW_PACKAGES; do
        [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$root/native/macos/$pkg/.build/Info.plist")" = "0.0.0" ] || {
            echo "$pkg/.build/Info.plist was not stamped with 0.0.0" >&2
            return 1
        }
    done
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
