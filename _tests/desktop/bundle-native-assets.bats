#!/usr/bin/env bats
# bundle-native-assets.sh must deploy the newest built artifact per package —
# a stale universal build must never shadow a fresh `swift build -c release`.

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/bundle-native-assets.sh"

setup() {
    if [ "$(uname)" != "Darwin" ]; then
        skip "macOS-only: the script exits early on non-macOS hosts"
    fi
    NATIVE_ROOT="$(mktemp -d "${BATS_TEST_TMPDIR}/native.XXXXXX")"
    DEST="$(mktemp -d "${BATS_TEST_TMPDIR}/dest.XXXXXX")"
}

teardown() {
    rm -rf "$NATIVE_ROOT" "$DEST"
}

# write_artifact <path> <content> [touch -t timestamp]
write_artifact() {
    mkdir -p "$(dirname "$1")"
    printf '%s' "$2" > "$1"
    chmod +x "$1"
    [ -z "${3:-}" ] || touch -t "$3" "$1"
}

populate_all_packages() {
    local pkg
    for pkg in reminders calendar mail notes audio-capture; do
        write_artifact "$NATIVE_ROOT/$pkg/.build/release/${pkg}-cli" "fresh-$pkg"
    done
}

@test "fresh swift-build artifact wins over a stale universal build" {
    populate_all_packages
    write_artifact "$NATIVE_ROOT/audio-capture/.build/apple/Products/Release/audio-capture-cli" \
        "stale-universal" 202605120000
    run env SPEEDWAVE_NATIVE_MACOS_DIR="$NATIVE_ROOT" bash "$SCRIPT" "$DEST"
    [ "$status" -eq 0 ]
    [ "$(cat "$DEST/audio-capture-cli")" = "fresh-audio-capture" ]
}

@test "newer universal build wins over an older swift-build artifact" {
    populate_all_packages
    touch -t 202601010000 "$NATIVE_ROOT/audio-capture/.build/release/audio-capture-cli"
    write_artifact "$NATIVE_ROOT/audio-capture/.build/apple/Products/Release/audio-capture-cli" \
        "release-universal"
    run env SPEEDWAVE_NATIVE_MACOS_DIR="$NATIVE_ROOT" bash "$SCRIPT" "$DEST"
    [ "$status" -eq 0 ]
    [ "$(cat "$DEST/audio-capture-cli")" = "release-universal" ]
}

@test "missing built artifact fails and names the binary" {
    populate_all_packages
    rm -r "$NATIVE_ROOT/notes"
    run env SPEEDWAVE_NATIVE_MACOS_DIR="$NATIVE_ROOT" bash "$SCRIPT" "$DEST"
    [ "$status" -eq 1 ]
    [[ "$output" == *"notes-cli"* ]]
}

@test "every package binary lands in the destination as an executable" {
    populate_all_packages
    run env SPEEDWAVE_NATIVE_MACOS_DIR="$NATIVE_ROOT" bash "$SCRIPT" "$DEST"
    [ "$status" -eq 0 ]
    local pkg
    for pkg in reminders calendar mail notes audio-capture; do
        [ -x "$DEST/${pkg}-cli" ]
    done
}
