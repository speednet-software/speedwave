#!/usr/bin/env bats

SCRIPT="$BATS_TEST_DIRNAME/../../scripts/install-wasm-pack.sh"

write_stub() {
    printf '#!/usr/bin/env bash\n%s\n' "$2" >"$STUBS/$1"
    chmod +x "$STUBS/$1"
}

stub_wasm_pack() {
    write_stub wasm-pack "echo 'wasm-pack $1'"
}

stub_npm_installing() {
    write_stub npm '
case "$1" in
    prefix) echo "$NPM_PREFIX" ;;
    install)
        echo "npm $*" >>"$CALLS"
        printf "#!/bin/sh\necho \"wasm-pack %s\"\n" "${3#wasm-pack@}" >"$NPM_PREFIX/bin/wasm-pack"
        chmod +x "$NPM_PREFIX/bin/wasm-pack"
        ;;
esac'
}

stub_npm_failing() {
    write_stub npm '
case "$1" in
    prefix) echo "$NPM_PREFIX" ;;
    install) echo "npm $*" >>"$CALLS"; exit 1 ;;
esac'
}

stub_cargo_installing() {
    write_stub cargo '
echo "cargo $*" >>"$CALLS"
printf "#!/bin/sh\necho \"wasm-pack 0.15.0\"\n" >"$CARGO_BIN/wasm-pack"
chmod +x "$CARGO_BIN/wasm-pack"'
}

setup() {
    STUBS="$BATS_TEST_TMPDIR/stubs"
    NPM_PREFIX="$BATS_TEST_TMPDIR/npm-prefix"
    CARGO_BIN="$BATS_TEST_TMPDIR/cargo-bin"
    CALLS="$BATS_TEST_TMPDIR/calls.log"
    VERSIONS="$BATS_TEST_TMPDIR/build-tool-versions.env"
    mkdir -p "$STUBS" "$NPM_PREFIX/bin" "$CARGO_BIN"
    : >"$CALLS"
    printf 'WASM_PACK_VERSION=0.15.0\n' >"$VERSIONS"
    export STUBS NPM_PREFIX CARGO_BIN CALLS
    export PATH="$STUBS:$CARGO_BIN:/usr/bin:/bin"
    export BUILD_TOOL_VERSIONS_FILE="$VERSIONS"
    unset GITHUB_PATH
}

@test "skips the install when the installed wasm-pack already matches the pinned version" {
    stub_wasm_pack 0.15.0
    stub_npm_installing
    stub_cargo_installing

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"already installed"* ]]
    [ ! -s "$CALLS" ]
}

@test "installs the pinned version with npm when wasm-pack is missing" {
    stub_npm_installing

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(cat "$CALLS")" = "npm install -g wasm-pack@0.15.0" ]
    [ "$("$NPM_PREFIX/bin/wasm-pack" --version)" = "wasm-pack 0.15.0" ]
}

@test "replaces an installed wasm-pack of another version with the pinned one" {
    stub_wasm_pack 0.13.1
    stub_npm_installing

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(cat "$CALLS")" = "npm install -g wasm-pack@0.15.0" ]
}

@test "finds wasm-pack under a user-level npm prefix that is not on PATH" {
    stub_npm_installing

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed (npm)"* ]]
    printf '#!/bin/sh\necho "wasm-pack 0.15.0"\n' >"$NPM_PREFIX/bin/wasm-pack"
    : >"$CALLS"
    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"already installed"* ]]
    [ ! -s "$CALLS" ]
}

@test "falls back to a locked cargo install of the pinned version when npm fails" {
    stub_npm_failing
    stub_cargo_installing

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"installed (cargo)"* ]]
    grep -qx 'npm install -g wasm-pack@0.15.0' "$CALLS"
    grep -qx 'cargo install wasm-pack --version 0.15.0 --locked --force' "$CALLS"
}

@test "fails when neither npm nor cargo yields the pinned version" {
    stub_npm_failing
    write_stub cargo 'exit 1'

    run "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"could not install wasm-pack 0.15.0"* ]]
}

@test "fails when npm installs a different version than the pinned one" {
    write_stub npm '
case "$1" in
    prefix) echo "$NPM_PREFIX" ;;
    install)
        printf "#!/bin/sh\necho \"wasm-pack 0.0.1\"\n" >"$NPM_PREFIX/bin/wasm-pack"
        chmod +x "$NPM_PREFIX/bin/wasm-pack"
        ;;
esac'

    run "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"could not install wasm-pack 0.15.0"* ]]
}

@test "appends the npm bin directory to GITHUB_PATH after an install" {
    stub_npm_installing
    export GITHUB_PATH="$BATS_TEST_TMPDIR/github-path"
    : >"$GITHUB_PATH"

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(cat "$GITHUB_PATH")" = "$NPM_PREFIX/bin" ]
}

@test "fails when the versions file does not exist" {
    stub_npm_installing
    export BUILD_TOOL_VERSIONS_FILE="$BATS_TEST_TMPDIR/missing.env"

    run "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"versions file not found"* ]]
    [ ! -s "$CALLS" ]
}

@test "fails when the versions file has no WASM_PACK_VERSION" {
    stub_npm_installing
    printf 'OTHER=1\n' >"$VERSIONS"

    run "$SCRIPT"
    [ "$status" -ne 0 ]
    [[ "$output" == *"WASM_PACK_VERSION is not set"* ]]
    [ ! -s "$CALLS" ]
}

@test "reads the pinned version from the repository versions file by default" {
    stub_npm_installing

    run env -u BUILD_TOOL_VERSIONS_FILE "$SCRIPT"
    [ "$status" -eq 0 ]
    local pinned
    pinned="$(awk -F= '$1 == "WASM_PACK_VERSION" { print $2 }' "$BATS_TEST_DIRNAME/../../scripts/build-tool-versions.env")"
    [[ "$pinned" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
    [ "$(cat "$CALLS")" = "npm install -g wasm-pack@$pinned" ]
}

stub_windows_git_bash() {
    WIN_PREFIX='C:\Users\ci\AppData\Roaming\npm'
    WIN_PREFIX_UNIX="$BATS_TEST_TMPDIR/win-npm"
    mkdir -p "$WIN_PREFIX_UNIX"
    export WIN_PREFIX WIN_PREFIX_UNIX
    write_stub uname 'echo MINGW64_NT-10.0'
    write_stub cygpath '
case "$1" in
    -u) echo "$WIN_PREFIX_UNIX" ;;
    -w) echo "$WIN_PREFIX" ;;
esac'
    write_stub npm '
case "$1" in
    prefix) printf "%s\r\n" "$WIN_PREFIX" ;;
    install)
        echo "npm $*" >>"$CALLS"
        printf "#!/bin/sh\necho \"wasm-pack %s\"\n" "${3#wasm-pack@}" >"$WIN_PREFIX_UNIX/wasm-pack"
        chmod +x "$WIN_PREFIX_UNIX/wasm-pack"
        ;;
esac'
}

@test "on Windows Git Bash the npm global bin is the prefix itself, not prefix/bin" {
    stub_windows_git_bash

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"wasm-pack 0.15.0 installed (npm)"* ]]
    [ "$("$WIN_PREFIX_UNIX/wasm-pack" --version)" = "wasm-pack 0.15.0" ]
}

@test "on Windows Git Bash GITHUB_PATH gets the Windows form of the npm prefix" {
    stub_windows_git_bash
    export GITHUB_PATH="$BATS_TEST_TMPDIR/github-path"
    : >"$GITHUB_PATH"

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$(cat "$GITHUB_PATH")" = "$WIN_PREFIX" ]
}

@test "on Windows detected through OS=Windows_NT the already installed pinned version is found" {
    stub_windows_git_bash
    write_stub uname 'echo Linux'
    printf '#!/bin/sh\necho "wasm-pack 0.15.0"\n' >"$WIN_PREFIX_UNIX/wasm-pack"
    chmod +x "$WIN_PREFIX_UNIX/wasm-pack"

    OS=Windows_NT run "$SCRIPT"
    [ "$status" -eq 0 ]
    [[ "$output" == *"already installed"* ]]
    [ ! -s "$CALLS" ]
}

@test "prints the installed version after a fresh install" {
    stub_npm_installing

    run "$SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = "wasm-pack 0.15.0 installed (npm)" ]
}
