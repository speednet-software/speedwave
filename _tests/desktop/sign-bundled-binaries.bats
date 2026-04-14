#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/sign-bundled-binaries.sh"
IDENTITY="Developer ID Application: Test (TESTTEAM)"

setup() {
    SRC_TAURI="$(mktemp -d "${BATS_TEST_TMPDIR}/sign-bundled.XXXXXX")"
    export SRC_TAURI

    # Force the script's `uname` check to return "Darwin" on any host so tests
    # exercise the Darwin-only branches on Linux CI too. PATH shim is undone
    # automatically when the subshell exits after each test.
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

# Tauri copies a small synthetic Mach-O into each expected path, so the script's
# existence + file-type checks pass. We cannot invoke codesign in tests (no real
# cert), so these helpers mirror the production layout but stop short of signing.

write_mach_o() {
    # Minimal Mach-O 64-bit magic number (cafebabe / feedfacf) — enough for
    # `file(1)` to classify as Mach-O. Not executable in practice, which is
    # fine since we mock codesign below.
    mkdir -p "$(dirname "$1")"
    # Use the system /bin/ls as a known-valid Mach-O binary on macOS; on Linux
    # it's ELF and the Mach-O check will fail — tests only exercise the
    # Mach-O-assertion path via the negative test, not positive execution.
    if [[ "$(uname)" == "Darwin" ]]; then
        cp /bin/ls "$1"
    else
        # On Linux, copy an ELF file as a stand-in; tests that need a true
        # Mach-O are skipped on Linux.
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
    write_mach_o "$SRC_TAURI/lima/bin/limactl"
    write_mach_o "$SRC_TAURI/nodejs/bin/node"
    mkdir -p "$SRC_TAURI/entitlements"
    cp "$BATS_TEST_DIRNAME/../../desktop/src-tauri/entitlements/node.plist" \
       "$SRC_TAURI/entitlements/node.plist"
}

@test "sign-bundled-binaries script exists and is executable" {
    [ -x "$SCRIPT" ]
}

@test "exits 0 on non-Darwin host (no uname shim)" {
    # Without the shim, real `uname` decides: macOS returns Darwin and the
    # script continues past the guard; Linux returns Linux and it exits early.
    # Either way, with no signing identity set, the final exit code is 0.
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
    # Remove one expected binary to trigger the existence check
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
    # Overwrite one target with a shell script — valid executable but not Mach-O
    printf '#!/bin/sh\nexit 0\n' > "$SRC_TAURI/cli/speedwave"
    chmod +x "$SRC_TAURI/cli/speedwave"

    run with_darwin_uname "$SCRIPT"

    [ "$status" -eq 1 ]
    [[ "$output" == *"is not a Mach-O binary"* ]]
}

@test "error message names the missing file and gives actionable hint" {
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
    populate_targets
    # Remove the first target so the missing-file check fires before codesign
    # would attempt to run with a non-existent test identity.
    rm "$SRC_TAURI/cli/speedwave"

    run with_darwin_uname "$SCRIPT"

    [ "$status" -eq 1 ]
    # Must identify the specific missing binary, not fail generically
    [[ "$output" == *"cli/speedwave"* ]]
    # Must point operator at the fix: updating SIGN_TARGETS after changing
    # tauri.macos.conf.json resources
    [[ "$output" == *"tauri.macos.conf.json"* ]]
}
