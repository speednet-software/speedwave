#!/usr/bin/env bats
# Guards scripts/stage-vulkan-runtime.sh and scripts/check-vulkan-path-budget.sh (ADR-085):
# the pin scrape, the hash gate, and the MAX_PATH budget math run on every Windows build.

STAGE_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/stage-vulkan-runtime.sh"
BUDGET_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/check-vulkan-path-budget.sh"

setup() {
    WORK="$(mktemp -d "${BATS_TEST_TMPDIR}/vulkan.XXXXXX")"
}

teardown() {
    rm -rf "$WORK"
}

hash_of() {
    (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1
}

# Copies the stage script into an isolated scripts/ dir next to a fabricated pin file and a
# repo-shaped destination, so the pass/fail paths run without a real SDK install.
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
    # 259 - 220 = 39 usable chars; 80 chars is safely over the budget.
    local deep
    deep="/$(printf 'x%.0s' {1..80})"
    CARGO_TARGET_DIR="$deep" run bash "$BUDGET_SCRIPT"

    [ "$status" -ne 0 ]
    [[ "$output" == *"too deep"* ]]
}

@test "check-vulkan-path-budget reads the crate-local .cargo/config.toml target-dir escape" {
    # The escape hatch documented in cross-platform.md: a short crate-local target-dir
    # must pass even when the default crate path would fail.
    mkdir -p "$WORK/repo/scripts" "$WORK/repo/desktop/src-tauri/.cargo"
    cp "$BUDGET_SCRIPT" "$WORK/repo/scripts/check-vulkan-path-budget.sh"
    printf '[build]\ntarget-dir = "/t"\n' > "$WORK/repo/desktop/src-tauri/.cargo/config.toml"

    CARGO_TARGET_DIR="" run bash "$WORK/repo/scripts/check-vulkan-path-budget.sh"

    [ "$status" -eq 0 ]
    [[ "$output" == *"/t:"* ]]
}
