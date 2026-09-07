#!/usr/bin/env bats
# Guards scripts/setup-dev-windows.ps1: install-phase isolation, and every file it writes.

SETUP_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/setup-dev-windows.ps1"
REPO_ROOT="$BATS_TEST_DIRNAME/../.."

line_of() {
    grep -n -- "$1" "$SETUP_SCRIPT" | head -1 | cut -d: -f1
}

@test "setup-dev-windows never writes the committed repo-root .cargo/config.toml" {
    run grep -n "Join-Path \$repoRoot '\.cargo'" "$SETUP_SCRIPT"
    [ "$status" -ne 0 ]
}

@test "setup-dev-windows provisions only the gitignored crate-local cargo config" {
    run grep -cF "Join-Path \$repoRoot 'desktop\\src-tauri\\.cargo'" "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
}

@test "desktop/src-tauri/.gitignore keeps the generated cargo config untracked" {
    run grep -qx "/\.cargo/" "$REPO_ROOT/desktop/src-tauri/.gitignore"
    [ "$status" -eq 0 ]
}

@test "setup-dev-windows pins a short target-dir for the ggml-vulkan path budget" {
    run grep -q '\[build\]' "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
    run grep -q 'target-dir = ' "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
}

@test "setup-dev-windows installs one package per choco invocation" {
    run grep -cE '^[[:space:]]*choco ' "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
    [ "$output" = "1" ]
    run grep -q 'choco \$verb -y --no-progress \$pkg\.Name' "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
}

@test "the node probe enforces the .node-version floor, not mere presence" {
    run grep -q 'Have = { Test-PinnedNode }' "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
    run grep -qF "Join-Path \$repoRoot '.node-version'" "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
    run grep -q "Name = 'nodejs-lts'.*Upgrade = \$true" "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
}

@test "setup-dev-windows does not list bats-core (absent from the Chocolatey feed)" {
    run grep -n 'bats' "$SETUP_SCRIPT"
    [ "$status" -ne 0 ]
}

@test "setup-dev-windows installs ninja, the cmake generator for whisper-rs-sys" {
    run grep -q "Name = 'ninja'" "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
}

@test "setup-dev-windows exports CMAKE_GENERATOR=Ninja into msvc-env.sh" {
    run grep -q "export CMAKE_GENERATOR='Ninja'" "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
}

@test "every package carries a capability probe re-checked after the install" {
    local block declared probes
    block="$(awk '/\$packages = @\(/,/^\)$/' "$SETUP_SCRIPT")"
    declared="$(printf '%s\n' "$block" | grep -c "@{ Name = '")"
    probes="$(printf '%s\n' "$block" | grep -c "Have = {")"
    [ "$declared" -eq "$probes" ]
    run grep -q 'if (& \$pkg\.Have) { continue }' "$SETUP_SCRIPT"
    [ "$status" -eq 0 ]
}

@test "a failed package is reported after the config phases, not before them" {
    local vulkan longpaths targetdir report
    vulkan="$(line_of '== Vulkan SDK')"
    longpaths="$(line_of 'LongPathsEnabled')"
    targetdir="$(line_of 'Wrote desktop/src-tauri/.cargo/config.toml')"
    report="$(line_of '== Incomplete')"
    [ -n "$report" ]
    [ "$vulkan" -lt "$report" ]
    [ "$longpaths" -lt "$report" ]
    [ "$targetdir" -lt "$report" ]
}

@test "a missing package still fails the script" {
    local report exit_line
    report="$(line_of '== Incomplete')"
    exit_line="$(awk -v s="$report" 'NR > s && $0 ~ /^[[:space:]]*exit 1$/ { print NR; exit }' \
        "$SETUP_SCRIPT")"
    [ -n "$exit_line" ]
}
