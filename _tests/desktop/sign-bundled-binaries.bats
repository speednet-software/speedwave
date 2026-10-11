#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/sign-bundled-binaries.sh"
IDENTITY="Developer ID Application: Test (TESTTEAM)"

setup() {
    SRC_TAURI="$(mktemp -d "${BATS_TEST_TMPDIR}/sign-bundled.XXXXXX")"
    export SRC_TAURI

    UNAME_SHIM_DIR="${BATS_TEST_TMPDIR}/uname-shim"
    mkdir -p "$UNAME_SHIM_DIR"
    cat > "$UNAME_SHIM_DIR/uname" <<'EOF'
#!/bin/sh
echo Darwin
EOF
    chmod +x "$UNAME_SHIM_DIR/uname"
}

teardown() {
    rm -rf "$SRC_TAURI" "$UNAME_SHIM_DIR"
    unset SRC_TAURI UNAME_SHIM_DIR
}

with_darwin_uname() {
    PATH="$UNAME_SHIM_DIR:$PATH" "$@"
}


write_mach_o() {
    mkdir -p "$(dirname "$1")"
    if [[ "$(uname)" == "Darwin" ]]; then
        cp /bin/ls "$1"
    else
        cp /bin/ls "$1" 2>/dev/null || printf '\x7fELF' > "$1"
    fi
    chmod +x "$1"
}

populate_targets() {
    write_mach_o "$SRC_TAURI/cli/speedwave"
    write_mach_o "$SRC_TAURI/reminders-cli"
    write_mach_o "$SRC_TAURI/calendar-cli"
    write_mach_o "$SRC_TAURI/mail-cli"
    write_mach_o "$SRC_TAURI/notes-cli"
    write_mach_o "$SRC_TAURI/audio-capture-cli"
    write_mach_o "$SRC_TAURI/lima/bin/limactl"
    write_mach_o "$SRC_TAURI/nodejs/bin/node"
    mkdir -p "$SRC_TAURI/entitlements"
    local ent_src="$BATS_TEST_DIRNAME/../../desktop/src-tauri/entitlements"
    cp "$ent_src/node.plist" "$SRC_TAURI/entitlements/node.plist"
    cp "$ent_src/virtualization.plist" "$SRC_TAURI/entitlements/virtualization.plist"
    cp "$ent_src/calendars.plist" "$SRC_TAURI/entitlements/calendars.plist"
    cp "$ent_src/reminders.plist" "$SRC_TAURI/entitlements/reminders.plist"
    cp "$ent_src/apple-events.plist" "$SRC_TAURI/entitlements/apple-events.plist"
    cp "$ent_src/audio-capture.plist" "$SRC_TAURI/entitlements/audio-capture.plist"
}

@test "exits 0 on non-Darwin host (no uname shim)" {
    unset APPLE_SIGNING_IDENTITY

    run "$SCRIPT"

    [ "$status" -eq 0 ]
}

@test "exits 0 when APPLE_SIGNING_IDENTITY is unset (dev build)" {
    unset APPLE_SIGNING_IDENTITY

    run with_darwin_uname "$SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *"skipping bundled binary signing"* ]]
}

@test "exits 1 when a SIGN_TARGETS path is missing" {
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
    populate_targets
    rm "$SRC_TAURI/cli/speedwave"

    run with_darwin_uname "$SCRIPT"

    [ "$status" -eq 1 ]
    [[ "$output" == *"ERROR: expected binary does not exist"* ]]
    [[ "$output" == *"cli/speedwave"* ]]
    [[ "$output" == *"update SIGN_TARGETS"* ]]
}

@test "exits 1 when a SIGN_TARGETS path is not a Mach-O binary" {
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
    populate_targets
    printf '#!/bin/sh\nexit 0\n' > "$SRC_TAURI/cli/speedwave"
    chmod +x "$SRC_TAURI/cli/speedwave"

    run with_darwin_uname "$SCRIPT"

    [ "$status" -eq 1 ]
    [[ "$output" == *"is not a Mach-O binary"* ]]
}

@test "error message names the missing file and gives actionable hint" {
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
    populate_targets
    rm "$SRC_TAURI/cli/speedwave"

    run with_darwin_uname "$SCRIPT"

    [ "$status" -eq 1 ]
    [[ "$output" == *"cli/speedwave"* ]]
    [[ "$output" == *"tauri.macos.conf.json"* ]]
}
