#!/usr/bin/env bats

# Guards scripts/check-windows-build-deps.sh: `make setup-dev` reports the Windows whisper
# prerequisites through it, and a wrong verdict sends a dev after the wrong tool.

DEPS_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/check-windows-build-deps.sh"
BUDGET_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/check-vulkan-path-budget.sh"
RESOLVER_SCRIPT="$BATS_TEST_DIRNAME/../../scripts/cargo-target-dir.sh"

setup() {
    WORK="$(mktemp -d "${BATS_TEST_TMPDIR}/deps.XXXXXX")"
}

teardown() {
    rm -rf "$WORK"
}

# Isolates the probe from the host toolchain: a stub `uname` picks the platform branch, and
# SEALED_PATH carries only the dirs the scripts themselves need — never a provisioned ninja.
deps_rig() {
    mkdir -p "$WORK/repo/scripts" "$WORK/repo/desktop/src-tauri" "$WORK/bin"
    cp "$DEPS_SCRIPT" "$WORK/repo/scripts/check-windows-build-deps.sh"
    cp "$BUDGET_SCRIPT" "$WORK/repo/scripts/check-vulkan-path-budget.sh"
    cp "$RESOLVER_SCRIPT" "$WORK/repo/scripts/cargo-target-dir.sh"
    printf '#!/usr/bin/env bash\necho "%s"\n' "${1:-MINGW64_NT-10.0-22631}" > "$WORK/bin/uname"
    chmod +x "$WORK/bin/uname"

    local tool dir
    SEALED_PATH="$WORK/bin"
    for tool in bash sed dirname; do
        dir="$(dirname "$(command -v "$tool")")"
        case ":$SEALED_PATH:" in
            *":$dir:"*) ;;
            *) SEALED_PATH="$SEALED_PATH:$dir" ;;
        esac
    done
    # The absent-ninja tests are only meaningful while the sealed PATH really has none.
    if PATH="$SEALED_PATH" command -v ninja >/dev/null 2>&1; then
        echo "sealed PATH leaks a ninja: $SEALED_PATH" >&2
        return 1
    fi
}

with_ninja() {
    printf '#!/usr/bin/env bash\necho 1.12.1\n' > "$WORK/bin/ninja"
    chmod +x "$WORK/bin/ninja"
}

run_probe() {
    run env -u VULKAN_SDK -u INCLUDE -u LIB -u CMAKE_GENERATOR -u CARGO_TARGET_DIR \
        PATH="$SEALED_PATH" "$@" bash "$WORK/repo/scripts/check-windows-build-deps.sh"
}

@test "the probe is a no-op off Windows" {
    deps_rig 'Darwin'

    run_probe

    [ "$status" -eq 0 ]
    [[ "$output" == *"skipped (not Windows)"* ]]
    [[ "$output" != *"VULKAN_SDK"* ]]
    [[ "$output" != *"path budget"* ]]
}

@test "a fully provisioned Windows shell reports every prerequisite present" {
    deps_rig
    with_ninja
    mkdir -p "$WORK/sdk"

    run_probe VULKAN_SDK="$WORK/sdk" INCLUDE=/i LIB=/l CMAKE_GENERATOR=Ninja CARGO_TARGET_DIR=/t

    [ "$status" -eq 0 ]
    [[ "$output" == *"✅ VULKAN_SDK $WORK/sdk"* ]]
    [[ "$output" == *"✅ ninja 1.12.1"* ]]
    [[ "$output" == *"✅ MSVC env + CMAKE_GENERATOR"* ]]
    # Indented: the gate's own verdict is nested under this section of `make setup-dev`.
    [[ "$output" == *"  ✅ Vulkan build path budget OK"* ]]
}

@test "a bare Windows shell names every missing prerequisite and its install step" {
    deps_rig

    run_probe CARGO_TARGET_DIR=/t

    [ "$status" -eq 0 ]
    [[ "$output" == *"VULKAN_SDK unset"* ]]
    [[ "$output" == *"ninja not found"* ]]
    [[ "$output" == *"msvc-env.sh not visible"* ]]
    [[ "$output" == *"make setup-dev-windows"* ]]
}

@test "a VULKAN_SDK pointing at a deleted install counts as unset" {
    deps_rig

    run_probe VULKAN_SDK="$WORK/gone" CARGO_TARGET_DIR=/t

    [ "$status" -eq 0 ]
    [[ "$output" == *"VULKAN_SDK unset"* ]]
}

@test "a half-provisioned MSVC env is not reported as present" {
    deps_rig

    run_probe INCLUDE=/i LIB=/l CARGO_TARGET_DIR=/t

    [ "$status" -eq 0 ]
    [[ "$output" == *"msvc-env.sh not visible"* ]]
    [[ "$output" != *"✅ MSVC env"* ]]
}

@test "a failing path budget is reported without failing the advisory probe" {
    # Advisory by contract: the hard gates are stage-vulkan-windows and whisper-rs-sys.
    deps_rig
    local deep
    deep="/$(printf 'x%.0s' {1..80})"

    run_probe CARGO_TARGET_DIR="$deep"

    [ "$status" -eq 0 ]
    [[ "$output" == *"too deep"* ]]
}
