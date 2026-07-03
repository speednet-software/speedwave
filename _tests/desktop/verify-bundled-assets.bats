#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/verify-bundled-assets.sh"

setup() {
    ROOT="$(mktemp -d "${BATS_TEST_TMPDIR}/bundled-assets.XXXXXX")"
}

teardown() {
    rm -rf "$ROOT"
}

write_file() {
    mkdir -p "$(dirname "$1")"
    printf '%s' "${2:-content}" > "$1"
}

write_exec() {
    mkdir -p "$(dirname "$1")"
    printf '#!/bin/sh\nexit 0\n' > "$1"
    chmod +x "$1"
}

populate_common() {
    mkdir -p "$ROOT/build-context/containers"
    mkdir -p "$ROOT/build-context/mcp-servers/shared"
    mkdir -p "$ROOT/mcp-os/os/dist"
    mkdir -p "$ROOT/mcp-os/shared/dist"
    mkdir -p "$ROOT/mcp-os/shared/node_modules/express"
    write_file "$ROOT/build-context/containers/Containerfile.claude"
    write_file "$ROOT/build-context/mcp-servers/shared/package.json"
    write_file "$ROOT/mcp-os/os/dist/index.js"
    write_file "$ROOT/mcp-os/shared/dist/index.js"
    write_file "$ROOT/mcp-os/shared/package.json"
    write_file "$ROOT/mcp-os/shared/package-lock.json"
    write_file "$ROOT/mcp-os/shared/node_modules/express/index.js"
    mkdir -p "$ROOT/mcp-os/os/node_modules/@speedwave/mcp-shared/dist"
    write_file "$ROOT/mcp-os/os/node_modules/@speedwave/mcp-shared/dist/index.js" "export {};"
    write_file "$ROOT/mcp-os/os/node_modules/@speedwave/mcp-shared/package.json" "{}"
}

populate_macos() {
    mkdir -p "$ROOT/lima/share"
    mkdir -p "$ROOT/nodejs/bin"
    mkdir -p "$ROOT/cli"
    write_exec "$ROOT/lima/bin/limactl"
    write_file "$ROOT/lima/share/lima.yaml"
    write_exec "$ROOT/nodejs/bin/node"
    write_exec "$ROOT/cli/speedwave"
    write_exec "$ROOT/reminders-cli"
    write_exec "$ROOT/calendar-cli"
    write_exec "$ROOT/mail-cli"
    write_exec "$ROOT/notes-cli"
    write_exec "$ROOT/audio-capture-cli"
}

@test "verify-bundled-assets script exists and is executable" {
    [ -x "$SCRIPT" ]
}

@test "verify-bundled-assets accepts complete macos tree" {
    populate_common
    populate_macos

    run "$SCRIPT" macos "$ROOT"

    [ "$status" -eq 0 ]
}

@test "verify-bundled-assets rejects missing notes-cli" {
    populate_common
    populate_macos
    rm "$ROOT/notes-cli"

    run "$SCRIPT" macos "$ROOT"

    [ "$status" -ne 0 ]
    [[ "$output" == *"notes-cli"* ]]
}

@test "verify-bundled-assets rejects missing mcp-shared symlink" {
    populate_common
    populate_macos
    rm -rf "$ROOT/mcp-os/os/node_modules"

    run "$SCRIPT" macos "$ROOT"

    [ "$status" -ne 0 ]
    [[ "$output" == *"mcp-shared"* ]]
}

@test "verify-bundled-assets rejects a Mach-O gzip under lima/share" {
    if [[ "$(uname)" != "Darwin" ]]; then
        skip "needs a Mach-O source binary (Darwin host)"
    fi
    populate_common
    populate_macos
    mkdir -p "$ROOT/lima/share/lima"
    gzip -c /bin/ls > "$ROOT/lima/share/lima/lima-guestagent.Darwin-aarch64.gz"

    run "$SCRIPT" macos "$ROOT"

    [ "$status" -ne 0 ]
    [[ "$output" == *"Mach-O"* ]]
    [[ "$output" == *"lima/share"* ]]
}

@test "verify-bundled-assets accepts a non-Mach-O gzip under lima/share" {
    populate_common
    populate_macos
    mkdir -p "$ROOT/lima/share/lima"
    printf '\x7fELF fake linux guestagent' | gzip -c \
        > "$ROOT/lima/share/lima/lima-guestagent.Linux-aarch64.gz"

    run "$SCRIPT" macos "$ROOT"

    [ "$status" -eq 0 ]
}
