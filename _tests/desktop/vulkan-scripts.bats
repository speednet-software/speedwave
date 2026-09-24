#!/usr/bin/env bats

STAGE_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/stage-vulkan-runtime.sh"
BUDGET_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/check-vulkan-path-budget.sh"
RESOLVER_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/cargo-target-dir.sh"

setup() {
    WORK="$(mktemp -d "${BATS_TEST_TMPDIR}/vulkan.XXXXXX")"
}

teardown() {
    rm -rf "$WORK"
}

hash_of() {
    (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1
}

stage_rig() {
    mkdir -p "$WORK/repo/scripts" "$WORK/repo/desktop/src-tauri" "$WORK/sdk/runtime/x64"
    cp "$STAGE_SCRIPT" "$WORK/repo/scripts/stage-vulkan-runtime.sh"
    printf 'fake loader bytes' > "$WORK/sdk/runtime/x64/vulkan-1.dll"
}

@test "stage-vulkan-runtime stages a loader matching the pin scraped from install-vulkan-sdk.ps1" {
    stage_rig
    printf "\$RuntimeDllSha256 = '%s'\n" "$(hash_of "$WORK/sdk/runtime/x64/vulkan-1.dll")" \
        > "$WORK/repo/scripts/install-vulkan-sdk.ps1"

    VULKAN_SDK="$WORK/sdk" run bash "$WORK/repo/scripts/stage-vulkan-runtime.sh"

    [ "$status" -eq 0 ]
    [ -f "$WORK/repo/desktop/src-tauri/vulkan-1.dll" ]
}

@test "stage-vulkan-runtime accepts an uppercase pin pasted from Get-FileHash" {
    stage_rig
    printf "\$RuntimeDllSha256 = '%s'\n" \
        "$(hash_of "$WORK/sdk/runtime/x64/vulkan-1.dll" | tr '[:lower:]' '[:upper:]')" \
        > "$WORK/repo/scripts/install-vulkan-sdk.ps1"

    VULKAN_SDK="$WORK/sdk" run bash "$WORK/repo/scripts/stage-vulkan-runtime.sh"

    [ "$status" -eq 0 ]
    [ -f "$WORK/repo/desktop/src-tauri/vulkan-1.dll" ]
}

@test "stage-vulkan-runtime prefers the pinned SDK version over a lexicographically later one" {
    stage_rig
    mkdir -p "$WORK/sdks/1.4.357.0/runtime/x64" "$WORK/sdks/9.9.9.9/runtime/x64"
    printf 'pinned loader' > "$WORK/sdks/1.4.357.0/runtime/x64/vulkan-1.dll"
    printf 'wrong loader' > "$WORK/sdks/9.9.9.9/runtime/x64/vulkan-1.dll"
    printf "\$Version = '1.4.357.0'\n\$RuntimeDllSha256 = '%s'\n" \
        "$(hash_of "$WORK/sdks/1.4.357.0/runtime/x64/vulkan-1.dll")" \
        > "$WORK/repo/scripts/install-vulkan-sdk.ps1"

    SPEEDWAVE_VULKANSDK_BASE="$WORK/sdks" run \
        env -u VULKAN_SDK bash "$WORK/repo/scripts/stage-vulkan-runtime.sh"

    [ "$status" -eq 0 ]
    [ -f "$WORK/repo/desktop/src-tauri/vulkan-1.dll" ]
}

@test "stage-vulkan-runtime rejects a loader that does not match the pin" {
    stage_rig
    printf "\$RuntimeDllSha256 = '%s'\n" \
        "0000000000000000000000000000000000000000000000000000000000000000" \
        > "$WORK/repo/scripts/install-vulkan-sdk.ps1"

    VULKAN_SDK="$WORK/sdk" run bash "$WORK/repo/scripts/stage-vulkan-runtime.sh"

    [ "$status" -ne 0 ]
    [[ "$output" == *"SHA256 mismatch"* ]]
    [ ! -f "$WORK/repo/desktop/src-tauri/vulkan-1.dll" ]
}

@test "stage-vulkan-runtime fails loud when the pin cannot be scraped" {
    stage_rig
    printf '# no pin here\n' > "$WORK/repo/scripts/install-vulkan-sdk.ps1"

    VULKAN_SDK="$WORK/sdk" run bash "$WORK/repo/scripts/stage-vulkan-runtime.sh"

    [ "$status" -ne 0 ]
    [[ "$output" == *"RuntimeDllSha256"* ]]
}

@test "stage-vulkan-runtime fails loud when the SDK loader is missing" {
    stage_rig
    rm "$WORK/sdk/runtime/x64/vulkan-1.dll"
    printf "\$RuntimeDllSha256 = 'deadbeef'\n" > "$WORK/repo/scripts/install-vulkan-sdk.ps1"

    VULKAN_SDK="$WORK/sdk" run bash "$WORK/repo/scripts/stage-vulkan-runtime.sh"

    [ "$status" -ne 0 ]
    [[ "$output" == *"not found"* ]]
}

@test "check-vulkan-path-budget passes a short CARGO_TARGET_DIR" {
    CARGO_TARGET_DIR="/t" run bash "$BUDGET_SCRIPT"

    [ "$status" -eq 0 ]
    [[ "$output" == *"path budget OK"* ]]
}

@test "check-vulkan-path-budget rejects a target dir past the MAX_PATH budget" {
    local deep
    deep="/$(printf 'x%.0s' {1..80})"
    CARGO_TARGET_DIR="$deep" run bash "$BUDGET_SCRIPT"

    [ "$status" -ne 0 ]
    [[ "$output" == *"too deep"* ]]
}

@test "check-vulkan-path-budget resolves a relative CARGO_TARGET_DIR against the crate dir" {
    local deep
    deep="$WORK/$(printf 'x%.0s' {1..80})"
    mkdir -p "$deep/repo/scripts" "$deep/repo/desktop/src-tauri"
    cp "$BUDGET_SCRIPT" "$deep/repo/scripts/check-vulkan-path-budget.sh"
    cp "$RESOLVER_SCRIPT" "$deep/repo/scripts/cargo-target-dir.sh"

    CARGO_TARGET_DIR="t" run bash "$deep/repo/scripts/check-vulkan-path-budget.sh"

    [ "$status" -ne 0 ]
    [[ "$output" == *"too deep"* ]]
}

@test "cargo-target-dir resolves a relative crate dir without doubling it" {
    local sealed expected
    mkdir -p "$WORK/repo/scripts" "$WORK/repo/desktop/src-tauri"
    cp "$RESOLVER_SCRIPT" "$WORK/repo/scripts/cargo-target-dir.sh"
    sealed="$(dirname "$(command -v bash)")"
    run env PATH="$sealed" bash -c 'command -v cargo'
    [ "$status" -ne 0 ]
    expected="$(cd "$WORK/repo" && pwd)/desktop/src-tauri/target"

    cd "$WORK/repo"
    run env -u CARGO_TARGET_DIR PATH="$sealed" bash scripts/cargo-target-dir.sh desktop/src-tauri

    [ "$status" -eq 0 ]
    [ "$output" = "$expected" ]
}

@test "cargo-target-dir fails loud on a crate dir that does not exist" {
    run bash "$RESOLVER_SCRIPT" "$WORK/absent"

    [ "$status" -ne 0 ]
}

budget_rig() {
    mkdir -p "$WORK/repo/scripts" "$WORK/repo/desktop/src-tauri/.cargo" "$WORK/repo/desktop/src-tauri/src"
    cp "$BUDGET_SCRIPT" "$WORK/repo/scripts/check-vulkan-path-budget.sh"
    cp "$RESOLVER_SCRIPT" "$WORK/repo/scripts/cargo-target-dir.sh"
    printf '[package]\nname = "budget-rig"\nversion = "0.0.0"\nedition = "2021"\n' \
        > "$WORK/repo/desktop/src-tauri/Cargo.toml"
    : > "$WORK/repo/desktop/src-tauri/src/lib.rs"
}

@test "check-vulkan-path-budget reads the crate-local .cargo/config.toml target-dir escape" {
    budget_rig
    printf '[build]\ntarget-dir = "/t"\n' > "$WORK/repo/desktop/src-tauri/.cargo/config.toml"

    run env -u CARGO_TARGET_DIR bash "$WORK/repo/scripts/check-vulkan-path-budget.sh"

    [ "$status" -eq 0 ]
    if command -v cygpath >/dev/null 2>&1; then
        [[ "$output" == *"path budget OK"* ]]
    else
        [[ "$output" == *"/t:"* ]]
    fi
}

@test "check-vulkan-path-budget rejects a deep target-dir from .cargo/config.toml" {
    budget_rig
    printf '[build]\ntarget-dir = "/%s"\n' "$(printf 'x%.0s' {1..80})" \
        > "$WORK/repo/desktop/src-tauri/.cargo/config.toml"

    run env -u CARGO_TARGET_DIR bash "$WORK/repo/scripts/check-vulkan-path-budget.sh"

    [ "$status" -ne 0 ]
    [[ "$output" == *"too deep"* ]]
}

@test "check-vulkan-path-budget labels the failure as the desktop build dir by default" {
    local deep="$WORK/d/$(printf 'q%.0s' {1..120})/crate"
    mkdir -p "$deep"
    CARGO_TARGET_DIR="$deep/target" run bash "$BUDGET_SCRIPT" "$deep"
    [ "$status" -eq 1 ]
    [[ "$output" == *"desktop build dir is too deep"* ]]
}

@test "check-vulkan-path-budget reports the caller's label for another workspace" {
    local deep="$WORK/d/$(printf 'q%.0s' {1..120})/crate"
    mkdir -p "$deep"
    CARGO_TARGET_DIR="$deep/target" run bash "$BUDGET_SCRIPT" "$deep" "root workspace build dir"
    [ "$status" -eq 1 ]
    [[ "$output" == *"root workspace build dir is too deep"* ]]
    [[ "$output" != *"desktop build dir"* ]]
}

@test "the budget failure names CARGO_TARGET_DIR as the escape" {
    local deep="$WORK/d/$(printf 'q%.0s' {1..120})/crate"
    mkdir -p "$deep"
    CARGO_TARGET_DIR="$deep/target" run bash "$BUDGET_SCRIPT" "$deep" "root workspace build dir"
    [ "$status" -eq 1 ]
    [[ "$output" == *"CARGO_TARGET_DIR"* ]]
}

@test "the budget gate measures the target dir, not the crate dir" {
    local deep="$WORK/d/$(printf 'q%.0s' {1..120})/crate"
    mkdir -p "$deep"
    CARGO_TARGET_DIR="$deep/target" run bash "$BUDGET_SCRIPT" "$deep" "root workspace build dir"
    [[ "$output" == *"target"* ]]
}

@test "test-transcription gates the root workspace on the path budget on Windows" {
    local recipe
    recipe="$(awk '/^test-transcription:/,/^$/' "$BATS_TEST_DIRNAME/../../Makefile")"
    echo "$recipe" | grep -q 'check-vulkan-path-budget.sh "$(CURDIR)"'
    echo "$recipe" | grep -q 'Windows_NT'
}
