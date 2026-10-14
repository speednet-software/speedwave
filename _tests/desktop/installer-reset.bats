#!/usr/bin/env bats

REPO_ROOT="$BATS_TEST_DIRNAME/../.."
RESET="$REPO_ROOT/desktop/src-tauri/windows/reset.ps1"

setup() {
    if ! command -v pwsh >/dev/null 2>&1; then
        [ -z "${CI:-}" ] || {
            echo "pwsh is required in CI to run reset.ps1" >&2
            return 1
        }
        skip "pwsh is not installed"
    fi
    WORK="$(mktemp -d)"
    DESKTOP="spwdesk$RANDOM"
    INST="$WORK/Local/Speedwave"
    DATA="$WORK/profile/.speedwave"
    mkdir -p "$DATA/oauth" "$INST/nodejs"
    for tree in build-context/mcp-servers/hub/src mcp-os/os/dist oauth/oauth/dist THIRD-PARTY-LICENSES host_exec/dist; do
        mkdir -p "$INST/$tree"
        touch "$INST/$tree/left-by-an-older-release"
    done
    touch "$INST/nodejs/node.exe" "$INST/speedwave-desktop.exe"
    [ "$(leftovers)" -eq 5 ]
}

teardown() {
    [ -z "${DESKTOP_PID:-}" ] || kill "$DESKTOP_PID" 2>/dev/null || true
    [ -z "${WORK:-}" ] || rm -rf "$WORK"
}

leftovers() {
    find "$INST" -name left-by-an-older-release | wc -l | tr -d ' '
}

run_reset() {
    run pwsh -NoProfile -NonInteractive -File "$RESET" -InstDir "$1" -DataDir "$2" -DefaultInstDir "$3" \
        -DesktopProcess "$DESKTOP"
}

@test "reset.ps1 clears every resource tree of the default install dir and keeps the rest" {
    run_reset "$INST" "$DATA" "$INST"
    [ "$status" -eq 0 ]
    [ "$(ls "$INST" | tr '\n' ' ')" = "nodejs speedwave-desktop.exe " ]
    [ -f "$INST/nodejs/node.exe" ]
}

@test "reset.ps1 reads its inputs from the environment the installer sets" {
    run env SPW_INSTDIR="$INST" SPW_DATA_DIR="$DATA" SPW_DEFAULT_INSTDIR="$INST" \
        pwsh -NoProfile -NonInteractive -File "$RESET" -DesktopProcess "$DESKTOP"
    [ "$status" -eq 0 ]
    [ "$(leftovers)" -eq 0 ]
}

@test "reset.ps1 leaves an install dir other than the default one untouched" {
    run_reset "$INST" "$DATA" "$WORK/Local/Elsewhere"
    [ "$status" -eq 10 ]
    [ "$(leftovers)" -eq 5 ]
}

@test "reset.ps1 leaves the trees alone when the data dir is the install dir" {
    run_reset "$INST" "$WORK/Local/speedwave/" "$INST"
    [ "$status" -eq 11 ]
    [ "$(leftovers)" -eq 5 ]
}

@test "reset.ps1 leaves the trees alone while the desktop process runs" {
    cp "$(command -v node)" "$WORK/$DESKTOP"
    "$WORK/$DESKTOP" -e 'setTimeout(() => {}, 60000)' 3>&- &
    DESKTOP_PID=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -x "$DESKTOP" >/dev/null && break
        sleep 0.2
    done
    pgrep -x "$DESKTOP" >/dev/null
    run_reset "$INST" "$DATA" "$INST"
    [ "$status" -eq 12 ]
    [ "$(leftovers)" -eq 5 ]
}

@test "reset.ps1 removes a linked directory without touching what it points to" {
    mkdir -p "$WORK/outside"
    echo keep > "$WORK/outside/sentinel"
    ln -s "$WORK/outside" "$INST/build-context/linked-outside"
    run_reset "$INST" "$DATA" "$INST"
    [ "$status" -eq 0 ]
    [ "$(cat "$WORK/outside/sentinel")" = keep ]
    [ ! -e "$INST/build-context" ]
}

@test "reset.ps1 fails without its inputs and removes nothing" {
    run env -u SPW_INSTDIR -u SPW_DATA_DIR -u SPW_DEFAULT_INSTDIR \
        pwsh -NoProfile -NonInteractive -File "$RESET"
    [ "$status" -eq 2 ]
    [ "$(leftovers)" -eq 5 ]
}
